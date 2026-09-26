---
bump: micro
---
### Changed

- **`SAY_RATE` unset now means the voice's own system speed.** Previously
  unset `SAY_RATE` defaulted to 205 wpm; now no `-r` is passed to `say` at
  all, so each voice speaks at its own default rate. Set `SAY_RATE` (120-300)
  to still choose a fixed speed.
