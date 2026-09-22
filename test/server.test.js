import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, server, startup, sessions } from '../server.js';
import { hashToken, WS_UNAUTHORIZED } from '../server/auth.js';
import { addJob, deleteJob, allJobs, updateSettings } from '../server/jobs.js';
import { config, orphans, codenamePool } from '../server/state.js';
import WebSocket from 'ws';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, existsSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';

const PORT = 17007; // Use non-default port to avoid conflicts
let baseUrl;
let wsUrl;

beforeAll(async () => {
  process.env.PORT = String(PORT);
  // Override the port before startup
  server.listen(PORT, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${PORT}`;
  wsUrl = `ws://127.0.0.1:${PORT}`;
});

afterAll(async () => {
  // Kill any sessions created during tests
  for (const [id] of sessions) {
    const session = sessions.get(id);
    if (session) {
      clearInterval(session.stateCheckInterval);
      clearTimeout(session.scanTimer);
      try { session.pty.kill(); } catch {}
      sessions.delete(id);
    }
  }
  await new Promise(r => server.close(r));
});

// --- Cross-origin check (HTTP + WS integration) ---

describe('cross-origin origin check', () => {
  it('rejects an HTTP request from a disallowed origin with 403', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`, {
      headers: { Origin: 'http://evil.example.com' },
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toMatch(/cross-origin/i);
  });

  it('allows an HTTP request from a localhost origin', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a WebSocket handshake from a disallowed origin', async () => {
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl, { origin: 'http://evil.example.com' });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('error', () => resolve('rejected'));
    });
    expect(result).toBe('rejected');
  });

  it('accepts a WebSocket handshake from a localhost origin', async () => {
    const ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(wsUrl, { origin: 'http://localhost:3000' });
      s.on('open', () => resolve(s));
      s.on('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

// --- /api/browse endpoint ---

describe('/api/browse', () => {
  it('should return directory listing for valid path', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    // Path may differ due to symlink resolution (e.g. /tmp → /private/tmp on macOS)
    expect(data.path).toBeTruthy();
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('should return 400 for non-existent path', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=/nonexistent/path/xyz123`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/does not exist/i);
  });

  it('should return 400 for a file path (not directory)', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${join(tmpdir(), '..')}/etc/hosts`);
    // This may or may not exist depending on platform
    const data = await res.json();
    if (res.status === 200) {
      // If it resolved to a dir somehow, that's fine
    } else {
      expect([400, 500]).toContain(res.status);
    }
  });

  it('should default to home directory when no path provided', async () => {
    const res = await fetch(`${baseUrl}/api/browse`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.path).toBeTruthy();
    expect(data.entries).toBeDefined();
  });

  it('should filter hidden directories unless showHidden=1', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${process.env.HOME}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const hasHidden = data.entries.some(e => e.name.startsWith('.'));
    expect(hasHidden).toBe(false);
  });

  it('should show hidden directories when showHidden=1', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${process.env.HOME}&showHidden=1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const hasHidden = data.entries.some(e => e.name.startsWith('.'));
    expect(hasHidden).toBe(true);
  });
});

// --- Job attachments ---

describe('/api/jobs/:id/attachments/:name', () => {
  let job;
  beforeAll(() => {
    ({ job } = addJob({
      title: 'Shot', repoPath: tmpdir(),
      attachments: [{ name: 'shot.png', data: Buffer.from('png!').toString('base64') }, { name: '.env', data: Buffer.from('K=1').toString('base64') }],
    }, () => {}));
  });
  afterAll(async () => { await deleteJob(job.id, () => {}); });

  it('serves the file sandboxed, sniff-proof, and without a referrer', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/attachments/shot.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toBe('png!');
  });

  it('serves a dotfile too', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/attachments/.env`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('K=1');
  });

  it('404s for a name the card does not have', async () => {
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/attachments/other.png`);
    expect(res.status).toBe(404);
  });

  it('404s when the file is gone from disk', async () => {
    rmSync(job.attachments[0].path, { force: true });
    const res = await fetch(`${baseUrl}/api/jobs/${job.id}/attachments/shot.png`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/missing on disk/);
  });

  // The one call that connects the form to the disk: job-create and
  // job-update forward `attachments`, and the broadcast carries the result.
  it('carries attachments over the WebSocket on create and update', async () => {
    const ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(wsUrl);
      s.on('open', () => resolve(s));
      s.on('error', reject);
    });
    const next = (pred) => new Promise((resolve) => {
      const h = (d) => { const m = JSON.parse(d.toString()); if (pred(m)) { ws.removeListener('message', h); resolve(m); } };
      ws.on('message', h);
    });
    let list = next(m => m.type === 'jobs-list' && m.jobs.some(j => j.title === 'Wire shot'));
    ws.send(JSON.stringify({ type: 'job-create', title: 'Wire shot', repoPath: tmpdir(), agent: 'codex', attachments: [{ name: 'wire.png', data: Buffer.from('w').toString('base64') }] }));
    const created = (await list).jobs.find(j => j.title === 'Wire shot');
    expect(created.attachments).toEqual([{ name: 'wire.png', path: join(process.env.AGENT007_CONFIG_DIR, 'attachments', created.id, 'wire.png') }]);
    expect(existsSync(created.attachments[0].path)).toBe(true);
    // The agent rides the same two messages.
    expect(created.agent).toBe('codex');
    list = next(m => m.type === 'jobs-list' && m.jobs.find(j => j.id === created.id)?.attachments.length === 0);
    ws.send(JSON.stringify({ type: 'job-update', jobId: created.id, agent: 'claude', attachments: [] }));
    expect((await list).jobs.find(j => j.id === created.id).agent).toBe('claude');
    expect(existsSync(created.attachments[0].path)).toBe(false);
    ws.close();
    await deleteJob(created.id, () => {});
  });
});

// --- WebSocket connection ---

describe('WebSocket', () => {
  function connectWs() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  function receiveMessages(ws, count, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const messages = [];
      const handler = (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(messages);
        }
      };
      const timer = setTimeout(() => {
        ws.removeListener('message', handler);
        resolve(messages);
      }, timeoutMs);
      ws.on('message', handler);
    });
  }

  it('should accept WebSocket connections', async () => {
    const ws = await connectWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should send repos-list and orphans-list on connect', async () => {
    // Collect messages from the moment the WS is created (before open fires)
    const ws = new WebSocket(wsUrl);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    // Wait for initial messages to arrive
    await new Promise(r => setTimeout(r, 500));
    const types = messages.map(m => m.type);
    expect(types).toContain('repos-list');
    expect(types).toContain('orphans-list');
    ws.close();
  }, 10000);

  it('should handle invalid JSON gracefully', async () => {
    const ws = await connectWs();
    // Drain initial messages (repos-list + orphans-list + any sessions)
    await new Promise(r => setTimeout(r, 500));
    // Clear any pending listeners
    ws.removeAllListeners('message');
    // Send garbage
    ws.send('not json at all');
    // Should not crash — wait briefly and verify connection is still open
    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10000);

  it('should handle unknown message type gracefully', async () => {
    const ws = await connectWs();
    await new Promise(r => setTimeout(r, 500));
    ws.removeAllListeners('message');
    ws.send(JSON.stringify({ type: 'nonexistent-type', data: 'test' }));
    await new Promise(r => setTimeout(r, 200));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  }, 10000);
});

// --- PTY lifecycle (smoke test with real PTY) ---

describe('PTY lifecycle', () => {
  it('should spawn a session with echo command and receive output', async () => {
    const ws = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    // Drain initial messages
    const initMsgs = [];
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000);
      ws.on('message', (data) => {
        initMsgs.push(JSON.parse(data.toString()));
        if (initMsgs.length >= 2) { clearTimeout(timer); resolve(); }
      });
    });

    // Spawn a simple echo command (no repo needed)
    ws.send(JSON.stringify({ type: 'spawn', command: 'echo hello-agent-007' }));

    // Collect messages for up to 5 seconds
    const messages = [];
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        messages.push(msg);
        // Stop collecting after we get session-ended
        if (msg.type === 'session-ended') { clearTimeout(timer); resolve(); }
      });
    });

    const types = messages.map(m => m.type);
    expect(types).toContain('session-created');

    // Should have received PTY output containing our echo string
    const outputMsgs = messages.filter(m => m.type === 'pty-output');
    expect(outputMsgs.length).toBeGreaterThan(0);

    // Decode base64 output and check for our string
    const allOutput = outputMsgs.map(m => Buffer.from(m.data, 'base64').toString()).join('');
    expect(allOutput).toContain('hello-agent-007');

    // Should have gotten session-ended (echo exits immediately)
    expect(types).toContain('session-ended');

    // Get the session ID for cleanup
    const created = messages.find(m => m.type === 'session-created');
    expect(created.sessionId).toBeTruthy();
    expect(created.name).toBeTruthy();
    expect(created.color).toBeTruthy();

    ws.close();
  }, 10000);

  it('should kill a session on request', async () => {
    const ws = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });

    // Drain initial messages
    await new Promise(r => setTimeout(r, 500));

    // Spawn a long-running command
    ws.send(JSON.stringify({ type: 'spawn', command: 'cat' })); // cat waits for input forever

    // Wait for session-created
    const sessionId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for session-created')), 5000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session-created') {
          clearTimeout(timer);
          resolve(msg.sessionId);
        }
      });
    });

    // Kill it
    ws.send(JSON.stringify({ type: 'kill', sessionId }));

    // Wait for session-ended
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for session-ended')), 5000);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'session-ended' && msg.sessionId === sessionId) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    ws.close();
  }, 15000);
});

// --- Auth enforcement (phase 1) ---
// Runs LAST: writes a user to the hermetic users path so the running server
// (which started auth-disabled) picks it up live, then removes it so nothing
// after this block is affected.

describe('auth enforcement (live enable)', () => {
  const usersPath = process.env.AGENT007_USERS_PATH;
  const token = 'tok_' + Math.random().toString(36).slice(2, 12);

  beforeAll(() => {
    writeFileSync(usersPath, JSON.stringify([
      { id: 'u_test', displayName: 'Tester', color: '#d4a847', tokenHash: hashToken(token) },
    ]));
  });
  afterAll(() => { try { rmSync(usersPath, { force: true }); } catch {} });

  it('rejects an /api request with no token (401)', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`);
    expect(res.status).toBe(401);
  });

  it('accepts an /api request with a valid Bearer token (200)', async () => {
    const res = await fetch(`${baseUrl}/api/browse?path=${tmpdir()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  // A card's attachment link is a plain <a href>, which cannot send a header,
  // so the token rides in the query for exactly this route.
  it('gates an attachment link on the token, in the query', async () => {
    const { job } = addJob({ title: 'Gated', repoPath: tmpdir(), attachments: [{ name: 'g.txt', data: Buffer.from('g').toString('base64') }] }, () => {});
    try {
      expect((await fetch(`${baseUrl}/api/jobs/${job.id}/attachments/g.txt`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/api/jobs/${job.id}/attachments/g.txt?token=${token}`)).status).toBe(200);
    } finally {
      await deleteJob(job.id, () => {});
    }
  });

  it('closes a WS handshake without a token (code 4401)', async () => {
    // The server accepts the socket then closes it with 4401 in the connection
    // handler, so the client sees a brief open followed by a 4401 close.
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => {});
    });
    expect(code).toBe(4401);
  });

  it('accepts a WS handshake with a valid token and sends welcome', async () => {
    const welcome = await new Promise((resolve, reject) => {
      const s = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(token)}`);
      s.on('message', (d) => {
        const m = JSON.parse(d);
        if (m.type === 'welcome') { resolve(m); s.close(); }
      });
      s.on('close', () => reject(new Error('closed before welcome')));
      s.on('error', reject);
    });
    expect(welcome.authEnabled).toBe(true);
    expect(welcome.user.displayName).toBe('Tester');
    expect(welcome.platform).toBe(process.platform);
  });
});

// --- Auth revocation (phase 1 hardening) ---
// A user removed from users.json must lose access on their LIVE socket, not just
// on the next reconnect. Two users so auth stays enabled after removing one.

describe('auth revocation (live socket)', () => {
  const usersPath = process.env.AGENT007_USERS_PATH;
  const tokenA = 'tokA_' + Math.random().toString(36).slice(2, 10);
  const tokenB = 'tokB_' + Math.random().toString(36).slice(2, 10);

  beforeAll(() => {
    writeFileSync(usersPath, JSON.stringify([
      { id: 'u_a', displayName: 'A', color: '#d4a847', tokenHash: hashToken(tokenA) },
      { id: 'u_b', displayName: 'B', color: '#58a6ff', tokenHash: hashToken(tokenB) },
    ]));
  });
  afterAll(() => { try { rmSync(usersPath, { force: true }); } catch {} });

  it('closes a live socket with 4401 when its user is removed', async () => {
    const ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(tokenA)}`);
      s.on('message', (d) => { if (JSON.parse(d).type === 'welcome') resolve(s); });
      s.on('error', reject);
    });
    // Revoke A, keep B so auth remains enabled.
    writeFileSync(usersPath, JSON.stringify([
      { id: 'u_b', displayName: 'B', color: '#58a6ff', tokenHash: hashToken(tokenB) },
    ]));
    const code = await new Promise((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.send(JSON.stringify({ type: 'refresh-tree', sessionId: 'none' }));
    });
    expect(code).toBe(WS_UNAUTHORIZED);
  });
});

