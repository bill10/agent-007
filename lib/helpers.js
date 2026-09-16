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
  // Claude Code positions each word with cursor moves, so after stripping the
  // words run together ("No,andtellClaudewhattododifferently"): \s* between
  // words wherever a phrase can be Claude's.
  /Do\s*you\s*want\s*to\s*(proceed|allow|make|run|create|fetch)/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  // Bounded middles, not `.+`: these run over the last synchronized frame
  // too (up to 2000 chars of agent-controlled text), and an unbounded gap
  // between two literals backtracks quadratically. No dialog puts 200 chars
  // between "Allow" and "to", or between "?" and "(Y/n)".
  /Allow [^\n]{1,200} to (read|edit|write|execute)/i,
  /Press Enter to continue/i,
  // The dialogs each CLI opens, by their own wording, and the answers they
  // offer. Word-bounded and phrase-shaped on purpose: this used to be a bare
  // /approve|deny|allow|reject/, which also matched ordinary prose — Codex's
  // permission picker says "choose what Codex is allowed to do" and "Ask for
  // approval", and every line of an agent's own summary is one "allowed"
  // away from a false "needs you" bubble. (Wording verified against
  // codex-cli 0.153.4 and Claude Code 2.1.273; the Claude dialogs are on
  // file in test/fixtures/claude-permission-dialogs.js.)
  /\bWould you like to (run|make|grant|send)\b/i,      // Codex: command, edits, permissions, terminal input
  /\bApprove app tool call\?/i,
  /\bApply Changes\?/i,
  /\bEnable full access\?/i,
  /\bUpdate Model Permissions\b/,                      // the /permissions picker's title — Title Case, unlike prose about it
  // Codex keeps its spaces, so its answers are word-bounded on both sides.
  /\bYes, (proceed|just this once|continue anyway|grant)\b/i,
  /\bNo, (continue without (running|permissions)|and block this host)\b/i,
  // The two answers both CLIs offer, space-tolerant for Claude and with no
  // trailing \b: with the spaces gone the phrase runs straight into the next
  // word ("...whattododifferently").
  /\bYes,\s*and\s*(don['’]t|do\s*not)\s*ask\s*again/i,
  /\bNo,\s*and\s*tell\s*(Codex|Claude)\s*what\s*to\s*do/i,
  // Claude Code 2.1's permission dialog: its answers, and its footer, since
  // four answers push the question itself out of the five-line window.
  /\bYes,\s*and\s*(always\s*allow|switch\s*to)/i,
  /Esc\s*to\s*cancel\s*·\s*Tab\s*to\s*amend/i,
  /\b(Allow for this session|Always allow|Allow and don['’]t ask)\b/i,
  // Gemini CLI and aider, the other TUIs a tab may run, by their own answers.
  /\bAllow execution\?/i,
  /\bYes, allow (once|always)\b/i,
  /\(Y\)es\/\(N\)o/i,
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
    has(name) {
      return used.has(name);
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

// Output that says something happened, as opposed to a spinner tick, a rule
// of box-drawing, or the remnant of a half-stripped escape (the ' q' left by
// ESC[0 SP q, the cursor-shape sequence). One test for the freshness clock
// and for whether a synchronized frame is a repaint worth keeping.
const TRIVIAL_RE = /^[\s.·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷─━▏▎▍▌▋▊▉█░▒▓⬡◐◑◒◓|\\\/\-*>]+$/;
const ESCAPE_REMNANT_RE = /^[\d;]*[a-zA-Z]$/;
export function isRealOutput(text) {
  return text.length > 3 && !TRIVIAL_RE.test(text) && !ESCAPE_REMNANT_RE.test(text);
}

// Synchronized output (DEC mode 2026): a TUI brackets each repaint in
// ?2026h ... ?2026l so the terminal shows it whole. Codex draws its bottom
// pane — composer, status line, and every dialog and picker — that way, so
// the last complete frame is the pane as it stands: the picker while it is
// open, the bare prompt once it is answered. detectState reads it in place of
// the five-line window, which for Codex holds whatever last got a newline and
// so keeps an answered dialog's text long after the screen let it go.
//
// A pty read is not a frame, nor even a whole marker: an open frame's body is
// carried between reads, and so are the last few bytes before a frame, so a
// marker cut by a read boundary is still found — a lost end marker would
// otherwise glue the next repaint onto a stale one, head first, and the
// answered dialog would be back. A begin marker inside an open frame restarts
// it: that is a new repaint. A frame whose text is nothing but cursor-shape
// remnants and whitespace — Codex blinks those while idle — is not a repaint
// of the pane and leaves the last real frame in place. The raw bound keeps
// the head; the text kept for matching is the head AND the tail, since a
// dialog states its question first and lists its answers last, and the agent
// controls how long whatever sits between them runs.
//
// Not every frame is the whole pane. Codex repaints just the option rows
// when the user arrows through a picker, re-inserts history boxes frame by
// frame after a resize, and prints each history line ("• Permissions
// updated …") as a frame of its own. A frame that carries the composer or
// the status row is the pane and replaces what was held; any other frame is
// a partial repaint and is merged onto it. The caller says which is which
// (`pane`), since the status row names the working directory. What that
// rule still cannot know is the screen itself — a terminal screen model is
// the full answer; see TODOS.md.
//
// A frame left open for more than a second is abandoned: no repaint takes
// that long, and a writer that died mid-frame must not swallow the rest of
// the session into a body that never closes.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const MARKER_LEN = SYNC_BEGIN.length;
export const FRAME_RAW_MAX = 64 * 1024;
export const FRAME_TEXT_MAX = 2000;
// Returns what this read contributed OUTSIDE any frame — the line stream the
// handler should reassemble — and how many bytes of the previous read turned
// out to be the head of a marker straddling the two, so the handler can
// take them back out of its carry. A frame's bytes are a repaint, never line
// text: left in the line stream, a cancelled picker's text would still be
// "the last line" for as long as the next 2000 bytes took to arrive.
export const FRAME_OPEN_MAX_MS = 1000;
export function trackSyncFrames(session, data, now = Date.now(), { pane = () => true } = {}) {
  if (typeof data !== 'string' || data.length === 0) return { outside: '', straddle: 0 };
  if (typeof session.frameOpen === 'string' && now - (session.frameOpenedAt || now) > FRAME_OPEN_MAX_MS) {
    session.frameOpen = null;   // abandoned; what it held is neither pane nor line text
    session.frameTail = '';
  }
  let open = typeof session.frameOpen === 'string';
  const prefix = open ? session.frameOpen : (session.frameTail || '');
  let buf = prefix + data;
  // Where buf[0] sits in `data` (negative while the prefix is still in front).
  let pos = -prefix.length;
  let at = open ? Math.max(0, prefix.length - (MARKER_LEN - 1)) : 0;
  let outside = '';
  let straddle = 0;
  for (;;) {
    const begin = buf.indexOf(SYNC_BEGIN, at);
    const end = open ? buf.indexOf(SYNC_END, at) : -1;
    if (open && end !== -1 && (begin === -1 || end < begin)) {
      const text = stripAnsiComplete(buf.slice(0, Math.min(end, FRAME_RAW_MAX))).replace(/\s+/g, ' ').trim();
      if (isRealOutput(text)) {
        const kept = !pane(text) && session.lastFrame ? `${session.lastFrame} ${text}` : text;
        session.lastFrame = kept.length > 2 * FRAME_TEXT_MAX
          ? `${kept.slice(0, FRAME_TEXT_MAX)} … ${kept.slice(-FRAME_TEXT_MAX)}`
          : kept;
        session.lastFrameAt = now;
      }
      buf = buf.slice(end + MARKER_LEN);
      pos += end + MARKER_LEN;
      open = false;
      at = 0;
      continue;
    }
    if (begin !== -1) {
      if (!open) {
        // Text before the marker is line text — the part of it in THIS read.
        outside += buf.slice(Math.max(0, -pos), begin);
        if (pos + begin < 0) straddle = -(pos + begin);   // the marker began in the previous read's tail
      }
      buf = buf.slice(begin + MARKER_LEN);
      pos += begin + MARKER_LEN;
      open = true;
      session.frameOpenedAt = now;
      at = 0;
      continue;
    }
    break;
  }
  if (open) {
    // Text past the cap is dropped, markers are not: the body keeps its last
    // few bytes past the cap, so a marker straddling the next read is still
    // found and the frame still closes.
    session.frameOpen = buf.length > FRAME_RAW_MAX
      ? buf.slice(0, FRAME_RAW_MAX - (MARKER_LEN - 1)) + buf.slice(-(MARKER_LEN - 1))
      : buf;
    session.frameTail = '';
  } else {
    outside += buf.slice(Math.max(0, -pos));
    session.frameOpen = null;
    session.frameTail = buf.slice(-(MARKER_LEN - 1));
  }
  return { outside, straddle };
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
  // A TUI that repaints inside synchronized-output frames (Codex does; Claude
  // Code does not) tells us what is on screen NOW: its last frame. That is the
  // dialog when one is open, and the bare prompt once it is answered. The
  // five-line window below is for everything else — and is exactly what went
  // stale for Codex, which redraws with cursor moves rather than newlines, so
  // an answered picker's text sat in the window until five real lines pushed
  // it out, with the bubble showing the whole time.
  //
  // The newer source speaks. A frame older than the last whole LINE printed
  // outside one is a program that stopped painting in frames — a shell tab
  // that ran one such tool and then launched Claude Code — and the window is
  // current again. Whole lines, not bytes: while a dialog waits, Codex writes
  // its window title outside any frame every second, which strips to nothing
  // whole but to a remnant when a read boundary falls inside it, and a
  // remnant must not outrank the dialog. (A tie goes to the frame.)
  const frame = typeof session.lastFrame === 'string' && (session.lastFrameAt || 0) >= (session.lastLineAt || 0)
    ? session.lastFrame : '';
  if (frame) {
    for (const pattern of messages) {
      if (pattern.test(frame)) return 'MESSAGE';
    }
  } else {
    for (const line of session.recentStrippedLines) {
      for (const pattern of messages) {
        if (pattern.test(line)) return 'MESSAGE';
      }
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
