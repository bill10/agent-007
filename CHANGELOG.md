# Changelog

All notable changes to Agent 007 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses a four-part `MAJOR.MINOR.PATCH.MICRO` version.

## [0.3.29.3] - 2026-09-03

### Fixed

- An idle agent walking over to the conference table now checks that its way is
  actually clear. Two legs of that walk were picked from the table's shape
  alone: the row it crossed the room on was a fixed offset above the tabletop,
  and the lane it came down beside the chairs never looked at the furniture at
  all. If anything stood between the conference set and that row — a plant, a
  spare desk, a pod rug in a tight room — the agent walked straight over it.
  The crossing now runs along the same clear-row scan the walk in and out
  already used, and the lane is vetted against the furniture, stepping a little
  wider when it is blocked. The head chair is still approached straight down
  its own column, and the last step in still goes between the chairs. On the
  open floor the set usually sits in, the walk is unchanged apart from crossing
  just above the chairs rather than over the tabletop.

## [0.3.29.2] - 2026-09-03

### Fixed

- An agent leaving a seat at the conference table now checks that the way out
  is actually clear. It steps out sideways from between the chairs, as before,
  but that step-out column was picked from the table's shape alone: if anything
  stood between the conference set and the corridor — a plant, a spare desk —
  the agent walked straight down over it. The column is now vetted against the
  furniture the same way every other walk is, and the agent steps a little
  wider when it is blocked. On the open floor the set usually sits in, the
  route is unchanged.

## [0.3.29.1] - 2026-09-03

### Fixed

- An agent walking to or from its desk no longer jumps sideways when someone
  else joins or leaves the office mid-walk. The walker's route was rebuilt from
  the current furniture on every frame while its progress along it ran on the
  clock, so a spawn that changed the room re-projected the walker onto a
  different route — at 900x800 with two repos, a walk could snap a whole desk
  over. The route is now fixed when the walk starts and only rebuilt when the
  canvas resizes.

## [0.3.29.0] - 2026-09-03

### Added

- An agent you are talking to can now read the job board back to you and change
  a card you have not started yet, not just post one. "What is queued?", "what
  does that card say?", "add the repro steps to that one" — the board answers
  through the same MCP tool surface `post_job` already used, so no setup and
  nothing new to learn. A card's id comes back with the listing, which is what
  the read and edit tools take.

### Changed

- A job card stops being editable the moment it leaves To do, for you as well as
  for an agent. Its agent was handed the title, detail and attachments in its
  prompt when the board dispatched it, so an edit afterwards changes nothing
  about the run and leaves the card describing work nobody was asked to do. The
  board's Edit button has only ever appeared on To do cards; now the rule holds
  wherever the request comes from. The cost: retitling a card in Review so the
  archive reads better is no longer possible.
- An agent cannot rewrite a card someone else queued, and an edit it does make
  is announced and marked on the card. A To do card's detail is the next agent's
  prompt, so an unnoticed rewrite is the one edit that matters most.

### Fixed

- A malformed tool call naming a built-in JavaScript property (`valueOf`,
  `toString`) made the board's MCP server return an error page or a nonsense
  result instead of "unknown tool".

## [0.3.28.0] - 2026-09-02

### Fixed

- Agents walking in and out of the office no longer step over the furniture on
  their way to the desk. The route already crossed the room on a clear floor
  row; the up-or-down leg went straight down the desk's own column, over
  whatever rugs, plants and sofas happened to lie between it and that row.
  It now drops down the nearest clear aisle and comes in along the desk's own
  row instead, without walking over the colleagues seated in its own pod, off
  the edge of the room, or out to an aisle it would only have to double back
  over. Agents heading to and from the conference table take the same clear
  aisle. Swept over 6,825 desk positions: 40% fewer routes cross furniture and
  48% fewer cross a colleague's desk, for 2% more walking.

## [0.3.27.3] - 2026-09-02

### Fixed

- The chair at the head of the conference table faced the wrong way and sat in
  the wrong place. It showed the back of a chair, as if its occupant had turned
  away from the table, and it floated in the open floor above the table rather
  than tucking into it. Both came from measuring against the table sprite's box
  instead of the tabletop it paints: the sprite's top sixth is empty, so the
  painted edge is well below where the chair was placed. The head chair now
  faces the room, stands with its feet against that edge, and uses a new
  front-facing chair sprite whose seat cushion catches the light the way the
  side chairs' do. It sits at the table rather than tucking under it, because
  it draws behind the table: overlap that reads as tucked-in on the foot chair
  would simply eat this one, leaving a stub too small to read as a chair.
- Sparser offices get their conference table back. The previous release grew the
  set to make the misplaced head chair visible, which pushed the table out of
  the room entirely on smaller panels. Tucking the chair where it belongs needs
  no extra height, so those layouts seat again.

## [0.3.27.2] - 2026-09-02

### Added

