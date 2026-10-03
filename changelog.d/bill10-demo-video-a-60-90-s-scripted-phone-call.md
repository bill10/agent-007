---
bump: micro
---
### Added

- **A phone-call demo at the top of the README.** A 66-second video of a Talk to Billion call on a phone, from the spoken request to the merged pull request, with burned-in captions and both voices on the soundtrack, plus an 8-second teaser GIF under the new headline, "Manage your coding agents by talking to them, from your phone." It is labelled as scripted, sped up and text-to-speech. `node scripts/demo/phone-call.mjs` re-records it on a scratch server with stand-in agents; `record.mjs` now shares that scratch setup (`scripts/demo/scratch.mjs`), and its cards no longer warn about a missing GitHub remote or ship skill.
