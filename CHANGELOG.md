# Changelog

All notable changes to Agent 007 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses a four-part `MAJOR.MINOR.PATCH.MICRO` version.

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
