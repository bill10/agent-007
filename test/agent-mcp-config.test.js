// Handing a spawned agent the board's MCP tool: the config file it reads at
// startup, and the flags that point it there.
//
// This is the half of the feature that decides whether an agent can see the
// tool at all, and it is the half that must not break a spawn when the command
// is not Claude Code.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Windows has no POSIX mode bits: writeFileSync's mode lands as 0o666 and chmod
// is a no-op, so the owner-only property can only be asserted on POSIX.
const POSIX = process.platform !== 'win32';

const DIR = mkdtempSync(join(tmpdir(), 'a007-mcp-'));
process.env.AGENT007_MCP_DIR = DIR;

const {
  writeMcpConfig, removeMcpConfig, sweepMcpConfigs, mcpConfigPath, mcpConfigBody,
  withMcpConfig, takesMcpConfig, boardBaseUrl, MCP_SERVER_NAME,
} = await import('../server/agent-mcp.js');

afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

describe('the config an agent reads at startup', () => {
  it('points at this board over loopback with the session token in a header', () => {
    const body = mcpConfigBody('a007a_secret');
    const server = body.mcpServers[MCP_SERVER_NAME];
    expect(server.type).toBe('http');
    expect(server.url).toBe(`${boardBaseUrl()}/mcp`);
    expect(server.headers.Authorization).toBe('Bearer a007a_secret');
  });

  it('keeps the token out of the URL', () => {
    // A ?token= lands in every proxy and access log between here and nowhere.
    const server = mcpConfigBody('a007a_secret').mcpServers[MCP_SERVER_NAME];
    expect(server.url).not.toContain('a007a_secret');
  });

  it('addresses the board over loopback, not the bind host', () => {
    // HOST may be a tailnet address; sending an agent's credential out over the
    // network to reach a server on the same machine would be gratuitous.
    expect(boardBaseUrl()).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)/);
  });

  it('writes the token into the file the agent will read', () => {
    const path = writeMcpConfig('session-1', 'a007a_secret');
    expect(path).toBe(mcpConfigPath('session-1'));
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers[MCP_SERVER_NAME].headers.Authorization)
      .toBe('Bearer a007a_secret');
  });

  it.skipIf(!POSIX)('writes the file readable only by its owner', () => {
    // It holds a live credential.
    expect(statSync(writeMcpConfig('session-1', 'a007a_secret')).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)('tightens the mode even when a file was already there', () => {
    // writeFileSync ignores its mode argument entirely for an existing file, so
    // a leftover world-readable file from an earlier run would stay that way.
    mkdirSync(DIR, { recursive: true });
    writeFileSync(mcpConfigPath('session-2'), '{}', { mode: 0o644 });
    writeMcpConfig('session-2', 'a007a_secret');
    expect(statSync(mcpConfigPath('session-2')).mode & 0o777).toBe(0o600);
  });

  it('removes the file, and does not complain when it is already gone', () => {
    writeMcpConfig('session-3', 'tok');
    removeMcpConfig('session-3');
    expect(existsSync(mcpConfigPath('session-3'))).toBe(false);
    expect(() => removeMcpConfig('session-3')).not.toThrow();
  });
});

describe('which commands take --mcp-config', () => {
  it('accepts claude, by name or by absolute path', () => {
    expect(takesMcpConfig('claude')).toBe(true);
    expect(takesMcpConfig('/opt/homebrew/bin/claude')).toBe(true);
  });

  it('refuses every other agent', () => {
    // Verified against the real CLIs: Gemini has no per-invocation MCP config
    // flag (only `gemini mcp add`), and Codex uses ~/.codex/config.toml.
    // Appending the flag to either is an unknown-option error and a dead spawn.
    for (const cmd of ['gemini', 'codex', 'aider', 'bash', '/usr/local/bin/gemini', '']) {
      expect(takesMcpConfig(cmd)).toBe(false);
    }
  });

  it('recognises the Windows launcher', () => {
    // On Windows the thing on PATH is claude.cmd. Spelling it out would
    // otherwise silently get no tool at all.
    // Backslash paths are deliberately not asserted: path.basename only splits
    // on them when running ON Windows, so such a case would test Node, not this.
    for (const cmd of ['claude.cmd', 'claude.exe', 'claude.CMD']) {
      expect(takesMcpConfig(cmd)).toBe(true);
    }
    expect(takesMcpConfig('gemini.cmd')).toBe(false);
  });
});

describe('stale configs from a previous run', () => {
  it('are swept at boot, so dead credentials do not pile up', () => {
    // Files are removed when their PTY exits, but a crash or a plain restart
    // never runs that handler. Without a sweep every run leaves its tokens
    // behind for ever.
    writeMcpConfig('session-1', 'tok-1');
    writeMcpConfig('session-2', 'tok-2');
    sweepMcpConfigs();
    expect(existsSync(mcpConfigPath('session-1'))).toBe(false);
    expect(existsSync(mcpConfigPath('session-2'))).toBe(false);
  });

  it('sweeps cleanly when nothing is there yet', () => {
    expect(() => sweepMcpConfigs()).not.toThrow();
  });

  it('leaves the directory usable afterwards', () => {
    sweepMcpConfigs();
    expect(writeMcpConfig('session-9', 'tok')).toBe(mcpConfigPath('session-9'));
  });
});

describe('injecting the flag', () => {
  it('goes immediately after the binary, ahead of everything typed', () => {
    expect(withMcpConfig('claude', ['--permission-mode', 'auto', 'do the thing'], '/cfg.json'))
      .toEqual(['--mcp-config', '/cfg.json', '--permission-mode', 'auto', 'do the thing']);
  });

  it('never lands after a positional prompt', () => {
    // Claude Code does accept flags after a positional, but placing it first
    // means the question never comes up.
    const args = withMcpConfig('claude', ['a long prompt'], '/cfg.json');
    expect(args.indexOf('--mcp-config')).toBeLessThan(args.indexOf('a long prompt'));
  });

  it('leaves a non-claude command completely alone', () => {
    const typed = ['--yolo', '-p', 'hello'];
    expect(withMcpConfig('gemini', typed, '/cfg.json')).toEqual(typed);
    expect(withMcpConfig('aider', [], '/cfg.json')).toEqual([]);
  });

  it('extends the user\'s own --mcp-config instead of adding a second one', () => {
    // The flag is variadic (`<configs...>`), so two occurrences are ambiguous.
    const args = withMcpConfig('claude', ['--mcp-config', 'theirs.json', '-p', 'x'], '/ours.json');
    expect(args).toEqual(['--mcp-config', '/ours.json', 'theirs.json', '-p', 'x']);
    expect(args.filter(a => a === '--mcp-config')).toHaveLength(1);
  });

  it('spawns unchanged when the config could not be written', () => {
    // A missing config is a missing convenience, never a failed spawn.
    expect(withMcpConfig('claude', ['-p', 'x'], null)).toEqual(['-p', 'x']);
  });
});
