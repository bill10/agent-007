---
bump: micro
---
### Fixed

- **Open questions section headers are headings again.** The project and type sections in the Open questions panel are `<h3>` headings wrapping the fold button, so screen-reader heading navigation jumps between them; the button now names the section body it opens (`aria-controls`). Look, keyboard behaviour and the remembered open/closed state are unchanged.
