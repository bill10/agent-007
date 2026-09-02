# Agent 007 — Design System

## Identity

Agent 007 is a pixel office for managing AI terminal agents. The aesthetic is
dark, terminal-native, with spy/espionage personality. UI should feel like a
mission control dashboard — calm, information-dense, utility-first.

**Logo:** Golden martini glass (filled, with olive) placed inline between
"Agent" and "007" in the app title. Favicon uses the same martini glass SVG.

**Brand color:** Gold `#d4a847` — used as the accent color throughout.

## Naming Conventions

**Agents** — Spy codenames from a fixed pool:
`Shadow, Phantom, Viper, Cipher, Raven, Onyx, Echo, Spectre, Falcon, Ghost, Dagger, Mirage, Cobra, Apex, Ember`

Random assignment, recycled on agent death. User can override with custom name.

**Branches** — Cocktail names with `{git-username}/` prefix:
`bill/vesper, bill/martini, bill/gimlet, bill/negroni, bill/sidecar, bill/daiquiri, bill/manhattan, bill/mojito, bill/paloma, bill/sazerac, bill/aviation, bill/bellini, bill/spritz, bill/collins, bill/julep, bill/highball, bill/rickey, bill/fizz`

Git username read from `git config user.name`, lowercased, spaces to hyphens.
Falls back to `agent` if not configured. User can override with custom branch name.

**Start point** — every agent branch starts from `origin/<base>`, fetched first,
where `<base>` comes from the remote's own HEAD (falling back to `main`, then
`master`). Not from HEAD of the main checkout: that silently started agents on a
stale local base, or worse, on whatever unrelated branch the user had checked
out, whose half-finished work then rode along in the agent's PR. Degrades
cleanly — no network or no remote falls back to the local base branch, and a repo
with neither falls back to HEAD. Overridable per spawn via Advanced -> "Start
from" for the "branch off what I'm working on" case.

## Color System

Two themes: dark (default) and light. Gold accent in both. Persisted to localStorage.

### Dark Theme (default)
```css
--bg-dark:       #090a0c    /* deepest: headers, panel tops */
--bg-panel:      #0f1114    /* panels: explorer, terminal */
--bg-office:     #131519    /* pixel office canvas */
--bg-terminal:   #07080a    /* terminal viewport */
--bg-tabs:       #0d0e11    /* tab bar */
--border:        #1f2228
--text:          #d8dce4    /* primary text */
--text-muted:    #9ca3af    /* secondary text (agent names, buttons) */
--text-dim:      #6b7280    /* tertiary text (branches, labels) */
--accent:        #d4a847    /* gold: interactive elements, brand */
```

### Light Theme (warm low-glare paper, Flexoki-style neutrals)
```css
--bg-dark:       #e6e4d9    /* headers, sidebars */
--bg-panel:      #f2f0e5    /* content panels */
--bg-office:     #dad8ce    /* pixel office */
--bg-terminal:   #f2f0e5    /* terminal */
--bg-tabs:       #e6e4d9    /* tab bar */
--border:        #c6c3b6
--text:          #1c1b1a    /* warm near-black ink */
--text-muted:    #62615c
--text-dim:      #6b6a64
--accent:        #7d611f    /* darker gold: 4.5:1+ on panel/header creams, 4.1:1 non-text on the office canvas */
--accent-contrast: #fff     /* ink on accent fills and message-state chips (#111 on dark) */
--hover:         rgba(0,0,0,0.05)   /* row-hover overlay (white-tint on dark) */
--state-working:      #8c6200
--state-waiting:      #1a7f37
--state-message:      #aa540f
--state-idle:         #7b7973
--state-disconnected: #c8222e
--state-recording:    #c8222e
```
Surfaces stay in the cream band (~L*90) rather than near-white so long
terminal sessions don't glare. `test/theme-tokens.test.js` guards every hex
value in the fence above against the CSS tokens in `style.css`, checks that
every `:root` token has a light override, and keeps the terminal's
background/foreground/cursor on the same values. The 16-color ANSI palette
below is hand-picked and not auto-guarded.

