# TODOS

## Agent messages go into anything that is not a recognised dialog
- **What:** `server/messages.js` types a message plus Enter into an agent whose
  state is WAITING, and WAITING means "no MESSAGE_PATTERNS match", not "its idle
  composer is on screen". A dialog a new CLI release words differently reads as
  WAITING and the Enter answers it (usually option 1, "Yes"). Deliver only on a
  positive match of each CLI's composer instead: Codex's `›` row and its
  "<model> · <cwd>" status row (see `isCodexPane` in server/pty.js), and a
  Claude Code equivalent, both verified against captured PTY output.
- **Why:** The Codex trust dialog was already answered this way once during
  development; patching MESSAGE_PATTERNS one dialog at a time is a denylist.
- **Effort:** M (human: ~1 day / CC: ~45 min, most of it capturing real panes)
- **Priority:** P2
- **Depends on:** Agent messaging (v0.4.4.0)
- **Context:** Raised by the security specialist, red team and adversarial
  review during /ship (2026-09-22); listed under Known limits in
  docs/designs/agent-messaging.md.

## Office canvas has no vertical overflow handling for many pods
- **What:** `computePodLayout` clamps only the top of the arrangement; enough
  pods (e.g. many single-agent repos) flow past `panelHeight`, so those desks
  render off-canvas and their click targets are unreachable, with no
  indicator. The old uniform grid had the same failure class (~19 agents on a
  700px panel); per-repo pods reach it with fewer agents when repos are
  diverse. Needs a design call: shrink desks, scroll the floor, or an
  overflow badge.
- **Why:** Agents silently vanishing from the office is the worst way to hit
  a capacity limit — nothing tells the user the room is over-full.
- **Effort:** M (human: ~1 day / CC: ~30 min once the design is chosen)
- **Priority:** P3
- **Depends on:** Per-repo pods (v0.3.18.0)
- **Context:** Raised by the adversarial review during /ship (2026-08-31).
  Deferred rather than guessed: all three remedies change the room's look,
  which is a taste decision.

## Bound the agents kept in Review
- **What:** Put a limit on the live agents a repo keeps in Review: an idle
  timeout after `reviewAt` that closes the PTY but keeps the worktree as an
  orphan to re-adopt, or a second, higher per-repo cap that counts them.
- **Why:** Since v0.4.8.0 a Review card keeps its agent (a CLI process, a PTY,
  a ring buffer and a worktree) until the card is done, and the per-repo cap
  only counts In progress. A card that needs no PR only reaches Done by hand
  (a closed PR files its card since v0.4.10.0), so on a board nobody tidies
  these add up.
  Schedules are bounded since v0.4.9.0 (at most one unfinished run each, and
  newer no-PR runs supersede older ones), so this is about one-time cards.
- **Effort:** S (human: ~3 hours / CC: ~20 min)
- **Priority:** P2
- **Depends on:** Review keeps its agent (v0.4.8.0)
- **Context:** Raised by the performance specialist and the adversarial review
  during /ship (2026-09-24). Keeping Review agents outside the cap was a
  deliberate choice; this is the guard for when it bites.

## Back off the merge check on long-lived Review cards
- **What:** Record a `lastMergeCheckAt` on each job and let `checkMergedPullRequests`
  skip cards it checked recently — every scan for the first hour after `reviewAt`,
  then hourly. Optionally memo "no account can see this repo" for the rest of a
  scan so N jobs in one unreachable repo do not each walk every gh account.
- **Note:** Since v0.4.10.0 a closed PR files its card too, so only open PRs
  and superseded PR numbers remain here.
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
- **Note:** A schedule's runs are already capped at 50 finished per schedule
  (v0.4.9.0); this is about one-time cards.
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

