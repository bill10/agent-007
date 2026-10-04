# One-liners

Character counts are of the text alone.

## Up to 140 characters

- Manage your coding agents by talking to them, from your phone. Free and open source, for Claude Code and Codex. (111)
- A job board your coding agents work from, one agent that merges their PRs, and a phone line to you. (99)
- The operations layer for Claude Code and Codex: a job board, a manager agent that merges, and voice from your phone. (116)

## Up to 280 characters

- Manage your coding agents by talking to them, from your phone. Agent 007 is the operations layer for Claude Code and Codex: agents take work from a board, one manager agent reviews and merges their PRs, and asks you only what matters. Free, open source, runs on your machine. (275)
- Agent 007 gives Claude Code and Codex a job board, one worktree and terminal per card, and a manager agent that turns your goal into cards, reviews and merges the PRs, and briefs you twice a day. Call it from your phone. It built itself: 138+ merged PRs from its own board. (273)

## GitHub repo description (proposal, not applied)

Current: "From web terminals for your coding agents to a self-running agent
company: Claude Code and Codex in parallel git worktrees, a job board they pick
work from, and one agent that runs the board from a goal."

Proposed (matches the README hero; GitHub allows 350):

> Manage your coding agents by talking to them, from your phone. The operations layer for Claude Code and Codex: a job board agents work from, one manager agent that reviews and merges their PRs, and voice calls over Tailscale.

`package.json`'s `description` shows on npm; change it in the same PR as the
repo description if you take this, so the two read the same.

## GitHub topics (proposal, not applied)

Current (11): agent-orchestration, ai-agents, claude-code, codex,
coding-agents, git-worktree, kanban, parallel-agents, pixel-art, self-hosted,
terminal.

Proposed (GitHub allows 20): keep all 11, add

- `voice-assistant`: the new pitch, and nothing else in the list says voice
- `tailscale`: how the phone gets there; people search for tool + tailscale
- `autonomous-agents`: already an npm keyword
- `mcp`: already an npm keyword; the board is an MCP server
- `developer-tools`: a broad topic with heavy browsing traffic
- `openai-codex`, `anthropic`: the names people search, beyond `codex`

That makes 18.