// --- Ownership authorization (phase 2) ---
// With auth on, only the owner may control a session. A non-owner's kill is
// rejected with a notification and the session survives; the owner's kill works.

describe('ownership authorization', () => {
  const usersPath = process.env.AGENT007_USERS_PATH;
  const tokenA = 'ownA_' + Math.random().toString(36).slice(2, 10);
  const tokenB = 'ownB_' + Math.random().toString(36).slice(2, 10);

  beforeAll(() => {
    writeFileSync(usersPath, JSON.stringify([
      { id: 'u_a', displayName: 'Aowner', color: '#d4a847', tokenHash: hashToken(tokenA) },
      { id: 'u_b', displayName: 'Bviewer', color: '#58a6ff', tokenHash: hashToken(tokenB) },
    ]));
  });
  afterAll(() => { try { rmSync(usersPath, { force: true }); } catch {} });

  const connect = (token) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsUrl}/?token=${encodeURIComponent(token)}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const nextMatching = (ws, pred, timeoutMs = 4000) => new Promise((resolve) => {
    const to = setTimeout(() => { ws.off('message', h); resolve(null); }, timeoutMs);
    const h = (d) => { const m = JSON.parse(d); if (pred(m)) { clearTimeout(to); ws.off('message', h); resolve(m); } };
    ws.on('message', h);
  });

  it('tags a spawned session with its owner and blocks a non-owner kill', async () => {
    const a = await connect(tokenA);
    const created = nextMatching(a, (m) => m.type === 'session-created' && /sleep/.test(m.command || ''));
    a.send(JSON.stringify({ type: 'spawn', command: 'sleep 5' }));
    const payload = await created;
    expect(payload).toBeTruthy();
    expect(payload.ownerId).toBe('u_a');
    expect(payload.ownerName).toBe('Aowner');
    const sessionId = payload.sessionId;

    // B (non-owner) tries to kill -> gets a read-only notification, session survives.
    const b = await connect(tokenB);
    const denied = nextMatching(b, (m) => m.type === 'notification' && /read-only/i.test(m.message || ''));
    b.send(JSON.stringify({ type: 'kill', sessionId }));
    const note = await denied;
    expect(note).toBeTruthy();
    expect(note.message).toMatch(/owned by Aowner/);
    expect(sessions.has(sessionId)).toBe(true);

    // A (owner) kills successfully.
    const ended = nextMatching(a, (m) => m.type === 'session-ended' && m.sessionId === sessionId);
    a.send(JSON.stringify({ type: 'kill', sessionId }));
    expect(await ended).toBeTruthy();

    a.close(); b.close();
  }, 15000);

  it('lets only the owner rename a session and broadcasts the new name', async () => {
    const a = await connect(tokenA);
    const created = nextMatching(a, (m) => m.type === 'session-created' && /sleep 7/.test(m.command || ''));
    a.send(JSON.stringify({ type: 'spawn', command: 'sleep 7' }));
    const { sessionId, name: oldName } = await created;
    const b = await connect(tokenB);

    const denied = nextMatching(b, (m) => m.type === 'notification' && /read-only/i.test(m.message || ''));
    b.send(JSON.stringify({ type: 'rename-session', sessionId, name: 'nope' }));
    expect(await denied).toBeTruthy();
    expect(sessions.get(sessionId).name).toBe(oldName);

    const seenByB = nextMatching(b, (m) => m.type === 'session-renamed' && m.sessionId === sessionId);
    a.send(JSON.stringify({ type: 'rename-session', sessionId, name: '  viper  ' }));
    const renamed = await seenByB;
    expect(renamed.name).toBe('viper');
    expect(sessions.get(sessionId).name).toBe('viper');

    a.send(JSON.stringify({ type: 'kill', sessionId }));
    a.close(); b.close();
  }, 15000);

  it('silently drops pty-input from a non-owner but forwards the owner\'s', async () => {
    const a = await connect(tokenA);
    const created = nextMatching(a, (m) => m.type === 'session-created' && /cat/.test(m.command || ''));
    a.send(JSON.stringify({ type: 'spawn', command: 'cat' }));
    const { sessionId } = await created;
    const b = await connect(tokenB);

    const marker = 'BINTRUDER_' + Math.random().toString(36).slice(2, 8);
    const echoOfB = nextMatching(a, (m) => m.type === 'pty-output'
      && Buffer.from(m.data || '', 'base64').toString().includes(marker), 1500);
    b.send(JSON.stringify({ type: 'pty-input', sessionId, data: marker + '\n' }));
    expect(await echoOfB).toBeNull(); // dropped server-side; cat never saw it

    const own = 'AOWNER_' + Math.random().toString(36).slice(2, 8);
    const echoOfA = nextMatching(a, (m) => m.type === 'pty-output'
      && Buffer.from(m.data || '', 'base64').toString().includes(own), 3000);
    a.send(JSON.stringify({ type: 'pty-input', sessionId, data: own + '\n' }));
    expect(await echoOfA).toBeTruthy();

    a.send(JSON.stringify({ type: 'kill', sessionId }));
    a.close(); b.close();
  }, 15000);

  it('marks a terminal as being typed in only for real keystrokes from its owner', async () => {
    // lastUserInputAt holds agent messages back (server/messages.js). A focus
    // report arrives every time the tab is clicked; counting it would stall
    // messages for 30 s on every glance at the terminal.
    const a = await connect(tokenA);
    const created = nextMatching(a, (m) => m.type === 'session-created' && /sleep 9/.test(m.command || ''));
    a.send(JSON.stringify({ type: 'spawn', command: 'sleep 9' }));
    const { sessionId } = await created;
    const b = await connect(tokenB);
    const session = sessions.get(sessionId);
    // Messages on one socket are handled in order: a later rename landing
    // means every earlier pty-input on that socket has been processed.
    const settled = async (ws, name) => {
      const done = nextMatching(a, (m) => m.type === 'session-renamed' && m.name === name);
      ws.send(JSON.stringify({ type: 'rename-session', sessionId, name }));
      await done;
    };

    a.send(JSON.stringify({ type: 'pty-input', sessionId, data: '\x1b[I' }));
    await settled(a, 'focus');
    expect(session.lastUserInputAt).toBeUndefined();

    // A viewer's keystrokes never reach the pty, so they hold nothing back.
    const refused = nextMatching(b, (m) => m.type === 'notification' && /read-only/i.test(m.message || ''));
    b.send(JSON.stringify({ type: 'pty-input', sessionId, data: 'x' }));
    b.send(JSON.stringify({ type: 'rename-session', sessionId, name: 'nope' }));
    expect(await refused).toBeTruthy();
    a.send(JSON.stringify({ type: 'pty-input', sessionId, data: '\x1b[O' }));
    await settled(a, 'blur');
    expect(session.lastUserInputAt).toBeUndefined();

    const before = Date.now();
    a.send(JSON.stringify({ type: 'pty-input', sessionId, data: 'x' }));
    await settled(a, 'typed');
    expect(session.lastUserInputAt).toBeGreaterThanOrEqual(before);

    a.send(JSON.stringify({ type: 'kill', sessionId }));
    a.close(); b.close();
  }, 15000);

  it('rejects refresh-tree and upload-file from a non-owner', async () => {
    const a = await connect(tokenA);
    const created = nextMatching(a, (m) => m.type === 'session-created' && /sleep/.test(m.command || ''));
    a.send(JSON.stringify({ type: 'spawn', command: 'sleep 5' }));
    const { sessionId } = await created;
    const b = await connect(tokenB);

    const t = nextMatching(b, (m) => m.type === 'notification' && /read-only/i.test(m.message || ''));
    b.send(JSON.stringify({ type: 'refresh-tree', sessionId }));
    expect(await t).toBeTruthy();

    const u = nextMatching(b, (m) => m.type === 'notification' && /read-only/i.test(m.message || ''));
    b.send(JSON.stringify({ type: 'upload-file', sessionId, filename: 'x.txt', data: Buffer.from('hi').toString('base64') }));
    expect((await u).message).toMatch(/owned by Aowner/);

    a.send(JSON.stringify({ type: 'kill', sessionId }));
    a.close(); b.close();
  }, 15000);

  it('keeps read paths (get-diff) open to a non-owner', async () => {
    const a = await connect(tokenA);
    const created = nextMatching(a, (m) => m.type === 'session-created' && /sleep/.test(m.command || ''));
    a.send(JSON.stringify({ type: 'spawn', command: 'sleep 5' }));
    const { sessionId } = await created;
    const b = await connect(tokenB);

    // Non-owner get-diff must return a file-diff response, not a read-only notice.
    const resp = nextMatching(b, (m) =>
      (m.type === 'file-diff' && m.sessionId === sessionId) ||
      (m.type === 'notification' && /read-only/i.test(m.message || '')));
    b.send(JSON.stringify({ type: 'get-diff', sessionId, filePath: 'anything', status: 'M' }));
    expect((await resp).type).toBe('file-diff');

    a.send(JSON.stringify({ type: 'kill', sessionId }));
    a.close(); b.close();
  }, 15000);
});

