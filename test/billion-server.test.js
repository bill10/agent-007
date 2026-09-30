import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { server, sessions, killSession } from '../server.js';
import { createSessionFromConfig } from '../server/pty.js';
import { broadcast } from '../server/ws.js';
import { codenamePool, nextSessionId } from '../server/state.js';
import { BILLION_NAME } from '../server/billion.js';
import { hashToken } from '../server/auth.js';

// A stand-in for Billion that runs anywhere: the real one would start Claude
// Code. What is under test is how the server treats a session marked isBillion.
const idle = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
function spawn({ isBillion = false, name }) {
  const { session, error } = createSessionFromConfig({
    sessionId: nextSessionId(), name, color: '#fff', command: idle,
    repoPath: null, worktreePath: null, cwd: mkdtempSync(join(tmpdir(), 'a007-billion-cwd-')),
    isBillion, ownerId: null,
  }, broadcast);
  if (error) throw new Error(error);
  sessions.set(session.id, session);
  return session;
}

let wsUrl;   // any free port, set once listening
const connect = (opts = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl, opts);
  const seen = [];
  ws.on('message', (d) => seen.push(JSON.parse(d)));
  ws.on('open', () => resolve({ ws, seen }));
  ws.on('error', reject);
});
const waitFor = async (seen, pred, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = seen.find(pred);
    if (m) return m;
    await new Promise(r => setTimeout(r, 20));
  }
  return null;
};

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  wsUrl = `ws://127.0.0.1:${server.address().port}`;
  codenamePool.reserve(BILLION_NAME);   // what startup() does
});

afterAll(async () => {
  for (const [id, s] of sessions) {
    clearInterval(s.stateCheckInterval);
    try { s.pty.kill(); } catch {}
    sessions.delete(id);
  }
  await new Promise(r => server.close(r));
});

