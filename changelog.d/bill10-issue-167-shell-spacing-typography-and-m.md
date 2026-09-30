---
bump: micro
---
### Fixed

- **The file explorer follows the cursor when you drag its divider.** Its width
  was animated, so the panel trailed a drag by 200ms; collapsing it (Cmd+E)
  now happens at once instead of re-laying out the office and terminal on every
  frame.
- **Easier-to-read panel labels.** REPOS, the job board's column headers and
  Finished go from 9px to 11px, and the job form's labels from 10px to 11px.
  Uppercase now applies only to each label's word, not to the dropdown or hint
  inside it.
- **Header buttons sit inside their headers.** "+ Agent"/"+ Job" and the REPOS
  row's icons had 3–4px between them and the header's bottom border; they now
  have 5–6px.
- **Reduced motion stops the dictation dot's pulse again.** Its
  `prefers-reduced-motion` rule came before the dot's own rule in the
  stylesheet and lost to it.
