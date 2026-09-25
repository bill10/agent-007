# Billion — the one agent you talk to

Design notes, worked out step by step. Status: **design, nothing built yet.**
Builds on PR #92 (orchestrator charter template and guide).

## Idea

Borrowed from Munder Difflin's orchestrator ("Michael"): one contact point. You
talk to Billion; Billion posts job cards, directs workers, and approves or denies
their permission prompts. It escalates only what needs you.

## Step 1 — the server starts Billion

Decided:

1. **On by default**, with a setting to turn it off.
2. **Repo:** `~/.agent-007/billion/` (under `CONFIG_DIR`, so tests that redirect
   `AGENT007_CONFIG_DIR` never touch the real one). Override with `BILLION_DIR`.
   First run: `git init`, copy Billion's templates (charter as `CLAUDE.md`,
   plus `STATE.md` and `COMPANY.md`), commit. Already there: just use it.
3. **Runs without permission prompts** (`--dangerously-skip-permissions`): it
   works all the time and must never block on a dialog.
4. **Server restart resumes it**: `claude --continue` when the folder has a
   previous session. Memory files cover whatever the conversation loses.
5. **No auto-restart** if it exits or crashes: show it stopped, with Re-spawn;
   start it again on the next server start.
6. **Fixed name "Billion"**, reserved. `send_message` addresses agents by name,
   so no other agent may take it. No cocktail codename.
7. **Placement:** top of the left panel (above the repo groups, not under
   "(no repo)"), top center of the office on its own desk, and its terminal
   open by default in the right panel.
8. **One Billion per server.** Messages only flow between agents with the same
   owner; per-user Billions wait until someone runs multi-user.

Existing code to lean on: repo-less agents already run (`server/pty.js`
`createSessionFromConfig`, cwd falls back to home), are listed under "(no repo)"
(`public/modules/explorer.js:260`), and sit in a final pod
(`public/modules/office.js:156`). Billion is a repo-less agent whose cwd is its
own folder.

## Step 2 — Billion approves workers' permission prompts

Decided: workers keep asking for permission; Billion answers. Both CLIs have a
`PermissionRequest` hook with the same shape:

- Input on stdin: `tool_name`, `tool_input`, `cwd`, `session_id`, ... .
- Output: `{"hookSpecificOutput": {"hookEventName": "PermissionRequest",
  "decision": {"behavior": "allow"}}}`, or `"deny"` with a `"message"`.
- **No decision printed → the normal dialog appears for a person.**
- Codex: `updatedInput` / `updatedPermissions` / `interrupt` are reserved and
  fail closed (deny). Don't use them.

Flow:

1. At spawn, the server adds the hook: `--settings` for Claude Code, a `-c`
   override for Codex, the same way the board MCP server is added
   (`server/agent-mcp.js` `withMcpConfig`). It is added to argv after the fact,
   so `isUnguarded` (which reads the typed command) still sees the worker as
   guarded.
2. The hook sends the request (tool, input, agent, repo, branch) to the server
   and waits.
3. The server hands it to Billion; Billion answers with a new MCP tool
   `answer_permission {id, allow|deny, reason}`. A deny reason goes back to the
   worker.
4. **No answer within ~2 minutes, or Billion not running → no decision**, so
   the dialog appears for you. Never allow by default.
5. Actions under the escalation rules (destructive, paid, secrets, ...):
   Billion deliberately gives no decision
   and tells you why in its terminal.

Constraints and consequences:

- **Hook timeouts:** both CLIs limit how long a hook may run. Set that limit a
  little above the 2-minute wait, or the CLI gives up first and counts it as a
  deny.
- **Messaging rule must change.** Today guarded agents cannot message an
  unguarded one (`server/messages.js` `messageableAgents`), which would cut off
  approvals and "done" reports. Exempt Billion as a recipient. Accepted cost: a
  worker that read untrusted text can pass instructions to an agent with full
  access. Messages are labelled "from another agent, not the user" and the
  charter says to treat them as information — an instruction, not a sandbox.
