// End-to-end local socket + real PTYs; auth is an in-memory fixture and the
// Claude executable is a stub. Never reads or changes a real login.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

const auth = vi.hoisted(() => ({ current: null, activation: null }));
vi.mock('../server/account-migration.js', async original => {
  const actual = await original();
  return {
    ...actual,
    captureLogin: async folder => structuredClone(folder ? { email: 'b@example.com', folder, secret: 'fake-b', fields: { oauthAccount: { accountUuid: 'b', emailAddress: 'b@example.com' } } } : auth.current),
    activateLogin: async snapshot => { await auth.activation?.(); auth.current = structuredClone(snapshot); },
  };
});
// Codex logins are fixtures too, and its background server "runs" for Codex checks only.
const codexAuth = vi.hoisted(() => ({ current: null, events: [], check: null }));
vi.mock('../server/codex-login.js', () => ({
  captureCodexLogin: async folder => structuredClone(folder === '/fixture-cb' ? { accountId: 'cx-b', email: 'cb@example.com', folder, secret: 'fake-cb' }
    : folder ? { accountId: `cx${folder}`, email: `${folder.slice(1)}@example.com`, folder, secret: 'fake-cx' } : codexAuth.current),
  activateCodexLogin: async snapshot => { codexAuth.check?.(); codexAuth.events.push('activate'); codexAuth.current = structuredClone(snapshot); },
  stopCodexDaemon: async () => { codexAuth.check?.(); codexAuth.events.push('daemon-stop'); },
}));
// The account scan is a fixture: no real ~/.codex* or ~/.claude* folder is looked at.
const scan = vi.hoisted(() => ({ agents: [] }));
vi.mock('../server/agent-accounts.js', async original => ({ ...(await original()), refreshAgentAccounts: async () => ({ scannedAt: Date.now(), agents: scan.agents }) }));
// Codex's background server runs until a stop, and is back once a login is written.
vi.mock('../server/claude-processes.js', () => ({ assertClaudeProcessesManaged: async (_sessions, { agent } = {}) => ({ daemon: agent === 'codex' && codexAuth.events.at(-1) !== 'daemon-stop' }) }));
vi.mock('../server/models.js', async original => ({ ...(await original()), modelsReady: async () => true, startModelRefresh: () => {} }));
import { server, sessions, startBillion } from '../server.js';
import { createSessionFromConfig } from '../server/pty.js';
import { nextSessionId, CONFIG_DIR } from '../server/state.js';
import { broadcast } from '../server/ws.js';
import { sendText, pendingMessages } from '../server/messages.js';
import { quote } from '../lib/jobs.js';
import { removeTempDir } from './temp-dir.js';

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
  const all = [...sessions.values()];
  for (const s of all) { clearInterval(s.stateCheckInterval); clearTimeout(s.scanTimer); try { s.pty.kill(); } catch {} }
  // The stubs run with root as their cwd, and Windows will not remove a folder
  // a live process sits in, so wait for every PTY to report its exit.
  await wait(() => all.every(s => s.exited)).catch(() => {});
  sessions.clear();
  await new Promise(r => server.close(r));
  removeTempDir(root);
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
      expect((await startBillion()).error).toMatch(/Retry the paused Claude conversations/);
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

  it('keeps an open Billion inbox, held worker inbox and scheduled wake across rotation', async () => {
    const ws = new WebSocket(url, { headers: { origin: url.replace('ws:', 'http:') } }), seen = [];
    ws.on('message', data => seen.push(JSON.parse(data)));
    await new Promise(r => ws.once('open', r));
    const previous = [...sessions.values()].filter(s => !s.exited);
    const billion = previous.find(s => s.isBillion), worker = previous.find(s => !s.isBillion);
    billion.messagesHeld = false; worker.messagesHeld = true;
    billion.wakeAt = Date.now() + 600_000; billion.lastWakeAt = Date.now() - 60_000;
    const state = JSON.parse(readFileSync(join(CONFIG_DIR, 'account-rotation.json'), 'utf8'));
    const target = state.accounts.find(a => a.id !== state.active);
    try {
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-switch', id: target.id }));
      await wait(() => previous.every(s => sessions.get(s.id) !== s));
      expect(sessions.get(billion.id).messagesHeld).toBe(false);
      expect(sessions.get(worker.id).messagesHeld).toBe(true);
      expect(sessions.get(billion.id).wakeAt).toBe(billion.wakeAt);
      expect(sessions.get(billion.id).lastWakeAt).toBe(billion.lastWakeAt);
      await wait(() => seen.find(m => m.type === 'account-state' && m.rotation?.active === target.id));
    } finally { ws.close(); }
  }, 20000);

  it('honors a stop requested during activation after the replacement session starts', async () => {
    const ws = new WebSocket(url, { headers: { origin: url.replace('ws:', 'http:') } }), seen = [];
    ws.on('message', data => seen.push(JSON.parse(data)));
    await new Promise(r => ws.once('open', r));
    const worker = [...sessions.values()].find(s => !s.exited && !s.isBillion);
    const state = JSON.parse(readFileSync(join(CONFIG_DIR, 'account-rotation.json'), 'utf8'));
    const target = state.accounts.find(a => a.id !== state.active);
    try {
      auth.activation = async () => {
        ws.send(JSON.stringify({ type: 'kill', sessionId: worker.id }));
        // Let the real WebSocket handler receive stop while activation remains pending.
        await new Promise(r => setTimeout(r, 100));
      };
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-switch', id: target.id }));
      await wait(() => seen.find(m => m.type === 'account-state' && m.rotation?.active === target.id));
      await wait(() => !sessions.has(worker.id));
      expect(sessions.has(worker.id)).toBe(false);
    } finally { auth.activation = null; ws.close(); }
  }, 20000);

  // Value: protects=a Codex switch from the owner socket stops only Codex PTYs, stops the background server, swaps, and resumes `codex resume <id>` with Claude untouched;
  //   fails_when=server.js routes msg.cli to Claude's registry, skips or misorders stopCodexDaemon, restarts Claude sessions, or loses the Codex conversation id;
  //   why_new=codex-rotation.test.js tests the pieces in isolation; nothing drives server.js's Codex wiring end to end; seam=none
  it.skipIf(process.platform === 'win32')('switches Codex logins: only Codex restarts, its background server stops first, and it resumes its exact conversation', async () => {
    const ws = new WebSocket(url, { headers: { origin: url.replace('ws:', 'http:') } }), seen = [];
    ws.on('message', data => seen.push(JSON.parse(data)));
    await new Promise(r => ws.once('open', r));
    const savedHome = process.env.CODEX_HOME;
    const codexHome = join(root, 'codex-home'), cwd = join(root, 'cx'), id = '019a0000-0000-7000-8000-00000000c0de';
    mkdirSync(join(codexHome, 'sessions', '2026', '10', '08'), { recursive: true }); mkdirSync(cwd);
    process.env.CODEX_HOME = codexHome;
    const codexExe = join(root, 'codex');
    writeFileSync(codexExe, `#!/bin/sh\nexec "${process.execPath}" "${join(root, 'stub.cjs')}" "$@"\n`, { mode: 0o755 });
    codexAuth.current = { accountId: 'cx-a', email: 'ca@example.com', folder: codexHome, secret: 'fake-ca' };
    const claudeBefore = [...sessions.values()].filter(s => !s.exited);
    const claudeAccounts = JSON.parse(readFileSync(join(CONFIG_DIR, 'account-rotation.json'), 'utf8')).accounts.length;
    try {
      const made = createSessionFromConfig({ sessionId: nextSessionId(), name: 'CodexWorker', command: `${quote(codexExe)} -m gpt-5.5 "initial task"`, cwd, spawnedBy: 'board', jobId: 'codex-job' }, broadcast);
      expect(made.error).toBeUndefined();
      const old = made.session; sessions.set(old.id, old);
      expect(old.agent).toBe('codex');
      await wait(() => old.ringBuffer.getAll().join('').includes('fixture started'));
      // Codex records its conversation once running: a rollout older than the session would not count.
      writeFileSync(join(codexHome, 'sessions', '2026', '10', '08', `rollout-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } })}\n`);
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-add', cli: 'codex', folder: '/fixture-cb' }));
      const enrolled = await wait(() => seen.find(m => m.type === 'account-state' && m.codexRotation?.accounts.length === 2));
      expect(enrolled.rotation.accounts).toHaveLength(claudeAccounts);
      const target = enrolled.codexRotation.accounts.find(a => a.email === 'cb@example.com');
      codexAuth.check = () => expect(old.exited).toBe(true);
      const at = seen.length;
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-switch', cli: 'codex', id: target.id }));
      await wait(() => seen.slice(at).find(m => m.type === 'account-state' && m.codexRotation?.active === target.id));
      expect(codexAuth.events).toEqual(['daemon-stop', 'activate']);
      expect(codexAuth.current.email).toBe('cb@example.com');
      for (const s of claudeBefore) expect(sessions.get(s.id)).toBe(s);
      const resumed = sessions.get(old.id);
      expect(resumed).not.toBe(old);
      expect(resumed.jobId).toBe('codex-job');
      await wait(() => resumed.ringBuffer.getAll().join('').includes('fixture started'));
      const output = resumed.ringBuffer.getAll().join('');
      expect(output).toContain(`"resume","${id}"`);
      expect(output).not.toContain('initial task');
      expect(JSON.stringify(seen)).not.toMatch(/fake-c[ab]/);
    } finally {
      codexAuth.check = null;
      if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
      ws.close();
    }
  }, 20000);

  // Value: protects=two app Codex sessions in one folder cannot be told apart, so the Codex switch refuses before stopping either or touching auth.json;
  //   fails_when=codexIdFor stops checking for a second live Codex session in the same folder and resumes both on the newest rollout;
  //   why_new=the Codex socket test above has one Codex session; codex-rotation.test.js passes idFor null directly; seam=none
  it.skipIf(process.platform === 'win32')('refuses a Codex switch before stopping anything when two app Codex sessions share a folder', async () => {
    const ws = new WebSocket(url, { headers: { origin: url.replace('ws:', 'http:') } }), seen = [];
    ws.on('message', data => seen.push(JSON.parse(data)));
    await new Promise(r => ws.once('open', r));
    const savedHome = process.env.CODEX_HOME;
    // The previous test's Codex home still holds a rollout for this folder, so only the sharing check refuses.
    process.env.CODEX_HOME = join(root, 'codex-home');
    const first = [...sessions.values()].find(s => s.agent === 'codex' && !s.exited);
    const events = codexAuth.events.length, email = codexAuth.current.email;
    try {
      const made = createSessionFromConfig({ sessionId: nextSessionId(), name: 'CodexTwin', command: `${quote(join(root, 'codex'))} "other task"`, cwd: first.cwd, spawnedBy: 'board' }, broadcast);
      expect(made.error).toBeUndefined();
      const twin = made.session; sessions.set(twin.id, twin);
      await wait(() => twin.ringBuffer.getAll().join('').includes('fixture started'));
      const state = JSON.parse(readFileSync(join(CONFIG_DIR, 'codex-account-rotation.json'), 'utf8'));
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-switch', cli: 'codex', id: state.accounts.find(a => a.id !== state.active).id }));
      const refused = await wait(() => seen.find(m => m.type === 'account-error'));
      expect(refused.message).toMatch(/exact Codex conversation/);
      for (const s of [first, twin]) { expect(sessions.get(s.id)).toBe(s); expect(s.exited).toBeFalsy(); expect(s.accountRotating).toBeFalsy(); }
      expect(codexAuth.events).toHaveLength(events);
      expect(codexAuth.current.email).toBe(email);
    } finally {
      if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
      ws.close();
    }
  }, 20000);

  // Value: protects=Find logged-in accounts with cli codex enrolls the scan's logged-in Codex homes into the Codex registry only, never logged-out ones or Claude's;
  //   fails_when=discoverRotationAccounts ignores cli, reads Claude's scan entry, or drops the loggedIn filter;
  //   why_new=no test drove rotation-discover through server.js for either CLI; seam=none
  it('discovers only logged-in Codex homes into the Codex registry', async () => {
    const ws = new WebSocket(url, { headers: { origin: url.replace('ws:', 'http:') } }), seen = [];
    ws.on('message', data => seen.push(JSON.parse(data)));
    await new Promise(r => ws.once('open', r));
    scan.agents = [
      { cli: 'claude', accounts: [{ folder: '/fixture-claude-in', loggedIn: true }] },
      { cli: 'codex', accounts: [{ folder: '/fixture-cx-in', loggedIn: true }, { folder: '/fixture-cx-out', loggedIn: false }] },
    ];
    const claudeAccounts = JSON.parse(readFileSync(join(CONFIG_DIR, 'account-rotation.json'), 'utf8')).accounts.length;
    // Its own default login: it runs on Windows too, where the Codex switch test above is skipped.
    codexAuth.current ||= { accountId: 'cx-a', email: 'ca@example.com', folder: '/fixture-default', secret: 'fake-ca' };
    try {
      ws.send(JSON.stringify({ type: 'account', action: 'rotation-discover', cli: 'codex' }));
      const found = await wait(() => seen.find(m => m.type === 'account-state' && m.codexRotation?.accounts.some(a => a.folder === '/fixture-cx-in')));
      expect(found.codexRotation.accounts.map(a => a.folder)).not.toContain('/fixture-cx-out');
      expect(found.rotation.accounts).toHaveLength(claudeAccounts);
      expect(seen.filter(m => m.type === 'account-error')).toHaveLength(0);
    } finally { scan.agents = []; ws.close(); }
  }, 20000);

});
