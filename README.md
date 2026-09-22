# Agent 007

[![Tests (Ubuntu)](https://github.com/bill10/agent-007/actions/workflows/test-ubuntu.yml/badge.svg)](https://github.com/bill10/agent-007/actions/workflows/test-ubuntu.yml)
[![Tests (Windows)](https://github.com/bill10/agent-007/actions/workflows/test-windows.yml/badge.svg)](https://github.com/bill10/agent-007/actions/workflows/test-windows.yml)

A pixel office for managing AI terminal agents. Spawn Claude Code (or any CLI) instances into isolated git worktrees and watch them work side-by-side in a retro pixel art office.

![Agent 007 — the pixel office alongside a live agent terminal](docs/screenshot.png)

## Why?

This project is inspired by [pixel-agents](https://github.com/pablodelucca/pixel-agents) (big shoutout to them), which is mainly a VS Code extension. However, I needed more than a VS Code extension, so I just vibe-coded one for my own use. If any of the following sounds like you, please feel free to give it a try or, even better, contribute and make it more useful.

- I normally have multiple Claude Code instances running simultaneously, and I rarely open VS Code to write code myself.
- I have multiple projects/repos being developed simultaneously, and a typical IDE's one-window-per-project view is not helpful.
- I need automatic worktree isolation when multiple agents are working on one repo for different features.
- I want something slightly more playful, since I'm talking to multiple terminals all day long.

## Features

- **Pixel office** -- Every agent gets a desk. The sprite faces the screen while working, turns to face you when it needs you, and wanders off to sit down when idle, so you can see the state of every agent at a glance. Desks group into per-repo pods; agents walk in on spawn and out on exit.
- **Git worktree isolation** -- Each agent gets its own worktree and branch automatically, so several agents can work on one repo without merge conflicts. Branches are named after cocktails (`bill/vesper`, `bill/martini`, ...).
- **Multi-repo support** -- Add any number of repos and manage every agent from one window.
- **Live file explorer** -- Real-time file tree with git status, inline diffs, and a changes-only filter.
- **Terminal multiplexer** -- Full xterm.js terminals with clickable URLs, clipboard image paste, draggable tabs, and renaming.
- **Job board** -- Queue work instead of babysitting it. Each queued job spawns a fresh agent on its own worktree and branch, moves To do -> In progress -> Review as the agent works and opens a pull request, and files itself away when the PR merges. A card can also run on a cron schedule. Per-board and per-card permission modes; Claude Code or Codex per card.
- **Agents post jobs too** -- Tell an agent "add that to the job board" and it files the card itself over MCP.
- **Agents message each other** -- Claude Code and Codex agents alike: "ask Viper what it changed" sends the question to that agent's terminal over MCP, and the reply comes back the same way.
- **Works on a phone** -- Below 700px the three panels become one screen at a time.
- **Dark/light themes** (see [DESIGN.md](DESIGN.md)), **live sync** across every connected browser, and **voice input** (`Cmd+D`) for dictating prompts.

The long version of each of these, with the details and caveats, is in [docs/FEATURES.md](docs/FEATURES.md).

## Quick Start

```bash
git clone https://github.com/bill10/agent-007.git
cd agent-007
npm install
npm start
```

Open [http://localhost:7007](http://localhost:7007) in your browser. Click **+ Agent**, pick a repo, and hit Start -- preset buttons (Claude Code, Codex, Gemini, Bash; PowerShell on a Windows server) fill in the command, or type your own under Advanced. **+ Job** posts work to the job board instead.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Cmd+N` | Spawn a new agent |
| `Cmd+1..9` | Switch to agent by tab position |
| `Cmd+E` | Toggle the file explorer panel |
| `Cmd+D` | Toggle voice input (dictation) |

## How It Works

Each agent runs in its own [git worktree](https://git-scm.com/docs/git-worktree), so multiple agents can work on the same repo without stepping on each other. The server manages PTY processes via [node-pty](https://github.com/microsoft/node-pty) and communicates with the browser over WebSocket. The pixel office is rendered on an HTML canvas with a day/night cycle that follows your local time.

Every agent's branch starts from your repository's base branch as it exists on
the remote, fetched just before the worktree is created, so an agent never picks
up a stale local base or whatever unrelated branch you happen to have checked
out. Override it per agent with **Advanced -> Start from** when you want to
branch off work in progress.

The job board reuses that same machinery: a dispatched job is an ordinary agent, with a real terminal you can type into and take over at any point. Each job gets its own worktree and branch, so a job maps one-to-one onto a branch and a pull request. When the PR appears the board closes the agent and releases its worktree and local branch; the PR itself is untouched, and work that was never pushed is kept as an orphan rather than deleted. **Re-spawn** on an orphan picks that conversation back up with the CLI it ran, `codex resume --last` or `claude --continue`, under the permission mode its job card was dispatched with (a board agent whose card is already finished or deleted follows the board's current setting), or, for an agent you spawned by hand, under the permission flags you started it with. When the PR merges the job is filed away as finished -- the record is kept, the card is not.

```
┌─────────────┬──────────────┬────────────────────┐
│  Explorer   │  Pixel       │  Jobs + Terminals   │
│  (repos,    │  Office      │  (job board tab,    │
│   files,    │  (canvas,    │   xterm.js, one     │
│   diffs)    │   agents)    │   tab per agent)    │
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
> terminal but can't type into, resize, kill, rename, or upload to it (enforced
> server-side). The dimmed-tile / read-only-terminal UI polish is still to come
> (see [docs/designs/multiplayer.md](docs/designs/multiplayer.md)).
>
> Caveat: agents you spawned **before** creating the first user are unowned, so
> once auth is on anyone can still control them. Spawn agents after enabling auth
> (or restart them) if you want them owned.

## Requirements

- Node.js 20.12+
- Git
- A modern browser (three panels at 900px+, explorer hidden below that, one panel at a time on a phone)
- A CLI to run as the agent (defaults to `claude`, but works with any command)
- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** `build-essential` and `python3` (`sudo apt install build-essential python3`)
- **Windows:** [Visual Studio Build Tools](https://github.com/microsoft/node-pty#windows) with the C++ workload

> **Note:** `node-pty` (used for terminal sessions) is a native addon that requires a C++ compiler. The requirements above ensure it compiles during `npm install`.

Agent 007 runs on macOS, Linux, and Windows -- spawning agents, adding repos, and browsing paths all handle Windows natively, and CI runs the test suite on both Ubuntu and Windows. One Windows caveat: the per-agent MCP config file protects its token with POSIX file permissions, which Windows doesn't have, so on a shared Windows machine other local users can read it.

## Architecture

```
server.js          Entry point + orchestrators (createSession, killSession)
server/
  state.js         Shared mutable state (sessions, orphans, pools, config)
  config.js        Config persistence (load, save, crash recovery)
  direct-run.js    Entry-point detection (symlink/space-safe `npm start` guard)
  git.js           Git operations (worktree, file tree, diff)
  jobs.js          Job board dispatcher (scan, spawn, PR watch, scheduled runs, attachment files)
  command-path.js  Resolves commands to spawnable files on Windows (PATHEXT)
  pty.js           PTY lifecycle (spawn, handlers, state detection)
  ws.js            WebSocket (message routing, broadcast, origin check)
  http.js          HTTP routes (/api/browse, /api/jobs, job attachment downloads, /mcp, origin + auth gates)
  mcp.js           The board's MCP server (post_job, list_jobs, read_job, edit_job)
  agent-mcp.js     Per-session MCP config + the flags that connect Claude Code and Codex to it
  agent-mcp-bridge.js  Codex stdio bridge to the board's HTTP endpoint
  agent-transcripts.js  Which CLI last ran in a worktree, read off its transcripts (re-spawn fallback)
  auth.js          Login tokens, user accounts, agent session tokens
bin/
  adduser.js       Create a login user (`npm run adduser`)
public/
  index.html       Three-panel layout, plus the phone's bottom nav
  style.css        Dark/light themes via CSS custom properties
  app.js           Main entry point
  assets/          Pixel art sprites (characters/ MIT with vendored LICENSE; furniture/ mixes Antea CC-BY 4.0 and pixel-agents MIT, see Acknowledgements)
  modules/
    office.js      Canvas pixel art (workstations, characters, job boards, day/night)
    terminal.js    xterm.js terminals, clipboard paste, tab management
    explorer.js    File tree, diff viewer, repo management
    jobs.js        Job board UI (columns, cards, the job form)
    ws.js          WebSocket client with auto-reload on reconnect
    state.js       Shared client state (agents, repos, viewer identity, server platform, the panel a phone shows)
    shortcuts.js   Keyboard shortcuts
    voice.js       Voice input (Web Speech API dictation)
    auth.js        Login tokens, presence, HTML escaping
lib/
  helpers.js       State detection (dialog patterns per CLI, the synchronized-output frames Codex paints in), git parsing, codename/cocktail pools, the file-name sanitiser
  jobs.js          Pure job-board logic (states, prompts, dispatch selection)
  cron.js          Five-field cron parser (schedules for scheduled jobs)
```

## Acknowledgements

- Character sprites and the ambient decor sprites (`furniture/cactus.png`, `plant_2.png`, `sofa_side.png`, `sofa_front.png`, `coffee_table.png`, `coffee.png`, `table_front.png`, `chair_side.png`, `chair_back.png` -- the two chairs recolored, and `chair_front.png` drawn for this project in the same style) from [pixel-agents](https://github.com/pablodelucca/pixel-agents) (MIT, © Pablo De Lucca — license vendored at `public/assets/characters/LICENSE`), character bases by JIK-A-4's ["Metro City" free top-down character pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) (CC0)
- Desk and `bookshelf.png` sprites from the Free Furniture Office Equipment Set by Antea (CC-BY 4.0)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

[MIT](LICENSE)
