# TODOS

## server.test.js fails to load under vitest on Windows
- **What:** `test/server.test.js` fails at collection with `SyntaxError: Invalid or unexpected token` importing `../server.js` — vitest can't load node-pty's native `.node` binary through the `server.js → server/pty.js → node-pty` chain on Windows. Likely fix: externalize node-pty in `vitest.config.js` (`test.server.deps.external`) or mock `server/pty.js` in the suite.
- **Why:** The server integration suite (auth handshake, WS behavior) never runs on Windows dev machines, so Windows contributors ship those paths untested locally. CI (ubuntu) still runs it green, so the gap is local-only.
- **Effort:** S (human: ~1-2 hours / CC: ~15-30 min)
- **Priority:** P0
- **Depends on:** Nothing
- **Context:** Found by /ship test triage on `lawson-wong/daiquiri` (2026-08-26). Reproduces identically on unmodified `main` code in a fresh worktree, so it is pre-existing and environment-specific, not branch-caused.

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