### State indicators (dark theme values; light values in the fence above)
```css
--state-working:      #d4a847    /* yellow: agent is producing output */
--state-waiting:      #7fbc6a    /* green: agent is at a prompt */
--state-message:      #e0853a    /* orange: agent needs attention */
--state-idle:         #4a4e58    /* gray: no activity */
--state-disconnected: #c44040    /* red: process exited */
--state-recording:    #c44040    /* red: voice input mic is live (same red as disconnected) */
```

### Terminal ANSI Colors (dark theme — GitHub dark palette)
```
black: #6e7681    red: #ff7b72     green: #3fb950    yellow: #d29922
blue: #58a6ff     magenta: #bc8cff cyan: #76d9e6     white: #c9d1d9
brightBlack: #8b949e  brightRed: #ffa198   brightGreen: #56d364  brightYellow: #e3b341
brightBlue: #79c0ff   brightMagenta: #d2a8ff  brightCyan: #a5d6ff  brightWhite: #f0f3f6
```

### Terminal ANSI Colors (light theme — GitHub light on warm paper)
```
black: #24292f    red: #cf222e     green: #1a7f37    yellow: #7d4e00
blue: #0969da     magenta: #8250df cyan: #1b7c83     white: #5c6570
brightBlack: #57606a  brightRed: #a40e26   brightGreen: #1a7f37  brightYellow: #633c01
brightBlue: #0969da   brightMagenta: #8250df  brightCyan: #3192aa  brightWhite: #24292f
```
White and the brights are darkened from stock GitHub-light, which assumes a
#ffffff ground; bold blue/magenta deliberately reuse the normal-weight colors
because the stock brights wash out on the cream ground.

## Typography

- **Font stack:** `'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace`
- **Sizes:**
  - 9px — panel labels (REPOS), uppercase, letter-spacing: 2-3px
  - 10px — branch labels, diff viewer, loading text
  - 11px — explorer items (files, agents), form labels
  - 12px — terminal tabs, form inputs, repo/branch in terminal header
  - 13px — terminal header agent info
  - 14px — app title (bold, letter-spacing: 1px)

## Text Hierarchy

Three levels of text prominence:
- `--text` — Primary content, headings, repo names, app title, buttons
- `--text-muted` — Secondary content, agent names, branch names, labels
- `--text-dim` — Hints, placeholders, inactive items, panel section labels

## Layout

Three-panel layout with per-panel headers:

```
┌─────────────┬──────────────┬────────────────────────┐
│ Agent🍸007  │ + Agent + Job│ Repo: 007bot  ⚡ main ☀│
│ REPOS [+↻<] │              │                        │
├─────────────┼──────────────┼────────────────────────┤
│             │              │ [tab1] [tab2] [tab3]   │
│  Explorer   │  Pixel       │────────────────────────│
│  (file      │  Office      │                        │
│   tree)     │  (canvas)    │  Terminal (xterm.js)    │
│             │              │                        │
└─────────────┴──────────────┴────────────────────────┘
```

- **Panel headers:** All use `--bg-dark` background for visual continuity
- **Dividers:** Gradient top (matches header bg) + border below. Gold on hover.
- **Explorer:** Two-row header (logo row + REPOS row), collapsible via Cmd+E
- **Office:** Centered "+ Agent" and "+ Job" buttons
- **Terminal:** "Repo:" label + repo name + branch icon + branch name + theme toggle in the header; the voice-input mic floats at the viewport's bottom-right, next to the prompt line
- **Terminal tabs:** Draggable for reordering, order persisted to localStorage
- **Jobs tab:** Pinned first in the tab bar, not draggable and not closable. Shows
  an orange count badge when any in-progress job needs the user. Selecting it swaps
  the terminal viewport for the board; selecting any agent tab swaps back to that
  terminal, so `activeSessionId` is deliberately left untouched while the board shows
- Panel widths persisted to localStorage
- Below 900px: explorer auto-hidden

## Pixel Office

Canvas-rendered pixel art workstations at Z=3 scale factor (character sprites
draw at 2x — 16px art in a 32px-tile office).

The canvas is sized from its own CSS box (`flex: 1` under the office header,
`min-height: 0`), never from the panel: the panel height includes the header,
so a panel-sized canvas hung below the panel edge and clipped the sofa and
corner plants (fixed in v0.3.21.2). `renderOffice`, click-to-focus, and the
walk-out animation all lay out against that same box, and the last real size
is kept while the diff viewer hides the canvas so nothing captured meanwhile
lays out against a 0x0 room.

