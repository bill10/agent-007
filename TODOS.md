# TODOS

## A scheduled run that never goes quiet starves its schedule silently
- **What:** A scheduled run only ends on agent exit or WAITING past the quiet
  window, so an agent wedged producing output (a spinner, a loop) holds the
  card at "running now" forever: no attention badge (scheduled cards badge only
  on MESSAGE), no notification, and every future firing is silently lost until
  a human notices and clicks End run. Add a max-run-duration ceiling (a board
  setting, since "too long" varies by job) or at least surface "running for
  N× its interval" on the card and the badge.
- **Why:** The board's promise is unattended recurrence; a single wedged run
  breaks that promise invisibly, which is the worst way to break it.
- **Effort:** S (human: ~2 hours / CC: ~15 min)
- **Priority:** P2
- **Depends on:** Scheduled jobs (v0.3.12.0)
- **Context:** Raised by the adversarial review during /ship (2026-08-30). A
  ceiling is policy, so it needs a knob, not a hardcoded constant — deferred
  rather than guessed.

## Back off the merge check on long-lived Review cards
- **What:** Record a `lastMergeCheckAt` on each job and let `checkMergedPullRequests`
  skip cards it checked recently — every scan for the first hour after `reviewAt`,
  then hourly. Optionally memo "no account can see this repo" for the rest of a
  scan so N jobs in one unreachable repo do not each walk every gh account.
- **Why:** Unlike In progress, the Review set does not self-drain. A PR closed
  without merging, or a card whose `prNumber` was superseded by a PR the board
  never saw, is polled every five minutes for the life of the board. Each poll is
  a `gh pr list` per signed-in account until one answers, and `runScan`'s
  in-flight guard means dispatch waits behind the sweep. At tens of jobs this is
  small; it just never stops.
- **Effort:** S (human: ~2 hours / CC: ~15 min)
- **Priority:** P3
- **Depends on:** Merge-to-Done sweep (v0.3.11.0)
- **Context:** Raised by the performance specialist during /review (2026-08-28).
  Deliberately not built with the sweep: a merged PR should leave the board
  promptly, and backoff trades that promptness for subprocess count. The gh
  account/token memo (`GH_AUTH_TTL_MS`) landed instead, which removes the
  repeated `gh auth status` / `gh auth token` spawns without delaying anything.

## Retention for finished jobs
- **What:** Cap what the Finished jobs view renders (most recent N, with a way to
  see the rest) and/or drop `done` jobs older than N days on load.
- **Why:** Finished jobs are kept forever by design, and every one of them is
  serialized into every `jobs-list` broadcast and rebuilt on each archive render.
  Nothing prunes them and nothing paginates, so both costs grow for the life of
  the install.
- **Effort:** S (human: ~3 hours / CC: ~15 min)
- **Priority:** P3
- **Depends on:** Finished jobs view (v0.3.11.0)
- **Context:** Raised by the performance specialist during /review (2026-08-28).
  Not built with the view because the request was to show ALL finished jobs, and
  a silent cap contradicts that. Retention is a policy the user should choose.

## Pre-seed workspace trust for board-dispatched agents

- **What:** Before the job board spawns an agent, write `hasTrustDialogAccepted`
  for the new worktree path into `~/.claude.json` so the agent starts working
  immediately instead of stopping at Claude Code's workspace-trust prompt.
- **Why:** Every board agent gets a brand-new worktree, and Claude Code shows
  the trust dialog the first time it runs in any directory, so every dispatched
  job currently needs one human click before it starts. That is the single
  thing standing between the board and genuinely unattended dispatch. Verified
  against claude 2.1.250: `--permission-mode acceptEdits`, `bypassPermissions`
  and `--dangerously-skip-permissions` all still show it; per `claude --help`
  it is skipped only in non-interactive `-p` mode, which defeats the point of
  having a terminal you can take over.
- **Effort:** S (human: ~2 hours / CC: ~10 min), most of it verification.
- **Priority:** P2
- **Depends on:** Job board (v0.3.0.0)
- **Context:** Deliberately not built with the board (2026-08-27). It writes a
  file outside the app that Claude Code rewrites constantly, so the read-modify-write
  races; and pre-granting trust on the user's behalf is their call, not the
  app's. If built, it should be an opt-in board setting, default off. Note that
  pre-seeding was never verified to work — a test using a throwaway `HOME` was
  invalid (the control case also passed, so claude was not really starting), and
  whether trust is inherited from a parent directory is also unverified. Settle
  both before building. Until then the board surfaces the dialog as "needs you"
  so it takes one click, not a mystery.

## Hand the board tool to non-Claude agents

- **What:** `POST /api/jobs` accepts an agent session token and does everything
  the MCP tool does, but nothing gives a Codex or Gemini agent that token, so
  the door exists and no one can walk through it. Decide how those agents learn
  it: an env var (the shape rejected for Claude agents, since every child
  process inherits it), a `codex mcp add` / `gemini mcp add` written at spawn
  into their persistent config plus a matching removal on exit, or accept that
  this is Claude-only and say so in the README.