- The conference table now has a chair at the head as well as the foot, so an
  empty top seat reads as a seat instead of bare floor. The head chair sits a
  little higher above the tabletop than its occupant does, which is what lets
  any of it show — the person facing you would otherwise hide it completely.
  How much higher is capped by what the room can spare: a taller chair back
  starts costing the whole conference set on smaller panels.

### Fixed

- The walk in/out route now measures the conference set from the same constant
  the set is built from, instead of a copy of its old height. A route could
  otherwise corridor straight through the top of the set whenever that height
  changed.

## [0.3.27.1] - 2026-09-02

### Changed

- The chairs around the conference table are slate blue instead of bright
  green, so the meeting area sits with the rest of the office instead of
  jumping out of it. The chair sprite only ever shipped in one colour, so the
  two 16x16 PNGs are recoloured in place onto the same blue-grey ramp the
  desks use (`#595d79` / `#4a4e68` / `#3a3e55`). Pixel shapes and transparency
  are unchanged, so nothing about the office layout moves.

## [0.3.27.0] - 2026-09-02

### Fixed

- Agents walking in and out of the office no longer drop to the bottom-left
  corner first. The route now comes in at the left edge on the empty floor row
  nearest the desk, crosses that row, and takes the desk column. There is no
  fixed door — the entrance rides the row, so it sits higher or lower with the
  desk. The row is picked from the furniture on the floor that frame — pod
  rugs, spare desks, the chat areas and plants, and the conference set with its
  chairs — so the walk no longer cuts through the sofas along the bottom edge.
  Most panels are too dense for a row that clears a whole character (the gaps
  run 18-54px against a 64px sprite), so when none fits the widest gap takes
  the crossing and the walker's feet ride its floor. Only a pod grid that
  already overflows the panel falls back to the desk's own row.

## [0.3.26.1] - 2026-09-02

### Changed

- Agents now enter and leave the office through the middle of the left wall
  instead of the bottom-left corner. A new agent walks in from the left edge,
  halfway down the floor, and a departing one walks out the same way along
  the clear left strip and the corridor above the conference table (or the
  bottom edge when there is no table). Spare desks and the conference set
  now keep that strip clear on narrow panels.

## [0.3.26.0] - 2026-09-02

### Added

- Attach screenshots and files to a job. The job form has an **Attach files**
  button, and pasting an image into Details attaches it as a screenshot.
  Files are kept outside the repository, so nothing can end up committed by
  accident, and the dispatched agent is told where to read them. Each card
  lists its attachments as links that open in a sandboxed tab. Up to 20
  files, 10MB each and 50MB in total; a file that cannot be stored is
  refused with a message rather than silently dropped. The files are freed
  when the card reaches Done: the archived card keeps its record and PR
  link, but the run its files were input to is over.

### Changed

- Attachments can only be changed while a card is in To do, the same rule
  that already applied to its repository: an agent mid-run was handed those
  paths when it started.
- An edit that is refused (a bad schedule, an oversized file) now changes
  nothing at all, instead of leaving the text edits half-applied.
- Terminal uploads and job attachments share one file-name sanitiser, which
  now also prefixes Windows device names (CON, NUL, COM1) so a file can
  never be written to a device.

## [0.3.25.0] - 2026-09-01

### Added

- A conference table in the open floor between the desks and the chat areas:
  a vertical boardroom table with cushioned chairs at thirds down both sides,
  one at the foot and a free seat at the head (sprites from pixel-agents,
  MIT). Idle agents wander over and sit there until their state changes,
  then walk back to their desks. The set only places while the band fits it,
  so it yields on short panels just like the rest of the decor.
- Clicking a seated agent at the conference table switches to its terminal —
  click-to-focus follows the character wherever it is.

### Changed

- The bottom decor: the single centred chat area is now a chat area in each
  bottom corner, with the leafy plant stacked above the cactus between them
  as a small divider drawn at 1.25x (down from 2x). The walk-in entrance
  moves to the bottom-left corner strip the chat margin leaves free.
- Walkers route around the conference set: wandering, arriving and departing
  agents climb clear lanes and cross a corridor above the table instead of
  driving through the tabletop or chairs.
- Idle agents already seated when the page connects render seated — no
  replayed commute — and colleagues' read-only agents stay at their desks,
  where their dimming and owner label live.

### Fixed

- A conference sprite that fails to load can no longer make an idle agent
  invisible: characters always draw, with or without their furniture.
- A departing agent walks out from wherever it actually is — its conference
  seat, or its current point mid-walk — instead of snapping to a desk first.
- Message bubbles no longer float over an empty desk while their agent is
  walking the floor.

## [0.3.24.0] - 2026-09-01

### Added

- A sparse office now shows a row of empty spare desks below the real one:
  dark screens, no chair filled, no rug, so the room reads as unassigned
  seats rather than bare floor. They sit on the same desk grid and vanish as
  soon as a second row of real desks is needed.
- A centred chat area at the bottom of the floor: two side sofas either side
  of the coffee table, a front-facing sofa above it, on its own gold rug.
  A leafy plant stands in the bottom-left corner and a cactus bottom-right.
  Like the old decor, all of it yields and disappears as desks fill the room.
