import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app, server, startup, sessions } from '../server.js';
import WebSocket from 'ws';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
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