## MCP config file is not owner-only on Windows
- **What:** `server/agent-mcp.js` writes the agent's bearer token to `~/.agent-007/mcp/<port>/` with `mode: 0o600` plus `chmod`. Windows has no POSIX mode bits, so the file inherits the directory's ACL instead. Decide whether that is acceptable (the default dir sits under the user profile, which is user-scoped on typical installs) or set an explicit owner-only ACL there.
- **Why:** The file holds a live credential; `0600` is the whole protection on POSIX and it is silently absent on Windows. `AGENT007_MCP_DIR` can also point anywhere.
- **Effort:** S (human: ~2 hours / CC: ~20 min), mostly deciding the threat model.
- **Priority:** P3
- **Depends on:** Nothing
- **Context:** Surfaced while making the test suite pass on Windows (2026-08-30): the mode assertions are skipped there rather than weakened on POSIX.

## Pre-trust Codex board worktrees

- **What:** Board-dispatched Claude Code workers skip the workspace-trust
  dialog (server/claude-trust.js). Codex workers still stop at Codex's
  "Trust and continue" dialog in every new worktree.
- **Why:** Same as for Claude Code: unattended dispatch needs one click per
  Codex card today.
- **Effort:** S. Codex records trust per path in `~/.codex/config.toml`
  (`[projects."<path>"] trust_level = "trusted"`), or it may take a
  `-c projects...` override on the command line, which would avoid writing
  the file, but the worktree path is not known when `buildJobCommand` runs.
- **Priority:** P3
- **Context:** Left out of the Claude Code change (2026-09-25) because it means
  editing TOML the user owns, or reworking where the command is built.

## Hand the board tool to Gemini agents

- **What:** Gemini still receives no board MCP configuration. Investigate a
  per-session integration that preserves the user's persistent settings.
- **Why:** Gemini is offered as a spawn preset but cannot discover the board.
- **Priority:** P3
- **Context:** Claude Code and Codex now receive the board automatically. Codex
  uses per-invocation config overrides and a stdio bridge reading the same
  per-session credential file as Claude.

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

## Collaborative mode

## Token rotation / expiry + non-URL WS auth
- **What:** Support short-lived / rotatable session tokens and stop sending the bearer token as a `?token=` query param on the WebSocket handshake (use `Sec-WebSocket-Protocol` or a one-time token-exchange → cookie).
- **Why:** Today's tokens are 256-bit but permanent, and the WS handshake URL (token included) routinely lands in reverse-proxy/Tailscale access logs. A leaked handshake log = a permanent credential. Rotation/expiry bounds the blast radius; moving auth off the URL removes the log-exposure path.
- **Effort:** M (human: ~1 day / CC: ~30-45 min)
- **Priority:** P2
- **Depends on:** Multiplayer phase 1 (identity & auth) — shipped.
- **Context:** Raised by adversarial + security review of the phase 1 auth PR (2026-07-18). Accepted as a known limitation for now: the app itself doesn't log request URLs and deployment is behind Tailscale, so exposure is bounded. Revisit when auth hardens further (phase 2+).

## A job title that begins with a dash reaches the agent CLI as a flag

- **What:** `buildJobCommand` hands the prompt to the CLI as a positional
  argument, and the prompt begins with the card title. A title such as
  `-c sandbox_mode=x` is parsed by Codex (clap) as an option, and one such as
  `--dangerously-skip-permissions` by Claude Code (commander), rather than as
  the prompt. In practice the trailing prompt text makes most values invalid
  and the spawn fails, but the argv position is unguarded for both CLIs.
- **Why:** A card title comes from a person or from an agent posting through
  the board's MCP tool, and the whole point of the permission mode is that
  the spawned argv is decided by the board, not by the card.
- **Fix:** A `--` separator before the prompt, which both parsers honour.
  For Claude the `--add-dir` flags must move ahead of it (they follow the
  prompt today and the argv-position tests depend on that), and the change
  wants verifying against both CLIs — Codex was not installed on the machine
  that raised this.