- A low bookshelf run under each window, tight against the wall, drawn from
  the same Antea office set as the desks.

### Changed

- The wall plants between the job boards, the bottom-left lounge corner, the
  bottom-right floor plant and the top-corner pots are gone, replaced by the
  bookshelves, chat area and corner plants above.
- Characters now walk in and out from the bottom-left of the floor, beside
  the corner plant, instead of the bottom centre where the chat area is.

### Removed

- The unused `plant_big.png` and `large_plant.png` sprites.

## [0.3.23.2] - 2026-09-01

### Fixed

- The pixel office's plants are smaller: every plant sprite (the wall cactus
  and leafy plant, the floor plant, the corner pots) now draws at 1x so it reads
  as desk-side decor, shorter than a job board, instead of standing as tall as
  a person. Being smaller, the corner and floor plants also fit in offices that
  used to be too crowded for them.
- The two back-wall plants are centred in the gaps between the three job
  boards, computed from the boards' positions, so they no longer overlap a
  board edge and stay centred when the panel is resized. On a panel too narrow
  for boards they stay out of the way too.

## [0.3.23.1] - 2026-09-01

### Changed

- The wall hangings (clock and two small paintings) added in 0.3.22.0 are
  removed again; the back wall beside the job boards is bare plaster.
- The break-room sofa is now a side view that faces right, toward the coffee
  table, instead of facing the viewer.

## [0.3.23.0] - 2026-09-01

### Changed

- Desk pods in the pixel office now sit just below the job boards instead of
  floating in the middle of the floor. With only a few agents the empty wood
  collects at the bottom, where the sofa and plants live, rather than as a
  dead band under the boards. A busy office that fills the floor lays out
  exactly as before.

## [0.3.22.0] - 2026-09-01

### Changed

- The pixel office no longer repeats one potted plant everywhere. Each window
  now gets a single plant of its own — a cactus by the first, a leafy plant by
  the second — and no plant sprite appears more than twice in the room.
- The bottom-left corner is a small break room: a real sofa sprite next to a
  coffee table with a coffee pot on it, replacing the drawn-by-hand sofa. A tall
  floor plant stands in the bottom-right corner. As before, the decor yields to
  desk pods as the office fills up.
- The back wall carries a clock and two small paintings beside the job boards
  (above them on the default narrow panel), so the plaster is no longer bare
  between the windows.
- Sprites come from the pixel-agents project (MIT) and are attributed in the
  README; a sprite that fails to load is simply skipped.

## [0.3.21.2] - 2026-09-01

### Fixed

- The sofa and the corner plants along the bottom of the office are no longer
  cut off mid-sprite. The canvas was being sized to the whole office panel,
  header included, so its bottom band hung below the panel edge and was
  clipped; it now fills exactly the area under the "+ Agent" / "+ Job" bar.
  Desks sit correctly centered in that space and click-to-focus, panel
  resizing, and the agent walk-out animation all measure the same box. While
  the diff viewer hides the office, the canvas keeps its last real size, so
  agents who leave while a diff is open still walk out from their own desk
  and dispatch papers already in flight are not dropped.

## [0.3.21.1] - 2026-09-01

### Fixed

- The rug under each repo's desk pod is visible again in light mode. It was
  tinted with the theme accent, and the light theme's darker gold is almost
  the same colour as the wood floor, so the rug disappeared. The rug now uses
  the same fixed gold in both themes, like the rest of the office furniture;
  the repo label keeps the theme's text colour.

## [0.3.21.0] - 2026-09-01

### Changed

- Every desk in the pixel office now faces front again. Desks inside a repo's
  pod sit in a plain classroom grid (up to four across, wrapping into rows
  with a full aisle between them), so every monitor screen stays readable and
  an agent's facing always tells you its state: back to you means working,
  facing you means idle or waiting. A narrow panel drops to fewer columns
  instead of turning desks around.

### Removed

- The face-to-face desk pairs from v0.3.19.0, along with the monitor-back
  sprite and the facing-pair screenshots. A turned desk hid its screen and
  made a typing agent face the same way as a waiting one.

## [0.3.20.0] - 2026-09-01

### Added

- The pixel office now shows cause and effect in motion. When the job board
  dispatches a job, a small paper flies from that job's whiteboard column down
  to the new agent's desk. A newly spawned agent walks in from the office
  entrance to its desk and sits; an exiting agent stands up and walks out
  before its desk disappears — including agents the server retires, such as
  board agents closing after opening their pull request.
- Animations respect your system's reduce-motion setting (agents appear and
  disappear instantly), never replay on page load for agents already running,
  and skip entirely while the tab is in the background.

## [0.3.19.0] - 2026-09-01

### Changed

- Desks in a pod now pair up facing each other across a shared aisle, the way
  a real office arranges them: the top desk of each pair turns toward you, its
  character seated behind it with the monitor's back to the aisle, while its
  partner faces it from the other side. A waiting agent at a turned desk reads
  instead of typing so its state stays readable, a lone agent keeps the
  familiar single desk, and an odd agent out takes a default desk at the end
  of the pod without leaving an empty row under the rug.
