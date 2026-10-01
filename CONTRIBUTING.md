# Contributing to Agent 007

Contributions are welcome! This project is intentionally simple: vanilla JS, no build step, no framework. That's on purpose to keep the barrier to entry low.

## Prerequisites

- **Node.js 20.12+**
- **Git**

`node-pty` ships prebuilt binaries for macOS, Linux and Windows (x64 and arm64), so `npm install` normally compiles nothing. If it does try to build `node-pty` and fails, see [Troubleshooting](README.md#troubleshooting) in the README.

## Setup

```bash
git clone https://github.com/bill10/agent-007.git
cd agent-007
npm install
```

## Development

```bash
npm run dev    # Start with --watch (auto-restart on changes)
npm start      # Start without watch
```

Open http://localhost:7007 in your browser.

## Testing

```bash
npm test          # Run all tests once
npm run test:watch  # Run tests in watch mode
```

Tests live in `test/`. We use [Vitest](https://vitest.dev/).

- `test/account-rotation.test.js` -- Account enrollment defaults and saved off settings, ordering, refreshed credentials, cooldowns, rollback and crash recovery; `test/claude-rotation-sessions.test.js` covers exact conversation IDs, preserved startup options, stopping every managed Claude session, failed restarts and external-process checks. `test/account-rotation-server.test.js` exercises the owner socket with real PTYs, stable session/job links, queued messages retained after a restart failure, Settings retry and the interrupted-switch spawn block. `test/client-account-panel.test.js` covers discovery, settings, recovery controls and visible errors.
- `test/helpers.test.js` -- Pure function unit tests (state detection, including that `MESSAGE_PATTERNS` match each CLI's real dialog wording and not prose about permissions, and that `detectState` reads a Codex session's last synchronized-output frame in place of the five-line window while the frame is the newer source; ANSI stripping, git parsing, file-name sanitising, the UTF-8 locale a pty gets when the server has none)
- `test/pty-chunking.test.js` -- Drives the real PTY output handler with captured bytes cut at read boundaries: line reassembly across chunks, and the DEC 2026 synchronized frames Codex paints its pane in (a marker split across reads, a partial repaint merged onto the pane, a frame abandoned after 1s, frame bytes kept out of the line stream, frames read for Codex sessions only). The captures live in `test/fixtures/`: a Claude Code AskUserQuestion dialog, and the Claude Code 2.1 Bash and edit permission dialogs
- `test/server.test.js` -- Integration tests (HTTP API including the job attachment route, WebSocket, PTY lifecycle including a command that is not installed coming back as a readable spawn error, a terminal shown in two windows taking the smaller owner window's size)
- `test/client-dom-patch.test.js` -- The keyed in-place list update the Jobs and Billion tabs redraw with (`public/modules/dom-patch.js`): an unchanged item kept as the same node, a changed one swapped in place with its focus carried over, the list never emptied so its scroll stays, and the 40px "at the bottom" rule the chat follows new messages by
- `test/client-*.test.js` -- Client module unit tests (auth, state, keyboard shortcuts, the terminal reporting what fits and rendering at the pty's size, resyncing its scroll area when shown so output written while hidden stays reachable (with the xterm version pinned to the one that fix was verified on), voice input, the explorer's collapsible repo sections, the Jobs tab (cards, the job form, its Agent select and the permission modes it hides for a Codex card, pasted and picked attachments), the office whiteboards, whose titles and per-column job counts are checked against the Jobs tab's columns and whose post cap and "+N" overflow are unit-tested, the office character sprites, whose per-agent variant assignment is checked for determinism and for a sheet on disk per variant, and the office motion overlay, whose walk paths (frozen when the walk starts, so a mid-walk spawn cannot re-project the walker), dispatch detection, replay guards, the idle wander (a resting agent walks to a seat pooled from the conference set and the chat-area sofas, routes there without crossing the furniture, sits down in the sheet's seated frame rather than the standing one, and drops its claim when the pool changes shape), and canvas sizing (the backing store follows the canvas box, not the panel, and the last real size is kept while the diff viewer hides it) are unit-tested; `test/client-mobile-view.test.js` covers the phone layout's view state (`setView` moves `body[data-view]` and the bottom nav's `aria-current`, opening a diff lands on the office panel and closing it returns to files, while switching sessions or opening the board in the background leaves the view alone); `test/client-office-pods.test.js` covers the per-repo pod layout, front-facing desk grid, ambient decor placement (the chat area and corner plants, and that the walk-in entrance on the left edge and its strip stay clear of them, of the conference chairs and of the spare desks, with the walk in/out route crossing above the table or along the bottom edge when there is no table), the conference seats, whose four side sitters are checked to land on their chairs rather than hang off the front, the spare-desk row below a single pod row, the bookshelf runs centred under the windows, and that every office sprite path points at a file on disk)
- `test/billion*.test.js` -- Billion: its folder and templates, starting and resuming it, the tab it shows when Claude Code is not installed, running it on Codex (the command, AGENTS.md, which CLI wins between `BILLION_AGENT` and a saved switch, and the switch's order: `test/billion-codex.test.js`), the server's wake-ups and `set_next_wake` (`test/billion-wake.test.js`), switching CLI at a usage limit (the limit-notice matcher against each CLI's wording and ordinary prose, the nudge once per threshold, no second switch within 30 minutes, both CLIs spent, `BILLION_AUTO_SWITCH=0`: `test/billion-limit.test.js`), the handover read off sample transcripts (`test/billion-handover.test.js`), the on/off switches, its mail and board notices, its board tools, answering workers' permission requests through the hook (and every way that falls back to you), and the review-fix edge cases; the client side is `test/client-billion-explorer.test.js` and `test/client-billion-tab.test.js`, and your chat with it is `test/client-waiting.test.js` (the Billion tab next to Jobs as a chat bubble and "Billion", its badge counting open questions and its aria-label, the phone's *Billion* button, the chat as the tab a page opens on with no close control, Billion's terminal tab hidden until opened and closing it leaving the board or the chat up, the thread with the owner on the right and Billion on the left and text never as HTML, questions with their choices, recommended first, answered by a tap and collapsing to "you answered", Dismiss, the text box sending on Enter and keeping its text when refused, which open question it answers and × to send a plain message instead, the pinned strip of open questions as one button with its one-time "tap to see all", the Open questions panel it opens (sections by project and their order, answering from a row, a row's text jumping to its bubble, × and Esc, open or closed remembered, the badge opening it), and reading aloud and dictating in the tab: the speaker on Billion's messages only and its stop state, auto-read off by default, remembered, queued and waiting on *Resume reading* after a reload, and the box's mic appending final text, showing interim text greyed, sending nothing and answering the question the box is set to), and `test/client-readaloud.test.js` covers what a message is read as (markdown stripped, URLs as "link", Q-numbers, a question's choices), the sentence chunks kept under Chrome's cut-off, the voice pick and the speaker's queue
- `test/theme-tokens.test.js` -- Guards the light theme: the DESIGN.md palette fence against the CSS tokens in `public/style.css`, the terminal's background/foreground/cursor in `public/modules/terminal.js` against those tokens, and that every `:root` token has a light override, and that each `animation: none` under `prefers-reduced-motion` comes after the rules it overrides (a later rule with the same selector would win the cascade and keep the animation running)
- Plus focused server-side suites: the `agent-007` command, `init`, settings-file precedence and the startup Settings line, and the package.json/VERSION match (`cli`), turning `changelog.d/` fragments into a version and a CHANGELOG section (`test/release.test.js`), finding a CLI before a spawn and the install hint when it is missing, plus Windows PATHEXT resolution (`test/command-path.test.js`), adduser, auth, origin checks, branch cleanup/sync, worktree cleanup (what is deleted and what is kept as an orphan), git diff, worktree retry, entry-point detection (`test/direct-run.test.js`), the job board's prompt, dispatch, permission mode, agent choice (Claude Code or Codex, the Codex permission-flag mapping, the mid-spawn recheck that abandons a card edited while its agent was starting, and re-spawning an orphan with the CLI it ran and its card's permission mode, or, for a hand-spawned agent, the permission flags it was started with: read through the `PERMISSION_FLAGS` allowlist in `lib/jobs.js` in every spelling, stopping at `--`, one per flag, with a board dispatch recording none and a board orphan whose card is gone following the board's current mode; both the Codex mode mapping and the allowlist's Codex and Claude Code entries are run through the installed CLI's parser when there is one, so the tables cannot drift from what the CLIs accept; and the transcript probe in `server/agent-transcripts.js`, including the Codex session id a re-spawn resumes by, which must be that exact worktree's and never a sibling worktree's) and attachment storage (`test/jobs.test.js`, `test/jobs-dispatch.test.js`, `test/jobs-permission-mode.test.js`, `test/jobs-agent.test.js`), the cron parser, scheduled-job lifecycle and what a server restart recovers, including the CLI note and permission flags an orphan inherits from a crashed session's record (`test/cron.test.js`, `test/jobs-scheduled.test.js`, `test/jobs-scheduled-dispatch.test.js`, `test/jobs-restart.test.js`), one-time schedules (`test/jobs-once.test.js`: `run_at` turned into a one-date cron, `once` archiving the schedule after its single run and staying due through a hold, the restart sweep of one-date schedules that have already run, archiving a To do card, and an archived schedule staying archived across a restart; Billion's `retire_job` is in `test/billion-board-tools.test.js`), the CI watch on Review cards (`test/jobs-ci-watch.test.js`: Billion's CI-finished notice once per head commit and run, re-armed by a push or a re-run of a failed job, never for a card it did not post, and a merged PR filed on the same poll), and the board's MCP tools (`test/mcp-protocol.test.js`, `test/mcp-endpoint.test.js`, `test/agent-mcp-config.test.js`, `test/agent-mcp-bridge.test.js`), and reaching the owner (`test/owner-telegram.test.js`: notify_owner's Telegram send, its errors with the token redacted and its rate limit, replies from any chat but the owner's ignored and the owner's typed into Billion's terminal, the getUpdates offset, stopping the poll, everything off without settings, the Billion tab's questions persisting and dismissing, and `tell_owner` and the owner's messages kept in the chat thread, all against a mocked fetch; `test/owner-rounds.test.js`: rounds, with the round times read from config.json (defaults, `[]` off, the owner's time zone across DST), notify_owner queueing per project with its position and `rank`, blocking or `telegram: true` going out at once, a release taking the top two per project and consolidating the last round's open questions (not ones asked outside a round), one Telegram message per round with the brief and link, Billion's one-line notice kept until it runs, the first-start migration, a missed round released once, `list_round_queue`/`drop_queued`/`set_round_brief`/`set_status`, the status line's fading text, starting a round early (and the clock not releasing it again), the round's item numbers and "1d 3d" from the chat or Telegram, each owner message pending until a `tell_owner` of its own (a server notice answering none), and the steps read off Billion's screen with the token redacted; `test/client-billion-round.test.js` is the tab's This round view (sections per project, numbered cards answered by tap, Done, "1d" or a typed reply folding in place, the counter, Start the round now, Earlier closed, a draft, focus and scroll kept through an update, the This round / Chat switch), its status line, and the thread's pending messages and progress box; `test/owner-answers.test.js`: `choices`/`recommended` checks and the MCP schema, Telegram inline buttons, answers from the app as `[Owner via app] Q<n>:` and from Telegram by button or reply-to, other chats ignored, open → answered / dismissed, the phone's copy edited even when the app answered first, a question's `project` (a board repo in any case, `general`, an unknown name lower-cased and capped, or read off a GitHub URL or a repo's name in the text), old `waiting.json` items, the 50 open / 30 closed cap, and who may answer; `test/owner-chat.test.js`: the Billion tab's chat thread, the owner's typed message reaching Billion as `[Owner via app]` or refused while Billion is not running, empty and oversized text refused, a message that answers the question it names, questions as bubbles that follow their status, the bot token redacted from everything kept, the newest 500 kept in `chat.json` with open questions kept past the cap, a missing or broken file, and Telegram messages and replies in the same thread; and `test/owner-voice.test.js`: TELEGRAM_VOICE's mirror/always/never and the long or links/code/paths text-only rule, the multipart `sendVoice` upload with its caption, text when `say` or ffmpeg is missing, the owner's voice note transcribed and delivered as `[Owner via Telegram, voice]` with any caption kept, a note with no words answered and nothing delivered, a stranger's ignored, the reply when whisper.cpp is not set up, the 5 minute / 20 MB caps, and the token kept out of errors, with fetch and spawn mocked; `test/say-voice.test.js`: which voice SAY_VOICE or the auto-pick chooses, and SAY_RATE's 205 wpm default, 120–300 clamp and garbage ignored with one log line), and agent-to-agent messaging (`test/messages.test.js`: delivery only while the recipient rests at its prompt and nobody is typing, who can reach whom including the never-asks rule, `AGENT_MESSAGING=open` lifting it and the reason a refused sender is given, the per-pair rate limit and queue cap, and the `list_agents`/`send_message` tools), and Billion reading a worker's screen (`test/read-agent-screen.test.js`: ANSI stripping, the line and size caps, only workers on Billion's own cards, an exited worker, and the screen quoted as untrusted), and the `.env` permission defaults (`test/permission-defaults.test.js`: `CLAUDE_PERMISSION_MODE`/`CODEX_PERMISSION_MODE` added to a command someone starts unless it already names a permission flag, never to a board worker's command, the board using each CLI's default until a mode is picked in its dropdown, and what a re-spawned agent resumes in), and pre-trusting board worktrees (`test/claude-trust.test.js`: for Claude Code, the one `~/.claude.json` entry added with everything else kept and a malformed or missing file left alone; for Codex, the per-run `-c projects=` trust flag reaching a board worker's spawn and not a hand-started one's, and nothing written; and `TRUST_BOARD_WORKTREES=0` and hand-started agents opting out)

