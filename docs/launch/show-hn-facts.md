# Show HN: facts sheet

This is not a post. HN's guidelines ask for posts and comments written by
people, so the owner writes the title, the text and every reply. This page is
the material to write them from: facts, links, the story, the caveats, and
answers to the questions that will come up. Numbers are as of 2026-10-04;
re-run [the count](../BUILT-BY-AGENTS.md#reproduce-the-count) on the day.

Before posting: Show HN is limited for new HN accounts
(news.ycombinator.com/showlim), so check the account can post one.

## The one-line version

Manage your coding agents by talking to them, from your phone.

Title rules for Show HN: starts with "Show HN:", says what it is, no
superlatives. The hook above already fits that shape.

## Links

- Repo: https://github.com/bill10/agent-007 (MIT)
- Video, 38 s with sound: https://github.com/bill10/agent-007/releases/download/v0.54.1.0/phone-call.mp4
  (scripted demo with stand-in agents, sped up, AI voices;
  say so if you link it)
- Built by agents, with the counts and how to reproduce them: [docs/BUILT-BY-AGENTS.md](../BUILT-BY-AGENTS.md)
- Remote access over Tailscale: [docs/REMOTE.md](../REMOTE.md)
- How Billion works, its charter and its rules: [docs/BILLION.md](../BILLION.md)
- npm: `@bill10/agent-007`

## Install

```bash
npx @bill10/agent-007          # try it
npm i -g @bill10/agent-007     # daily use
agent007 install               # run as a service (LaunchAgent / systemd --user)
agent007 install --remote      # reach it from your phone over Tailscale
```

Needs Node.js 20.12+, Git, and Claude Code (logged in) for Billion. Cards that
end in a PR also need `gh` signed in and gstack's ship skill. `agent007 doctor`
checks all of it.

## What it is, in facts

- The operations layer for Claude Code and Codex. It does not replace them: it
  starts them, hands them work, and keeps them running.
- A job board. Each card gets its own git worktree and branch, a Claude Code or
  Codex worker in a real terminal you can open and type into, and ends as a pull
  request (or a summary, for work that isn't code). Cards run now, at a time, or
  on a cron schedule, and pick their model.
- One manager agent, Billion. You give it a goal; it posts cards, reads the
  diffs, waits for CI, merges or sends work back, and asks you about money,
  access, deploys, payments, security, secrets or anything irreversible. Its questions come in a briefing
  twice a day (08:30 and 15:30), or on Telegram.
- Talk to Billion: a hands-free voice conversation in the Billion tab, from a
  phone browser over Tailscale. Billion speaks short progress updates while it
  works. Audio is transcribed on your machine by whisper.cpp and spoken by `say`
  where available. It is a web page, not a phone number.
- Runs locally. Billion's plan and memory live in a git repo, so it picks up
  after a restart. Settings has an Update button.
- Free, MIT, no paid tier, no account, no telemetry server of its own.

## Story beats (for the owner's own words)

1. One person running several Claude Code and Codex sessions found the work had
   become operating them: starting them, setting up worktrees, checking which
   one was stuck, reading diffs, merging.
2. Started as web terminals for agents in parallel worktrees, with a pixel
   office so you can see at a glance who needs you.
3. Added a job board, so agents pick up work instead of being started one by
   one.
4. Added Billion, so the owner stopped posting cards too and only answered
   questions.
5. Then made it reachable from a phone, and made it talk: you can ask for a
   change on a walk and hear when it merged.
6. Proof it works: it built itself. 208 merged PRs on agent-007 since July, 138
   or more from board workers; 117 of the last 131. The owner's other product,
   finnamon (private), got 102 merged PRs in two weeks, 75 or more from board
   workers. See [BUILT-BY-AGENTS.md](../BUILT-BY-AGENTS.md).

## Honest caveats (say these before someone else does)

- macOS and Linux get the service install. Windows runs it in a terminal (CI
  tests it), with no service yet.
- You need your own Claude Code and/or Codex subscription. Agent 007 is free,
  the agents' usage is not: workers and Billion draw on your plan's limits like
  any session you start.
- Early. Version 0.54, changing daily, mostly used so far by its maintainer.
- One maintainer.
- It runs on your machine: a sleeping laptop pauses the agents.
- The demo video is scripted with stand-in agents and sped up.
- finnamon is private, so its numbers can't be checked by readers. The
  agent-007 ones can.
- The board-worker counts are a floor from a branch-name rule, not a log. The
  page says how the rule works.
- Billion's reviews don't show on GitHub (it reviews in its own session, and
  merges under the owner's account), so "Billion reviewed N PRs" is not a
  number we can give.

## Likely questions, with the facts for an answer

**Can't Claude Code do this on its own, with subagents and loops?**
Much of it, with setup: Claude Code has subagents, can run them in worktrees,
can loop and resume, and can call Codex. Agent 007 is that setup built and kept
running: workers are full top-level sessions in terminals you can watch and type
into (not subagents inside one context), a board that survives restarts, a
manager that reviews and merges, and one place their questions reach you. It
runs Codex workers next to Claude Code ones. Use only the parts you want.

**How is it different from other orchestrators?**
Tools from the repo's own landscape notes
([product-design.md](../designs/product-design.md),
[file-explorer-worktree.md](../designs/file-explorer-worktree.md)):
Conductor, claude-squad, dmux, cmux, Worktrunk, Superset run agents in parallel
worktrees; Pixel Agents and AgentOffice visualise them; Munder Difflin is a much
bigger desktop app with memory, meetings and Slack built in. Agent 007 overlaps
with the worktree tools on day one, and differs in: a board workers pull from
on their own, one manager agent that merges, voice from a phone, and a web app
from one command (no desktop app). Be generous to them; the owner used
Conductor before this.

**What does it cost?**
Nothing for Agent 007. Usage comes out of your Claude Code / Codex plans. When a
plan hits its limit, cards on that model wait for the reset; Billion warns as it
nears its own limit and can hand over between Claude Code and Codex, or rotate
across Claude accounts you select.

**Isn't letting agents merge their own code dangerous?**
The rules, as built:
- Workers never merge their own PRs. Only Billion merges, after reading the
  diff and waiting for CI, or it sends the card back.
- Billion asks you first about anything that spends money, needs your
  credentials, can't be undone, or touches payments, security or secrets.
- Before each merge Billion checks whether it would trigger a deploy (a GitHub
  Actions workflow on the base branch that deploys or publishes) and asks you
  if so. You can tell it to always ask, ask only for production, or never.
- Workers on Billion's cards ask Billion for permissions before they ask you.
- Workers don't inherit Billion's Telegram token; each worker gets the GitHub
  token of the account that owns its repo.
What it doesn't protect against: a worker runs with the permission mode you
pick (up to `bypassPermissions`), on your machine, as you. Branch protection
and required CI on GitHub are still your job.

**Is it safe to expose it to my phone?**
It binds to 127.0.0.1 by default. `install --remote` serves it inside your
tailnet only, through `tailscale serve`; it is never on the public internet.
Anyone who can reach it can open a shell on the host, so treat a login token
like an SSH key. Optional per-user login exists, but it gives identity, not
isolation.

**Does the voice go to a cloud service?**
Not with whisper.cpp installed (`agent007 install --voice`): the browser finds
the end of each utterance, your machine transcribes it, `say` speaks the reply.
Without whisper.cpp it falls back to the browser's speech recognition and says
so first (in Chrome that sends audio to Google). The words still go to Claude
or Codex, like anything you type to them.

**Why a pixel office?**
It shows at a glance which agent is working and which one turned to face you
because it needs you. Also, it's fun.

**Who's behind it?**
One maintainer, bill10 on GitHub. No company funding, no paid tier.