- **Effort:** S (human: ~1h / CC: ~10 min)
- **Priority:** P3
- **Depends on:** None
- **Context:** Raised by the security specialist and the adversarial review
  during /ship for v0.4.1.0 (2026-09-14). Pre-existing for Claude; the Codex
  branch added a second parser with the same exposure.

## A rejected job save throws away what you typed

- **What:** `saveForm` in public/modules/jobs.js sends `job-update` and calls
  `closeForm()` unconditionally, before the server has answered. When the save
  is refused — the card was dispatched a moment ago, an attachment is too large,
  a cron does not parse — the toast arrives after the form and its contents are
  gone. Keeping the form open until an ack (the ws protocol has no ack for
  job-update today, so one has to be added) fixes all of them at once.
- **Why:** Pre-existing for the attachment and schedule refusals, but the To-do
  gate widens it to the common case: retitling a card the dispatcher happens to
  pick up in the same second now loses the edit instead of applying it.
- **Effort:** S (human: ~3h / CC: ~20 min)
- **Priority:** P3
- **Depends on:** To-do-only editing (v0.3.29.0)
- **Context:** Raised by the adversarial review during /ship (2026-09-03).

## A wander claim is an index into an array rebuilt every frame

- **What:** `seatClaims` maps a session to an INDEX into `currentSeats`, which
  `renderOffice` rebuilds from scratch on every frame. Any reader that indexes
  a different list, or any frame where the pool's composition shifts without
  tripping the invalidation key, silently re-points a claim at unrelated
  furniture. Storing the seat object (or a stable id) on the claim instead of
  its position deletes the whole class.
- **Why:** Three separate bugs of exactly this shape surfaced in one review:
  `setupOfficeClick` indexing `conf.seats` with a pooled index (a live crash),
  `drawConference` doing the same (latent, correct only by an ordering
  accident), and count-only invalidation aliasing a 6-seat conference pool onto
  a 6-seat sofa pool. The current key (length + conference-seat count) still
  cannot separate a left-chat-only pool from a right-chat-only one — both are 9
  seats with 6 conference seats — so a sitter could teleport across the room.
  Narrow to reach, but the third instance of a class is a design signal.
- **Effort:** S (human: ~3h / CC: ~30 min)
- **Priority:** P3
- **Depends on:** Sofa wander (v0.3.30.0)
- **Context:** Raised by the adversarial review during /ship (2026-09-03),
  after two instances had already been fixed in the same round.

## chatSeats restates drawDecor's sofa layout instead of reading it

- **What:** The sofa positions exist three times: `drawDecor` draws them,
  `chatSeats` re-derives the same arithmetic to seat sitters on them, and the
  test re-derives it a third time from hardcoded literals. Nothing binds any of
  the three, so refactoring `drawDecor`'s inline positions moves the sofas out
  from under the sitters and only the two copies that already agree would fail.
- **Why:** The seats and the furniture they sit on must not be able to drift
  apart silently. The draw-recording harness (`sofaOffice`) can already read
  real sprite draws out of a frame, so asserting seats against the sofas
  `drawDecor` actually drew is within reach.
- **Effort:** S (human: ~2h / CC: ~20 min)
- **Priority:** P3
- **Depends on:** Sofa wander (v0.3.30.0)
- **Context:** Raised by the testing specialist during /ship (2026-09-03).

## The wander's read-only-colleague guard is untested

- **What:** `canControlAgent(agent)` gates the wander so a colleague's agent
  keeps its desk (where its dimming and owner label live), but no test in the
  motion suite sets `ownerId` — `authEnabled` is not settable from the client
  harness. The set of states reaching that line just doubled, and WAITING is
  now the common resting state, so a colleague-owned agent is exactly the case
  that would walk off someone else's desk.
- **Why:** Pre-existing gap, newly load-bearing. The clause itself is unchanged
  by v0.3.30.0 but far more of the state space now reaches it.
- **Effort:** S (human: ~1h / CC: ~15 min)
- **Priority:** P3
- **Depends on:** Multiplayer phase 3 (colleague rendering)
- **Context:** Raised independently by the coverage audit and the testing
  specialist during /ship (2026-09-03).