### Per-repo pods (since v0.3.18.0)
- Desks are grouped into pods, one per repo, each on its own rug with the repo
  name above it; agents with no repo (bash terminals) share a final unlabeled
  pod. Within a pod agents keep spawn order, so an unrelated spawn/exit never
  reshuffles desks inside a pod.
- Cell: 32w x 36h Z units (96 x 108 screen px); gap within a pod: 12 x 18;
  gap between pods: 20 x 26
- Max 4 columns per pod, responsive to panel width; the column count
  reserves the rug padding, so a max-width pod's rug never clips at the
  panel edges
- Rug pads the desk block by 4 Z units each side, 7 above (repo label) and
  12 below (agent name tags); rug rects double as the keep-out zone for
  ambient decor
- Rug colour is the brand gold (`GOLD_RGB` in `office.js`, 10% fill with
  32% outer and 16% inner borders), fixed in both themes like the walls and
  floor: the light theme's darker accent is nearly the floor colour, so a
  theme-tinted rug vanished in light mode (fixed in v0.3.21.1). The repo
  label keeps the theme's text colour
- Pods flow left-to-right and wrap when a row would overflow the panel; the
  arrangement is anchored near the top of the floor (first rug 8 Z below
  `FLOOR_TOP`, `POD_TOP_MARGIN`) so a sparse office leaves its empty wood at
  the bottom for decor. A nearly-full floor still centers, clamped to
  `FLOOR_TOP` (pure layout in `computePodLayout`, `public/modules/office.js`)
- Screenshots: `docs/office-pods-sparse.png` (2 agents) and
  `docs/office-pods-after.png` (6 agents, 2 repos) show the top-anchored
  layout at the default 440px panel; `docs/office-pods-before.png` is the
  pre-pod uniform grid

### Desk grid (all desks face front)
- Within a pod, desks sit in a plain classroom grid, every one in the default
  orientation: `cols = min(agentCount, maxCols)` (maxCols derived from the
  panel width, clamped 1..4), agent `i` at column `i % cols`, row
  `floor(i / cols)`. The row pitch keeps a full aisle (`WS_H + WS_GAP_Y`) so a
  back row never occludes the row in front.
- Every screen faces the viewer, so its content (activity lines while
  WORKING, +adds/-dels while WAITING, message lines on MESSAGE) is always
  readable, and the character's facing carries state: back to the viewer =
  working, facing the viewer = idle/waiting. Facing pairs (v0.3.19.0) were
  removed because a flipped desk hid its screen and made a typing agent face
  the same way as a waiting one.
- A narrow panel degrades to fewer columns (down to 1) rather than changing
  desk orientation.