> **Windows note:** `vitest.config.js` keeps node-pty external so its native
> addon is never transformed, which is what lets `test/server.test.js` load on
> Windows at all. The two `0600` mode assertions in
> `test/agent-mcp-config.test.js` are skipped there because Windows has no POSIX
> permission bits, so the MCP config file is not owner-only on Windows (see
> TODOS.md). The PTY lifecycle tests spawn `echo`, `cat` and `sleep`, so they
> need those on `PATH` (Git for Windows provides them). CI runs the suite on
> both ubuntu and Windows, so a change that passes locally on macOS/Linux can
> still go red on the Windows leg.

### Releases

**A PR never edits `VERSION`, `package.json`'s version, `package-lock.json`'s
version or `CHANGELOG.md`.** It adds one changelog fragment instead,
`changelog.d/<branch-name>.md`:

```markdown
---
bump: patch
---
### Added

- **What changed, in bold.** Why it matters and how to use it.
```

`bump` is `major`, `minor`, `patch` or `micro` (the part of `VERSION` it
raises). Each PR's fragment is its own file, so PRs written in parallel never
conflict on the version or the changelog. Title the PR without a version
(`feat: ...`, not `v0.6.7.0 feat: ...`): the version is picked at merge.

Releases are automatic. On every push to `main`,
`.github/workflows/release.yml` runs `scripts/release.js`, which reads the
fragments, raises `VERSION` by the largest `bump` among them, writes
`package.json` and `package-lock.json`, adds a `## [X] - date` section to
`CHANGELOG.md` with the fragments' notes, and deletes the fragments; the
workflow commits that to `main` as `vX release: <PR headline>`. It then tags
that commit `vX`, publishes a GitHub Release whose notes are that section, and
publishes the version to npm as
`@bill10/agent-007` (npm rejected the unscoped `agent-007` as too close to
`agent007`). PRs merged close together can share one release. A merge with no
fragment (a typo fix, a test) makes no release. `test/release.test.js` covers
the version arithmetic and the fragment collection.

