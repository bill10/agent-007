// boardBaseUrl against a non-wildcard bind.
//
// HOST and PORT are read once at import, so this needs its own file with the
// environment set before the module graph loads.
//
// The case that matters: Agent 007 is routinely reached over Tailscale, where
// HOST is a tailnet address rather than a wildcard. An IPv6 literal has to be
// bracketed or the URL is malformed and every agent silently gets no tool.

import { describe, it, expect } from 'vitest';

process.env.HOST = 'fd7a:115c:a1e0::1';
process.env.PORT = '7007';

const { boardBaseUrl } = await import('../server/agent-mcp.js');

describe('boardBaseUrl on a non-wildcard bind', () => {
  it('uses the bind address, because loopback may not be listening', () => {
    expect(boardBaseUrl()).toContain('fd7a:115c:a1e0::1');
  });

  it('brackets an IPv6 literal so the URL parses', () => {
    const url = boardBaseUrl();
    expect(url).toBe('http://[fd7a:115c:a1e0::1]:7007');
    expect(() => new URL(url)).not.toThrow();
    expect(new URL(url).port).toBe('7007');
  });
});