- **Billion can hold up the workers.** Messages reach it only while it rests
  at its prompt, and every approval takes up its conversation and tokens.
  Start with Billion answering directly and log how long approvals wait. If
  waits get long, answer approvals with a separate `claude -p` call that uses
  Billion's charter, and give Billion only a summary.

### Codex hook trust (resolved)

Codex runs a hook only once its hash is trusted in `~/.codex/config.toml`
(`[hooks.state]`), or when launched with `--dangerously-bypass-hook-trust`
(which applies to that session only).

- If Codex loads hooks only from `~/.codex/` and `-c` overrides → **use the
  flag.** Simpler, and no trust prompt that Billion can't answer.
- If Codex also loads hooks from the project (`.codex/` in the worktree or a
  parent) → the flag would run those unreviewed too. That covers repos you
  didn't write, and a worker that writes a hooks file into its worktree turns
  "write a file" (which approval covers) into "run any command" on the next
  re-spawn (which it doesn't). Then instead: approve once in Codex's own
  "Hooks need review" prompt, with a **stable hook command**
  (`~/.agent-007/hooks/permission-request.js`, port passed by env var) so the
  hash doesn't change across runs, worktrees and ports. The app already
  recognises that prompt (`lib/helpers.js:96`), so Billion won't answer it.
- Not writing the hash into `~/.codex/config.toml` ourselves: agent-007 has
  not changed the user's permanent CLI config so far.

Question sent to the other agent (codex-cli 0.156.1; Codex is not installed on
this machine):

> 1. Besides `~/.codex/hooks.json` (and `~/.codex/config.toml`) and `-c`
>    overrides, does it load hooks from the project, e.g. a `.codex/` directory
>    in the working directory, the git root, or any parent?
> 2. If so, are those under the same `[hooks.state]` hash trust, and does
>    `--dangerously-bypass-hook-trust` skip review for them too?
> 3. Does a project's `.codex/` load only when the project is marked trusted
>    (`[projects."<path>"] trust_level`)? Is a git worktree of a trusted repo
>    the same project, or a new, untrusted one?

Answer (other agent, 2026-09-24; tested against the installed 0.156.1 binary
with a throwaway `CODEX_HOME`, file hooks only):

1. Project hooks load from every `.codex/` between cwd and the repo root
   (`hooks.json` and a `[hooks]` table in `config.toml`), never above the root.
2. They use the same `[hooks.state]` hash trust (key
   `<abs path to file>:<event>:<i>:<j>`). The bypass flag skips the hash check
   for project and user hooks alike.
3. Project hooks load only if the project is `trust_level = "trusted"` in
   `config.toml` (a `-c` override of that does not count). The bypass flag does
   not override this. A worktree counts as the same project, **and runs the
   main checkout's hook files, never the worktree's own** (trust keys use main
   checkout paths).

What that means:

- The "worker writes a hooks file into its worktree" risk is **gone**: those
  files never run.
- Untrusted repos are safe even with the flag.
- What the flag still exposes: in a *trusted* repo, a hook that lands in the
  main checkout (e.g. a merged contributor PR) runs without hash review.
- Their conclusion ("the hook must sit in each main checkout or
  `~/.codex/hooks.json`") assumes a file. We plan a `-c` override, which was
  not tested. That case decides the design.

Follow-up sent (all without the bypass flag):

> 1. A PermissionRequest hook supplied only via `-c`, no hooks file: does it
>    run with no `[hooks.state]` entry, or is it held for trust?
> 2. If held: what is its `[hooks.state]` key, and is it stable across cwds,
>    worktrees and repos (same hook command)?
> 3. Does a `-c` hook run in an untrusted project?
> 4. Does `hooks/list` show it, and with what source?

What each outcome means:

- Runs untrusted, in untrusted projects too → no flag, no approval. Best case.
- Needs trust, stable key → approve once (stable command, port by env var).
- Needs trust, key varies by folder → choose between the flag (accept the
  merged-PR risk above) and writing our own trust entry into `config.toml`.

Follow-up answer (other agent, 2026-09-24; app-server threads with
`approvalPolicy: "on-request"`, never the bypass flag; `codex exec` forces
`approval: never` so it can't test this):

1. A `-c`-only hook is **held for trust** without a `[hooks.state]` entry;
   with a trusted hash it runs and its allow is honoured. Stdin carries
   `tool_name`, `tool_input` (`command`, `description`), `cwd`, `session_id`,
   `turn_id`, `model`, `permission_mode`, `transcript_path`.
2. Key: `/<session-flags>/config.toml:permission_request:<group>:<hook>` — no
   cwd in it; identical across non-git folder, repos and a worktree. The hash
   covers the command string (exact, incl. the script's absolute path),
   `timeout` and `statusMessage`; not `matcher`. Position is in the key: a hook
   placed ahead of ours makes ours untrusted. **The trust entry can itself be
   passed with `-c`** (`hooks.state={"<key>"={trusted_hash="sha256:…"}}`).
3. It runs in untrusted projects and their worktrees: only per-hook hash trust
   applies, not project trust.
4. `hooks/list` shows it with `source: "sessionFlags"` and a `trustStatus`
   (untrusted / trusted / modified).

**Resolved: the best case, and better.** Each Codex spawn gets two `-c` flags:
the hook and its trusted hash. No bypass flag (repo hooks keep their review),
no hook file anywhere, nothing written to `~/.codex/config.toml`, no trust
prompt for you, works in every worktree.

Build rules:

1. Ours is the **only** `PermissionRequest` entry agent-007 passes (position
   is in the key).
2. The command never changes: script at a fixed path
   (`~/.agent-007/hooks/permission-request.js`), port via env var.
3. **Get the hash at startup from Codex itself**: run `codex app-server` with
   our `-c` hook and read it from `hooks/list`. Don't hardcode (the path
   includes the home directory) or reimplement the hashing (a Codex update
   could change it). Codex not installed → skip; no Codex workers to hook.
4. `timeout` above Billion's 2-minute wait; it's in the hash, so pick once.

To check at build time: behaviour when the user also has their own
`PermissionRequest` hook in `~/.codex/hooks.json` (both run; which decision
wins?).

## Step 3 — first run: introduction

Decided: on its first run (empty repo just created), Billion greets you with a
short self-introduction, then asks for the information it needs.

1. **The server decides it's the first run** (it just created the repo) and
   starts `claude "<first-run prompt>"` instead of `claude --continue`. If
   the app is closed partway through, the next start resumes with
   `--continue`; the charter says to finish the introduction while
   `STATE.md` still says "not started".
2. **Ask only what it can't look up.** Repos, agents and cards it finds
   itself (board tools, file system). **Decided:** a one-sentence
   introduction, the escalation rules (so you know what it will bring to you,
   and can change them), then two questions — the mission, and where new repos
   go.
   Everything else uses defaults and can be changed by telling Billion later.
   Example:

   > Hi, I'm Billion. I run the work here: I turn a goal into a plan, hand the
   > pieces to workers on the job board, review what comes back, and merge it.
   >
   > I decide most things myself. I'll come to you before anything that:
   > - spends money;
   > - needs access I don't have (accounts, keys, logins);
   > - can't be undone, like deleting data or repos;
   > - makes a private repo public (its whole history goes public, including
   >   anything ever committed);
   > - touches payments, pricing, security or secrets;
   > - is a real fork in direction that's yours to call.
   >
   > If you want that list different, just tell me, now or any time.
   >
   > If you don't give me a goal, I'll look for improvements across your
   > projects and work on those. Do you have a specific mission in mind? It
   > can be as narrow as "ship the Windows build of agent-007" or as broad as
   > "grow the company".
   >
   > And when I start a new project, where should its repo go? Your projects
   > seem to live in `~/Projects/`. Shall I use that?

   After your answers, it closes with where everything lives:

   > Got it. Everything I know is in `~/.agent-007/billion/`: my rules in
   > `CLAUDE.md`, the mission and what we learn in `COMPANY.md`, and my
   > current plan in `STATE.md`. Every change is a commit there. Ask me to
   > change any of it, any time. Starting now.

   The suggested folder is worked out from the repos already added (their
   common parent), not hardcoded; with none, it just asks. Where answers go:
   the mission (or "none, find improvements") → `COMPANY.md`; the projects
   directory → `CLAUDE.md` (an operating rule, like the escalation list,
   which also lives there and changes there if you ask). Then commit,
   `billion_ready`, start the loop.
3. **It never contacts your agents.** It manages work, not agents: it
   messages only the workers of its own cards and leaves agents you started
   alone, so there is nothing to ask (replaces PR #92's "message every running
   agent" first cycle). No messages during the introduction is covered by
   point 4.
4. **Billion's message queue holds until the introduction is done.**
   `server/messages.js` already queues per agent (cap 20), delivering only
   while the recipient rests at its prompt, not within 30 s of a person
   typing, one per stop. That alone isn't enough: during the introduction
   Billion rests at its prompt waiting for *you*, so the queue would deliver
   into your conversation. Add one condition to the "may I deliver now?"
   check: nothing goes to Billion until it calls `billion_ready`.
   - Messages (worker questions, `finish_job` notices) wait and arrive after
     the introduction. Nothing is lost.
   - Approvals wait up to their ~2-minute hook timeout, then fall back to
     your dialog as usual.
   Rare in practice: after a restart only the board starts workers (its
   running state is saved; first check 2 s after boot, `server/jobs.js`
   `startDispatcher`), and a new install has an empty board.
5. **The loop starts right after the introduction**, in the same
   conversation. Later starts: `--continue`, then straight into the loop.

## Template files

Billion's own `templates/billion/`, starting as a copy of PR #92's
`templates/orchestrator/` (merge #92 as the general template; don't couple
Billion's behaviour to a file others edit for their own orchestrators). Copied
into `~/.agent-007/billion/` on first run.

### The files at a glance

- **`CHARTER.md` — how Billion works, as Agent 007 ships it.** Role, cycle,
  principles, escalation list, tools and limits. Rewritten by the server on
  every start; Billion never edits it.
- **`CLAUDE.md` — the owner's rules.** Imports `@CHARTER.md`, then the
  owner's settings and rules (e.g. where new repos go), which take
  precedence. Changes only when you ask. Loaded automatically by Claude Code
  at session start (with the charter) and kept through compaction.
- **`COMPANY.md` — what's true about the company.** *Mission* (your words; only
  you change it) + *What we know* (Billion: projects, customers, numbers,
  lessons). Changes when something is learned. **Not imported** (it grows,
  and an import would put all of it in every turn, approvals included). A
  pointer in `CLAUDE.md`; read at the start of every cycle, so the mission is
  in front of Billion whenever it plans, and reloaded after compaction. **Kept
  as an index:** a line or two per project pointing at the project's repo
  (README / `NOTES.md`), where the details live; only cross-project things
  (mission, project list, customers, key numbers, lessons) stay here.
- **`STATE.md` — what's happening now.** Plan, waiting on you, short-term
  notes. Rewritten every cycle. Read explicitly at the start of every cycle,
  not imported (an import is read once per session and this changes every
  cycle). After a restart it's the handoff note.

All of this — what each file is for, when it's read, and the boundary test —
goes into `CLAUDE.md` itself, the one file guaranteed to be in context.

Boundary test for Billion:

- A rule the owner gave me? → `CLAUDE.md` (Agent 007's rules are in `CHARTER.md`, read-only)
- A fact that will still matter in a month? → `COMPANY.md`
- About what's happening now? → `STATE.md`
- A card's status or full result? → the board
- Why I decided something? → that cycle's commit message

### `charter.md` (→ `CLAUDE.md`)

Billion is a founder: it runs the company, not just the office. It turns a
statement into a plan and the plan into cards.

- **The statement:** free text from you, kept in `COMPANY.md`. Anything from
  "build an app that does X" to "improve the company". Limits you want (money,
  time, how many projects) go in the statement too.
- **The cycle, always the same:** read `COMPANY.md` and `STATE.md` → check status (what has
  been done, its cards and PRs, worker reports and questions, pending
  approvals) → make or update the plan → post cards → commit → schedule the
  next wake-up. Everything else — start a project, research, build, drop — is
  a decision inside the plan, not a step in the cycle.
- **`STATE.md` holds the plan and status**, rewritten every cycle. The
  decisions and why go in each cycle's commit message. No other files.
- **It manages work, not agents.** It posts cards, follows them with
  `list_jobs`, and messages only the workers of its own cards. Agents you start
  by hand are yours. Throughput is capped by the board's `maxPerRepo`.
- **Tools and limits:** as in #92, plus `add_repo` and `answer_permission`.

Principles (the charter gives these, not procedures):

- **Every project is a repo, from the first research onwards.** Research,
  drafts and code for a project all live in its repo; Billion's own repo holds
  only its memory. A new repo needs a remote and a pushed `main` before its
  first card (workers branch from the remote base; PRs need a remote), and
  `add_repo` so the board knows it (today `post_job` rejects unknown repos,
  `server/jobs.js:333`; `add_repo` wraps `addRepo`, `server/git.js:173`).
  Private by default.
- **Check results, not claims.**
- **Billion reviews and merges its PRs.**
- **Escalate** money, missing access, irreversible steps, payments /
  pricing / security / secrets, making a private repo public (its whole git
  history goes public), and strategic forks. Going public is **not** an
  escalation on its own: publishing posts, changing the website, launching,
  emailing people are Billion's call. A merge escalates when it touches payments, pricing,
  auth, secrets or data deletion.
- **Archive, never delete.**
- Money and safety sections: as in #92.

Practical note for the charter: check `baseRefName` and retarget stacked PRs
to main before merging. Machine-specific quirks (which `gh` account can write,
for example) are not in the template; Billion learns them and keeps them in
its own `CLAUDE.md`.

Still to add to the template: `<NAME>` = Billion, the introduction section
(step 3), approvals (`answer_permission`, when to give no decision), "report
back to Billion" in every card, drop #92's manual-setup text.

Projects directory for new repos: asked in the introduction (step 3).

### `STATE.md`

Decided. Billion's working memory between cycles: read first after a restart,
rewritten whole every cycle, readable by you. The board already records every
card Billion posted (`postedByAgent`, `server/jobs.js:392`; the name "Billion"
is reserved) with its status, PR and summary, so none of that is copied here —
it would go stale. `STATE.md` holds only what the board can't know.

```markdown
# STATE

Rewritten every cycle; keep it to one screen. The board is the record of my
cards and their results. This file is what the board can't know.

Status: not started

## Plan
Next steps toward the statement in COMPANY.md, in order. Add the card id once
a step is posted. Group by project when there is more than one.

## Waiting on you
Escalations: what, why, what I recommend, asked when.

## Notes
Short-term only: what the next few cycles need. Anything that will still matter
in a month goes in COMPANY.md.
```

- **Status:** "not started" until the introduction is done (step 3's marker);
  then a line or two on the current focus.
- **Plan:** next steps in order; the order is the priority. Posted steps carry
  their card id. Finished steps drop out; the commit history keeps them.
- **Waiting on you:** open escalations, each with a recommendation.
- **Notes:** short-term only ("recheck card 118 after the retry"). Anything
  that will still matter in a month goes in `COMPANY.md`; full results stay on
  the card.

Example of an active one:

```markdown
Status: Validating a CLI for agent cost reports; building agent-007's close_job tool.

## Plan
agent-cost (new repo, ~/Projects/agent-cost):
1. Market research: who tracks agent spend today (card 118, in progress)
2. Decide build or drop from 118's result
agent-007:
1. close_job tool (card 119, in Review, reviewing the PR)
2. Notify the poster on finish_job

## Waiting on you
- Buy agentcost.dev ($12/yr)? Needed only if we build. Recommend: wait for card 118. Asked 14:20.

## Notes
- Card 118's first run hit a rate limit; recheck its summary before deciding.
```

### `COMPANY.md`

Decided. The company's lasting memory: your mission plus what Billion learns
that outlasts a cycle. Uppercase to match `CLAUDE.md` and `STATE.md`.

```markdown
# Company

## Mission
<your statement, in your words; only you change this>

## What we know
Maintained by Billion. Facts that outlast a cycle:
- Projects: each one's repo, what it's for, its stage, where its research lives.
- Customers and channels: who uses what, where they came from.
- Numbers that matter: users, revenue, costs.
- Lessons: what worked, what didn't, and constraints (e.g. the board runs
  one worker per repo).
```

The split: `COMPANY.md` = what stays true (changes when something is
learned); `STATE.md` = what's happening now (changes every cycle); the board =
every card and its full summary. Billion's test: "would this still matter a
month from now?" → `COMPANY.md`. One file rather than a separate
`MISSION.md`: the mission is one paragraph, marked as yours.

### `decisions.md` — dropped

Decided. Each cycle's commit message is the decision log: git history is
already append-only and timestamped, and a separate file would have to be kept
in step with it. Billion reads recent decisions with `git log -10`; you read
them with `git log` in its repo. The card id replaces #92's "who" field.
Example:

```
cycle: start agent-cost; drop the browser-extension idea

- Started agent-cost: three users asked for per-agent spend reports (card 112).
- Dropped browser extension: research found 4 free competitors (card 107).
- Merged #119 (close_job): reviewed, CI green, no escalation items.
```

## Board changes on main (v0.4.8.0 #91, v0.4.9.0 #93) and what they change

- Workers finish with `finish_job` (PR URL, or a summary for `requires_pr:
  false` cards) → card to Review. Review keeps the agent until Done, so
  Billion can question a worker before merging. Schedules post a run card per
  firing and never flood the board.
- Research results come back as **card summaries** (`read_job`), not files.
  `STATE.md` Notes keep only conclusions, never copies of summaries.
- "Report back to Billion" in every card is **dropped**: `finish_job` is the
  report. Add: on `finish_job`, the server notifies the card's
  `postedByAgent`, so Billion wakes at once. A server notification isn't
  agent-to-agent, so the guarded/unguarded rule doesn't apply; the messaging
  exemption is now needed only for worker questions and replies.
- **Gap: Billion can't close a card that has no PR.** PR cards close on merge;
  a no-PR card waits in Review for Done, which only the UI can do. Needs a
  tool (e.g. `close_job`: accept → Done, or reject → back to To do with a
  note), or Review fills with idle workers.
- Recurring work → a schedule card Billion posts once.

## Order of building

1. **Billion itself — built.** `server/billion.js` (on/off via `BILLION`,
   folder via `BILLION_DIR`, first-run repo from `templates/billion/`,
   command with first-run or resume prompt, projects-folder suggestion),
   started from `server.js` `startup()`; name reserved; rename refused;
   pinned row with a Start button when stopped; own desk top center; tab
   first and open by default. The charter template is `charter.md` in this
   repo (copied in as `CLAUDE.md`) so agents working on Agent 007 don't load
   it. Verified live in an isolated server: repo created and committed,
   introduction as designed.
2. **Messaging — built.** Every agent can message Billion (exempt from the
   permission and owner rules as a recipient, `server/messages.js`); its
   inbox is held until it calls `billion_ready` (a tool listed for Billion
   only), which the charter calls at the end of the introduction and at the
   start of every cycle, so a restart needs no stored flag; a card Billion
   posted sends it a `[Job board]` notice when it reaches Review, through
   `finish_job` or the PR poll (Billion only: another agent's terminal may be
   mid-conversation with a person); workers on Billion's cards are told they
   can ask it. Verified live: a guarded worker messaged Billion, Billion
   replied, the reply arrived.
3. **Board tools — built.** `add_repo` (wraps `addRepo`, `~/` allowed) and
   `close_job` (accept a no-PR card → Done; send any card back → To do with
   the note appended to its detail; a PR card is filed Done by its merge, so
   accept refuses it). Billion only, its own cards only, Review only; both
   listed only for Billion and checked again in the route. Verified live end
   to end: Billion added a repo, posted a no-PR card, the worker finished,
   the `[Job board]` notice woke Billion, it read the result and accepted
   the card — Done in 41 s.
4. **Approvals — built for Claude Code.** Workers on Billion's cards get a
   `--settings` with a `PermissionRequest` hook (`server/permission-hook.js`)
   that posts the request to `POST /hook/permission` with the worker's own
   agent token, read from its 0600 MCP config (not an env var: every child
   process would inherit it). `server/approvals.js` types `[Approval <id>]`
   into Billion and waits up to 2 minutes for `answer_permission`
   (allow / deny with a reason / owner); anything else — no Billion, one not
   ready, silence, an error — is no decision, and the dialog goes to a
   person. The same settings pre-allow `finish_job` and `send_message`, the
   two board tools the job prompt tells workers to use. Your own agents and
   cards are not hooked. Verified live: a worker in manual mode asked to
   Write outside its worktree, Billion allowed it, the file was written, the
   card closed.
   - Approvals fire only when a worker would show a dialog: in `auto` mode
     the classifier decides most things itself, and a user allow list (yours
     allows all `Bash`) skips the dialog entirely.
   - **Codex: not wired.** The recipe is known (two `-c` flags: the hook and
     its trusted hash, read from `codex app-server` `hooks/list` at startup),
     but Codex isn't installed here to build and test it against. Codex
     workers keep asking the owner.

Each part is useful without the next.

**Charter upgrades — built.** Billion's instructions have two owners, so
they are two files. `CHARTER.md` is Agent 007's (from
`templates/billion/charter.md`): the server rewrites it on every start and
commits it on its own ("Agent 007: update the charter") when it changed, so a
new release reaches a Billion that already exists; the pathspec commit leaves
Billion's uncommitted work alone. `CLAUDE.md` is the owner's (from
`templates/billion/owner.md`, first run only): it imports `@CHARTER.md` and
holds *Owner's rules* — projects folder, escalation changes, any rule the
owner gives — which take precedence. Verified live: the import loads, the
introduction writes the owner's rules into `CLAUDE.md` only, and a simulated
older charter was replaced on restart with the owner's rules intact.

Found while verifying part 1:

- **Claude Code's folder trust dialog** appears on Billion's first start and
  defaults to "No, exit". No flag skips it, and pre-trusting would mean
  writing `~/.claude.json`, which live Claude sessions write concurrently.
  Decided: the server answers it, for Billion only (its folder holds only
  what the server put there). It reads the settled screen and presses one
  key for the last cursor drawn — Down off "No", Enter on "Yes", nothing
  otherwise — because the dialog arrives in several reads and a late one can
  still show the old cursor (answering per read pressed Down twice and
  wrapped back to "No"). Verified live on a fresh folder.
- A server started from inside a Claude Code session passes
  `CLAUDE_CODE_CHILD_SESSION` to its agents, which turns their transcript
  saving off — and `--continue` needs a transcript. Only affects a server
  launched by an agent, not one started from a terminal.

## Not borrowing from Munder Difflin

The hive (mailboxes, blackboard, git event log), the `Stop`-hook inbox loop,
semantic memory. Here each job is an isolated branch that ends in a PR; the
board already does their job.