- Each agent's desk style now sticks to the agent (like its character sprite)
  instead of its position in the room, so desks no longer restyle when an
  unrelated agent leaves.
- On narrow panels, a full-width pod now leaves room for its rug border
  instead of letting the rug clip at the panel edges.

## [0.3.18.0] - 2026-08-31

### Changed

- The pixel office now seats agents in per-repo pods: agents working on the
  same repo share a rug labeled with the repo name, and separate repos sit
  visibly apart. Agents without a repo (bash terminals) get their own
  unlabeled pod. With a single repo the desk layout is unchanged — the
  shared labeled rug is the only addition.
- Leftover floor space fills with ambient furniture — a sofa-and-plant
  corner and potted plants — that yields and disappears as desks crowd
  the room.

## [0.3.17.0] - 2026-08-31

### Changed

- The agents in the pixel office are now real pixel-art characters (six
  variants from the pixel-agents sprite pack) instead of procedurally drawn
  figures. A working agent sits typing at its keyboard, an agent waiting for
  you turns around in its chair to face you, and an idle agent stands by its
  desk. Each agent keeps the same look for as long as it runs.

### Removed

- The old procedurally drawn character code (~150 lines of fillRect art).

## [0.3.16.0] - 2026-08-31

### Changed

- The whiteboards in the pixel office now show the real job board: each board
  pins one paper per job in its column (To do, In progress, Review), updates
  the moment the board changes, and notes "+N" when more jobs are queued than
  fit on the board. An empty column shows a clean board instead of decorative
  paper.

## [0.3.15.0] - 2026-08-31

### Added

- Repo sections in the file explorer can now be collapsed: click a repo
  header (or focus it and press Enter/Space) to fold that section away and
  click again to bring it back. A collapsed header still shows how many
  agents live inside and a colored dot for the most urgent agent state, so
  nothing important goes quiet just because a section is folded. Which
  sections are folded is remembered in the browser, so a page refresh keeps
  your layout.

## [0.3.14.0] - 2026-08-31

### Added

- The "+ Agent" dialog now offers one-click presets — Claude Code, Codex,
  Gemini, and Bash — so starting an agent no longer means typing its command.
  Picking one fills the Command field under Advanced, and the shell preset
  follows the server's operating system: PowerShell on a Windows server, Bash
  everywhere else.

### Fixed

- A quiet Codex or Gemini agent no longer reads as idle: state detection now
  treats `codex` and `gemini` commands as TUI sessions, so their workstations
  show waiting (green) at a quiet prompt instead of idle gray.

## [0.3.13.1] - 2026-08-31

### Changed

- The README now says what the last few releases made true: Agent 007 runs on
  macOS, Linux, and Windows — spawning agents, adding repositories, and
  browsing paths all handle Windows natively, and CI runs the test suite on
  both Ubuntu and Windows. It also names the one Windows caveat: the per-agent
  MCP config file's token protection is POSIX permissions, which Windows
  doesn't have.

### Fixed

- The README's and CONTRIBUTING's node-pty links pointed at a personal fork;
  they now point at microsoft/node-pty, where the dependency actually lives,
  and the Windows requirement names Visual Studio Build Tools instead of the
  deprecated windows-build-tools.

## [0.3.13.0] - 2026-08-31

### Added

- A theme-token sync test (`test/theme-tokens.test.js`) that fails if the
  palette in DESIGN.md, the CSS light-theme tokens, and the terminal's core
  colors drift apart.

### Changed

- Light mode is easier on the eyes: panels and the terminal now sit on warm
  low-glare cream surfaces instead of near-white, with warm near-black ink
  and a darker gold accent, tuned to WCAG AA contrast on the panel surfaces.
- Light-mode state colors, terminal ANSI colors, and text selection were
  retuned for the cream background so nothing washes out.

### Fixed

- Diff add/delete highlighting, row-hover feedback, the office watermark,
  and primary-button labels were unreadable in light mode; each now has a
  light-theme-aware color.
- Toggling the theme with no agents running repaints the office canvas
  immediately instead of leaving it in the old theme's colors.

## [0.3.12.3] - 2026-08-30

### Changed

- CI runs the test suite on windows-latest as well as ubuntu, so a change that
  passes locally on macOS/Linux can still go red on the Windows leg.

### Fixed

- A `.gitattributes` file forces LF line endings at checkout. Without it,
  Windows checkouts got CRLF, and the `\r` after `server.js`'s shebang line
  broke Vite's transform of that file — the whole `test/server.test.js` suite
  died at collection with "Invalid or unexpected token".
- On Windows, Vitest's test and hook timeouts are 30s instead of 5s/10s: the
  git-heavy worktree tests run 5-12s on a Windows CI runner and were timing
  out.

## [0.3.12.2] - 2026-08-30

### Fixed

