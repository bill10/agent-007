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
const connect = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(wsUrl);
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
  const refusal = async (ws, seen, msg) => {
    const before = seen.length;
    ws.send(JSON.stringify({ type: 'account', ...msg }));
    return waitFor(seen, (m, i) => i >= before && m.type === 'notification' && m.level === 'error');
  };

  it('tells a new window the state, and every action answers with its error', async () => {
    const { ws, seen } = await connect();
    const state = await waitFor(seen, m => m.type === 'account-state');
    expect(state).toMatchObject({ status: 'not set up' });
    expect(JSON.stringify(state)).not.toMatch(/backupDir/);
    for (const [msg, error] of [
      [{ action: 'bogus' }, /Unknown account action bogus/],
      [{ action: 'setup', folder: 'claude-new' }, /absolute path/],
      [{ action: 'arm' }, /Set the new account's folder up first/],
      [{ action: 'migrate' }, /Set the new account's folder up first/],
      [{ action: 'rollback' }, /No backup to roll back to/],
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