npm publishing uses OIDC trusted publishing, so there is no npm token: the owner
sets it up once on npmjs.com, on the `@bill10/agent-007` package page under
Settings → Trusted Publisher, with GitHub Actions, repository
`bill10/agent-007` and workflow `release.yml`. npm only shows that page once
the package exists, so the very first version is published by hand
(`npm publish --access public` from a clean checkout of the release commit,
after `npm pkg set version=` the npm version below).

### Versions

`VERSION` is four-part (`MAJOR.MINOR.PATCH.MICRO`), but npm only takes
three-part semver. Two translations follow from it:

- `package.json` (and `package-lock.json`) carry `MAJOR.MINOR.PATCH`, the
  first three parts. `scripts/release.js` writes them with `VERSION`.
  `test/cli.test.js` fails when they disagree, and the release workflow
  refuses to publish.
- npm gets `MAJOR.MINOR.(PATCH*1000 + MICRO)`, which the release workflow
  sets just before `npm publish`, so a MICRO release reaches npm too:

| VERSION | package.json | npm |
|---------|--------------|-----|
| 0.6.0.0 | 0.6.0 | 0.6.0 |
| 0.6.0.3 | 0.6.0 | 0.6.3 |
| 0.6.2.1 | 0.6.2 | 0.6.2001 |

