# Contributing to Agent 007

Contributions are welcome! This project is intentionally simple: vanilla JS, no build step, no framework. That's on purpose to keep the barrier to entry low.

## Prerequisites

- **Node.js 20.12+**
- **Git**
- **C++ build tools** (required by `node-pty`):
  - macOS: `xcode-select --install`
  - Linux: `sudo apt install build-essential python3`
  - Windows: [Visual Studio Build Tools](https://github.com/microsoft/node-pty#windows) with the C++ workload

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

- `test/helpers.test.js` -- Pure function unit tests (state detection, including that `MESSAGE_PATTERNS` match each CLI's real dialog wording and not prose about permissions, and that `detectState` reads a Codex session's last synchronized-output frame in place of the five-line window while the frame is the newer source; ANSI stripping, git parsing, file-name sanitising, the UTF-8 locale a pty gets when the server has none)
- `test/pty-chunking.test.js` -- Drives the real PTY output handler with captured bytes cut at read boundaries: line reassembly across chunks, and the DEC 2026 synchronized frames Codex paints its pane in (a marker split across reads, a partial repaint merged onto the pane, a frame abandoned after 1s, frame bytes kept out of the line stream, frames read for Codex sessions only). The captures live in `test/fixtures/`: a Claude Code AskUserQuestion dialog, and the Claude Code 2.1 Bash and edit permission dialogs
- `test/server.test.js` -- Integration tests (HTTP API including the job attachment route, WebSocket, PTY lifecycle, a terminal shown in two windows taking the smaller owner window's size)
- `test/client-*.test.js` -- Client module unit tests (auth, state, keyboard shortcuts, the terminal reporting what fits and rendering at the pty's size, voice input, the explorer's collapsible repo sections, the Jobs tab (cards, the job form, its Agent select and the permission modes it hides for a Codex card, pasted and picked attachments), the office whiteboards, whose titles and per-column job counts are checked against the Jobs tab's columns and whose post cap and "+N" overflow are unit-tested, the office character sprites, whose per-agent variant assignment is checked for determinism and for a sheet on disk per variant, and the office motion overlay, whose walk paths (frozen when the walk starts, so a mid-walk spawn cannot re-project the walker), dispatch detection, replay guards, the idle wander (a resting agent walks to a seat pooled from the conference set and the chat-area sofas, routes there without crossing the furniture, sits down in the sheet's seated frame rather than the standing one, and drops its claim when the pool changes shape), and canvas sizing (the backing store follows the canvas box, not the panel, and the last real size is kept while the diff viewer hides it) are unit-tested; `test/client-mobile-view.test.js` covers the phone layout's view state (`setView` moves `body[data-view]` and the bottom nav's `aria-current`, opening a diff lands on the office panel and closing it returns to files, while switching sessions or opening the board in the background leaves the view alone); `test/client-office-pods.test.js` covers the per-repo pod layout, front-facing desk grid, ambient decor placement (the chat area and corner plants, and that the walk-in entrance on the left edge and its strip stay clear of them, of the conference chairs and of the spare desks, with the walk in/out route crossing above the table or along the bottom edge when there is no table), the conference seats, whose four side sitters are checked to land on their chairs rather than hang off the front, the spare-desk row below a single pod row, the bookshelf runs centred under the windows, and that every office sprite path points at a file on disk)
- `test/theme-tokens.test.js` -- Guards the light theme: the DESIGN.md palette fence against the CSS tokens in `public/style.css`, the terminal's background/foreground/cursor in `public/modules/terminal.js` against those tokens, and that every `:root` token has a light override
- Plus focused server-side suites: adduser, auth, origin checks, branch cleanup/sync, worktree cleanup (what is deleted and what is kept as an orphan), git diff, worktree retry, entry-point detection (`test/direct-run.test.js`), the job board's prompt, dispatch, permission mode, agent choice (Claude Code or Codex, the Codex permission-flag mapping, the mid-spawn recheck that abandons a card edited while its agent was starting, and re-spawning an orphan with the CLI it ran and its card's permission mode, or, for a hand-spawned agent, the permission flags it was started with: read through the `PERMISSION_FLAGS` allowlist in `lib/jobs.js` in every spelling, stopping at `--`, one per flag, with a board dispatch recording none and a board orphan whose card is gone following the board's current mode; both the Codex mode mapping and the allowlist's Codex and Claude Code entries are run through the installed CLI's parser when there is one, so the tables cannot drift from what the CLIs accept; and the transcript probe in `server/agent-transcripts.js`, including the Codex session id a re-spawn resumes by, which must be that exact worktree's and never a sibling worktree's) and attachment storage (`test/jobs.test.js`, `test/jobs-dispatch.test.js`, `test/jobs-permission-mode.test.js`, `test/jobs-agent.test.js`), the cron parser, scheduled-job lifecycle and what a server restart recovers, including the CLI note and permission flags an orphan inherits from a crashed session's record (`test/cron.test.js`, `test/jobs-scheduled.test.js`, `test/jobs-scheduled-dispatch.test.js`, `test/jobs-restart.test.js`), and the board's MCP tools (`test/mcp-protocol.test.js`, `test/mcp-endpoint.test.js`, `test/agent-mcp-config.test.js`, `test/agent-mcp-bridge.test.js`), and agent-to-agent messaging (`test/messages.test.js`: delivery only while the recipient rests at its prompt and nobody is typing, who can reach whom including the never-asks rule, the per-pair rate limit and queue cap, and the `list_agents`/`send_message` tools)

> **Windows note:** `vitest.config.js` keeps node-pty external so its native
> addon is never transformed, which is what lets `test/server.test.js` load on
> Windows at all. The two `0600` mode assertions in
> `test/agent-mcp-config.test.js` are skipped there because Windows has no POSIX
> permission bits, so the MCP config file is not owner-only on Windows (see
> TODOS.md). The PTY lifecycle tests spawn `echo`, `cat` and `sleep`, so they
> need those on `PATH` (Git for Windows provides them). CI runs the suite on
> both ubuntu and Windows, so a change that passes locally on macOS/Linux can
> still go red on the Windows leg.

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
  config.js        Config persistence
  direct-run.js    Entry-point detection (npm start guard)
  git.js           Git operations
  jobs.js          Job board dispatcher (scans, spawns agents, watches PRs)
  command-path.js  Resolves commands to spawnable files on Windows (PATHEXT)
  pty.js           PTY lifecycle
  ws.js            WebSocket routing
  http.js          HTTP routes and the user/agent auth gates
  mcp.js           The board's MCP server (post_job, list_jobs, read_job, edit_job, list_agents, send_message)
  messages.js      Agent-to-agent messages (reach, rate limit, delivery queue)
  agent-mcp.js     Per-session MCP config for spawned Claude Code and Codex agents
  agent-mcp-bridge.js  Codex stdio bridge to the board's HTTP endpoint
  agent-transcripts.js  Which CLI last ran in a worktree, and the Codex session id to resume, read off its transcripts (re-spawn)
  auth.js          Login tokens, ownership, agent session tokens
bin/adduser.js     Create a login user (npm run adduser)
lib/               Pure functions, tested (helpers.js, jobs.js job logic, cron.js parser)
public/            Frontend (vanilla JS, no build)
```

## Submitting a PR

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run tests: `npm test`
5. Open a PR with a clear description of what and why