- The test suite passes on Windows. `test/server.test.js` used to fail before a
  single test ran because Vite tried to transform node-pty's native addon; the
  test runner now leaves node-pty alone. Three assertions that assumed `/` path
  separators or POSIX permission bits no longer fail on a Windows machine, and
  the owner-only check on the agent MCP config file still holds on Linux and
  macOS.

## [0.3.12.1] - 2026-08-30

### Changed

- **The office whiteboards are the job board.** The three whiteboards on the
  office canvas now read TO DO, IN PROGRESS and REVIEW, the columns of the Jobs
  tab, instead of the made-up JOBS / HIRE / OPEN. They also stand almost
  against the back wall, level with the plant pots, rather than out on the
  floor. A test keeps the three titles in step with the Jobs tab's columns and
  the server's job states, so renaming a column can no longer leave the office
  showing something else.
- Each whiteboard's heading underline now matches the heading's width instead
  of a fixed fraction of the board.

## [0.3.12.0] - 2026-08-30

### Added

- **Scheduled jobs.** A job card can now be a standing one that fires on a cron
  schedule instead of being dispatched once. Pick "Scheduled" in the job form and
  give it a schedule — `0 9 * * 1-5` for weekday mornings, or one of `@hourly`,
  `@daily`, `@weekly`, `@monthly`, `@yearly` — and the board runs it every time
  it comes due, in the server's local time. The card shows its schedule, when it
  next fires, and how many times it has run.
- A scheduled job does not have to be a coding task, so its prompt is just the
  task plus one line about assuming rather than asking. When the run goes quiet
  the board puts the card back in To do with its next run time — and keeps the
  agent's terminal open so you can read what the run wrote; the next run, or
  closing the tab, retires it. It cycles To do → In progress → To do and never
  reaches Review, so one card is one standing job — neither the pull-request
  watcher nor the merged-PR sweep will file a scheduled card away, even when a
  run's work happens to open or merge one.
- Agents can post a scheduled card too: `post_job` and `POST /api/jobs` take an
  optional `schedule`, and the reply reads back the schedule and the next run
  time so a cron expression that means something other than you intended is
  visible while there is still someone in the conversation to correct it.

### Changed

- Scheduled jobs sit outside the per-repo agent cap, in both directions: a run
  in flight does not consume a slot a one-time job could use, and busy one-time
  jobs cannot hold a schedule back — missed firings are never replayed, so a
  firing starved by the cap would simply be lost.
- Existing jobs are now called **one-time** jobs. Nothing about them changed —
  they are dispatched once, move to Review when their pull request appears, and
  stop there. Cards posted before this release are one-time jobs.
- The Jobs tab's attention badge and a card's status pill both know the
  difference between an agent that went quiet with work unfinished and a
  scheduled run that simply ended. A finished run no longer asks for your
  attention.

## [0.3.11.1] - 2026-08-28

### Fixed

- Agents start on Windows. Spawning or re-spawning one used to kill the whole
  server with `Cannot create process, error code: 2`, taking every other agent's
  terminal down with it. `claude` installs from npm as `claude.cmd`, and the
  Windows console host only ever looks for a `.exe`, so it never found the
  command it had just been told existed. Agent 007 now hands it the full path to
  a file Windows can actually launch.
- Re-spawning an agent whose worktree was deleted says so on that one tab
  instead of ending the session. Windows reports a missing working directory
  after the terminal has already been handed back, far too late for the old
  error path, so the directory is checked before the terminal is opened. Any
  other console-host failure is now contained to the agent it belongs to.
- Adding a repository works on Windows. Every path you could type was rejected
  as "Path must be absolute", because the check looked for a leading slash and
  an absolute Windows path starts with a drive letter.
- The repository browser opens where you point it. Typing a Windows path and
  clicking Browse used to send you to your home directory, and at the top of a
  drive the "up" entry navigated to itself instead of stopping.

## [0.3.11.0] - 2026-08-28

### Added

- **A merged pull request takes its card off the board.** Jobs gain a fourth
  state, `done`, with no column. The Review column exists to hold the short list
  of things a human still has to look at; letting merged work pile up in it made
  it an archive nobody read. The job itself is kept, not deleted, with its agent,
  branch and PR link intact.
- **View finished jobs.** A toolbar toggle swaps the columns for the archive,
  newest first, each card saying when it merged. A Review card also gains
  "✓ Done" to file one away by hand, for a merge the board cannot see; it asks
  first, because done is the end of a card's life on the board. A finished card
  cannot be moved back — follow-up work on merged code is a new job, and the
  archived card is the record to point at. Deleting it is the only other option.

### Fixed

- The board no longer confuses "some pull request on this branch merged" with
  "this card's pull request merged". `gh pr list --head` matches the head ref
  *name*, and that name outlives the branch: a merged PR stays in the listing
  forever, and board branch names are reused once the branch is deleted at
  retirement. The sweep now matches on the card's own PR number, or on a merge
  that postdates the current attempt. Without it a stale merge filed a card away
  while its real pull request was still open, overwriting the card's PR number
  on the way out so the open one was no longer recorded anywhere.
