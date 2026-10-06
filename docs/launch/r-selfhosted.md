# r/selfhosted: megathread comment only

Not posted. r/selfhosted takes new projects in its weekly **New Project
Megathread** (around Thursday, as of 2026-09-25), not as posts of their own, so
a standalone post would be removed. Agent 007 fits there on the self-hosted
side (it runs on your own machine, reached over your tailnet, nothing hosted by
us) but leans on cloud models: the agents are Claude Code or Codex, on your own
subscription. Say that up front; that crowd will ask.

Before posting: re-read `old.reddit.com/r/selfhosted/about/rules/` and the
megathread's own header for its current AI-disclosure requirement, and match
it. Edit into your own words.

---

**Agent 007**: run your coding agents (Claude Code, Codex) from a web app on
your own machine, and talk to them from your phone.

- Self-hosted: one `npm` install, runs as a LaunchAgent or a systemd user unit
  (`agent007 install`), binds to 127.0.0.1. `agent007 install --remote` serves
  it on your tailnet with `tailscale serve`, never the public internet.
- Voice can be fully local: with whisper.cpp installed (`agent007 install --voice`)
  it transcribes on the host and `say` speaks the replies; without it the
  browser's own speech recognition is used, after a notice.
- State lives on disk and in a git repo; no account, no cloud service of ours.
- Not local: the agents themselves call Anthropic's or OpenAI's models, on your
  own Claude Code / Codex subscription.
- What it does: a job board agents pull work from (one git worktree and
  terminal per card, ending in a PR or a summary), and a manager agent that reviews and
  merges and asks you only what matters.
- MIT, free, early (v0.54), one maintainer. macOS and Linux; Windows runs it
  in a terminal.

Repo and 38 s demo video: https://github.com/bill10/agent-007

*AI disclosure: written mostly by Claude Code and Codex agents (counts in
docs/BUILT-BY-AGENTS.md); this comment drafted with Claude, edited by me.*
