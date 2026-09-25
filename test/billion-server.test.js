import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { server, sessions, killSession } from '../server.js';
import { createSessionFromConfig } from '../server/pty.js';
import { broadcast } from '../server/ws.js';
import { codenamePool, nextSessionId } from '../server/state.js';
import { BILLION_NAME } from '../server/billion.js';

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

const PORT = 17117;
const wsUrl = `ws://127.0.0.1:${PORT}`;
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
  server.listen(PORT, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  codenamePool.addUsed(BILLION_NAME);   // what startup() does
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
