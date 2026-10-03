---
bump: micro
---
### Added

- **A phone-call demo at the top of the README.** A 76-second video of a Talk to Billion call on a phone, from a Veo-generated cold open and the spoken request to the merged pull request, with burned-in captions and AI-generated voices, plus an 8-second teaser GIF under the new headline, "Manage your coding agents by talking to them, from your phone." It is labelled: sped up, voices AI-generated, app screens real. `node scripts/demo/phone-call.mjs` re-records it on a scratch server with stand-in agents (with `DEMO_MEDIA` pointing at generated clips, or macOS `say` without); `record.mjs` now shares that scratch setup (`scripts/demo/scratch.mjs`), and its cards no longer warn about a missing GitHub remote or ship skill.
