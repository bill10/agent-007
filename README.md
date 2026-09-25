# Agent 007

[![Tests (Ubuntu)](https://github.com/bill10/agent-007/actions/workflows/test-ubuntu.yml/badge.svg)](https://github.com/bill10/agent-007/actions/workflows/test-ubuntu.yml)
[![Tests (Windows)](https://github.com/bill10/agent-007/actions/workflows/test-windows.yml/badge.svg)](https://github.com/bill10/agent-007/actions/workflows/test-windows.yml)

**Queue coding jobs, walk away, review the PRs.**

Agents run in parallel, each in its own git worktree; one boss agent runs the board for you; and a pixel office shows who's working and who's waiting on you.

![An agent walks to its desk and starts work, a job card is posted and dispatched to a second desk, and an agent turns orange when it stops to ask a question](docs/demo.gif)

*Recorded from the running app. If the capture does not load, there is a [still screenshot](docs/screenshot.png).*

## Quick Start

```bash
npx @bill10/agent-007
```

Or install it globally with `npm i -g @bill10/agent-007`, then run `agent-007`.

Or run it from a clone:

```bash
git clone https://github.com/bill10/agent-007.git && cd agent-007
npm install
npm start
```

Open [http://localhost:7007](http://localhost:7007). Click **+ Job** to queue work on the board, or **+ Agent** to start one by hand -- preset buttons (Claude Code, Codex, Gemini, Bash; PowerShell on a Windows server) fill in the command, or type your own under Advanced. Needs Node.js 20.12+ and Git ([full requirements](#requirements)).

## Highlights

- **A job board, not a babysitting job** -- Each card gets a fresh agent on its own worktree and branch. It moves To do -> In progress -> Review on its own and lands as a pull request (or a summary, for work that isn't code). Cards can also run on a cron schedule.
- **Billion, the one agent you talk to** -- Give it a mission and it plans, posts cards, reviews what comes back, merges PRs and answers its workers' permission requests. It comes to you only for money, access, anything irreversible and real forks in direction.
- **Your agents, your subscriptions** -- Claude Code, Codex, any terminal agent is supported -- use your existing subscriptions, no extra charge.
- **See everything at a glance** -- Every agent gets a desk in the pixel office: facing the screen while it works, turning to face you when it needs you. One window for every repo, with live terminals, a file explorer and inline diffs.
- **Agents that talk to each other** -- Tell one to "add that to the job board" or "ask Viper what it changed", and it does it over MCP.

Everything else -- scheduled jobs, phone layout, voice input, themes, and the details and caveats of each feature -- is in [docs/FEATURES.md](docs/FEATURES.md).

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

The job board reuses that same machinery: a dispatched job is an ordinary agent, with a real terminal you can type into and take over at any point. Each job gets its own worktree and branch, so a job maps one-to-one onto a branch and a pull request. When the agent finishes it calls the board's `finish_job` tool (a card that requires a pull request hands over the PR it opened; one that does not hands over a summary), and the card moves to Review with the agent still running, so you can click straight into it to ask about the work. When the card reaches Done the board closes the agent and releases its worktree and local branch; the PR itself is untouched, and work that was never pushed is kept as an orphan rather than deleted. **Re-spawn** on an orphan picks that conversation back up with the CLI it ran, `codex resume <session-id>` (the newest Codex session recorded in that exact worktree) or `claude --continue`, under the permission mode its job card was dispatched with (a board agent whose card is already finished or deleted follows the board's current setting), or, for an agent you spawned by hand, under the permission flags you started it with. When the PR merges the job is filed away as finished -- the record is kept, the card is not.

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
`--env-file-if-exists`), and `npx @bill10/agent-007` loads a `.env` in the
directory you run it from; variables already set in your environment win over
the file. `npx @bill10/agent-007 --port 8080` overrides `PORT`, and
`npx @bill10/agent-007 --help` lists the options. Everything the app saves
lives in `~/.agent-007`. Copy the template to get going:

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
| `CLAUDE_PERMISSION_MODE` | *(the CLI's own)* | Permission mode every Claude Code agent the app starts runs in (`auto`, `acceptEdits`, `bypassPermissions`, `manual`, `dontAsk`, `plan`). Flags in the command, a card's own mode or a mode picked in the board's dropdown win over it |
| `CODEX_PERMISSION_MODE` | *(the CLI's own)* | The same for Codex agents, mapped onto Codex's sandbox and approval flags |
| `AGENT_MESSAGING` | *(guarded)* | `open` lets any of your agents message any other. By default an agent that asks before acting cannot message one that never asks |
| `BILLION` | *(on)* | `0` (or `false`/`off`/`no`) turns Billion off. It is also off whenever user accounts exist, since it would belong to everyone |
| `BILLION_DIR` | `~/.agent-007/billion` | Billion's own folder and git repo. Point it at a new or empty folder |
| `TRUST_BOARD_WORKTREES` | *(on)* | Board-dispatched Claude Code workers skip the workspace-trust dialog, so queued jobs start unattended. That also lets the repo's own `.claude/settings.json` hooks and permission allow rules apply without asking. `0` (or `false`/`off`/`no`) keeps the dialog. Hand-started agents always keep it |

> **Running remotely?** The server spawns real shells, so never expose it to the
> open internet. See [docs/REMOTE.md](docs/REMOTE.md) for the recommended
> Tailscale setup.

### Multiplayer & login

By default there are no user accounts and no login — the app runs open on
localhost, exactly as before. To turn on per-user login (for shared/remote use),
create a user:

```bash
npm run adduser -- "Alice"     # prints a one-time login token
npx @bill10/agent-007 adduser "Alice"  # the same, without a clone
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

Agent 007 runs on macOS, Linux, and Windows -- spawning agents, adding repos, and browsing paths all handle Windows natively, and CI runs the test suite on both Ubuntu and Windows. One Windows caveat: the per-agent MCP config file protects its token with POSIX file permissions, which Windows doesn't have, so on a shared Windows machine other local users can read it.

## Troubleshooting

**`npm install` fails building `node-pty`.** `node-pty` ships prebuilt binaries for macOS, Linux and Windows on x64 and arm64, so normally nothing compiles. Only if the install tries to build it from source and fails, install a C++ toolchain and run `npm install` again:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** `build-essential` and `python3` (`sudo apt install build-essential python3`)
- **Windows:** [Visual Studio Build Tools](https://github.com/microsoft/node-pty#windows) with the C++ workload

## Architecture

```
server.js          Entry point + orchestrators (createSession, killSession)
server/
  state.js         Shared mutable state (sessions, orphans, pools, config)
  config.js        Config persistence (load, save, crash recovery)
  direct-run.js    Entry-point detection (symlink/space-safe `npm start` guard)
  git.js           Git operations (worktree, file tree, diff)
  jobs.js          Job board dispatcher (scan, spawn, PR watch, schedule firing, attachment files)
  command-path.js  Resolves commands to spawnable files on Windows (PATHEXT)
  pty.js           PTY lifecycle (spawn, handlers, state detection)
  ws.js            WebSocket (message routing, broadcast, origin check, shared terminal sizing)
  http.js          HTTP routes (/api/browse, /api/jobs, job attachment downloads, /mcp, origin + auth gates)
  mcp.js           The board's MCP server (post_job, list_jobs, read_job, edit_job, finish_job, list_agents, send_message; Billion also gets billion_ready, add_repo, close_job, answer_permission)
  messages.js      Agent-to-agent messages and board notices (who can reach whom, rate limit, queued until the recipient rests at its prompt)
  billion.js       Billion's folder (git repo, templates, charter refresh) and whether it runs
  approvals.js     Hands a worker's permission request to Billion and waits for its answer
  permission-hook.js  Claude Code PermissionRequest hook a worker on Billion's cards runs
  agent-mcp.js     Per-session MCP config + the flags that connect Claude Code and Codex to it
  agent-mcp-bridge.js  Codex stdio bridge to the board's HTTP endpoint
  agent-transcripts.js  Which CLI last ran in a worktree, read off its transcripts (re-spawn fallback)
  auth.js          Login tokens, user accounts, agent session tokens
bin/
  agent-007.js     The `agent-007` command (`npx @bill10/agent-007`): flags, .env, start
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
templates/
  billion/         Billion's starting files (charter, owner rules, STATE.md, COMPANY.md)
```

## Acknowledgements

- Inspired by [pixel-agents](https://github.com/pablodelucca/pixel-agents), the VS Code extension that put AI agents in a pixel office first.
- Character sprites and the ambient decor sprites (`furniture/cactus.png`, `plant_2.png`, `sofa_side.png`, `sofa_front.png`, `coffee_table.png`, `coffee.png`, `table_front.png`, `chair_side.png`, `chair_back.png` -- the two chairs recolored, and `chair_front.png` drawn for this project in the same style) from [pixel-agents](https://github.com/pablodelucca/pixel-agents) (MIT, © Pablo De Lucca — license vendored at `public/assets/characters/LICENSE`), character bases by JIK-A-4's ["Metro City" free top-down character pack](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack) (CC0)
- Desk and `bookshelf.png` sprites from the Free Furniture Office Equipment Set by Antea (CC-BY 4.0)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

[MIT](LICENSE)

If this is useful, a ⭐ helps others find it.
