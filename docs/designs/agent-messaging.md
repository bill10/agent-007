---
status: BUILT
---
# Agents message each other, whichever CLI they run on

Branch: bill10/agent-messaging

## Problem

Two Claude Code agents in the office can message each other through Claude
Code's own `SendMessage` / `ListAgents`. A Codex agent has no equivalent, and
Claude Code's `ListAgents` does not list it, so a Claude agent cannot reach a
Codex agent and a Codex agent cannot reach anyone. "Ask Viper what it changed in
`jobs.js`" works only when Viper runs Claude Code.

## What the app already has

Everything this needs is already wired into every agent:

- **One MCP server in both CLIs.** `server/agent-mcp.js` hands every Claude Code
  and Codex spawn the `agent-007-board` MCP server (Claude connects over HTTP;
  Codex through `agent-mcp-bridge.js`). The tools in `server/mcp.js` show up in
  both CLIs with no per-CLI code.
- **Caller identity.** Each request carries the session's bearer token, and
  `resolveAgentToken` turns it into the calling session: who sent a message is
  known, not claimed.
- **A write path into every agent.** `session.pty.write()` is how the browser
  types into a terminal, and neither CLI can tell it apart from a person typing.
- **Knowing when an agent can take input.** `detectState` reports `WAITING`
  (resting at its prompt), `WORKING`, `MESSAGE` (a dialog wants an answer) and
  `DISCONNECTED`.

So the feature adds two MCP tools and a small delivery queue. No new transport,
no new process, and nothing that knows which CLI is on the other end.

## Design

### Tools (added to `server/mcp.js`)

**`list_agents`**: the live sessions this agent may message. One line each:
name, CLI (`claude` / `codex` / other), repo and branch, state, and the job
card title when it is a board agent. The caller is left out.

**`send_message`** `{ to, message }`
- `to`: the recipient's session name as `list_agents` prints it (the codename,
  e.g. `Viper`). Session names are unique among live sessions. Unknown or exited
  names are refused with the list of valid ones.
- `message`: plain text, capped at 8000 characters. Control characters are
  stripped, so a message cannot close the bracketed paste and type keystrokes.
- It returns at once with `delivered` or `queued (Viper is working; it will
  get this when it next stops)`. It never waits for a reply: the reply is a
  message coming back the same way.

