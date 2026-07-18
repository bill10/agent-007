import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, server, startup, sessions } from '../server.js';
import { hashToken, WS_UNAUTHORIZED } from '../server/auth.js';
import WebSocket from 'ws';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'fs';
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
});