- A pull request that opens and merges inside one scan interval no longer
  strands its job. `--state open` cannot see a merged PR, so the open-PR watcher
  found nothing and left the card in In progress reading "agent gone" forever,
  for work that had shipped. The merge sweep now covers In progress as well as
  Review, and retires the agent when it finishes a job from there.
- A finished card can no longer be walked back onto the board and re-filed by
  the next scan. It kept the pull request that finished it, and `reviewAt` stays
  the sweep's time floor, so a job moved back to In progress carried a spent PR
  of record into its new attempt: the sweep matched that same old merge within
  five minutes, filed the card away again, and — because finishing from In
  progress retires an agent — closed whatever terminal had been re-adopted on
  the branch. Done is now terminal, enforced on the server rather than only in
  the UI, so the whole class of problem is gone.
- The "cannot check for a pull request here" note no longer follows a card into
  the archive still telling the user to move it by hand.

### Changed

- One `gh auth status` and one `gh auth token` per account now serve a whole
  scan instead of being re-run for every job, with a one-minute cache. Signing
  in or out is still picked up promptly.
## [0.3.10.1] - 2026-08-28

### Changed

- **Dispatched agents now finish with /ship alone.** The job prompt used to end
  with "run /review, fix, re-review, then /ship" — a hand-written description of
  what /ship already does on its own. Its pre-landing step dispatches the same
  specialist review army /review does (the two skills share the section file)
  and runs the same auto-fix-and-loop cycle afterwards, so every dispatched job
  paid for that army twice, and the first pass reviewed the pre-merge tree that
  /ship's base merge was about to replace. The prompt now names /ship as the
  single finishing step and no other skill: an agent arrives with no memory of
  the rest, and naming one to forbid it is what puts it on the table.

## [0.3.10.0] - 2026-08-28

### Changed

- Clicking a job that is in progress now opens that agent's terminal. Before,
  only the small status pill at the bottom of the card was a jump target, which
  is a hard thing to find and a harder thing to hit; the obvious gesture, which
  is to click the job you want to look at, did nothing. The whole card is now
  the target, and it lights up on hover to say so. The pill still works and
  remains the keyboard path, so nothing that used to work has moved. Clicks on
  the card's own buttons, on its pull request link, and clicks that finish
  selecting text on the card are all left alone.

## [0.3.9.0] - 2026-08-28

### Changed

- The couch nooks along the office wall are gone. In their place stand three job
  boards: whiteboards on A-frame easels, out on the floor rather than hung on the
  wall, each one with paper job posts pinned to it under a marker-written heading.
  The boards cap themselves to the wall section they stand in, so they never drift
  under a window, and they step aside entirely on a panel too narrow to hold one.
  The potted plants now draw behind the boards, which is the right way round: the
  plants sit against the wall, the easels stand in front of them.

## [0.3.8.0] - 2026-08-28

### Added

- You can now ask an agent you are working with to put a job on the board. Say
  "add that to the job board" and it posts the card itself, so noticing work no
  longer means stopping to type it into the form. The board reaches every Claude
  Code agent as an MCP tool, which is what makes it discoverable — the agent can
  see the tool without being told it exists — and Claude Code still asks you to
  approve the call, so nothing is filed behind your back. The card lands in To do
  showing "via <agent>" beside whoever it belongs to, and runs in that terminal's
  repo unless the agent names another.
- `POST /api/jobs` does the same thing over plain HTTP, for agents that cannot
  take a per-invocation MCP config.

### Changed

- Routes under `/api` now require a *user* token by default. The new agent
  session token reaches only the two places that are meant for it; anything added
  later is people-only unless it deliberately says otherwise.

## [0.3.7.0] - 2026-08-28

### Added

- **"+ Job" in the top bar.** Posting a job no longer starts with hunting for
  the Jobs tab. The button sits in the office header and does the whole trip in
  one click: it brings the board up, switches the panel to it, and opens the new
  job form with the title field already focused. The spawn button beside it is
  now labelled "+ Agent", so the two read as the pair of things you can start.

### Fixed

- Opening the job form while the agent spawn form was up no longer swallows what
  you type. The spawn form covers the panels but not the header strip, so both
  header buttons stay clickable underneath it. Either button now closes the
  other's form first, instead of leaving a focused text field hidden behind the
  overlay.

## [0.3.6.0] - 2026-08-28

### Fixed

- A finished job card now shows what it produced. One card reached Review with
  its pull request open and displayed nothing but its title: the agent's name was
  discarded on restart, the branch was only drawn as part of the agent line so it
  vanished with it, and a card moved to Review by hand never looked up its pull
  request. The name is kept as a record of who did the work, the branch stands on
  its own, and a manual move fetches the pull request once.
- A card no longer claims the board is still waiting for a pull request directly
  above the number of the one it just found.
- Agents are identified in a way that cannot be reused between runs. Previously a
  finished card could point at a slot number that a completely different agent
  later occupied, so it reported an agent alive that had nothing to do with it.
