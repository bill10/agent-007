# Contributing to Agent 007

Contributions are welcome! This project is intentionally simple: vanilla JS, no build step, no framework. That's on purpose to keep the barrier to entry low.

## Prerequisites

- **Node.js 20.12+**
- **Git**
- **C++ build tools** (required by `node-pty`):
  - macOS: `xcode-select --install`
  - Linux: `sudo apt install build-essential python3`
  - Windows: [windows-build-tools](https://github.com/nicknisi/node-pty#windows)

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

- `test/helpers.test.js` -- Pure function unit tests (state detection, ANSI stripping, git parsing)
- `test/server.test.js` -- Integration tests (HTTP API, WebSocket, PTY lifecycle)
- `test/client-*.test.js` -- Client module unit tests (auth, state, keyboard shortcuts, voice input)
- Plus focused server-side suites: adduser, auth, origin checks, branch cleanup/sync, git diff, worktree retry, entry-point detection (`test/direct-run.test.js`), the cron parser and scheduled-job lifecycle (`test/cron.test.js`, `test/jobs-scheduled.test.js`, `test/jobs-scheduled-dispatch.test.js`, `test/jobs-restart.test.js`), and the board's MCP tool (`test/mcp-protocol.test.js`, `test/mcp-endpoint.test.js`, `test/agent-mcp-config.test.js`)

> **Windows note:** four tests fail locally on Windows and pass in CI (ubuntu).
> `test/server.test.js` fails to load at all (node-pty's native addon). Two
> assertions in `test/agent-mcp-config.test.js` expect mode `0600`, which Windows
> cannot express through `chmod`. One in `test/mcp-endpoint.test.js` splits a
> fixture path on `/` only. All four are tracked in TODOS.md; the rest of the
> suite passes locally on Windows.

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
  mcp.js           The board's MCP server (the post_job tool)
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
