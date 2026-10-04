# Built by agents

Agent 007 is built with Agent 007, and so is the owner's other product,
finnamon. These are the counts from GitHub as of 2026-10-04, and how to get them
again yourself.

| | agent-007 | finnamon |
|---|---|---|
| Merged pull requests | 208 | 102 |
| ...opened by board workers (at least) | 138 (66%) | 75 (74%) |
| ...opened any other way | 70 | 27 |
| Time span of merged PRs | 2026-07-18 to 2026-10-04 (11 weeks) | 2026-09-20 to 2026-10-04 (2 weeks) |
| Merged in the last two weeks | 131, of them 117 by board workers | all 102 |
| Lines changed (merged PRs) | +72,275 / -8,899 | +33,194 / -17,077 |
| Repo | [public](https://github.com/bill10/agent-007) | private |

agent-007's job board itself landed on 2026-08-28 (PR #15), so its first six
weeks of PRs could not have come from board workers. Since the board has been
running, most changes have: 117 of the 131 PRs merged in the last two weeks.

finnamon was not started by agents: it already had 130 commits from July to
November 2025. The 102 PRs above are the two weeks since 2026-09-20.

## Reviews

GitHub shows one review across all 310 PRs, and that number is not the review
count. Reviews happen outside GitHub:

- the worker runs [gstack](https://github.com/garrytan/gstack)'s `/ship` before
  opening the PR, which runs the tests and a pre-landing review of the diff in
  the worker's own session;
- on cards Billion posted, Billion reads the diff, waits for CI and merges or
  sends the card back.

Neither leaves a GitHub review, and both Billion and the owner merge under the
owner's account (`bill10`, or `theslungai` on a second machine), so GitHub
cannot tell you how many merges Billion did and how many the owner did. We
don't have that number.

## What the owner did, and what the agents did

The owner (one person) set the goals, wrote or approved the cards, answered
Billion's questions, tried the features on a laptop and a phone, reported
what was wrong (several branches are named after those reports, such as
`billion-tab-fixes-from-the-owner-10-1`), and made the calls Billion is told to
leave to a person: money, access, deploys, anything irreversible.

Board workers (Claude Code and Codex) wrote the code, the tests, the docs, the
PR descriptions and the release notes, and opened the PRs. Billion turned goals
into cards, reviewed and merged.

The "any other way" PRs are ones not started from the board: agents the owner
started by hand in a web terminal, the owner's own Claude Code sessions, and
early branches from before the board existed. They are AI-assisted too, but
are not counted as board work.

## Reproduce the count

Needs [`gh`](https://cli.github.com) and `jq`. finnamon is private, so only its
owner can run the second line.

```bash
count() { gh pr list -R "$1" --state merged --limit 1000 --json headRefName,createdAt,mergedAt | jq -r '
  def board: .headRefName | test("^(?!(feat|fix|docs|feature|chore)/)[^/]+/[a-z0-9-]{36,}$");
  "\(length) merged, \(map(select(board)) | length) from board workers, \(map(select(.mergedAt >= "2026-09-20")) | length) merged since 2026-09-20 (\(map(select(board and .mergedAt >= "2026-09-20")) | length) from board workers), \(map(.createdAt) | min[:10]) to \(map(.mergedAt) | max[:10])"'; }
count bill10/agent-007
count bill10/finnamon
```

How it tells a board worker's PR apart: the board names a card's branch
`<git user>/<card title as a slug>`, cut at 40 characters
(`branchSlugFromTitle` in `lib/jobs.js`), and card titles are sentences, so
the slug almost always runs to the cut, as in
`bill10/talk-to-billion-on-iphone-a-speaker-earp`. An agent started by hand
gets a one-word cocktail name (`bill10/gimlet`), and branches a person names
are short or start `feat/` or `fix/`. So the rule counts a PR as board work
when its branch is `<user>/<slug of 36+ characters>`. That is a floor, not an
exact count: a card with a short title is counted as "any other way", and the board keeps no public record to
check against. Counting every `<user>/<three or more words>` branch instead
gives 162 for agent-007, which over-counts hand-named branches.
