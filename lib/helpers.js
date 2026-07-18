// Pure helpers extracted from server.js for testability
import stripAnsi from 'strip-ansi';
import { basename } from 'path';
import { createHash } from 'crypto';

// --- Constants ---

export const CODENAMES = [
  'shadow', 'phantom', 'viper', 'cipher', 'raven', 'onyx', 'echo',
  'spectre', 'falcon', 'ghost', 'dagger', 'mirage', 'cobra', 'apex', 'ember'
];

export const COCKTAILS = [
  'vesper', 'martini', 'gimlet', 'negroni', 'sidecar', 'daiquiri',
  'manhattan', 'mojito', 'paloma', 'sazerac', 'aviation', 'bellini',
  'spritz', 'collins', 'julep', 'highball', 'rickey', 'fizz'
];

export const AGENT_COLORS = [
  '#4a9eff', '#ff6b6b', '#ffd43b', '#51cf66', '#cc5de8',
  '#ff922b', '#20c997', '#f06595', '#5c7cfa', '#ffe066'
];

export const PROMPT_PATTERNS = [
  /^❯\s*$/,
  /^>\s*$/,
  /\$\s*$/,
  /^claude[->❯]\s*$/i,
  /^\s*\?\s*$/,
];

export const MESSAGE_PATTERNS = [
  /Do you want to proceed\?/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  /Allow .+ to (read|edit|write|execute)/i,
  /Press Enter to continue/i,
  /\? .+\(Y\/n\)/,
  /approve|deny|allow|reject/i,
];

export const STATE_TIMEOUT_MS = 3000;

// --- Factory: Codename Pool ---

export function createCodenamePool(names = CODENAMES) {
  const used = new Set();
  return {
    pick() {
      const available = names.filter(n => !used.has(n));
      if (available.length > 0) {
        const name = available[Math.floor(Math.random() * available.length)];
        used.add(name);
        return name;
      }
      for (const base of names) {
        for (let i = 2; i <= 99; i++) {
          const name = `${base}-${i}`;
          if (!used.has(name)) {
            used.add(name);
            return name;
          }
        }
      }
      return `agent-${Date.now()}`;
    },
    recycle(name) {
      used.delete(name);
    },
    addUsed(name) {
      used.add(name);
    },
    get usedCount() {
      return used.size;
    },
  };
}

// --- Factory: Cocktail Pool ---

export function createCocktailPool(names = COCKTAILS) {
  const usedByRepo = new Map();
  return {
    pick(repoPath) {
      if (!usedByRepo.has(repoPath)) usedByRepo.set(repoPath, new Set());
      const used = usedByRepo.get(repoPath);
      const available = names.filter(c => !used.has(c));
      if (available.length > 0) {
        const cocktail = available[Math.floor(Math.random() * available.length)];
        used.add(cocktail);
        return cocktail;
      }
      for (const base of names) {
        for (let i = 2; i <= 99; i++) {
          const name = `${base}-${i}`;
          if (!used.has(name)) {
            used.add(name);
            return name;
          }
        }
      }
      return `branch-${Date.now()}`;
    },
    recycle(repoPath, cocktail) {
      const used = usedByRepo.get(repoPath);
      if (used) used.delete(cocktail);
    },
    addUsed(repoPath, cocktail) {
      if (!usedByRepo.has(repoPath)) usedByRepo.set(repoPath, new Set());
      usedByRepo.get(repoPath).add(cocktail);
    },
  };
}

// --- Factory: Color Cycler ---

export function createColorCycler(colors = AGENT_COLORS) {
  let index = 0;
  return {
    next() {
      const color = colors[index % colors.length];
      index++;
      return color;
    },
  };
}

// --- Pure Functions ---

export function stripAnsiComplete(str) {
  let result = stripAnsi(str);
  result = result.replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '');
  result = result.replace(/\x1bP.*?\x1b\\/g, '');
  result = result.replace(/\x1b[=>()]/g, '');
  return result;
}

export function detectState(session, { now, stateTimeoutMs, promptPatterns, messagePatterns } = {}) {
  const timestamp = now ?? Date.now();
  const timeout = stateTimeoutMs ?? STATE_TIMEOUT_MS;
  const prompts = promptPatterns ?? PROMPT_PATTERNS;
  const messages = messagePatterns ?? MESSAGE_PATTERNS;

  const timeSinceOutput = timestamp - session.lastOutputAt;
  if (session.exited) return 'DISCONNECTED';
  if (timeSinceOutput < timeout) return 'WORKING';
  const lastLine = session.lastStrippedLine || '';
  for (const pattern of messages) {
    if (pattern.test(lastLine)) return 'MESSAGE';
  }
  for (const line of session.recentStrippedLines) {
    for (const pattern of messages) {
      if (pattern.test(line)) return 'MESSAGE';
    }
  }
  for (const pattern of prompts) {
    if (pattern.test(lastLine)) return 'WAITING';
  }
  if (session.isTUI) return 'WAITING';
  return 'IDLE';
}

// Split a command string into { file, args } with shell-like quoting so
// commands with spaces survive (e.g. bash -lc "echo hi; ls"). Handles single
// quotes, double quotes, and backslash escapes. Naive split(/\s+/) broke any
// command that needed a quoted argument.
export function parseCommand(command) {
  const tokens = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else current += c;
      hasToken = true;
    } else if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) current += command[++i];
      else current += c;
      hasToken = true;
    } else if (c === "'") {
      inSingle = true; hasToken = true;
    } else if (c === '"') {
      inDouble = true; hasToken = true;
    } else if (c === '\\' && i + 1 < command.length) {
      current += command[++i]; hasToken = true;
    } else if (/\s/.test(c)) {
      if (hasToken) { tokens.push(current); current = ''; hasToken = false; }
    } else {
      current += c; hasToken = true;
    }
  }
  if (hasToken) tokens.push(current);
  return { file: tokens[0] || '', args: tokens.slice(1) };
}

export function parseGitStatus(output) {
  const files = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let path = line.slice(3);
    if (xy === '!!') continue;
    let status;
    if (xy === '??') {
      status = '?';
    } else if (xy[0] === 'R' || xy[1] === 'R') {
      status = 'R';
      const arrow = path.indexOf(' -> ');
      if (arrow !== -1) path = path.slice(arrow + 4);
    } else if (xy[1] !== ' ') {
      status = xy[1];
    } else {
      status = xy[0];
    }
    files.push({ path, status });
  }
  return files;
}

export function buildFileTree(files, repoName) {
  const root = { name: repoName, children: [], type: 'dir' };
  for (const { path, status } of files) {
    const parts = path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (i === parts.length - 1) {
        current.children.push({ name, status, type: 'file', path });
      } else {
        let dir = current.children.find(c => c.name === name && c.type === 'dir');
        if (!dir) {
          dir = { name, children: [], type: 'dir' };
          current.children.push(dir);
        }
        current = dir;
      }
    }
  }
  return root;
}

export function createRingBuffer(maxSize) {
  const buffer = [];
  return {
    push(item) {
      buffer.push(item);
      if (buffer.length > maxSize) buffer.shift();
    },
    getAll() { return [...buffer]; },
    get length() { return buffer.length; },
  };
}

export function repoDirName(repoPath) {
  const name = basename(repoPath).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const hash = createHash('md5').update(repoPath).digest('hex').slice(0, 4);
  return `${name}-${hash}`;
}
