# An orchestrator agent

One agent can direct all the others: it hands each one its next task, checks the
results, staffs new work on the job board, and comes to you only for what needs
you. Nothing new in the app does this. The orchestrator is an ordinary agent
with a charter, using the MCP tools every agent already has (`list_agents`,
`send_message`, and the job board tools). [`templates/orchestrator/`](../templates/orchestrator/)
has a charter and memory files to start from.

## Set it up

1. **Give it its own repo.** Its notes are not product code, and an agent needs
   a git repo for its worktree. Messages cross repos, so it can reach agents in
   every repo from there.

   ```bash
   mkdir ~/Projects/orchestrator && cd ~/Projects/orchestrator
   git init
   cp /path/to/agent-007/templates/orchestrator/{STATE,decisions,company}.md .
   cp /path/to/agent-007/templates/orchestrator/charter.md CLAUDE.md   # AGENTS.md for Codex
   ```

2. **Fill in the charter.** In `CLAUDE.md`, replace `<NAME>` (what you call it)
   and `<OWNER>` (you), list the agents it manages and what each is for, say how
   it should reach you, and adjust the money and escalation rules to how you
   work. Commit.

3. **Add the repo in the office and spawn the agent** with a command that
   starts its loop straight away:

   ```
   claude "/loop Run one operating cycle as defined in CLAUDE.md."
   ```

   `/loop` with no interval lets it pace itself: it wakes up every few minutes
   while work is moving, and every 20–30 minutes when things are quiet. Each
   reply from another agent wakes it too, because a message arrives as a new
   turn.

## How it runs

Each cycle it reads `STATE.md` and the recent tail of `decisions.md`, checks
every agent and job, and handles the replies that came in. Then it gives each
waiting agent one concrete task (goal, what done means, "report back when done
or blocked") and posts jobs for work nobody owns. Last, it rewrites `STATE.md`,
logs its decisions, and commits. The first cycle asks every agent for a status
report and builds `company.md` and `STATE.md` from the answers.

Its memory lives in files, so a server restart costs it nothing: the next
session reads the same `STATE.md` and carries on. The git history of its repo
is a log of what it decided and when.

## Permission modes: pick one for everyone

An agent that never asks before acting (`bypassPermissions`,
`--dangerously-skip-permissions`, or Codex's `--dangerously-bypass-approvals-and-sandbox`
and similar) **only takes messages from another agent that never asks**
([FEATURES.md](FEATURES.md#features), "Agents message each other"). So the
orchestrator and the agents it manages should run in the same kind of mode:

- **All in `auto`** (Claude Code's classifier reviews each action). Messages
  flow both ways. An action the classifier escalates still stops for you.
- **All permission-free.** Nothing stops for a dialog, and nothing inside the
  app bounds what they do. Only do this for repos and inputs you trust.
- **Mixed** is where it breaks. A permission-free orchestrator can send to an
  agent in `auto`, but that agent's reply is refused. An orchestrator in `auto`
  cannot reach a permission-free agent at all.

Changing an agent's mode means starting it again with other flags; the
orchestrator cannot do that for you, and it cannot answer another agent's
permission dialog. An agent stuck on a dialog waits for you.

## Limits

- 10 messages from one agent to another every 10 minutes, and a message goes
  in only while the recipient rests at its prompt (queued up to 20 otherwise).
  The template tells it to send each agent one batched message per cycle.
- It cannot restart agents or re-spawn orphans. It can staff new work only
  through the job board.
- Replies are addressed by name. A codename freed by an exited agent can be
  handed to a new one.
- It runs all day, so it uses tokens all day. The self-paced loop keeps quiet
  periods cheap.
- A message runs with the recipient's permissions. The charter tells it never
  to order anything destructive without your yes, but that is an instruction,
  not a sandbox.
