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
  // Claude Code's TUI dialogs. Two things make these need their own patterns:
  //
  //  1. The TUI positions each word with cursor moves rather than spaces, so
  //     after stripAnsiComplete the text arrives run together —
  //     "Yes,Itrustthisfolder". Hence \s* between every word, not a literal
  //     space. (Verified against real captured PTY output.)
  //  2. Without them a dialog reads as plain WAITING, which for a TUI agent is
  //     indistinguishable from "idle at the prompt". The workspace-trust dialog
  //     in particular greets EVERY agent spawned into a fresh worktree, so a
  //     job-board agent would otherwise sit there looking like it was working.
  /Yes,?\s*I\s*trust\s*this\s*folder/i,
  // "select" as well as "confirm": the multiple-choice prompt's footer reads
  // "Enter to select ... Esc to cancel", and without it an agent blocking on a
  // question reads as plain WAITING -- indistinguishable from resting at the
  // prompt, which is what now sends it wandering off mid-question.
  //
  // The middle is a bounded [^\n]{0,120} rather than the old `\s*.?\s*`: that
  // allowed exactly ONE character between the verb and "Esc", so the real
  // footer ("Enter to select · up/down to navigate · n to add notes · Esc to
  // cancel") never matched, and its three mutually ambiguous quantifiers
  // backtracked quadratically on a line an agent controls (32k spaces = ~800ms
  // per scan, run against every PTY chunk).
  /Enter\s*to\s*(?:confirm|select)\b[^\n]{0,120}Esc\s*to\s*cancel/i,
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

// Names to TRY, in order. Deliberately not a ledger of what is in use.
//
// Git already knows which branches exist — `worktree add -b` answers definitively
// and atomically, including for branches made outside this app, on another
// machine, or a second ago. So the caller walks these candidates and stops at the
// first one git accepts. Nothing here has to stay in sync with anything.
//
// `reject` is a speed hint, never a source of truth: a name git turned down goes
// to the back of the queue so the next spawn tries it last, not never. A branch
// can be deleted at any time, and a stale hint must not cost us a usable name.
export function createCocktailPool(names = COCKTAILS) {
  const rejectedByRepo = new Map();

  // Round 1 is the bare cocktail; later rounds prefix it — 2nd-vesper, 3rd-vesper.
  // These become real branch names, so 21st beats 21th.
  const ordinal = (round) => {
    const suffix = round % 100 >= 11 && round % 100 <= 13
      ? 'th'
      : ({ 1: 'st', 2: 'nd', 3: 'rd' }[round % 10] || 'th');
    return `${round}${suffix}`;
  };

  const shuffled = (list) => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  return {
    // Random order within a round so two concurrent spawns rarely open with the
    // same name; if they do, the loser just takes the next candidate.
    *candidates(repoPath, maxRounds = 99) {
      // Bind the live Set, creating it if absent. `?? new Set()` would hand back a
      // detached copy on a repo's first spawn, so rejections made mid-walk would
      // land in a different object than the one being read.
      if (!rejectedByRepo.has(repoPath)) rejectedByRepo.set(repoPath, new Set());
      const rejected = rejectedByRepo.get(repoPath);
      for (let round = 1; round <= maxRounds; round++) {
        const prefix = round === 1 ? '' : `${ordinal(round)}-`;
        const pool = shuffled(names).map(n => `${prefix}${n}`);
        // Partition BEFORE yielding either half. The caller rejects each name as
        // it fails, so a lazily-evaluated second filter would re-collect names the
        // first half already yielded and hand them back inside the same round —
        // burning the attempt budget on names we just proved were taken.
        const fresh = pool.filter(n => !rejected.has(n));
        const stale = pool.filter(n => rejected.has(n));
        yield* fresh;   // names with no strike against them
        yield* stale;   // then the hints, in case a branch was deleted
      }
    },
    reject(repoPath, name) {
      if (!rejectedByRepo.has(repoPath)) rejectedByRepo.set(repoPath, new Set());
      rejectedByRepo.get(repoPath).add(name);
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

// One sanitiser for every file name a client hands the server (terminal
// uploads, job attachments). Only [A-Za-z0-9._-] survive, so no separator
// does, and a Windows device name (CON, NUL, COM1...) is prefixed so
// writeFileSync cannot open a device instead of a file.
export function safeFilename(name) {
  const clean = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(clean) ? `_${clean}` : clean;
}