## The wander seat pool is rebuilt every frame

- **What:** `renderOffice` calls `wanderSeats(currentConf, decor)` on every
  animation frame, allocating a fresh pool (~12 objects, 6 arrays, 2 closures)
  from inputs that only change on canvas resize or agent spawn/exit —
  roughly 1,100 short-lived objects a second, all identical.
- **Why:** Modest against the existing per-frame baseline (`computeOfficeLayout`
  and `walkObstacles` already allocate ~3N+30 objects a frame), so this is
  young-gen churn rather than a visible cost. `drawMotion`'s `routeOf` already
  shows the memoization shape to copy.
- **Effort:** S (human: ~1h / CC: ~10 min)
- **Priority:** P4
- **Depends on:** Sofa wander (v0.3.30.0)
- **Context:** Raised by the performance specialist during /ship (2026-09-03).

## wanderRoute carries two seat shapes discriminated by nullishness

- **What:** `wanderRoute` accepts a sofa seat (carrying `lane`/`yPref`) and a
  conference seat (needing a non-null `conf`), told apart by `??` rather than
  by the `kind` field both already have. `conf.table.y` is dereferenced
  unguarded, and the walk-back path reconstructs a seat from anim fields that
  are undefined for conference seats, so the shape is carried by absence. Give
  conference seats their `lane`/`yPref` in `wanderSeats` and both branches and
  the `conf` parameter itself can go.
- **Why:** Advisory, not a defect — every current caller is correct. But the
  contract is undeclared, and the same class of undeclared contract (a claim
  index addressing one list while a reader reached for another) is what
  produced the click-handler crash caught in this same review.
- **Effort:** S (human: ~2h / CC: ~20 min)
- **Priority:** P4
- **Depends on:** Sofa wander (v0.3.30.0)
- **Context:** Raised by the simplification and maintainability specialists
  during /ship (2026-09-03).

## Session MCP tokens sit in a sibling directory of the worktrees

- **What:** `MCP_CONFIG_DIR` is `~/.agent-007/mcp/<port>/` (`server/agent-mcp.js`)
  and `WORKTREE_DIR` is `~/.agent-007/worktrees/` (`server/state.js`). They are
  siblings, and every board agent's cwd is inside the second one, so
  `../../mcp/<port>/*.json` reaches every live session's bearer token. Move the
  token files somewhere a worktree cannot walk to with two `..` segments, and
  give each dispatched session only its own.
- **Why:** `resolveAgentToken` maps a token to its session and `server/http.js`
  derives the MCP caller's identity from that session's `ownerId`, so a stolen
  token makes the caller that other user and `editJobForAgent`'s
  `job.postedBy !== asker` check passes. That is the ownership rule the board's
  agent-facing writes rest on. The 0600/0700 modes do not help: same UID.
- **Effort:** S (human: ~2 hours / CC: ~15 min)
- **Priority:** P2
- **Depends on:** Board MCP credential (v0.3.0.0)
- **Context:** Found by the adversarial review during /ship for v0.3.33.0
  (2026-09-04), which made it matter: board agents now dispatch with
  `bypassPermissions`, so reading outside the worktree no longer prompts.
  Fixing this does not restore a boundary against a hostile agent -- ungated
  Bash means there is none -- it removes a needless one-command path to every
  other session's identity, and lets DESIGN.md's ownership rule mean what it
  says for an agent that is merely confused. `USERS_PATH` is a sibling too and
  `loadUsers()` re-reads on mtime with no restart; same directory-layout fix.

## A board agent that dies seconds after spawn leaves its card stuck forever

