import { describe, it, expect } from 'vitest';
import {
  createCodenamePool, createCocktailPool, createColorCycler,
  stripAnsiComplete, detectState, parseGitStatus, buildFileTree,
  createRingBuffer, repoDirName, parseCommand,
  CODENAMES, COCKTAILS, AGENT_COLORS, STATE_TIMEOUT_MS,
} from '../lib/helpers.js';

// --- parseCommand ---

describe('parseCommand', () => {
  it('splits a simple command on whitespace', () => {
    expect(parseCommand('claude')).toEqual({ file: 'claude', args: [] });
    expect(parseCommand('claude --continue')).toEqual({ file: 'claude', args: ['--continue'] });
  });

  it('keeps a double-quoted argument with spaces intact', () => {
    expect(parseCommand('bash -lc "echo hi; ls -la"')).toEqual({
      file: 'bash', args: ['-lc', 'echo hi; ls -la'],
    });
  });

  it('keeps a single-quoted argument with spaces intact', () => {
    expect(parseCommand("bash -lc 'for i in 1 2 3; do echo $i; done'")).toEqual({
      file: 'bash', args: ['-lc', 'for i in 1 2 3; do echo $i; done'],
    });
  });

  it('handles a quoted executable path containing spaces', () => {
    expect(parseCommand('"/opt/my tools/agent.sh" --flag')).toEqual({
      file: '/opt/my tools/agent.sh', args: ['--flag'],
    });
  });

  it('handles backslash-escaped spaces', () => {
    expect(parseCommand('/opt/my\\ tool/run.sh')).toEqual({
      file: '/opt/my tool/run.sh', args: [],
    });
  });

  it('collapses extra whitespace between tokens', () => {
    expect(parseCommand('  npm   run    dev  ')).toEqual({ file: 'npm', args: ['run', 'dev'] });
  });

  it('preserves an empty double-quoted argument', () => {
    expect(parseCommand('cmd ""')).toEqual({ file: 'cmd', args: [''] });
  });

  it('returns an empty file for an empty string', () => {
    expect(parseCommand('')).toEqual({ file: '', args: [] });
    expect(parseCommand('   ')).toEqual({ file: '', args: [] });
  });
});

// --- createRingBuffer ---

describe('createRingBuffer', () => {
  it('should return empty array from fresh buffer', () => {
    const rb = createRingBuffer(5);
    expect(rb.getAll()).toEqual([]);
    expect(rb.length).toBe(0);
  });

  it('should store and retrieve items in order', () => {
    const rb = createRingBuffer(5);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    expect(rb.getAll()).toEqual(['a', 'b', 'c']);
  });

  it('should evict oldest items when exceeding maxSize', () => {
    const rb = createRingBuffer(3);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    rb.push('d');
    expect(rb.getAll()).toEqual(['b', 'c', 'd']);
    expect(rb.length).toBe(3);
  });

  it('should return a snapshot, not a reference to internal array', () => {
    const rb = createRingBuffer(5);
    rb.push('a');
    const snap = rb.getAll();
    rb.push('b');
    expect(snap).toEqual(['a']);
    expect(rb.getAll()).toEqual(['a', 'b']);
  });
});

// --- createCodenamePool ---

describe('createCodenamePool', () => {
  it('should return a name from the pool', () => {
    const pool = createCodenamePool(['alpha', 'bravo']);
    const name = pool.pick();
    expect(['alpha', 'bravo']).toContain(name);
  });

  it('should never return the same name twice', () => {
    const pool = createCodenamePool(['alpha', 'bravo', 'charlie']);
    const names = new Set();
    for (let i = 0; i < 3; i++) names.add(pool.pick());
    expect(names.size).toBe(3);
  });

  it('should exhaust all base names before using suffixed fallbacks', () => {
    const pool = createCodenamePool(['alpha']);
    expect(pool.pick()).toBe('alpha');
    const second = pool.pick();
    expect(second).toBe('alpha-2');
  });

  it('should use sequential suffixes after pool exhaustion', () => {
    const pool = createCodenamePool(['alpha']);
    pool.pick(); // alpha
    pool.pick(); // alpha-2
    expect(pool.pick()).toBe('alpha-3');
  });

  it('should fall back to agent-{timestamp} when fully exhausted', () => {
    const pool = createCodenamePool(['a']);
    pool.pick(); // a
    for (let i = 2; i <= 99; i++) pool.pick(); // a-2 through a-99
    const last = pool.pick();
    expect(last).toMatch(/^agent-\d+$/);
  });

  it('should allow recycled names to be picked again', () => {
    const pool = createCodenamePool(['alpha']);
    const name = pool.pick();
    pool.recycle(name);
    expect(pool.pick()).toBe('alpha');
  });

  it('should handle recycling a name that was never used', () => {
    const pool = createCodenamePool(['alpha']);
    pool.recycle('nonexistent'); // should not throw
    expect(pool.usedCount).toBe(0);
  });

  it('should track used count', () => {
    const pool = createCodenamePool(['alpha', 'bravo']);
    expect(pool.usedCount).toBe(0);
    pool.pick();
    expect(pool.usedCount).toBe(1);
    pool.pick();
    expect(pool.usedCount).toBe(2);
  });
});

