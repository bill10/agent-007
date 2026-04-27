# Contributing to Agent 007

Contributions are welcome! This project is intentionally simple: vanilla JS, no build step, no framework. That's on purpose to keep the barrier to entry low.

## Prerequisites

- **Node.js 18+**
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

## Code Style

- **Vanilla JS.** No TypeScript, no framework, no build step. This is intentional.
- **ES modules.** All files use `import`/`export`, not `require`.
- **No external linter.** Keep it readable. Match the style of surrounding code.

## Architecture

```
server.js          Entry point + orchestrators
server/
  state.js         Shared mutable state
  config.js        Config persistence
  git.js           Git operations
  pty.js           PTY lifecycle
  ws.js            WebSocket routing
  http.js          HTTP routes
lib/helpers.js     Pure functions (tested)
public/            Frontend (vanilla JS, no build)
```

## Submitting a PR

1. Fork the repo
2. Create a branch (`git checkout -b my-feature`)
3. Make your changes
4. Run tests: `npm test`
5. Open a PR with a clear description of what and why