- **What:** `dispatchOnce` treats a successful `createSession` as a successful
  dispatch. If the spawned `claude` exits immediately -- a flag its runtime
  rejects, a missing binary, a crash on startup -- the PTY spawn still
  succeeded, so `result.error` is null, the card takes `agentSessionId`, a
  branch and a worktree, and moves to In progress. `deriveJobStatus` then shows
  "agent gone" with `lastError` null, and nothing puts a one-time job back in To
  do, so it never retries. A schedule's run gets stuck the same way, and its
  schedule then holds off behind it. Treat an exit within a few seconds of dispatch as a dispatch
  failure: set `lastError` from the tail of the session's ring buffer and
  requeue the card.
- **Why:** The card gives no reason and offers no retry, so the only way to find
  out why a job never ran is to open the dead terminal tab and read the error
  the process printed before it died.
- **Effort:** S (human: ~3 hours / CC: ~20 min)
- **Priority:** P3
- **Depends on:** Job board (v0.3.0.0)
- **Context:** Noticed while tracing the `auto`-mode problem on Bedrock
  (2026-09-04), but it is NOT what happened there -- an unavailable auto mode
  starts the session in Manual rather than killing it, so that card stalled
  visibly instead of vanishing. Filed as a latent gap with no observed
  occurrence, hence P3. It has since been hit: before v0.4.2.1 a Codex card in
  `manual` mode dispatched with `--ask-for-approval untrusted`, a value
  codex-cli 0.153 rejects, so the agent died at parse time and the card sat in
  In progress with no reason (2026-09-16). That flag is fixed; the requeue is
  not, so the next rejected flag lands the same way.

## A scan tick uses the agent cap it started with, not the one in force

- **What:** `dispatchOnce` reads `boardSettings()` once (`const settings`) and
  uses `settings.maxPerRepo` for the whole tick, then awaits `createSession`
  once per candidate -- seconds each. `boardSettings()` returns a freshly
  merged object every call, so a concurrent `updateSettings` mutates a
  different object than the one the loop still points at, and a cap lowered
  mid-tick has no effect until the next scan. Re-read the setting per
  iteration, or document that a tick is deliberately atomic in its cap.
- **Why:** A user reaching for the cap is usually reacting to a board that is
  spawning too much right now, and the control quietly does nothing until the
  current tick drains. The permission mode had the same shape and was fixed in
  v0.3.33.0 (it re-reads `boardSettings()` at the post-await recheck, because
  there the stale value decides what a live agent is allowed to do); the cap is
  the same latent race with a smaller blast radius.
- **Effort:** S (human: ~1 hour / CC: ~10 min)
- **Priority:** P3
- **Depends on:** Job board (v0.3.0.0)
- **Context:** Found by the adversarial review during /ship for v0.3.33.0
  (2026-09-04), which flagged that making the toolbar controls reachable is
  exactly what gives users a reason to reach for one mid-crisis.

## Any board user can raise another user's queued card to bypassPermissions

- **What:** `server/ws.js`'s `job-update` is deliberately not ownership-gated
  ("the board is shared workspace state, not a per-user resource"), and as of
  v0.3.33.0 `permissionMode` rides that same door. So on a multi-user board any
  authenticated user can change someone else's To do card to
  `bypassPermissions` before it dispatches. Decide whether the permission mode
  specifically should be ownership-gated the way `editJobForAgent` already
  gates agent writes, or whether the shared-board model covers it.
- **Why:** Every other field on that door describes work; this one decides what
  the spawned agent is allowed to do to the machine. `editJobForAgent` already
  draws exactly this line for agents (`job.postedBy !== asker`), so the board
  has the notion of card ownership -- it is only the browser door that does not
  apply it. Consistent with the project's stated trust model (auth is identity,
  not a sandbox -- see server/auth.js), which is why this is a question rather
  than a bug.
- **Effort:** S (human: ~2 hours / CC: ~15 min)
- **Priority:** P3
- **Depends on:** Per-job permission mode (v0.3.33.0)
- **Context:** Raised by the adversarial review during /ship for v0.3.33.0
  (2026-09-04) as "worth the maintainer explicitly confirming that's
  acceptable". Only bites on a board with more than one user.