- Sending a job back to To do now clears the note explaining why its pull request
  could not be checked, so a fresh card no longer reports a failure against work
  that has not been attempted yet.
- Moving a card to Review by hand no longer attaches a pull request to it if you
  send the job back to To do while the lookup is still running.

## [0.3.5.0] - 2026-08-28

### Fixed

- An agent whose job reaches Review is now retired even when the board had lost
  track of which agent it was. A restart clears that link, so a job whose pull
  request turned up afterwards moved to Review with its agent still running,
  holding a worktree for work that had already shipped. The branch identifies
  the agent instead, since it outlives a restart.
- Agents already sitting in Review are deliberately left alone. If you reopen an
  agent on a branch whose pull request is already up, to deal with review
  comments, it stays yours — the board only retires an agent at the moment the
  job moves to Review, never afterwards.

## [0.3.4.0] - 2026-08-28

### Fixed

- The job board tries every GitHub account you are signed in to before deciding
  it cannot find a pull request. If you keep more than one account on a machine
  — one for your own repositories, another for an organisation's — a private
  repo is usually visible to exactly one of them, so the signed-in account
  failing said nothing about whether the pull request existed. Jobs in the
  "wrong" repository could never complete. The account that answers is
  remembered per repository, so the usual case stays a single lookup.
- The job board now tells you when it cannot check for a pull request, instead
  of looking like the agent went quiet. If the `gh` account signed in on this
  machine cannot see a repository — the wrong account for that organisation, a
  renamed repo, no access — every job in it used to sit in progress forever with
  its agent still running and its worktree still held, and the only clue was a
  card reading "quiet, may need you", which points at the agent rather than at
  the real cause. The card now names the reason and tells you to move the job by
  hand. It clears itself as soon as the check works again.
- Re-adopting an agent after a restart reconnects it to the job it was working
  on. Before, the card kept saying its agent was gone while the agent was
  visibly running, the job stopped counting toward the per-repo limit so the
  board could start a second agent on the same work, and when the pull request
  arrived the board could not close the agent or release its worktree. The two
  are matched by branch name, which is the one thing that survives a restart.

## [0.3.1.1] - 2026-08-28

### Fixed

- Job board agents no longer stop one step short of opening their pull request.
  An agent would finish the work, review it, fix what the review found, and then
  end its turn announcing that shipping was next — leaving the job parked at a
  prompt with everything uncommitted, because nothing was there to tell it to
  carry on. The instructions a dispatched agent receives now rule that stopping
  point out explicitly, while still leaving it free to stop for a question it
  genuinely cannot answer or a failure it cannot get past.

## [0.3.1.0] - 2026-08-28

### Fixed

- New agents now start from your repository's base branch as it exists on the
  remote, freshly fetched, instead of from whatever you happen to have checked
  out. Two things went wrong before. If your local `main` had fallen behind, the
  agent quietly worked from superseded code and its pull request showed a diff
  against a base it had never seen. Worse, if you were sitting on an unrelated
  feature branch, the new agent inherited that branch's half-finished work,
  which then rode along inside the agent's pull request. This matters most for
  job board agents, which are dispatched while you are busy doing something
  else, and your checkout is least likely to be on a clean base.
- Agent 007 no longer waits on a git credential prompt that nobody can answer.
  Any git command that needs credentials now fails immediately instead of
  hanging.

### Added

- **Start from** (New Agent -> Advanced). Branch, tag or commit the agent's
  branch starts from. Leave it blank for the repository's base branch on the
  remote; set it to branch off work you have in progress. A value that does not
  exist is reported by name rather than failing later with a confusing git
  error.

## [0.3.0.0] - 2026-08-27

### Added

- **Job board.** A new "Jobs" tab in the terminal panel holds a queue of work
  across three columns: To do, In progress, and Review. A job has a title, a
  free-text detail, the repo it belongs to, who posted it and when, and once it
  starts, which agent is working on it and since when.
- **Automatic dispatch.** Start the dispatcher and every five minutes the board
  takes the oldest queued job whose repo is under its agent cap (2 by default,
  adjustable per board) and puts a fresh agent on it: a new worktree, a branch
  named after the job title, and the job text handed to `claude` in auto mode.
  The agent is told to run /review, fix, re-review, then /ship, and the board
  watches for the pull request that /ship opens.
- **A job that needs you says so.** When a dispatched agent stops to ask
  something, its card turns orange with a "needs you" badge and the Jobs tab
  shows a count. Click the badge to land in that agent's terminal, answer, and
  it carries on. A card that has gone quiet for a few minutes is flagged too,
  since an agent that finished without opening a PR looks the same as one that
  is still thinking.
- Dispatched agents open their tab quietly instead of stealing focus, so the
  dispatcher firing while you are mid-sentence no longer moves your cursor.
- When a job's PR appears, the board moves the card to Review, closes the
  agent, and releases its worktree and local branch. The pull request is
  untouched. The card keeps the agent name, branch and PR link.

### Fixed

