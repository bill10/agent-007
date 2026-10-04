# X thread draft

Not posted. Five posts, each under 280 characters. Attach `phone-call.mp4`
(v0.54.1.0 release asset, 76 s) natively to post 1 rather than linking it: X
plays native video inline and ranks it above links. Put the repo link in post
5, not post 1. Edit into your own voice.

---

**1/5** (with the video)

I manage my coding agents by talking to them, from my phone.

Ask for a change on a call. Hear when it's merged.

Agent 007: free, open source, for Claude Code and Codex. 🧵

**2/5**

How it works: a job board. Each card gets its own git worktree and a Claude Code or Codex worker in a real terminal you can open and type into. Code cards end as pull requests.

**3/5**

One manager agent, Billion, runs the board. Give it a goal: it posts the cards, reads the diffs, waits for CI and merges.

It asks me only about money, access, deploys, security or anything irreversible, in a briefing twice a day.

**4/5**

It built itself: 208 merged PRs since July, at least 138 opened by board workers (117 of the last 131).

My other product got 102 merged PRs in two weeks the same way.

Counts, and how to reproduce them with gh: github.com/bill10/agent-007/blob/main/docs/BUILT-BY-AGENTS.md

**5/5**

Runs on your machine, on your existing subscriptions. Phone access over Tailscale, voice transcribed locally.

npx @bill10/agent-007

github.com/bill10/agent-007

Early, one maintainer, macOS/Linux. Feedback welcome.