## State detection reads Codex's last repaint as the whole pane
- **What:** `trackSyncFrames` keeps the last DEC 2026 synchronized frame and
  `detectState` treats it as what is on screen. Codex repaints nothing while a
  dialog waits, so this holds today, but a partial repaint (the status row
  alone) would stand in for the pane and drop the "needs you" bubble until
  the dialog repainted. The full answer is a screen model: feed each TUI
  session's bytes to `@xterm/headless` at the tab's size and run the dialog
  patterns over the visible rows, so a closed dialog is simply not there and
  a partial repaint changes only its rows.
- **Why:** The bubble is what stops the board from calling a blocked agent
  "resting".
- **Effort:** M (human: ~1 day / CC: ~30 min, one new server dependency, and
  the headless terminal must follow `pty-resize`)
- **Priority:** P2
- **Depends on:** v0.4.2.3 (frame tracking)
- **Context:** Raised by the adversarial reviews during /ship (2026-09-16).
  The frame approach was chosen over the screen model to avoid the
  dependency; this is the upgrade when a partial repaint is observed.

## Completed

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
  rather than guessed. Second route into the same failure, found by the
  security review during /ship (2026-09-03): `isScheduledRunOver` also returns
  false on `state === 'MESSAGE'`, and MESSAGE is inferred from agent-controlled
  terminal output, so a repo whose agent's last line matches a dialog pattern
  pins its card just as effectively. v0.3.30.0 widened that pattern set, so the
  surface is slightly larger. The ceiling fixes both routes at once; anchoring
  individual patterns only ever chases one. And it is not adversary-only:
  `/approve|deny|allow|reject/i` matches those words ANYWHERE in any of the
  last five lines, so a git log, a LICENSE, a CI transcript or a dependency
  changelog can flip a quiet agent to MESSAGE by accident — which argues for
  treating this as ordinary-operation breakage rather than a hardening task.
- **Completed:** v0.4.9.0 (2026-09-24). A schedule now posts one-time run
  cards instead of running itself, so a run ends with `finish_job` rather than
  by going quiet, and a stuck run is an ordinary In progress card showing
  "running" or "needs you". The schedule holds off while it is stuck and says
  why on its card, so no firing is lost silently. There is still no maximum
  run duration; a run that never finishes has to be moved by hand.

## Don't auto-switch tabs on teammates' spawns
- **What:** `handleSessionCreated` calls `switchToSession` unconditionally, so in a multi-user deployment a teammate spawning an agent steals every viewer's active tab. Only auto-switch to sessions this client spawned (or when no session is active).
- **Why:** Tab-stealing interrupts whatever the viewer was doing; with voice input it also stops an in-flight dictation (a notice now flashes, but the interruption remains).
- **Effort:** S (human: ~2 hours / CC: ~5 min)
- **Priority:** P2
- **Depends on:** Nothing
- **Context:** Flagged by the red-team pass during the voice-input review (2026-08-24, v0.2.0.0). Pre-existing behavior, out of scope for the voice branch; the voice-side symptom was mitigated with a "Voice input stopped — switched agents" notice.
- **Completed:** v0.4.7.0 (2026-09-23)

## A card edited in the window dispatchOnce awaits in runs the old prompt

- **What:** `dispatchOnce` builds the command, branch and repo from the card,
  then awaits `createSession` (addRepo + `git worktree add` + PTY spawn) and
  only re-checks `state === 'todo'` afterwards. Throughout that multi-second
  await the card still reads `todo`, so `editableInPlace` lets an edit through:
  the agent then runs the OLD prompt in the OLD repo while the card advertises
  the new `repoPath`, and `branchName`/`worktreePath` are written from the old
  repo's session. `checkPullRequests` searches the new repoPath for that branch,
  never finds the PR, and the card sits in In progress forever. Fix belongs in
  `dispatchOnce` — stamp the claim before the await, or re-read the fields after
  `stillQueued` — not in the gate.
