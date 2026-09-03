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

- `test/helpers.test.js` -- Pure function unit tests (state detection, ANSI stripping, git parsing, file-name sanitising)
- `test/server.test.js` -- Integration tests (HTTP API including the job attachment route, WebSocket, PTY lifecycle)
- `test/client-*.test.js` -- Client module unit tests (auth, state, keyboard shortcuts, voice input, the explorer's collapsible repo sections, the Jobs tab (cards, the job form, pasted and picked attachments), the office whiteboards, whose titles and per-column job counts are checked against the Jobs tab's columns and whose post cap and "+N" overflow are unit-tested, the office character sprites, whose per-agent variant assignment is checked for determinism and for a sheet on disk per variant, and the office motion overlay, whose walk paths (frozen when the walk starts, so a mid-walk spawn cannot re-project the walker), dispatch detection, replay guards, and canvas sizing (the backing store follows the canvas box, not the panel, and the last real size is kept while the diff viewer hides it) are unit-tested; `test/client-office-pods.test.js` covers the per-repo pod layout, front-facing desk grid, ambient decor placement (the chat area and corner plants, and that the walk-in entrance on the left edge and its strip stay clear of them, of the conference chairs and of the spare desks, with the walk in/out route crossing above the table or along the bottom edge when there is no table), the spare-desk row below a single pod row, the bookshelf runs centred under the windows, and that every office sprite path points at a file on disk)
- `test/theme-tokens.test.js` -- Guards the light theme: the DESIGN.md palette fence against the CSS tokens in `public/style.css`, the terminal's background/foreground/cursor in `public/modules/terminal.js` against those tokens, and that every `:root` token has a light override
- Plus focused server-side suites: adduser, auth, origin checks, branch cleanup/sync, git diff, worktree retry, entry-point detection (`test/direct-run.test.js`), the job board's prompt, dispatch and attachment storage (`test/jobs.test.js`, `test/jobs-dispatch.test.js`), the cron parser and scheduled-job lifecycle (`test/cron.test.js`, `test/jobs-scheduled.test.js`, `test/jobs-scheduled-dispatch.test.js`, `test/jobs-restart.test.js`), and the board's MCP tools (`test/mcp-protocol.test.js`, `test/mcp-endpoint.test.js`, `test/agent-mcp-config.test.js`)

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
  mcp.js           The board's MCP server (post_job, list_jobs, read_job, edit_job)
  agent-mcp.js     Per-session MCP config for spawned agents
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