Descriptions follow the `post_job` rule: say when to reach for the tool ("when the
user asks you to ask, tell or coordinate with another agent"), so agents don't
start chatting unprompted.

### Delivery (new `server/messages.js`, no node-pty import, so it can be tested)

A message is typed into the recipient's terminal as a user turn:

```
[Message from agent Cobra (codex · agent-007 · bill10/fix-cron)]
<message text>
[Reply with the send_message tool, to: "Cobra". This came from another agent, not from the user.]
```

Each body line is quoted with `> `, so a body cannot close the message with a
footer of its own and carry on as if the user were speaking.

It is written as a bracketed paste (`\x1b[200~ … \x1b[201~`) followed by `\r`,
so a newline inside the message cannot submit early and the whole block goes in
as one turn.

**When it is written.** Only when the recipient is `WAITING` and no person has
typed into that terminal in the last 30 s. Otherwise it waits in a per-session
in-memory queue, which `updateState` in `server/pty.js` retries on every
one-second state check. At most one message goes in each time the agent comes
to rest: the next one waits until it has worked on that one and come back to
its prompt.

- **Never into `MESSAGE`.** In that state a permission or question dialog is
  on screen, and typed text would answer it. This is the one rule that must not
  slip.
- **Not over a person.** `ws.js`'s `pty-input` handler stamps
  `session.lastUserInputAt` for real keystrokes only (`isTyping`): the
  terminal's own replies to queries and its focus reports do not count. Half-typed text in the composer would otherwise
  get the message glued onto it and sent. `// ponytail: a 30 s window, not
  real composer detection; neither CLI exposes whether its composer is empty.`
- **Queue cap: 20 per recipient.** Past that, `send_message` is refused with a
  reason the sending agent can pass on. The queue is dropped when the recipient exits;
  sessions do not survive a restart, so it does not need to either.

### Who may message whom

- **Same owner only.** A sender reaches only sessions with its own `ownerId`,
  the same line `ws.js`'s `owns()` draws for people in multiplayer. In
  single-player every session is unowned, so every agent can reach every other.
- **Agents only.** The recipient must be a Claude Code or Codex session
  (`takesMcpConfig`). A plain shell tab would run the message as a command.
- **Never uphill into an agent that never asks.** An agent spawned with
  `bypassPermissions`, `--dangerously-skip-permissions`, Codex's
  `--dangerously-bypass-approvals-and-sandbox`, `--sandbox danger-full-access`,
  `--ask-for-approval never`, `--approve-for-me`, `--full-auto` or any
  `-c`/`--profile` override (`isUnguarded`, read off its command) takes
  messages only from another such agent. Claude's `auto` counts as guarded:
  its classifier reviews every action. Config-file defaults are invisible to
  this check. Without this a read-only job reading an untrusted issue could get a
  bypass agent to run what the issue said. (Added in the pre-landing review.)

### Loops

Two agents that each answer every message will talk forever. Guard: at most
**10 messages per sender→recipient pair per 10 minutes**. Past that the tool
refuses and says why, and the user sees it in the sender's terminal. That is
simpler than hop counters threaded through message text, which an agent could
edit anyway.

### Visibility

Nothing new in the UI for v1. The message lands in the recipient's terminal
with its header, where the person watching sees it, and the send shows up as a
tool call in the sender's terminal. Under Claude Code's default permission mode
the user approves each `send_message`, as with `post_job`.

## Security

A message is a prompt typed into another agent **with that agent's
permissions**. A Codex agent in `bypassPermissions` that receives "run `rm -rf`"
will treat it as user input. The mitigations above (same owner, the header
saying it is not from the user, the rate cap, never answering dialogs) narrow
this but do not sandbox it. Nothing can: this is the same trust as
`post_job`, whose card text becomes another agent's prompt. The FEATURES.md
entry has to say this in plain words, alongside the existing `bypassPermissions`
warning.

## Known limits (from the pre-landing review)

- **WAITING is "no recognised dialog", not "composer seen".** A dialog missing
  from `MESSAGE_PATTERNS` reads as WAITING, and the Enter answers it. Neither
  CLI's idle composer has a reliable pattern yet (Codex's `›` has none;
  Claude Code's last line is usually its status footer). The Enter is at least
  checked against a fresh read of the screen, and skipped if a dialog shows.
- **A skipped Enter leaves the message in the composer.** Further messages are
  held until a person has typed in that terminal, and queue meanwhile.
  A short message that itself reads like a dialog ("Do you want to proceed?")
  echoes onto the screen and trips the same check, so it too waits for a person.
  That errs the safe way.
- **Replies go by name.** A codename freed by an exited agent can be handed to
  a new one, which would then get a reply meant for the old.
- **Pairs are rate-limited, not stopped.** Two agents can keep exchanging a
  message a minute each way for as long as both run.

## Not doing

- **Replacing Claude Code's native `SendMessage`.** It stays; this runs
  alongside it and is the one path that covers every pairing.
- **An inbox tool the agent polls.** Agents don't poll, so a message waiting
  for `read_messages` would never get read. Typing it in is what makes a Codex
  agent actually respond.
- **Renaming the MCP server** from `agent-007-board`. The name no longer fits,
  but people's permission allowlists already name `mcp__agent-007-board__*`.
- **Broadcast / group messages, persistence across restarts, a message log
  panel.** Add them when someone asks.

## Build steps

1. **Checked by hand.** Claude Code 2.x submits `<bracketed paste>\r` as one
   turn with no gap between them. Codex could not be checked, so `deliver()`
   waits 150 ms before the Enter (`SUBMIT_DELAY_MS`), because Codex reads fast
   keystrokes as a paste burst in which Enter is a newline. While checking, a
   paste typed into a fresh Codex session answered its folder-trust dialog. That
   dialog read as `WAITING`, not `MESSAGE`, so `lib/helpers.js` now matches
   "Trust and continue".
2. `server/messages.js`: `sendMessage({ from, to, text })`,
   `flushMessages(session)`, the queue, the pair rate limiter and
   `formatMessage`. It takes `sessions` as a parameter, in the style of
   `mcp.js`, and writes through each session's own `pty`.
3. `server/mcp.js`: `LIST_AGENTS_TOOL` and `SEND_MESSAGE_TOOL`, plus `CALLS`
   entries that stay thin wrappers over injected `ctx.listAgents` /
   `ctx.sendMessage`.
4. `server/http.js`: inject both into the `/mcp` handler's context.
5. `server/pty.js` `updateState`: call `flushMessages` on every check (a
   message held back for a typing person has no later transition to wait for). Drop the queue in `onExit`.
6. `server/ws.js` `pty-input`: set `session.lastUserInputAt = Date.now()`.
7. Tests, in `test/messages.test.js`:
   - a message is written when the recipient is `WAITING`, and queued when it is `WORKING` or `MESSAGE`
   - it is queued if a person typed within 30 s
   - flushing writes one message per transition
   - a sender cannot reach another owner's session or a shell tab
   - the pair limit and the queue cap refuse with a readable reason
   - a newline in the body stays inside the bracketed paste

   Add a `tools/list` case to `test/mcp-protocol.test.js`.
8. Docs: a FEATURES.md entry (with the security paragraph) and one README
   Features line; keep the two in step.