describe('Billion on the server', () => {
  it('tells a new window it runs Billion, and replays Billion first', async () => {
    const other = spawn({ name: 'Viper' });          // older than Billion
    const billion = spawn({ isBillion: true, name: BILLION_NAME });
    const { ws, seen } = await connect();
    const welcome = await waitFor(seen, m => m.type === 'welcome');
    expect(welcome.billionEnabled).toBe(true);
    await waitFor(seen, m => m.type === 'session-created' && m.sessionId === other.id);
    const created = seen.filter(m => m.type === 'session-created');
    expect(created[0].sessionId).toBe(billion.id);
    expect(created[0].isBillion).toBe(true);
    expect(created.find(m => m.sessionId === other.id).isBillion).toBe(false);
    ws.close();
    await killSession(other.id);
    await killSession(billion.id);
  });

  it('refuses to rename Billion', async () => {
    const billion = spawn({ isBillion: true, name: BILLION_NAME });
    const { ws, seen } = await connect();
    ws.send(JSON.stringify({ type: 'rename-session', sessionId: billion.id, name: 'Bob' }));
    const refused = await waitFor(seen, m => m.type === 'notification' && /can't be changed/.test(m.message));
    expect(refused).toBeTruthy();
    expect(billion.name).toBe(BILLION_NAME);
    ws.close();
    await killSession(billion.id);
  });

  it('keeps the name reserved after Billion is closed', async () => {
    const billion = spawn({ isBillion: true, name: BILLION_NAME });
    await killSession(billion.id);
    expect(sessions.has(billion.id)).toBe(false);
    expect(codenamePool.has(BILLION_NAME)).toBe(true);
  });
});

// The owner's Claude account switch over the socket (server.js accountAction,
// server/ws.js 'account'). Every action here fails before the module reaches
// `security` or `claude`: CONFIG_DIR is the suite's temp dir with nothing set
// up, and the one folder given is relative. Nothing on this machine is touched.
describe('the Claude account switch over the socket', () => {
  // A refusal comes back as account-error, for the panel to show in place.
  const refusal = async (ws, seen, msg) => {
    const before = seen.length;
    ws.send(JSON.stringify({ type: 'account', ...msg }));
    return waitFor(seen, (m, i) => i >= before && m.type === 'account-error');
  };

  // What a browser sends; a socket without it is not a browser (server/ws.js).
  const browser = () => ({ headers: { origin: `http://127.0.0.1:${new URL(wsUrl).port}` } });

  it('refuses a socket that carries no Origin, or one from another local port: not this server\'s page', async () => {
    for (const opts of [{}, { headers: { origin: 'http://127.0.0.1:9' } }, { headers: { origin: 'http://localhost:9' } }]) {
      const { ws, seen } = await connect(opts);
      const got = await refusal(ws, seen, { action: 'setup', folder: '/tmp/never-read' });
      expect(got.message, JSON.stringify(opts)).toMatch(/switched from the browser only/);
      expect(seen.some(m => m.type === 'account-state')).toBe(false);   // nor is the state sent to it
      ws.close();
    }
  });

  it('tells a new window the state, and every action answers with its error', async () => {
    const { ws, seen } = await connect(browser());
    const state = await waitFor(seen, m => m.type === 'account-state');
    expect(state).toMatchObject({ status: 'not set up' });
    expect(JSON.stringify(state)).not.toMatch(/backupDir/);
    for (const [msg, error] of [
      [{ action: 'bogus' }, /Unknown account action bogus/],
      [{ action: 'constructor' }, /Unknown account action constructor/],
      [{ action: ['migrate'] }, /Unknown account action migrate/],
      [{ action: 'setup', folder: 'claude-new' }, /absolute path/],
      [{ action: 'arm' }, /Set the new account's folder up first/],
      [{ action: 'migrate' }, /Set the new account's folder up first/],
      [{ action: 'arm', on: false }, /Nothing is armed/],
      [{ action: 'rollback' }, /Nothing to roll back: no switch has been made/],
      [{ action: 'retire' }, /Only a folder whose account has been switched to/],
    ]) {
      const got = await refusal(ws, seen, msg);
      expect(got?.message, msg.action).toMatch(error);
    }
    // Each action re-broadcasts the state, still not set up.
    expect(seen.filter(m => m.type === 'account-state').length).toBeGreaterThan(1);
    expect(seen.filter(m => m.type === 'account-state').every(m => m.status === 'not set up')).toBe(true);
    ws.close();
  });

  it('a switch that fails before the swap reaches the owner as a notification, with no Billion to restart', async () => {
    const cfg = process.env.AGENT007_CONFIG_DIR;
    // A folder that exists but never logged in: preflight fails before any `security` or `claude` call.
    const folder = mkdtempSync(join(tmpdir(), 'acct-empty-'));
    writeFileSync(join(cfg, 'account-migration.json'), JSON.stringify({ status: 'ready', folder, newEmail: 'new@x', oldEmail: 'old@x' }));
    expect([...sessions.values()].some(s => s.isBillion && !s.exited)).toBe(false);   // nothing to stop or start
    try {
      const { ws, seen } = await connect(browser());
      expect(await waitFor(seen, m => m.type === 'account-state' && m.status === 'ready')).toBeTruthy();
      const before = seen.length;
      ws.send(JSON.stringify({ type: 'account', action: 'migrate' }));
      // The click gets its answer over the socket, once, for the panel: no broadcast copy.
      const note = await waitFor(seen, (m, i) => i >= before && m.type === 'account-error' && /\.claude\.json/.test(m.message));
      try {
        expect(note).toBeTruthy();
        expect(note.message).not.toMatch(/sk-ant|Claude account switch to/);
        await new Promise(r => setTimeout(r, 200));
        expect(seen.slice(before).filter(m => m.type === 'account-error')).toHaveLength(1);
        expect(seen.slice(before).filter(m => m.type === 'notification')).toHaveLength(0);
        expect(seen.slice(before).some(m => m.type === 'account-state' && m.status === 'ready')).toBe(true);
      } finally { ws.close(); }
    } finally { rmSync(join(cfg, 'account-migration.json'), { force: true }); }
  });

  it('a browser action reaches browser sockets only', async () => {
    const plain = await connect();
    const { ws, seen } = await connect(browser());
    const before = plain.seen.length;
    ws.send(JSON.stringify({ type: 'account', action: 'arm' }));
    await waitFor(seen, m => m.type === 'account-error');
    await new Promise(r => setTimeout(r, 100));
    expect(plain.seen.slice(before).filter(m => m.type === 'account-state' || m.type === 'account-error' || m.type === 'notification')).toEqual([]);
    ws.close(); plain.ws.close();
  });

  it('with user accounts on, nobody switches the account', async () => {
    const usersPath = process.env.AGENT007_USERS_PATH;
    const token = 'tokAcct_' + Math.random().toString(36).slice(2, 10);
    writeFileSync(usersPath, JSON.stringify([{ id: 'u_acct', displayName: 'Owner', color: '#d4a847', tokenHash: hashToken(token) }]));
    try {
      const { ws, seen } = await new Promise((resolve, reject) => {
        const s = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(token)}`);
        const seen = [];
        s.on('message', (d) => seen.push(JSON.parse(d)));
        s.on('open', () => resolve({ ws: s, seen }));
        s.on('error', reject);
      });
      expect((await waitFor(seen, m => m.type === 'welcome')).authEnabled).toBe(true);
      const got = await refusal(ws, seen, { action: 'setup', folder: '/tmp/never-read' });
      expect(got.message).toMatch(/Only the owner switches the Claude account, and with user accounts on nobody does/);
      ws.close();
    } finally {
      rmSync(usersPath, { force: true });
    }
  });
});

// The Billion tab's text box over the socket (server/ws.js 'chat-send').
describe('the Billion tab over the socket', () => {
  const browser = () => ({ headers: { origin: `http://127.0.0.1:${new URL(wsUrl).port}` } });
  const say = async ({ ws, seen }, text) => {
    const nonce = `n${Math.random()}`;
    ws.send(JSON.stringify({ type: 'chat-send', nonce, text }));
    return waitFor(seen, m => m.type === 'chat-sent' && m.nonce === nonce);
  };

  it('sends the thread on connect, and a browser\'s message is taken for Billion and shown to every window', async () => {
    const billion = spawn({ isBillion: true, name: BILLION_NAME });
    const other = await connect(browser());
    const owner = await connect(browser());
    try {
      expect(await waitFor(owner.seen, m => m.type === 'chat-list')).toBeTruthy();
      expect(await say(owner, 'hello from the tab')).not.toHaveProperty('error');
      expect(await waitFor(other.seen, m => m.type === 'chat-message' && m.message.text === 'hello from the tab')).toMatchObject({ message: { from: 'owner', via: 'app' } });
    } finally {
      owner.ws.close(); other.ws.close();
      await killSession(billion.id);
    }
  });

  it('takes a message\'s files and serves them back from chat-files only, to the owner only', async () => {
    const billion = spawn({ isBillion: true, name: BILLION_NAME });
    const owner = await connect(browser());
    const http = `http://127.0.0.1:${new URL(wsUrl).port}`;
    try {
      const nonce = 'files1';
      owner.ws.send(JSON.stringify({ type: 'chat-send', nonce, text: '', files: [{ name: 'shot.png', type: 'image/png', data: Buffer.from('PNG').toString('base64') }] }));
      expect(await waitFor(owner.seen, m => m.type === 'chat-sent' && m.nonce === nonce)).not.toHaveProperty('error');
      const { message } = await waitFor(owner.seen, m => m.type === 'chat-message' && m.message.files);
      const res = await fetch(`${http}/api/chat/${message.id}/files/shot.png`);
      expect([res.status, await res.text(), res.headers.get('content-security-policy')]).toEqual([200, 'PNG', 'sandbox']);
      for (const path of [`${message.id}/files/other.png`, `${message.id}/files/..%2F..%2Fchat.json`, `..%2F/files/chat.json`]) {
        expect((await fetch(`${http}/api/chat/${path}`)).status).toBe(404);
      }
      // With user accounts on the chat is nobody's, and so are its files.
      const usersPath = process.env.AGENT007_USERS_PATH;
      const token = 'tokFile_' + Math.random().toString(36).slice(2, 10);
      writeFileSync(usersPath, JSON.stringify([{ id: 'u_file', displayName: 'Owner', color: '#d4a847', tokenHash: hashToken(token) }]));
      try {
        expect((await fetch(`${http}/api/chat/${message.id}/files/shot.png`)).status).toBe(401);
        expect((await fetch(`${http}/api/chat/${message.id}/files/shot.png?token=${token}`)).status).toBe(403);
      } finally { rmSync(usersPath, { force: true }); }
    } finally {
      owner.ws.close();
      await killSession(billion.id);
    }
  });

  it('refuses a socket that is not this server\'s page, and never shows it the thread', async () => {
    const plain = await connect();
    const owner = await connect(browser());
    try {
      expect((await say(plain, 'hi')).error).toMatch(/browser only/);
      broadcast({ type: 'chat-message', message: { id: 'x', from: 'billion', text: 'private' } });
      expect(await waitFor(owner.seen, m => m.type === 'chat-message' && m.message.id === 'x')).toBeTruthy();
      await new Promise(r => setTimeout(r, 100));
      expect(plain.seen.filter(m => m.type === 'chat-list' || m.type === 'chat-message')).toEqual([]);
    } finally { plain.ws.close(); owner.ws.close(); }
  });
});