- Agent 007 now notices when an agent is sitting on one of Claude Code's own
  dialogs, including the workspace-trust prompt that greets every agent started
  in a fresh worktree. Previously such an agent showed as merely waiting, which
  for a Claude agent is indistinguishable from idle, so it could sit unanswered
  indefinitely.
- Closing an agent whose branch is fully pushed now removes its worktree and
  local branch instead of keeping them as an orphan. Work that is uncommitted,
  or committed but never pushed, is still preserved exactly as before. The old
  check treated "not merged into main" as "unpushed", so every branch with an
  open pull request was kept forever.
- A repository whose `user.name` is set to an empty string no longer fails
  every agent spawn. Git reports success with no output in that case, so the
  fallback never fired and every branch name came out invalid.

## [0.2.2.0] - 2026-08-27

### Fixed

- `npm start` now works when Agent 007 is installed in a folder whose path
  contains a space (e.g. `C:\Users\you\Claude Code\agent-007`) or other
  special characters. Previously the server built everything, decided it
  wasn't the entry point, and exited silently with no error.
- The server also starts correctly when launched through a symlinked or
  junction path (macOS `/tmp`-style links, relocated Windows folders) and via
  `node .`.
- If the entry-point check ever misfires again when `server.js` is launched
  directly, the server now prints a clear "not auto-starting" message to
  stderr instead of exiting silently with code 0.

## [0.2.1.0] - 2026-08-24

### Changed

- The voice-input mic is now a floating button at the terminal's bottom-right,
  next to the prompt line — no more hunting for it in the header. The live
  transcript pill docks right above the mic and slides out of it when you
  click, so the reaction appears exactly where you clicked, without ever
  covering the terminal's last row (where your dictated keystrokes echo).
- Clicking the mic for the first time now asks for microphone permission
  *before* recording starts. Previously the permission prompt raced the
  recognizer: by the time you clicked "Allow", the mic had silently shut off
  and your speech went nowhere. The red recording signals now turn on only
  once the mic is truly live — while the permission prompt is open you see a
  dot-less "Requesting microphone…" notice instead.
- Repeat dictation starts faster: the microphone permission is acquired once
  per visit instead of on every mic click (and re-requested automatically if
  you revoke it mid-session).
- Better error messages: a mic held by another app, missing hardware, or a
  policy block each get their own guidance instead of a generic "access
  denied".
- Starting or stopping dictation now returns keyboard focus to the
  terminal, so the Enter that sends your prompt lands in the terminal even
  when you used Cmd+D from elsewhere in the app.
- The multiplayer presence dots moved just above the mic, keeping the
  bottom-right corner clear for the new button in logged-in sessions.
- The new voice animations (pill slide-in, recording pulse) are explicitly
  disabled under the system reduce-motion preference.

## [0.2.0.0] - 2026-08-24

### Added

- Voice input: dictate prompts instead of typing. Click the mic button in the
  terminal header (or press `Cmd+D`), speak, and your words are typed into the
  active agent's terminal — press Enter to send, exactly as if you had typed.
  A floating pill shows the live transcript while you speak; nothing is ever
  auto-submitted. Works in Chrome, Edge, and Safari over HTTPS or localhost
  (for remote access, use `tailscale serve` — see `docs/REMOTE.md`).
- The microphone is deliberately bounded so it can never stay hot unnoticed:
  it stops after ~1 minute without delivered speech, always after 5 minutes,
  when you switch or close agents, when an agent's shell ends, and when the
  browser tab is hidden — each stop except the hidden-tab one flashes an
  on-screen notice explaining why (a hidden tab can't show one; that stop is
  announced to screen readers).
- Screen-reader support for dictation: the mic button announces its
  pressed state and voice start/stop/errors are read out via a live region.

### Changed

- Global keyboard shortcuts (`Cmd+1..9`, `Cmd+E`, `Cmd+N`, and the new
  `Cmd+D`) now fire only on exact Cmd chords: combos with Ctrl or Alt also
  held, and held-key repeats, no longer trigger them. The page and the
  terminal now share one shortcut list, so no chord is blocked in the
  terminal but dead on the page.
- The docs now spell out the voice privacy trade-off: Chrome and Edge process
  speech on vendor servers, so dictated content leaves the machine even inside
  a tailnet — don't dictate secrets. They also note that transcripts arrive as
  keystrokes, so single-key prompts (pagers, y/n confirmations) react to
  speech like typing.

## [0.1.0.1] - 2026-08-01

### Added

- The README now shows a screenshot of the app: the pixel office running four
  agents alongside a live agent terminal. The README had referenced
  `docs/screenshot.png` since the initial commit, but the image was never
  captured, so the link rendered broken on GitHub.
- Version tracking via a `VERSION` file and this changelog.
- CI: a GitHub Actions workflow that runs the test suite on pushes to `main` and
  on every pull request. The README's Tests badge had pointed at
  `.github/workflows/test.yml` since the initial commit, but no workflow existed,
  so the badge never resolved.

### Changed

- README image markup now carries descriptive alt text and no longer keeps the
  placeholder comment that specified the screenshot before it existed.