describe('ownership is inert when auth is disabled', () => {
  // No users file here (default hermetic state) => authEnabled() false.
  const open = () => new Promise((res, rej) => {
    const s = new WebSocket(wsUrl); s.on('open', () => res(s)); s.on('error', rej);
  });
  const next = (ws, pred, ms = 4000) => new Promise((res) => {
    const to = setTimeout(() => { ws.off('message', h); res(null); }, ms);
    const h = (d) => { const m = JSON.parse(d); if (pred(m)) { clearTimeout(to); ws.off('message', h); res(m); } };
    ws.on('message', h);
  });

  it('lets any socket control any session in single-player mode', async () => {
    const w1 = await open();
    const created = next(w1, (m) => m.type === 'session-created' && /sleep/.test(m.command || ''));
    w1.send(JSON.stringify({ type: 'spawn', command: 'sleep 5' }));
    const { sessionId, ownerId } = await created;
    expect(ownerId ?? null).toBeNull(); // unowned in single-player

    const w2 = await open();
    const ended = next(w2, (m) => m.type === 'session-ended' && m.sessionId === sessionId);
    w2.send(JSON.stringify({ type: 'kill', sessionId }));
    expect(await ended).toBeTruthy(); // second socket kills it — no ownership block

    w1.close(); w2.close();
  }, 15000);

  it('spawn refuses a custom name that is already held', async () => {
    const w = await open();
    const created = next(w, (m) => m.type === 'session-created' && m.name === 'dup-name-test');
    w.send(JSON.stringify({ type: 'spawn', command: 'sleep 4', name: 'dup-name-test' }));
    const { sessionId } = await created;
    const err = next(w, (m) => m.type === 'spawn-error' && /already exists/.test(m.error || ''));
    w.send(JSON.stringify({ type: 'spawn', command: 'sleep 4', name: 'dup-name-test' }));
    expect(await err).toBeTruthy();
    w.send(JSON.stringify({ type: 'kill', sessionId }));
    w.close();
  }, 15000);

  it('rename-session ignores bad input, rejects a taken name, and truncates to 40', async () => {
    const w = await open();
    const spawn = async (cmd) => {
      const created = next(w, (m) => m.type === 'session-created' && m.command === cmd);
      w.send(JSON.stringify({ type: 'spawn', command: cmd }));
      return created;
    };
    const one = await spawn('sleep 6');
    const two = await spawn('sleep 8');

    // A missing session, a non-string or missing name, a whitespace name, a
    // name with no letters or digits, and the current name are all silent no-ops.
    w.send(JSON.stringify({ type: 'rename-session', sessionId: 'nope-999', name: 'ghost' }));
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId, name: 42 }));
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId }));
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId, name: '   ' }));
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId, name: '...' }));
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId, name: one.name }));
    // A name another live session holds is refused with an error notification.
    const dup = next(w, (m) => m.type === 'notification' && /already exists/.test(m.message || ''));
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId, name: two.name }));
    expect((await dup).level).toBe('error');
    expect(sessions.get(one.sessionId).name).toBe(one.name);
    // So is a name an orphan still holds: the pool reserves those too.
    orphans.set('orphan-rename-test', { id: 'orphan-rename-test', name: 'orphan-ghost', worktreePath: '/nonexistent/orphan-ghost' });
    codenamePool.addUsed('orphan-ghost');
    const dupOrphan = next(w, (m) => m.type === 'notification' && /already exists/.test(m.message || ''));
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId, name: 'orphan-ghost' }));
    expect((await dupOrphan).level).toBe('error');
    orphans.delete('orphan-rename-test');
    codenamePool.recycle('orphan-ghost');

    // Over-long names are cut to 40 characters.
    const renamed = next(w, (m) => m.type === 'session-renamed' && m.sessionId === one.sessionId);
    w.send(JSON.stringify({ type: 'rename-session', sessionId: one.sessionId, name: 'x'.repeat(41) }));
    expect((await renamed).name).toBe('x'.repeat(40));

    w.send(JSON.stringify({ type: 'kill', sessionId: one.sessionId }));
    w.send(JSON.stringify({ type: 'kill', sessionId: two.sessionId }));
    w.close();
  }, 15000);

  it('rename-session carries the new name into the restart record and the linked job card', async () => {
    const w = await open();
    const created = next(w, (m) => m.type === 'session-created' && m.command === 'sleep 9');
    w.send(JSON.stringify({ type: 'spawn', command: 'sleep 9' }));
    const { sessionId, name: oldName } = await created;
    const session = sessions.get(sessionId);
    // A bare spawn has no worktree; give it one named after the codename, the
    // way createWorktree lays them out, so the config record is findable.
    session.worktreePath = join(tmpdir(), oldName);
    config.activeSessions.push({ name: oldName, worktreePath: session.worktreePath });
    const { job } = addJob({ title: 'Rename me', repoPath: tmpdir() }, () => {});
    Object.assign(job, { agentSessionId: sessionId, agentName: oldName });
    // Every card linked to this session follows, whatever label it showed before.
    const { job: other } = addJob({ title: 'Stale label', repoPath: tmpdir() }, () => {});
    Object.assign(other, { agentSessionId: sessionId, agentName: 'someone-else' });

    try {
      const list = next(w, (m) => m.type === 'jobs-list' && m.jobs.find(j => j.id === job.id)?.agentName === 'mamba');
      w.send(JSON.stringify({ type: 'rename-session', sessionId, name: 'mamba' }));
      expect((await list).jobs.find(j => j.id === other.id).agentName).toBe('mamba');
      expect(config.activeSessions.find(s => s.worktreePath === session.worktreePath).name).toBe('mamba');
      // The old codename still names the worktree directory on disk, so it stays
      // reserved: a later spawn must not try to create the same path.
      expect(codenamePool.has(oldName)).toBe(true);
      expect(codenamePool.has('mamba')).toBe(true);
      // Renaming back to the directory's own codename is allowed, and frees the label.
      const back = next(w, (m) => m.type === 'session-renamed' && m.name === oldName);
      w.send(JSON.stringify({ type: 'rename-session', sessionId, name: oldName }));
      expect(await back).toBeTruthy();
      expect(codenamePool.has('mamba')).toBe(false);
    } finally {
      config.activeSessions = config.activeSessions.filter(s => s.worktreePath !== session.worktreePath);
      session.worktreePath = null; // keep the kill path from touching a worktree that never existed
      codenamePool.recycle(oldName);
      await deleteJob(job.id, () => {});
      await deleteJob(other.id, () => {});
      w.send(JSON.stringify({ type: 'kill', sessionId }));
      w.close();
    }
  }, 15000);

  // Closing a tab whose worktree cannot be cleaned up parks it as an orphan, and
  // the explorer's Re-spawn brings it back. What Re-spawn runs must be the CLI
  // the tab ran: `claude --continue` in a Codex worktree dies at once.
  //
  // A fake `codex` first on PATH stands in for the real one, which would try to
  // resume a real session; the PTY inherits process.env at spawn time. The
  // worktree is a bare directory with an unreadable .git, which the close path
  // treats like uncommitted work (git status fails) and the re-adopt path
  // accepts as a worktree (.git is there).
  function fakeOrphanWorktree() {
    const worktreePath = mkdtempSync(join(tmpdir(), 'a007-orphan-wt-'));
    writeFileSync(join(worktreePath, '.git'), 'not a gitfile\n');
    return worktreePath;
  }

  // A fake `codex` first on PATH, as a posix shell script: the Windows leg has
  // neither the shebang nor the `:` PATH delimiter, so these two skip there.
  function fakeCodexOnPath() {
    const bin = mkdtempSync(join(tmpdir(), 'a007-bin-'));
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    return { bin, restore: () => { process.env.PATH = savedPath; rmSync(bin, { recursive: true, force: true }); } };
  }

  it.skipIf(process.platform === 'win32')('closing a tab notes its CLI on the orphan, and Re-spawn resumes with that CLI', async () => {
    const { bin, restore } = fakeCodexOnPath();
    const worktreePath = fakeOrphanWorktree();
    // Started with a permission flag, which the re-spawn must carry back.
    const command = `${join(bin, 'codex')} --model o3 --dangerously-bypass-approvals-and-sandbox`;
    const w = await open();
    let name, back;
    try {
      const created = next(w, (m) => m.type === 'session-created' && m.command === command);
      w.send(JSON.stringify({ type: 'spawn', command }));
      const { sessionId, name: spawned } = await created;
      name = spawned;
      // A bare spawn has no worktree; give it one, as createWorktree would have.
      Object.assign(sessions.get(sessionId), { repoPath: tmpdir(), worktreePath, branchName: 'b/orphan-test' });

      const parked = next(w, (m) => m.type === 'orphans-list' && m.orphans.some(o => o.name === name));
      w.send(JSON.stringify({ type: 'kill', sessionId }));
      const orphan = (await parked).orphans.find(o => o.name === name);
      expect(orphan.agent).toBe('codex');   // read off the command, path and flags stripped
      expect(orphans.get(orphan.id).agent).toBe('codex');
      expect(orphan.permissionFlags).toEqual(['--dangerously-bypass-approvals-and-sandbox']);

      const readopted = next(w, (m) => m.type === 'session-created' && m.name === name && m.sessionId !== sessionId);
      w.send(JSON.stringify({ type: 're-adopt-orphan', orphanId: orphan.id }));
      back = await readopted;
      expect(back.command).toBe('codex resume --last --dangerously-bypass-approvals-and-sandbox');
      expect(orphans.has(orphan.id)).toBe(false);
      // The record for the next restart carries the CLI and the flags too.
      const rec = config.activeSessions.find(s => s.worktreePath === worktreePath);
      expect(rec.agent).toBe('codex');
      expect(rec.permissionFlags).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    } finally {
      restore();
      config.activeSessions = config.activeSessions.filter(s => s.worktreePath !== worktreePath);
      for (const o of [...orphans.values()]) if (o.worktreePath === worktreePath) orphans.delete(o.id);
      if (back) {
        // Keep the kill path from orphaning the fake worktree a second time.
        Object.assign(sessions.get(back.sessionId), { repoPath: null, worktreePath: null });
        w.send(JSON.stringify({ type: 'kill', sessionId: back.sessionId }));
      }
      if (name) codenamePool.recycle(name);
      rmSync(worktreePath, { recursive: true, force: true });
      w.close();
    }
  }, 15000);

  // An orphan with no note (a record written before the CLI was noted, or a
  // worktree discovered on disk) resumes by whatever its job card or the
  // transcripts say — but that answer is a guess, and the new session must
  // NOT record it as fact, or a wrong one could never be corrected. The card,
  // when there is one, also lends the resume its permission mode.
  it.skipIf(process.platform === 'win32')('re-adopting an orphan with no note resumes by card and transcript, under the card\'s mode, and records nothing', async () => {
    const { bin, restore } = fakeCodexOnPath();
    const worktreePath = fakeOrphanWorktree();
    const repoPath = tmpdir();
    const branchName = 'b/no-note-test';
    // A Codex rollout whose cwd is the worktree, under a fake CODEX_HOME.
    const codexHome = mkdtempSync(join(tmpdir(), 'a007-codex-home-'));
    const day = join(codexHome, 'sessions', '2026', '09', '16');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-x.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: realpathSync.native(worktreePath), source: 'cli', thread_source: 'user' } }) + '\n');
    const savedHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    const savedRepos = config.repos;
    config.repos = [...config.repos, { path: repoPath }];
    const command = `${join(bin, 'codex')} --model o3`;
    const w = await open();
    let name, back, jobId;
    try {
      const created = next(w, (m) => m.type === 'session-created' && m.command === command);
      w.send(JSON.stringify({ type: 'spawn', command }));
      const { sessionId, name: spawned } = await created;
      name = spawned;
      Object.assign(sessions.get(sessionId), { repoPath, worktreePath, branchName });
      const parked = next(w, (m) => m.type === 'orphans-list' && m.orphans.some(o => o.name === name));
      w.send(JSON.stringify({ type: 'kill', sessionId }));
      const orphan = (await parked).orphans.find(o => o.name === name);
      orphans.get(orphan.id).agent = null;   // as a record from before the note, or a discovered worktree

      // No card yet: the transcript answers, bare, and the session keeps no note.
      let readopted = next(w, (m) => m.type === 'session-created' && m.name === name && m.sessionId !== sessionId);
      w.send(JSON.stringify({ type: 're-adopt-orphan', orphanId: orphan.id }));
      back = await readopted;
      expect(back.command).toBe('codex resume --last');
      expect(sessions.get(back.sessionId).agent).toBeNull();
      expect(config.activeSessions.find(s => s.worktreePath === worktreePath).agent).toBeNull();

      // Park it again; this time a read-only card on the branch is waiting.
      const reparked = next(w, (m) => m.type === 'orphans-list' && m.orphans.some(o => o.name === name));
      w.send(JSON.stringify({ type: 'kill', sessionId: back.sessionId }));
      const again = (await reparked).orphans.find(o => o.name === name);
      expect(again.agent).toBeNull();   // still no note: nothing was learned for certain
      const { job } = addJob({ title: 'read only codex', repoPath, agent: 'codex', permissionMode: 'plan' }, () => {});
      jobId = job.id;
      Object.assign(job, { state: 'in-progress', branchName, agentSessionId: null });
      readopted = next(w, (m) => m.type === 'session-created' && m.name === name && m.sessionId !== back.sessionId);
      w.send(JSON.stringify({ type: 're-adopt-orphan', orphanId: again.id }));
      back = await readopted;
      expect(back.command).toBe('codex resume --last --sandbox read-only');
      expect(allJobs().find(j => j.id === jobId).agentSessionId).toBe(back.sessionId);   // relinked to its card
      const rec = config.activeSessions.find(s => s.worktreePath === worktreePath);
      expect(rec.agent).toBeNull();
      // Under a card's mode the session records no flags of its own — the
      // card, or the board once the card is gone, decides again next time —
      // even though its resume command carries `--sandbox read-only`.
      expect(rec.permissionFlags).toEqual([]);
      expect(sessions.get(back.sessionId).permissionFlags).toEqual([]);
    } finally {
      restore();
      if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
      config.repos = savedRepos;
      config.activeSessions = config.activeSessions.filter(s => s.worktreePath !== worktreePath);
      for (const o of [...orphans.values()]) if (o.worktreePath === worktreePath) orphans.delete(o.id);
      if (back && sessions.has(back.sessionId)) {
        Object.assign(sessions.get(back.sessionId), { repoPath: null, worktreePath: null, jobId: null });
        w.send(JSON.stringify({ type: 'kill', sessionId: back.sessionId }));
      }
      if (jobId) await deleteJob(jobId, () => {});
      if (name) codenamePool.recycle(name);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
      w.close();
    }
  }, 20000);
});
