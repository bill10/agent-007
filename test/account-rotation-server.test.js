// End-to-end local socket + real PTYs; auth is an in-memory fixture and the
// Claude executable is a stub. Never reads or changes a real login.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

const auth = vi.hoisted(() => ({ current: null, activation: null }));
vi.mock('../server/account-migration.js', async original => {
  const actual = await original();
  return {
    ...actual,
    captureLogin: async folder => structuredClone(folder ? { email: 'b@example.com', folder, secret: 'fake-b', fields: { oauthAccount: { accountUuid: 'b', emailAddress: 'b@example.com' } } } : auth.current),
    activateLogin: async snapshot => { auth.activation?.(); auth.current = structuredClone(snapshot); },
  };
});
vi.mock('../server/claude-processes.js', () => ({ assertClaudeProcessesManaged: async () => {} }));
import { server, sessions, startBillion } from '../server.js';
import { createSessionFromConfig } from '../server/pty.js';
import { nextSessionId, CONFIG_DIR } from '../server/state.js';
import { broadcast } from '../server/ws.js';
import { sendText, pendingMessages } from '../server/messages.js';
import { quote } from '../lib/jobs.js';

let root, executable, url;
const wait = async fn => { const end = Date.now() + 12000; while (Date.now() < end) { const result = fn(); if (result) return result; await new Promise(r => setTimeout(r, 25)); } throw Error('Timed out'); };
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rotation-server-'));
  executable = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const script = join(root, 'stub.cjs');
  writeFileSync(script, 'console.log("fixture started " + JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 1000);');
  writeFileSync(executable, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  auth.current = { email: 'a@example.com', folder: '/default', secret: 'fake-a', fields: { oauthAccount: { accountUuid: 'a', emailAddress: 'a@example.com' } } };
  server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  url = `ws://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  for (const s of sessions.values()) { clearInterval(s.stateCheckInterval); clearTimeout(s.scanTimer); try { s.pty.kill(); } catch {} }
  sessions.clear();
  await new Promise(r => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe('rotation through the owner socket', () => {
  it('stops two real PTYs before changing auth and resumes both exact conversations with their job links', async () => {
    const ws = new WebSocket(url, { headers: { origin: url.replace('ws:', 'http:') } }), seen = [];
    ws.on('message', data => seen.push(JSON.parse(data)));
    await new Promise(r => ws.once('open', r));
    const old = [];
    try {
      for (const isBillion of [true, false]) {
        const result = createSessionFromConfig({ sessionId: nextSessionId(), name: isBillion ? 'Billion' : 'Worker', command: `${quote(executable)} --permission-mode auto "initial task"`, cwd: root, isBillion, spawnedBy: isBillion ? 'user' : 'board', jobId: isBillion ? null : 'fixture-job' }, broadcast);
        expect(result.error).toBeUndefined();
        sessions.set(result.session.id, result.session); old.push(result.session);
      }
      await wait(() => old.every(s => s.ringBuffer.getAll().join('').includes('fixture started')));
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-add', folder: '/fixture-b' }));
      const enrolled = await wait(() => seen.find(m => m.type === 'account-state' && m.rotation?.accounts.length === 2));
      const target = enrolled.rotation.accounts.find(a => a.email === 'b@example.com');
      auth.activation = () => expect(old.every(s => s.exited)).toBe(true);
      old[0].messagesHeld = true;
      sendText(old[0], 'fixture pending mail');
      const at = seen.length;
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-switch', id: target.id }));
      await wait(() => seen.slice(at).find(m => m.type === 'account-state' && m.rotation?.active === target.id));
      expect(auth.current.email).toBe('b@example.com');
      expect(pendingMessages(old[0].id)).toBe(1);
      for (const previous of old) {
        const resumed = sessions.get(previous.id);
        expect(resumed).not.toBe(previous);
        expect(resumed.claudeSessionId).toBe(previous.claudeSessionId);
        expect(resumed.jobId).toBe(previous.jobId);
        expect(resumed.cwd).toBe(root);
        await wait(() => resumed.ringBuffer.getAll().join('').includes('fixture started'));
        const output = resumed.ringBuffer.getAll().join('');
        expect(output).toContain('--resume');
        expect(output).toContain(previous.claudeSessionId);
        expect(output).not.toContain('initial task');
      }
      expect(seen.slice(at).filter(m => m.type === 'session-ended')).toHaveLength(0);
      expect(JSON.stringify(seen)).not.toMatch(/fake-a|fake-b/);
    } finally { ws.close(); }
  }, 20000);
  it('retains mail and exact session IDs when restart fails, then retries through Settings', async () => {
    const ws = new WebSocket(url, { headers: { origin: url.replace('ws:', 'http:') } }), seen = [];
    ws.on('message', data => seen.push(JSON.parse(data)));
    await new Promise(r => ws.once('open', r));
    const previous = [...sessions.values()].filter(s => !s.exited);
    const billion = previous.find(s => s.isBillion);
    const queueSize = pendingMessages(billion.id);
    expect(queueSize).toBeGreaterThan(0);
    const state = JSON.parse(readFileSync(join(CONFIG_DIR, 'account-rotation.json'), 'utf8'));
    const target = state.accounts.find(a => a.id !== state.active);
    const hidden = `${executable}.unavailable`;
    try {
      auth.activation = () => { if (existsSync(executable)) renameSync(executable, hidden); };
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-switch', id: target.id }));
      await wait(() => seen.find(m => m.type === 'account-state' && m.rotation?.resumePending));
      for (const old of previous) {
        expect(sessions.get(old.id)).toBe(old);
        expect(old.exited).toBe(true);
        expect(old.rotationResume).toBe(true);
      }
      expect(pendingMessages(billion.id)).toBe(queueSize);
      expect(startBillion().error).toMatch(/Retry the paused Claude conversations/);
      expect(sessions.get(billion.id)).toBe(billion);
      renameSync(hidden, executable);
      auth.activation = null;
      const at = seen.length;
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-resume' }));
      await wait(() => seen.slice(at).find(m => m.type === 'account-state' && m.rotation?.resumePending === false));
      for (const old of previous) {
        const resumed = sessions.get(old.id);
        expect(resumed).not.toBe(old);
        expect(resumed.claudeSessionId).toBe(old.claudeSessionId);
        expect(resumed.rotationResume).toBe(false);
        await wait(() => resumed.ringBuffer.getAll().join('').includes('fixture started'));
      }
      expect(pendingMessages(billion.id)).toBe(queueSize);
    } finally {
      auth.activation = null;
      if (existsSync(hidden)) renameSync(hidden, executable);
      ws.close();
    }
  }, 20000);
  it('blocks new Claude processes after a crash left an unfinished authentication write', () => {
    const path = join(CONFIG_DIR, 'account-rotation.json');
    const original = readFileSync(path, 'utf8');
    const state = JSON.parse(original);
    state.pending = { from: state.active, to: state.accounts[0].id };
    writeFileSync(path, JSON.stringify(state));
    try {
      const result = createSessionFromConfig({ sessionId: nextSessionId(), name: 'Blocked', command: quote(executable), cwd: root, rotationRestart: true }, broadcast);
      expect(result.error).toMatch(/Restore the interrupted Claude login/);
      expect(result.session).toBeUndefined();
    } finally { writeFileSync(path, original); }
  });

});