### Workstation anatomy (back-to-front draw order)
1. **Monitor** — 14w x 9h, 1px uniform bezel, content varies by state
2. **Monitor stand** — 2w centered, 1px tall neck + 4w base
3. **Desk** — sprite-based (desk.png / desk2.png), top 13 rows cropped
4. **Character** — sprite-based (pixel-agents sheets `char_0.png`–`char_5.png`,
   16x32 frames drawn at 2x; variant picked by hashing the session id so an
   agent keeps its look across renders; the desk sprite variant hashes the
   same way, so a desk's style sticks to its agent, not its slot).
   State-dependent pose, anchored at sy+13:
   - WORKING: seated typing, 2-frame cycle (static under
     `prefers-reduced-motion`), back to the viewer
   - WAITING/MESSAGE: chair turned around, facing the viewer
   - IDLE: standing, facing the viewer
   - DISCONNECTED: pixel art X pattern, no character
5. **Name tag** — bold 11px monospace, centered below character
   - Active: gold `#d4a847` with pulsing glow animation
   - Inactive: `--text-muted` with 0.7 opacity

### Monitor screen states
- **WORKING:** Animated colored code lines scrolling
- **WAITING:** Shows +additions/-removals (green/red) if changes exist, else prompt chevron with blinking cursor
- **MESSAGE:** Accent-colored text lines with thought bubble (three dots)
- **IDLE:** Same as WAITING
- **DISCONNECTED:** Dark screen

### Message bubble
- Accent-colored dots (not hardcoded orange), positioned relative to character
- Only shown for MESSAGE state (agent needs user input)

### Transient motion
- **Walk in/out:** a newly spawned agent walks in from the entrance
  (bottom-left, just right of the corner plant, since the bottom centre is the
  chat area) to its desk along an L-shaped path, across first so it passes in
  front of the chat furniture; a departing agent walks out the same way before
  its desk disappears. While a walk plays, the motion
  overlay draws the character instead of the seated pass.
- **Dispatch paper:** when the board hands a job to a fresh agent, a small
  paper arcs from that job's whiteboard column down to the new desk.
- All motion is client-side and time-based: animations never replay on page
  load (the connect sync renders pre-existing agents seated), are not queued
  while the tab is hidden, and are disabled under `prefers-reduced-motion`
  (queried live, so flipping the OS setting applies to the next animation,
  not the next reload).

### Room elements
- **Walls:** Fixed warm cream plaster, independent of UI theme
- **Floor:** Warm wood planks, fixed base `#4a3525`
- **Windows:** Two windows with day/night cycle based on local time
- **Job boards:** Three freestanding whiteboards on A-frame stands (not wall-mounted), standing almost against the back wall, one in each wall section (either side of the windows and between them). Titled TO DO / IN PROGRESS / REVIEW after the columns of the `## Job Board` feature below, and kept in step with `JOB_STATES` by a test. Since v0.3.16.0 the pinned posts are live: each board pins one paper per job in its column (a fixed grid of pin slots, filled left to right then top to bottom), draws a "+N" corner chip for jobs beyond the slots, shows a clean board when its column is empty, and repaints on every `jobs-list` broadcast
- **Bookshelves:** A low bookshelf run under each window — three short
  Antea bookcase units tiled edge-to-edge at 2x, centred on the window and
  narrower than it, feet tight against the wall with a contact shadow
  (`computeBookshelfRuns`). Drawn before the boards so an easel overlaps a
  shelf, never the reverse; none when the panel is too narrow for boards
- **Spare desks:** While the office has a single row of real pods, a row of
  up to three empty workstations (dark screens, no character, name or rug)
  sits on the pod grid one row-pitch below it, so a sparse office reads as
  unassigned seats. Only when the row clears the decor and the panel bottom
  by the decor margin (`computeSpareDesks`); it vanishes as rows are added
- **Ambient decor:** The bottom of the floor fills from a fixed candidate
  list — a centred chat area on a label-less pod-style rug (side sofas left
  and right of a coffee table with the coffee pot on it, the right one
  mirrored to face it, and a front-facing sofa above), a leafy plant in the
  bottom-left corner and a cactus bottom-right, all at the 2x character scale.
  A candidate only draws when it clears every pod rug by a margin
  (`computeDecorPlacement`), so decor yields and disappears as desks crowd the
  room. `docs/office-decor.png` shows a one-row office at a 458px panel
- **Particles:** 5 ambient dust motes

## Job Board

Three columns in the terminal panel: To do, In progress, Review. Card state is
durable (persisted in `config.json`). What a live agent is *doing* is derived;
what the board could not do — a PR check that failed — is stored, because it is
a fact about the board, not about a PTY.

### The fourth state has no column

A job whose PR has merged is `done`, and `done` is the one state with no
column. A Review column that accumulates merged work stops meaning
"needs your review" — the only column whose job is to hold a short list of
things a human still has to look at becomes an archive nobody reads.

The sweep covers In progress as well as Review: a PR can open and merge inside
one scan interval, and `--state open` cannot see it afterwards, so a
Review-only sweep would leave that card in In progress forever reading "agent
gone" for work that had shipped. Finishing from In progress retires the agent
(that is what the per-repo cap counts); finishing from Review does not.

The job itself is kept, never deleted: it is the record of what an agent did and
where the PR is. It is reached through **View finished jobs** in the toolbar,
which swaps the columns for the archive rather than sitting beside them, so a
list that only grows can never squeeze the live work.

**Done is terminal.** A finished card cannot be moved back onto the board; the
only thing that can happen to it is deletion, and the manual `✓ Done` button
asks before filing a card away because of it. An earlier design let a card
return to Review, and it could not be made safe: the card keeps the PR that
finished it, and `reviewAt` is the sweep's time floor, so a job walked back to
In progress carried a spent PR of record into its new attempt. The sweep matched
that same old merge on the very next scan and filed the card away again — and
because finishing from in-progress retires an agent, it killed whatever terminal
had been re-adopted on the branch. Clearing those fields instead would trade the
bug for a card whose history is gone, which defeats the point of keeping it.
Work that follows a merged PR is a new job; the archive keeps the old one to
point at.

Four rules keep the transition honest:

- **Only MERGED finishes a job.** A PR closed without merging left the work
  undelivered, and someone still has to decide what to do about it — its card
  stays on the board.
- **Only THIS card's merge finishes it.** `gh pr list --head <branch>` matches
  the head ref *name*, and that name outlives the branch: a merged PR stays in
  the listing forever, and board branch names are reused once the branch is
  deleted at retirement. So the sweep matches on the card's own PR number when
  it has one, and otherwise only accepts a merge that happened after this
  attempt started. Without that, a stale merge files a card away while its real
  pull request is still open — and overwrites the card's PR number on the way
  out, so the open one is no longer recorded anywhere.
- **`prMergedAt` is written once and never cleared.** Nothing leaves done, so
  nothing needs to unwind it. It is also what the archive reads to tell a merge
  from a card filed away by hand: a manual `✓ Done` stamps `doneAt` but not
  `prMergedAt`, because the board is recording that the *user* called the job
  finished, which is not a claim about GitHub.
- **The sweep never retires an agent it finds in Review.** Unlike the one-shot
  kill at the PR, this runs every scan; an agent you re-adopted on a shipped
  branch to address review comments is yours. Finishing from In progress is the
  one exception, and barely one: that is a job leaving in-progress, which is
  exactly what the per-repo cap counts. A manual move to Done retires it too,
  because that is the user saying the job is over. Exactly one manual move keeps
  an agent — a move into In progress, taking the work back up; every other one
  retires it.

### One-time and scheduled cards

Two kinds of card share those three columns.

A **one-time** job is the original: dispatched once, it crosses the board and
stops in Review when its pull request appears. A **scheduled** job is a standing
card fired by a cron schedule; it cycles To do -> In progress -> To do and never
reaches Review. Cards written before types existed carry no `type` at all, so
every read goes through `jobType()` — a missing type is one-time, which is what
those cards have always been.

- **Same columns, not a fourth one.** A scheduled card between runs is queued
  work like any other, and pulling it into its own column would take it out of
  the glance the three columns exist to give. It is marked with a chip and a row
  showing the cron, the next run, and how many times it has run.
- **Exempt from the per-repo cap, in both directions.** The cap exists to
  bound how many agents the board piles onto one repo while draining the
  one-time queue. A scheduled card neither counts toward it nor waits behind
  it: it is already bounded — one run at a time, at cron pace — and holding it
  under the cap would let two long one-time jobs silently starve every
  schedule on the repo, with the missed firings never replayed. The cap's
  invariant is unchanged for what it actually governs: one-time in-progress
  cards and their live agents remain the same set.
- **The prompt is the task, plus one line.** A scheduled job need not be code
  at all, so the review/ship instruction is gone — telling an agent that
  summarises yesterday's commits to run `/ship` would push it into inventing a
  change so it had something to open a pull request with. Nothing replaces it:
  an agent already ends its turn with a summary, and the kept terminal (below)
  is what makes that summary readable. The one line that stays is
  assumptions-over-questions, because a run that stops to ask holds its card
  in In progress until a human notices.
- **A run ends with its agent, not with a pull request.** There is no artefact
  to watch for, so what is left is the agent: the run is over when it exits, or
  when it has been parked at its prompt past the quiet window. MESSAGE is
  excluded — that is the agent asking a question, and killing it would throw
  away the answer it is waiting for, so such a run holds its slot and shows
  "needs you" exactly as a one-time job does. `finishScheduledRuns` runs first
  in each scan, so a run that ended has its card back in To do in time for the
  same scan to dispatch what was queued behind it. A session gone entirely also
  counts as over, so a run whose agent was killed or crashed closes out the
  same way. A restart does not wait for that: `loadConfig` re-arms a scheduled
  card caught in-progress on the spot — back to To do, next run computed from
  now, with a `lastError` naming the interrupted run's branch so its work can
  be recovered from the orphans list. **End run** on the card is the manual
  version of the same move, and its only manual control while running.
- **The run's terminal outlives the run.** The agent is not killed when the
  run ends: its terminal is the run's only output — a scheduled job need not
  produce code — and killing it would destroy the summary before anyone read
  it. The card keeps a pointer to the tab ("last run · open terminal"), and
  the next dispatch retires it, or the user closes it by hand; deleting the
  card retires it too. Bounded at one kept agent, and so one worktree, per
  card between runs.
- **A run that leaves a dirty worktree orphans it, every time.** `removeWorktree`
  keeps a worktree whose tree is dirty or whose commits are unpushed, which is
  the right call for a one-time job — that is somebody's work. Recurrence
  amplifies it: a scheduled job that reliably leaves a modified file orphans
  one worktree per run, hourly, each one when the next run retires the kept
  agent. Deliberately not capped here. The orphan
  notification fires on every run, so it is visible rather than silent, and the
  fix belongs in the job (stop leaving files behind), not in a policy that
  starts deleting work the rest of the app promises to keep. `git status
  --porcelain` respects `.gitignore`, so build output in an ignored path does
  not trigger it.
- **The PR watcher and the merge sweep both skip scheduled cards.** A scheduled
  run that happens to open a pull request must not be moved to Review, and one
  whose pull request merges must not be filed away as done — either would take
  the card out of rotation permanently, and done is terminal. The server
  refuses a manual move to Review or Done for the same reason (delete the card
  to retire its schedule), and type and schedule are only editable while the
  card sits in To do — flipping an in-flight card would corrupt the cap
  accounting and the run finisher's view of it.
- **The next run is measured from the end of the last one**, never stepped on
  from the previous due time, so a run that overran its own interval schedules
  the next one afterwards instead of coming due again the instant it lands.
  Missed firings never queue up, but the LAST one is owed: a board stopped
  overnight still holds each card's past due time, so every overdue schedule
  fires once at the first scan after boot and re-arms into the future from
  there. One catch-up run, never a backlog.
- **Cron granularity is bounded by the scan interval.** The dispatcher only acts
  on a scan (five minutes by default, floor 30s), so `* * * * *` means "every
  scan", not every minute. Times are the server's local time — the schedule is
  written by the person sitting in front of the machine the agents run on.
- **A five-field parser, not a dependency** (`lib/cron.js`). Ranges, lists,
  steps, `7` for Sunday, and the `@hourly`/`@daily`/... shorthands, plus the one
  genuinely surprising rule: when both day fields are restricted they are ORed.
  `nextCronTime` walks whole months and days rather than minute by minute, and
  gives up after four years — enough for 29 February, bounded for an expression
  like `0 0 30 2 *` that parses fine and can never match. Such a card is stored
  and says "never fires again" rather than being refused, because refusing it
  would mean the parser having to know about calendars — and `isJobDue` treats
  it as never due, since "no next run time" would otherwise read as "due now"
  and fire the card on every scan. Local arithmetic is also how the walk moves,
  so an hour that a daylight-saving transition skips simply does not fire that
  day (what cron does), and a step that fails to advance ends the walk rather
  than spinning.

### Card states and colors
- Left border and status pill follow the agent's live state, reusing the shared
  `--state-*` tokens rather than introducing a second vocabulary:
  - `running` -> `--state-working` (agent is producing output)
  - `needs you` -> `--state-message` (agent is at a prompt or dialog; the dot
    pulses, and only this one pulses -- a merely quiet card must not compete for
    attention with one that is actually blocking)
  - `quiet -- may need you` -> `--state-idle` (parked at a prompt past the window)
  - `agent gone` -> `--state-disconnected` (session ended)
  - On a scheduled card, `quiet` and `agent gone` both render as `run finished`
    in idle gray instead: that quiet IS the run's completion signal, and the
    alarm colors would tell the user they might be needed when they are not.
- Clicking anywhere on an in-progress card switches to that agent's terminal;
  the status pill does the same, and stays the keyboard path since the card
  itself is not a tab stop. Card buttons, the PR link, and a click that ends
  a text selection on the card are all excluded.
- Card actions are hidden until hover/focus-within, so a full board stays scannable.
- Two error lines can appear, and they are independent. `lastError` carries what
  happened to the job (a dispatch failure, or "agent lost" after a restart);
  `prCheckError` carries why the board cannot check for the pull request at all.
  Both can be true at once — the agent is gone AND this repo is invisible to the
  signed-in `gh` account — so neither may silence the other.
- The agent line renders whichever of agent name, branch and start time are
  known. The branch is a fact about the job, not about the agent: gating it on
  the name left a finished card showing nothing once the name was lost.

### Derived, never stored
"Needs you" describes a PTY as it is right now. It is computed on both sides --
the server derives it per broadcast, the client recomputes from its own agent map
on every state change -- and never persisted, since a stored copy would be stale
the moment the server restarted. The same reasoning is why `prCheckError` IS
stored: it describes the board's own ability to reach GitHub, which outlives any
session and is not re-derivable from one.

### Identity across restarts
No session survives a restart, so every job's `agentSessionId` is cleared on
load. Session ids also carry a per-process prefix: the counter alone restarts at
zero while job records outlive the process, so a stored `session-5` would
otherwise resolve to whatever `session-5` is in the next generation — an
unrelated agent on a different branch.

`agentName` is kept. It is history, not a live link: "Phantom did this work"
stays true across a restart, and it is the credit the card exists to show.

The BRANCH is the durable identity. It is created per job, not reused while it
exists, and survives on both the orphan record and the job — so it is what
reconnects a re-adopted agent to its card, and what finds the agent to retire
when the stored link is gone.

### Board-spawned agents
A dispatched agent is an ordinary agent with one difference: its tab opens
without taking focus (`spawnedBy: 'board'`), because an unattended dispatcher
firing every five minutes would otherwise move the user's cursor mid-sentence.
Its tab dot carries a faint outline to show where it came from, and the tab is
disposed automatically when the agent is retired.

Retirement happens when a one-time job LEAVES In progress — to Review when its
pull request appears, or straight to Done when that pull request opened and
merged inside a single scan — and on a manual move to Done, which is the user
saying the job is over. A scheduled run's agent is the exception: it outlives
its run as the kept terminal and is retired by the next dispatch, by the user
closing the tab, or with the card's deletion (see "One-time and scheduled
cards"). It never happens as a recurring sweep over jobs already in
Review, and never over a card in the archive, which no longer has an agent to
retire. An agent you re-adopt on a shipped branch to address review comments is
yours; a poll that killed it every five minutes would make Review permanently
hostile to working on your own PR.

### Agent-posted jobs
An agent you are talking to can put a card on the board when you ask it to, so
"add that to the job board" does not mean leaving the conversation to type it.
The board exposes one MCP tool, `post_job`, over streamable HTTP from the app's
own Express server (`server/mcp.js`), and every spawned Claude Code agent is
pointed at it with `--mcp-config` (`server/agent-mcp.js`).

- **A tool, not a command on PATH.** An agent does not enumerate its `PATH`, so
  a binary sitting there is invisible — the first attempt at this feature put a
  CLI on every agent's `PATH` and the only thing that ever told an agent it
  existed was a line appended to every dispatched job's prompt, which is an
  instruction to queue work rather than a capability to use when asked. A tool
  arrives in the agent's tool list with a description. That is real discovery,
  and it is passive: nothing anywhere tells an agent to post jobs.
- **HTTP, not stdio.** stdio would have Claude Code spawn a server process per
  agent. We already listen on a port, so HTTP costs no processes at all.
- **Merged with the user's own MCP servers, never replacing them.** We pass
  `--mcp-config` and deliberately NOT `--strict-mcp-config`: the strict flag
  scopes cleanly but takes away every MCP server the user has configured, inside
  every agent this app spawns. Verified both ways against the real CLI.
- **Claude Code only, by construction.** Gemini CLI has no per-invocation MCP
  config flag (only `gemini mcp add`, which writes its persistent settings) and
  Codex configures MCP through `~/.codex/config.toml`. Appending the flag to
  either is an unknown-option error and a dead spawn, so injection is gated on
  the binary being `claude` and every other command is passed through untouched.
  `POST /api/jobs` is the same action behind plain HTTP, kept as the door those
  agents could use — the MCP tool is a wrapper over it, not a second copy.
- **The token is a file, not an environment variable.** An env var is inherited
  by every child process the agent starts — a test run, an install script in a
  repo under review — and any of them could read it. The token lives in a
  mode-0600 config file that the MCP client opens at startup and that is deleted
  when the PTY exits. It identifies one live agent, never a user, and it stops
  resolving the moment that session ends.
- **`requireUser` is the default; agent access is opt-in.** Routes an agent
  token may reach are registered ABOVE the `requireUser` gate in `setupRoutes`,
  and that placement is the whole access-control decision. The earlier shape had
  it the other way round — agents allowed unless a route remembered to exclude
  them — which meant `/api/browse` had to be retrofitted the day the credential
  was introduced.
- **Claude Code asks the user before the call goes through.** Measured: under
  both the default mode and `--permission-mode auto`, a `post_job` call waits for
  approval. That is the right outcome and not something to design around — a
  card is filed because a person said yes. It does mean an unattended agent
  cannot post one, which is exactly why nothing instructs dispatched agents to.
- **Attribution is two facts, not one.** `postedByAgent` (which agent typed it)
  is stored beside `postedBy`/`postedByName` (whose work it is), and the card
  shows the agent as an accent-tinted `via <name>`. Folding them into one field
  would make a machine-queued card indistinguishable from a hand-typed one.

### Branch naming
Board branches are named from the job title rather than a cocktail:
`{git-username}/add-rate-limiting`. Slugged to `[a-z0-9-]` and length-bounded,
which side-steps every git ref rule at once instead of enumerating them. Two jobs
may share a title, so collisions walk `-2`, `-3`; names taken on the remote count
as collisions too, since a finished job leaves its remote branch alive (that is
the open PR).

## Interactive Behaviors

### Icon buttons
- Shared `.icon-btn` primitive (formerly `.theme-toggle`): theme toggle in the
  terminal header; the voice mic reuses it with the `.voice-fab` overlay class

### Voice input
- Mic button floats bottom-right of the terminal viewport (`.voice-fab`,
  34px, shadowed, clears the xterm scrollbar) so it sits next to the prompt
  line being dictated into
- Mic button pulses `--state-recording` red while listening (`mic-pulse`)
- Transcript pill is anchored to the mic (right-aligned with the fab, one
  row ABOVE it, growing leftward) so the reaction appears where the user
  clicked without ever covering the terminal's last row — that row is where
  dictated keystrokes echo; it slides up from the mic (`pill-in`) on show
- Fab/pill/presence geometry all derive from `--voice-fab-*` custom
  properties on `:root`; the presence pill is stacked above the voice column
  (`bottom: var(--voice-column-top)`) so it can never sit on the mic and eat
  its clicks, and resizing the fab moves the whole column together
- The recording signals (button pulse, live dot, screen-reader "started")
  turn on only after `getUserMedia` grants — the requesting phase uses the
  dot-less notice variant
- `prefers-reduced-motion: reduce` disables the pulse and slide animations
- The pill's pulsing dot means "recording" — hidden on notice/error variants
  (the mic is off there; a red dot would be an inverted privacy signal)
- Screen-reader announcements go to a visually-hidden `.sr-only` live region

### Theme toggle
- Sun/moon SVG icons in terminal panel header
- Toggles between dark and light themes
- Terminal colors update in real time (full ANSI palette swap)
- The office canvas repaints once on toggle — the animation loop skips frames
  when no agents are alive, so without it the canvas kept the old theme's colors

### Auto-reload on reconnect
- WebSocket reconnection triggers full page reload
- Clears stale agent state after server restart

### Clipboard paste
- Cmd+V with image data in clipboard uploads as screenshot
- Uses capture phase to intercept before xterm.js

### New agent spawning
- Preset buttons at the top of the spawn dialog (Claude Code, Codex, Gemini,
  and a shell) fill the Command field, which lives inside the collapsed
  Advanced section; the shell preset follows the server's OS — PowerShell on
  win32, Bash elsewhere — using the `platform` field the welcome message
  carries, and re-renders if the form was opened before the socket connected
- Newly spawned agent auto-activates (switches terminal tab)
- Empty repos get automatic initial commit

### Branch sync
- Branch name updates in real time in explorer and terminal header
- Server polls branch on every file tree scan cycle