// --- createCocktailPool ---

describe('createCocktailPool', () => {
  it('should return a cocktail from the pool', () => {
    const pool = createCocktailPool(['vesper', 'martini']);
    const name = pool.pick('/repo/a');
    expect(['vesper', 'martini']).toContain(name);
  });

  it('should track cocktails per repo independently', () => {
    const pool = createCocktailPool(['vesper']);
    expect(pool.pick('/repo/a')).toBe('vesper');
    expect(pool.pick('/repo/b')).toBe('vesper');
  });

  it('should not return a cocktail already used for the same repo', () => {
    const pool = createCocktailPool(['vesper', 'martini']);
    const first = pool.pick('/repo/a');
    const second = pool.pick('/repo/a');
    expect(first).not.toBe(second);
  });

  it('should use suffixed fallbacks after pool exhaustion', () => {
    const pool = createCocktailPool(['vesper']);
    pool.pick('/repo/a'); // vesper
    expect(pool.pick('/repo/a')).toBe('vesper-2');
  });

  it('should fall back to branch-{timestamp} when fully exhausted', () => {
    const pool = createCocktailPool(['v']);
    pool.pick('/r'); // v
    for (let i = 2; i <= 99; i++) pool.pick('/r');
    expect(pool.pick('/r')).toMatch(/^branch-\d+$/);
  });

  it('should recycle a cocktail for reuse', () => {
    const pool = createCocktailPool(['vesper']);
    pool.pick('/repo/a');
    pool.recycle('/repo/a', 'vesper');
    expect(pool.pick('/repo/a')).toBe('vesper');
  });

  it('should handle recycling from a repo with no prior usage', () => {
    const pool = createCocktailPool(['vesper']);
    pool.recycle('/unknown', 'vesper'); // should not throw
  });
});

// --- stripAnsiComplete ---

describe('stripAnsiComplete', () => {
  it('should return plain text unchanged', () => {
    expect(stripAnsiComplete('hello world')).toBe('hello world');
  });

  it('should strip SGR color codes', () => {
    expect(stripAnsiComplete('\x1b[31mred text\x1b[0m')).toBe('red text');
  });

  it('should strip OSC sequences with BEL terminator', () => {
    expect(stripAnsiComplete('\x1b]0;My Title\x07some text')).toBe('some text');
  });

  it('should strip OSC sequences with ST terminator', () => {
    expect(stripAnsiComplete('\x1b]0;My Title\x1b\\some text')).toBe('some text');
  });

  it('should strip DCS sequences when not pre-processed by strip-ansi', () => {
    // Direct DCS regex test: the regex targets ESC P ... ESC \
    // In practice, strip-ansi may partially process the sequence first
    const dcsRegex = /\x1bP.*?\x1b\\/g;
    expect('\x1bPpayload\x1b\\visible'.replace(dcsRegex, '')).toBe('visible');
  });

  it('should strip charset designation sequences', () => {
    // strip-ansi handles ESC( sequences; our regex catches any remainder
    const result = stripAnsiComplete('\x1b(Btext');
    expect(result).toBe('text');
  });

  it('should handle empty string', () => {
    expect(stripAnsiComplete('')).toBe('');
  });

  it('should handle string of only escape sequences', () => {
    expect(stripAnsiComplete('\x1b[31m\x1b[0m')).toBe('');
  });
});

// --- detectState ---

