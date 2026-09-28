---
bump: patch
---
### Fixed

- **A resumed Billion is told what changed in its charter, not only which tools changed.** After an upgrade, a Billion that resumed its old conversation kept answering the owner's tab messages in its terminal only: a re-read CHARTER.md loses to hundreds of turns of old habit. Each start now saves the charter to `billion-charter.md` in the config folder, and the restart prompt of a resumed conversation quotes the changed paragraphs under "Your charter changed; these rules replace what you did before." (a long change names the sections to re-read instead). The first start on this version, with no saved copy, quotes the charter's paragraphs on answering `[Owner via app]` and `[Owner via Telegram]` messages with `tell_owner`.
