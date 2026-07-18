# Agent 007

[![Tests](https://github.com/bill10/agent-007/actions/workflows/test.yml/badge.svg)](https://github.com/bill10/agent-007/actions/workflows/test.yml)

A pixel office for managing AI terminal agents. Spawn Claude Code (or any CLI) instances into isolated git worktrees and watch them work side-by-side in a retro pixel art office.

<!-- Screenshot: 1400x900, dark theme, 4 agents (shadow=WORKING, phantom=MESSAGE, viper=WAITING, cipher=WORKING), terminal showing Claude Code output, explorer with 5-7 changed files -->
![Agent 007 Screenshot](docs/screenshot.png)

## Why?

This project is inspired by [pixel-agents](https://github.com/pablodelucca/pixel-agents) (big shoutout to them), which is mainly a VS Code extension. However, I needed more than a VS Code extension, so I just vibe-coded one for my own use. If any of the following sounds like you, please feel free to give it a try or, even better, contribute and make it more useful.

- I normally have multiple Claude Code instances running simultaneously, and I rarely open VS Code to write code myself.
- I have multiple projects/repos being developed simultaneously, and a typical IDE's one-window-per-project view is not helpful.
- I need automatic worktree isolation when multiple agents are working on one repo for different features.
- I want something slightly more playful, since I'm talking to multiple terminals all day long.

## Features

- **Pixel office** -- Canvas-rendered workstations that show each agent's state at a glance (working, waiting, needs attention, idle, disconnected). Characters face the screen when working and turn around when waiting.
- **Git worktree isolation** -- Each agent gets its own worktree and branch automatically. No merge conflicts between agents working on the same repo. Branches are named with cocktail names (`bill/vesper`, `bill/martini`, ...).
- **Multi-repo support** -- Add any number of repos. Spawn agents on different repos and manage them all from one place.
- **Live file explorer** -- Real-time file tree with git status indicators, inline diff viewer, and a changes/all toggle to filter what you see.
- **Terminal multiplexer** -- Full xterm.js terminals with clickable URLs, clipboard image paste (Cmd+V a screenshot), and draggable tabs for reordering.
- **Dark/light themes** -- Gold-accented dark theme and a Linear-inspired warm light theme. Toggles instantly, including terminal colors.
- **Live sync** -- Branch names, file changes, line-level diff stats (+/-), and agent states update in real time across all panels.

## Quick Start

```bash
git clone https://github.com/bill10/agent-007.git
cd agent-007
npm install
npm start
```

Open [http://localhost:7007](http://localhost:7007) in your browser. Click **+ New Agent**, pick a repo, and hit Start.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Cmd+N` | Spawn a new agent |
| `Cmd+1..9` | Switch to agent by tab position |
| `Cmd+E` | Toggle the file explorer panel |

## How It Works

Each agent runs in its own [git worktree](https://git-scm.com/docs/git-worktree), so multiple agents can work on the same repo without stepping on each other. The server manages PTY processes via [node-pty](https://github.com/nicknisi/node-pty) and communicates with the browser over WebSocket. The pixel office is rendered on an HTML canvas with a day/night cycle that follows your local time.

```
┌─────────────┬──────────────┬────────────────────┐
│  Explorer   │  Pixel       │  Terminal           │
│  (repos,    │  Office      │  (xterm.js,         │
│   files,    │  (canvas,    │   one per agent,    │
│   diffs)    │   agents)    │   draggable tabs)   │
└─────────────┴──────────────┴────────────────────┘
```

## Configuration

Configure via environment variables, either inline or in a `.env` file. On
startup `npm start` auto-loads `.env` if present (via Node's built-in
`--env-file-if-exists`). Copy the template to get going:

```bash
cp .env.example .env    # then edit; .env is gitignored
npm start
```

Or set them inline:

```bash
PORT=8080 npm start                       # Custom port (default: 7007)
HOST=0.0.0.0 npm start                    # Bind all interfaces (default: 127.0.0.1)
ALLOWED_ORIGINS=mac-mini.tailXXXX.ts.net npm start   # Allow a remote browser origin
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `7007` | Listen port |
| `HOST` | `127.0.0.1` | Bind interface. Use `0.0.0.0` only behind Tailscale/a trusted network |
| `ALLOWED_ORIGINS` | *(none)* | Comma-separated extra origins for the cross-origin check (`localhost` is always allowed) |

> **Running remotely?** The server spawns real shells, so never expose it to the
> open internet. See [docs/REMOTE.md](docs/REMOTE.md) for the recommended
> Tailscale setup.

### Multiplayer & login

By default there are no user accounts and no login — the app runs open on
localhost, exactly as before. To turn on per-user login (for shared/remote use),
create a user:

```bash
npm run adduser -- "Alice"     # prints a one-time login token
```

The moment the first user exists, the server **requires a token** for every
`/api` call and WebSocket connection. Log in by opening the app and pasting the
token, or visit `http://<host>:7007/?token=<token>` once (the token is stored in
your browser and stripped from the URL). Add a user per person; each gets a
distinct color and shows up in the presence indicator.

> Login establishes **identity**, not isolation — every logged-in user can still
> spawn their own shells on the host. Only issue tokens to people you'd give an
> SSH login, and keep the server behind Tailscale/a trusted network.
>
> Each agent is owned by the user who spawned it. You have full control of your
> own agents and are **read-only** on everyone else's — you see their live
> terminal but can't type into, resize, kill, or upload to it (enforced
> server-side). The dimmed-tile / read-only-terminal UI polish is still to come
> (see [docs/designs/multiplayer.md](docs/designs/multiplayer.md)).
>
> Caveat: agents you spawned **before** creating the first user are unowned, so
> once auth is on anyone can still control them. Spawn agents after enabling auth
> (or restart them) if you want them owned.

## Requirements

- Node.js 20.12+
- Git
- Desktop browser (900px+ viewport)
- A CLI to run as the agent (defaults to `claude`, but works with any command)
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** `build-essential` and `python3` (`sudo apt install build-essential python3`)
- **Windows:** [windows-build-tools](https://github.com/nicknisi/node-pty#windows) or Visual Studio Build Tools

> **Note:** `node-pty` (used for terminal sessions) is a native addon that requires a C++ compiler. The requirements above ensure it compiles during `npm install`.

## Architecture

```
server.js          Entry point + orchestrators (createSession, killSession)
server/
  state.js         Shared mutable state (sessions, orphans, pools, config)
  config.js        Config persistence (load, save, crash recovery)
  git.js           Git operations (worktree, file tree, diff)
  pty.js           PTY lifecycle (spawn, handlers, state detection)
  ws.js            WebSocket (message routing, broadcast, origin check)
  http.js          HTTP routes (/api/browse, origin check middleware)
public/
  index.html       Three-panel layout
  style.css        Dark/light themes via CSS custom properties
  app.js           Main entry point
  modules/
    office.js      Canvas pixel art (workstations, characters, day/night)
    terminal.js    xterm.js terminals, clipboard paste, tab management
    explorer.js    File tree, diff viewer, repo management
    ws.js          WebSocket client with auto-reload on reconnect
    state.js       Shared agent state
    shortcuts.js   Keyboard shortcuts
lib/
  helpers.js       State detection, git parsing, codename/cocktail pools
```

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

[MIT](LICENSE)