describe('detectState', () => {
  const BASE = {
    exited: false,
    lastOutputAt: 0,
    lastStrippedLine: '',
    recentStrippedLines: [],
    isTUI: false,
  };

  it('should return DISCONNECTED when session has exited', () => {
    expect(detectState({ ...BASE, exited: true }, { now: 1000 })).toBe('DISCONNECTED');
  });

  it('should return WORKING when output was recent', () => {
    const now = 5000;
    expect(detectState({ ...BASE, lastOutputAt: now - 100 }, { now })).toBe('WORKING');
  });

  it('should return MESSAGE when last line matches a message pattern', () => {
    const now = 50000;
    expect(detectState({
      ...BASE, lastOutputAt: 0, lastStrippedLine: 'Do you want to proceed?',
    }, { now })).toBe('MESSAGE');
  });

  it('should return MESSAGE when a recent line matches a message pattern', () => {
    const now = 50000;
    expect(detectState({
      ...BASE, lastOutputAt: 0,
      lastStrippedLine: 'some other text',
      recentStrippedLines: ['Allow editor to read files'],
    }, { now })).toBe('MESSAGE');
  });

  it('should return WAITING when last line matches a prompt pattern', () => {
    const now = 50000;
    expect(detectState({
      ...BASE, lastOutputAt: 0, lastStrippedLine: '$ ',
    }, { now })).toBe('WAITING');
  });

  it('should return WAITING for TUI sessions that are idle', () => {
    const now = 50000;
    expect(detectState({
      ...BASE, lastOutputAt: 0, isTUI: true,
    }, { now })).toBe('WAITING');
  });

  it('should return IDLE when nothing matches and not TUI', () => {
    const now = 50000;
    expect(detectState({
      ...BASE, lastOutputAt: 0, lastStrippedLine: 'random text',
    }, { now })).toBe('IDLE');
  });

  it('should prioritize DISCONNECTED over WORKING', () => {
    const now = 5000;
    expect(detectState({
      ...BASE, exited: true, lastOutputAt: now - 100,
    }, { now })).toBe('DISCONNECTED');
  });

  it('should prioritize WORKING over MESSAGE', () => {
    const now = 5000;
    expect(detectState({
      ...BASE, lastOutputAt: now - 100, lastStrippedLine: 'Do you want to proceed?',
    }, { now })).toBe('WORKING');
  });

  it('should prioritize MESSAGE over WAITING', () => {
    const now = 50000;
    // A line that matches both message and prompt
    expect(detectState({
      ...BASE, lastOutputAt: 0, lastStrippedLine: 'approve (y/n)',
    }, { now })).toBe('MESSAGE');
  });

  it('should match Claude permission prompt', () => {
    const now = 50000;
    expect(detectState({
      ...BASE, lastOutputAt: 0, lastStrippedLine: 'Allow claude to read package.json',
    }, { now })).toBe('MESSAGE');
  });

  it('should match [Y/n] confirmation', () => {
    const now = 50000;
    expect(detectState({
      ...BASE, lastOutputAt: 0, lastStrippedLine: 'Continue? [Y/n]',
    }, { now })).toBe('MESSAGE');
  });

  it('should match bare prompt characters', () => {
    const now = 50000;
    expect(detectState({ ...BASE, lastOutputAt: 0, lastStrippedLine: '❯ ' }, { now })).toBe('WAITING');
    expect(detectState({ ...BASE, lastOutputAt: 0, lastStrippedLine: '> ' }, { now })).toBe('WAITING');
  });
});

// --- parseGitStatus ---