- **Why:** The window is pre-existing (the old `if (fields.repoPath && job.state
  === 'todo')` had it too), but it used to need a mistimed human click. With
  `edit_job` on the board's MCP surface it is something a program can hit on
  purpose, and the failure is silent: a card stuck in In progress with no error
  on it.
- **Effort:** S (human: ~2h / CC: ~20 min)
- **Priority:** P3
- **Depends on:** Board read/edit MCP tools (v0.3.29.0)
- **Context:** Raised by the adversarial review during /ship (2026-09-03).
- **Completed:** v0.4.1.0 (2026-09-14) — `dispatchOnce` now compares the spawned
  command and repository against the card after the await and abandons the
  spawn on any difference.

## Hand the board tool to Codex agents

- **What:** Connect every spawned Codex agent to the board's existing MCP tools.
- **Why:** Codex was offered as a spawn preset but could not discover the board.
- **Priority:** P3
- **Effort:** S
- **Context:** Codex receives a per-launch configuration override pointing to a
  local stdio bridge. The bridge reads the same per-session credential file as
  Claude Code and forwards requests to the board's authenticated endpoint.
  Gemini integration remains open above.

**Completed:** v0.4.0.0 (2026-09-11)

## The board permission mode is unreachable and unmigrated

- **What:** Two halves of the same gap. `server/ws.js` accepts `permissionMode`
  on the `job-settings` message, but nothing in `public/` ever sends it, so
  there is no way to change the mode from the app -- only by hand-editing
  `~/.agent-007/config.json` and restarting. And `boardSettings()` spreads the
  stored object over the defaults, so every board that has ever run has the
  old default persisted and keeps it: changing `DEFAULT_PERMISSION_MODE` only
  reaches installs that never saved one.
- **Why:** Together they mean a default change cannot reach an existing user at
  all, and the user cannot apply it themselves without leaving the app. A
  migration is not obviously safe on its own -- rewriting a stored `auto` would
  stomp a deliberate choice on a setup where the classifier works, and pinning
  the legacy value as "unset" would make `auto` unselectable -- so the control
  should probably come first, and the migration decided with it.
- **Effort:** S (human: ~3 hours / CC: ~20 min)
- **Priority:** P2
- **Depends on:** Job board (v0.3.0.0)
- **Context:** Raised by the ship coverage audit for v0.3.33.0 (2026-09-04).
  `test/jobs-permission-mode.test.js` documents the stored-mode behaviour as it
  stands, so a migration has to change that test deliberately.
- **Shape it should take:** a per-job permission mode on the card, defaulting to
  the board setting, with the board setting defaulting back to `auto`. Two
  levels, so a machine where auto is unavailable sets it once rather than per
  card, and the safe mode is what you get unless a job asks for more. `auto` is
  the right default on merit -- its classifier is the only thing reviewing a
  dispatched agent's actions, which matters most for a job whose prompt came
  from repo content. Adding the field is cheap: `jobsPayload()` spreads the
  whole job so it reaches the client for free, and the mode is only read at
  dispatch, which happens from To do, so `editableInPlace` refusing edits past
  To do is exactly the right gate.

- **Outcome:** Both halves closed in v0.3.33.0. The board's toolbar has a
  **permissions** select (the fallback), and the job form has a per-card one
  whose "Board default" option stores `null` rather than a copy of the board
  value -- so an unset card follows the board if that changes before it is
  dispatched. `buildJobCommand` resolves card-then-board-then-default, and the
  allowlist check stayed at the argv-building function as well as the settings
  boundary. The migration became decidable once the control existed: a stored
  mode with no `permissionModeChosen` flag is a default nobody picked, so it is
  ignored and `DEFAULT_PERMISSION_MODE` (back to `auto`) wins. Boards that had
  been running on `bypassPermissions` -- every board whose first dispatcher
  start happened on v0.3.33.0 -- move back to `auto`.

**Completed:** v0.3.33.0 (2026-09-04)