- **Why:** The spawn command is user-configurable, so a user who runs `codex`
  or `gemini` today gets no board tool and no explanation of why. Right now the
  README implies the board is reachable from "every agent terminal".
- **Effort:** S (human: ~2-3 h / CC: ~20 min)
- **Priority:** P3
- **Depends on:** Nothing.
- **Context:** Verified during the MCP PR (2026-08-28): Gemini CLI has no
  per-invocation MCP config flag, only `gemini mcp add` writing persistent
  settings; Codex configures MCP through `~/.codex/config.toml`. Both would need
  a write-then-clean-up dance that the per-session file for Claude avoids.

## Diff-between-agents for conflict files
- **What:** When a conflict is detected (two agents modified the same file), clicking the warning icon shows both agents' diffs for that file side-by-side or sequentially.
- **Why:** Makes conflict detection actionable instead of just a passive warning. Without this, users see "conflict" but can't easily compare what each agent did.
- **Effort:** S-M (human: ~4 hours / CC: ~10 min)
- **Priority:** P2
- **Depends on:** Phase 2 (inline diff viewer) + Phase 3 (conflict detection)
- **Context:** Identified by outside voice review during CEO review (2026-03-24). The reviewer argued conflict detection without an action path is "theater." This TODO makes it actionable.

## ARIA accessibility roles
- **What:** Add proper ARIA roles and labels to interactive elements: `tablist`/`tab` on terminal tabs, `treeitem` on explorer branches, `aria-label` on status dots and icon buttons.
- **Why:** Keyboard-only and screen reader users cannot navigate the app effectively. Explorer branches, terminal tabs, and file entries are all clickable but have no semantic roles.
- **Effort:** S (human: ~4 hours / CC: ~10 min)
- **Priority:** P3
- **Depends on:** Nothing
- **Context:** Identified by design review subagent (2026-03-26). Focus-visible ring was added but semantic roles are still missing across the app.

## stripAnsiComplete charset designation bug
- **What:** The regex `/\x1b[=>()]/g` in `stripAnsiComplete` strips `ESC(` but leaves the designator character (e.g., `B` from `ESC(B`). Fix: `/\x1b[=>()]./g` to consume the next character too.
- **Why:** Can leave stray characters in stripped output, potentially causing false positives in state detection prompt/message matching.
- **Effort:** XS (human: ~5 min / CC: ~2 min)
- **Priority:** P3
- **Depends on:** Nothing
- **Context:** Identified during eng review (2026-03-26). Currently masked because `strip-ansi` v7 handles most charset sequences before our regex runs, but edge cases may slip through.

## npm global install + CLI UX
- **What:** Add `bin` entry, `--help`/`--version`/`--port` flags, `.npmignore`, and `npm publish` workflow so users can `npm install -g agent-007`.
- **Why:** Dramatically lowers Time-To-Hello-World from clone+install+start to one command.
- **Effort:** M (human: ~4-8 hours / CC: ~15-30 min)
- **Priority:** P2
- **Depends on:** Stable (non-beta) node-pty release, npm account setup
- **Context:** Deferred from v0.1.0 open-source launch per outside voice review (2026-04-06). The current `node-pty ^1.2.0-beta.12` has inconsistent prebuilds, and the server has no CLI argument parsing. Ship clone-and-run first, npm publish when CLI UX is ready.

## Don't auto-switch tabs on teammates' spawns
- **What:** `handleSessionCreated` calls `switchToSession` unconditionally, so in a multi-user deployment a teammate spawning an agent steals every viewer's active tab. Only auto-switch to sessions this client spawned (or when no session is active).
- **Why:** Tab-stealing interrupts whatever the viewer was doing; with voice input it also stops an in-flight dictation (a notice now flashes, but the interruption remains).
- **Effort:** S (human: ~2 hours / CC: ~5 min)
- **Priority:** P2
- **Depends on:** Nothing
- **Context:** Flagged by the red-team pass during the voice-input review (2026-08-24, v0.2.0.0). Pre-existing behavior, out of scope for the voice branch; the voice-side symptom was mitigated with a "Voice input stopped — switched agents" notice.

## Collaborative mode

## Token rotation / expiry + non-URL WS auth
- **What:** Support short-lived / rotatable session tokens and stop sending the bearer token as a `?token=` query param on the WebSocket handshake (use `Sec-WebSocket-Protocol` or a one-time token-exchange → cookie).
- **Why:** Today's tokens are 256-bit but permanent, and the WS handshake URL (token included) routinely lands in reverse-proxy/Tailscale access logs. A leaked handshake log = a permanent credential. Rotation/expiry bounds the blast radius; moving auth off the URL removes the log-exposure path.
- **Effort:** M (human: ~1 day / CC: ~30-45 min)
- **Priority:** P2
- **Depends on:** Multiplayer phase 1 (identity & auth) — shipped.
- **Context:** Raised by adversarial + security review of the phase 1 auth PR (2026-07-18). Accepted as a known limitation for now: the app itself doesn't log request URLs and deployment is behind Tailscale, so exposure is bounded. Revisit when auth hardens further (phase 2+).