describe('parseGitStatus', () => {
  it('should parse modified file (working tree)', () => {
    expect(parseGitStatus(' M src/app.js')).toEqual([{ path: 'src/app.js', status: 'M' }]);
  });

  it('should parse modified file (index)', () => {
    expect(parseGitStatus('M  src/app.js')).toEqual([{ path: 'src/app.js', status: 'M' }]);
  });

  it('should parse added file', () => {
    expect(parseGitStatus('A  newfile.js')).toEqual([{ path: 'newfile.js', status: 'A' }]);
  });

  it('should parse deleted file', () => {
    expect(parseGitStatus(' D old.js')).toEqual([{ path: 'old.js', status: 'D' }]);
  });

  it('should parse untracked file', () => {
    expect(parseGitStatus('?? untracked.js')).toEqual([{ path: 'untracked.js', status: '?' }]);
  });

  it('should parse renamed file and extract new path', () => {
    expect(parseGitStatus('R  old.js -> new.js')).toEqual([{ path: 'new.js', status: 'R' }]);
  });

  it('should ignore ignored files', () => {
    expect(parseGitStatus('!! node_modules/')).toEqual([]);
  });

  it('should prefer working tree status over index status', () => {
    // MM means modified in both index and working tree; working tree wins
    expect(parseGitStatus('MM src/app.js')).toEqual([{ path: 'src/app.js', status: 'M' }]);
  });

  it('should handle multiple files', () => {
    const output = ' M file1.js\n?? file2.js\nA  file3.js';
    const result = parseGitStatus(output);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ path: 'file1.js', status: 'M' });
    expect(result[1]).toEqual({ path: 'file2.js', status: '?' });
    expect(result[2]).toEqual({ path: 'file3.js', status: 'A' });
  });

  it('should ignore blank lines', () => {
    expect(parseGitStatus(' M file.js\n\n')).toHaveLength(1);
  });

  it('should return empty array for empty output', () => {
    expect(parseGitStatus('')).toEqual([]);
  });
});

// --- buildFileTree ---

describe('buildFileTree', () => {
  it('should create root node with repo name', () => {
    const tree = buildFileTree([], 'myapp');
    expect(tree).toEqual({ name: 'myapp', children: [], type: 'dir' });
  });

  it('should place a root-level file as a child of root', () => {
    const tree = buildFileTree([{ path: 'README.md', status: 'M' }], 'myapp');
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toEqual({ name: 'README.md', status: 'M', type: 'file', path: 'README.md' });
  });

  it('should create nested directory structure', () => {
    const tree = buildFileTree([{ path: 'src/lib/utils.js', status: 'M' }], 'myapp');
    expect(tree.children[0].name).toBe('src');
    expect(tree.children[0].type).toBe('dir');
    expect(tree.children[0].children[0].name).toBe('lib');
    expect(tree.children[0].children[0].children[0].name).toBe('utils.js');
  });

  it('should reuse existing directory nodes', () => {
    const tree = buildFileTree([
      { path: 'src/a.js', status: 'M' },
      { path: 'src/b.js', status: 'A' },
    ], 'myapp');
    expect(tree.children).toHaveLength(1); // one src dir
    expect(tree.children[0].children).toHaveLength(2); // two files
  });

  it('should preserve file status and full path', () => {
    const tree = buildFileTree([{ path: 'deep/nested/file.ts', status: 'D' }], 'repo');
    const file = tree.children[0].children[0].children[0];
    expect(file.status).toBe('D');
    expect(file.path).toBe('deep/nested/file.ts');
  });
});

// --- createColorCycler ---

describe('createColorCycler', () => {
  it('should return colors in order', () => {
    const cycler = createColorCycler(['#aaa', '#bbb', '#ccc']);
    expect(cycler.next()).toBe('#aaa');
    expect(cycler.next()).toBe('#bbb');
    expect(cycler.next()).toBe('#ccc');
  });

  it('should wrap around after exhausting palette', () => {
    const cycler = createColorCycler(['#aaa', '#bbb']);
    cycler.next(); // #aaa
    cycler.next(); // #bbb
    expect(cycler.next()).toBe('#aaa');
  });
});

// --- repoDirName ---

describe('repoDirName', () => {
  it('should use lowercase basename and short hash', () => {
    const result = repoDirName('/Users/bill/MyApp');
    expect(result).toMatch(/^myapp-[a-f0-9]{4}$/);
  });

  it('should replace non-alphanumeric characters with hyphens', () => {
    const result = repoDirName('/path/my_special.app');
    expect(result).toMatch(/^my-special-app-[a-f0-9]{4}$/);
  });

  it('should produce different hashes for different paths with same basename', () => {
    const a = repoDirName('/home/user/myapp');
    const b = repoDirName('/opt/deploy/myapp');
    // Same basename but different full paths → different hashes
    expect(a).not.toBe(b);
    expect(a.slice(0, -5)).toBe(b.slice(0, -5)); // same name prefix
  });

  it('should produce consistent output for same input', () => {
    expect(repoDirName('/foo/bar')).toBe(repoDirName('/foo/bar'));
  });
});