## Sofa sitter placement has never been checked against a render

- **What:** `chatSeats` positions its three sitters from the sofa sprites' BOX
  coordinates. `sofa_side.png` is a 16x32 box with art only in x 0-12, and the
  right-hand sofa is drawn mirrored, so its 3px of padding flips to the other
  side — the two side sitters sit 3px off-centre in opposite directions, a 6px
  asymmetry. Nothing has ever rendered this: the vitest ctx is a stub with no
  transform, so a mirrored `drawStanding` records at 0,0 and cannot be placed.
- **Why:** Not measured as wrong, only unverified — the character (32px) is
  wider than the painted sofa (26px) either way, so it covers the sofa
  regardless and the error may be invisible. The art spans are now documented
  in `SPRITE_PATHS`; the nudge itself should not be made blind, because the
  repo has already shipped one sprite-adjacency bug (the head chair floating
  63px clear of the table) that only a composited render caught.
- **Effort:** S (human: ~1h / CC: ~15 min)
- **Priority:** P3
- **Depends on:** Sofa wander (v0.3.30.0)
- **Context:** Raised by the coverage audit and the pre-landing review during
  /ship (2026-09-03). Needs eyes on a real canvas, not another unit test.
- **Outcome:** Checked against a live office (2026-09-04). The horizontal
  placement was already correct and the arithmetic that said otherwise was
  wrong twice: it anchored on the sofa's painted centre when the anchor is the
  SEAT (the backrest is part of the sprite), and it was compensating for the
  wrong sprite entirely. The real defect was that sitters drew the STANDING
  frame. Fixed in v0.3.30.1; the values were read off rendered comparisons,
  not computed.

**Completed:** v0.3.30.1 (2026-09-04)


## The conference walk-out lane skips the clear-column check

- **What:** `entryRoute`'s conference branch sends a foot-seat sitter down
  `confLanes(conf).left/right` chosen by table geometry alone, bypassing
  `approachX` entirely, so that one leg still descends over whatever lies
  between the set and the corridor — the exact defect `approachX` was added to
  fix, left in the branch that does not use it.
- **Why:** The conference set sits in open floor, so the lane is usually clear
  and nothing has been seen crossing furniture in practice. It is a correctness
  hole rather than an observed bug: nothing checks it.
- **Effort:** S (human: ~1h / CC: ~10 min)
- **Priority:** P4
- **Depends on:** Walk route aisles (v0.3.28.0)
- **Context:** Raised by the adversarial review during /ship (2026-09-02).

**Completed:** v0.3.29.2 (2026-09-03)

## Walk routes are recomputed every frame, so a spawn can teleport a walker

- **What:** `drawMotion` rebuilds each walker's path from live obstacles every
  frame while its distance advances on wall-clock time, so any change to
  `path.total` re-projects the walker somewhere else along a different route.
  Measured at 900x800 with 2 repos: agent `a2`'s desk does not move between 7
  and 8 agents, but its approach column jumps 66px and its path grows 132px, so
  an unrelated spawn mid-walk snaps it sideways. Fix is to freeze the path on
  the anim when it starts (and rebuild only on resize), not to make the pickers
  stabler.
- **Why:** Pre-existing — `corridorY` always had this property — but `approachX`
  adds a second discontinuous decision and the sidestep adds real length to
  `total`, so a jump that used to be invisible now moves the walker a desk
  over. Only visible when an agent spawns or exits during someone else's 2-5s
  walk, which is exactly what a busy board does.
- **Effort:** S (human: ~2h / CC: ~15 min)
- **Priority:** P3
- **Depends on:** Walk route aisles (v0.3.28.0)
- **Context:** Raised by the adversarial review during /ship (2026-09-02),
  measured but not fixed then: freezing the path changes how resize behaves
  mid-walk, which wanted its own look. Resolved by rebuilding on resize only,
  so a mid-walk resize is the one place the route still moves.

**Completed:** v0.3.29.1 (2026-09-03)
