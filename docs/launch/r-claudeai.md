# r/ClaudeAI draft (Built with Claude)

Not posted. Before posting, re-read the rules at
`old.reddit.com/r/ClaudeAI/about/rules/`: the sub needs more than 50 karma to
post (as of 2026-08), and "Built with Claude" posts must say what was built,
how Claude was used, and whether it's free. Use the **Built with Claude**
flair. Attach the video (`phone-call.mp4` from the v0.54.1.0 release) as the
post media, or link it.

Edit it into your own voice before posting; the AI-use line at the end stays.

---

**Title:** I manage my Claude Code agents by talking to them from my phone (free, open source, built by those agents)

**Body:**

[76 s video: asking for a change on a call, hearing it merged]

**What I built:** Agent 007, a free, MIT-licensed web app that runs Claude Code
(and Codex) for you:

- a job board: each card gets its own git worktree and a Claude Code worker in a
  real terminal, and ends as a pull request (or a summary)
- one manager agent, Billion (a long-running Claude Code session), that turns a
  goal into cards, reads the diffs, waits for CI, merges, and asks me only about
  money, access, deploys, security or anything irreversible, in a briefing twice a day
- voice: I open it on my phone over Tailscale, tap Talk to Billion and talk;
  it answers out loud and tells me how the work is going. Transcription runs
  locally with whisper.cpp.

**How Claude helped:** most of it was written by Claude Code and Codex workers
on its own board. Since July: 208 merged PRs, at least 138 opened by board
workers (117 of the last 131). My other project got 102 merged PRs in two
weeks the same way. The counts and how to reproduce them with `gh`:
https://github.com/bill10/agent-007/blob/main/docs/BUILT-BY-AGENTS.md

What I did: set goals, answered Billion's questions, tested on my phone,
reported bugs, made the calls it's told to leave to me.

What I learned:
- Agents need a person for decisions, not for typing. Billion batching its
  questions into two briefings a day was the biggest change in how it felt.
- Workers should never merge their own work. A separate reviewer that reads the
  diff and waits for CI catches a surprising amount.
- Voice only works if the replies are short. Billion is told to answer a voice
  turn in a sentence or two.

**Free?** Yes. It uses your existing Claude Code (or Codex) subscription, so
workers draw on your plan's usage like any session you start. No paid tier.

**Caveats:** macOS and Linux (Windows runs, without the service install),
early (v0.54), one maintainer, runs on your machine so a sleeping laptop pauses
it. The video is a scripted demo with stand-in agents, sped up.

Try it: `npx @bill10/agent-007` · https://github.com/bill10/agent-007

*AI use: the app was written by Claude Code and Codex agents, and this post
was drafted with Claude and edited by me.*