The order holds as long as MICRO stays under 1000. `agent-007 --version`
prints `VERSION` itself.

## Code Style

- **Vanilla JS.** No TypeScript, no framework, no build step. This is intentional.
- **ES modules.** All files use `import`/`export`, not `require`.
- **No external linter.** Keep it readable. Match the style of surrounding code.
- **Design system.** Colors, naming pools, and UI conventions live in [DESIGN.md](DESIGN.md).

## Architecture

```
server.js          Entry point + orchestrators
server/
  state.js         Shared mutable state
  settings.js      Config dir, ./.env + ~/.agent-007/.env loading, startup Settings line
  config.js        Config persistence
  direct-run.js    Entry-point detection (npm start guard)
  git.js           Git operations
  jobs.js          Job board dispatcher (scans, spawns agents, watches PRs)
  command-path.js  Checks a CLI is installed before a spawn; resolves commands to spawnable files on Windows (PATHEXT)
  pty.js           PTY lifecycle
  ws.js            WebSocket routing
  http.js          HTTP routes and the user/agent auth gates
  agent-accounts.js  Installed agent CLIs and their logged-in accounts (Settings panel; read-only)
  mcp.js           The board's MCP server (post_job, list_jobs, read_job, edit_job, finish_job, list_agents, send_message; Billion also gets billion_ready, add_repo, close_job, answer_permission)
  messages.js      Agent-to-agent messages and board notices (reach, rate limit, delivery queue)
  billion.js       Billion's folder, templates and charter refresh (docs/BILLION.md)
  account-rotation.js   Persistent account pool, cooldowns, refreshed logins and recovery (docs/FEATURES.md)
  account-migration.js  Platform credential stores, selective account writes and legacy rollback
  claude-rotation-sessions.js  Resume exact conversations after a shared login switch
  claude-processes.js  Detect Claude processes outside the app before a login switch
  approvals.js     Hands a worker's permission request to Billion and waits for its answer
  permission-hook.js  PermissionRequest hook (Claude Code and Codex) for workers on Billion's cards
  agent-mcp.js     Per-session MCP config for spawned Claude Code and Codex agents
  agent-mcp-bridge.js  Codex stdio bridge to the board's HTTP endpoint
  agent-transcripts.js  Which CLI last ran in a worktree, and the Codex session id to resume, read off its transcripts (re-spawn)
  auth.js          Login tokens, ownership, agent session tokens
bin/agent-007.js   The agent-007 command (npx @bill10/agent-007, npm start): flags, init, settings, start
bin/adduser.js     Create a login user (npm run adduser)
scripts/release.js changelog.d/ fragments -> VERSION, package.json, CHANGELOG (run by release.yml)
scripts/demo/      Re-records the README demo GIF, video and screenshot with stub claude/gh (usage atop record.mjs)
lib/               Pure functions, tested (helpers.js, jobs.js job logic, cron.js parser)
public/            Frontend (vanilla JS, no build)
templates/billion/ Billion's starting files (charter, owner rules, STATE.md, COMPANY.md)
```

## Submitting a PR

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run tests: `npm test`
5. Add your `changelog.d/<branch-name>.md` fragment (see [Releases](#releases))
6. Open a PR with a clear description of what and why
