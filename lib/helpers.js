// Pure helpers extracted from server.js for testability
import stripAnsi from 'strip-ansi';
import { basename } from 'path';
import { createHash } from 'crypto';

// --- Constants ---

export const CODENAMES = [
  'Shadow', 'Phantom', 'Viper', 'Cipher', 'Raven', 'Onyx', 'Echo',
  'Spectre', 'Falcon', 'Ghost', 'Dagger', 'Mirage', 'Cobra', 'Apex', 'Ember'
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

// A name is unavailable for one of two independent reasons, tracked separately:
//
//   reserved — handed out by pick() (or claimed via addUsed) this process. Released
//              by recycle() when the session ends.
//   taken    — backed by a branch that actually exists in the repo. Refreshed
//              wholesale from git by syncFromBranches().
//
// Keeping them apart is what lets a git refresh drop names whose branches were
// deleted outside the app without also clearing live reservations.
//
// Both are keyed by repoPath: a cocktail in use in one repo says nothing about
// another repo, since the branches live in different repositories.
export function createCocktailPool(names = COCKTAILS) {
  const reservedByRepo = new Map();
  const takenByRepo = new Map();

  const reservedFor = (repoPath) => {
    if (!reservedByRepo.has(repoPath)) reservedByRepo.set(repoPath, new Set());
    return reservedByRepo.get(repoPath);
  };
  // Read-only: never creates the per-repo Set, so counting availability for a
  // repo the pool has never handed out doesn't leave an entry behind.
  const isUsed = (repoPath, name) =>
    Boolean(reservedByRepo.get(repoPath)?.has(name)) ||
    Boolean(takenByRepo.get(repoPath)?.has(name));

  return {
    pick(repoPath) {
      const available = names.filter(c => !isUsed(repoPath, c));
      if (available.length > 0) {
        const cocktail = available[Math.floor(Math.random() * available.length)];
        reservedFor(repoPath).add(cocktail);
        return cocktail;
      }
      for (const base of names) {
        for (let i = 2; i <= 99; i++) {
          const name = `${base}-${i}`;
          if (!isUsed(repoPath, name)) {
            reservedFor(repoPath).add(name);
            return name;
          }
        }
      }
      return `branch-${Date.now()}`;
    },
    recycle(repoPath, cocktail) {
      reservedByRepo.get(repoPath)?.delete(cocktail);
    },
    addUsed(repoPath, cocktail) {
      reservedFor(repoPath).add(cocktail);
    },
    // Claim a name because a branch holds it, not because a session does. Lands in
    // `taken`, so the next syncFromBranches re-derives it from git and drops it if
    // the branch is gone — unlike addUsed, which waits for an explicit recycle().
    markTaken(repoPath, cocktail) {
      if (!takenByRepo.has(repoPath)) takenByRepo.set(repoPath, new Set());
      takenByRepo.get(repoPath).add(cocktail);
    },
    // Mark every name already backed by a branch in this repo as unavailable.
    //
    // Matches only branches the app itself would create — `${branchPrefix}/${name}`,
    // where branchPrefix is the same git user createWorktree derives. Matching on
    // the last path segment instead would block a cocktail because an unrelated
    // `feature/negroni` or a teammate's `alice/rickey` happens to end in one, even
    // though `bill/negroni` is still free. (Measured on a real repo: 2 of 12 blocks
    // were spurious that way.)
    //
    // Replaces rather than merges: a branch deleted outside the app should hand
    // its cocktail back. Reservations are untouched, so a live session never
    // loses its name to a refresh.
    syncFromBranches(repoPath, branchNames, branchPrefix = '') {
      const prefix = `${branchPrefix}/`;
      const taken = new Set();
      for (const raw of branchNames) {
        const branch = String(raw).trim();
        if (!branch.startsWith(prefix)) continue;
        const name = branch.slice(prefix.length);
        if (name) taken.add(name);
      }
      takenByRepo.set(repoPath, taken);
    },
    availableCount(repoPath) {
      return names.filter(c => !isUsed(repoPath, c)).length;
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
