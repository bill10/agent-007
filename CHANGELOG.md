# Changelog

All notable changes to Agent 007 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses a four-part `MAJOR.MINOR.PATCH.MICRO` version.

## [0.2.0.0] - 2026-08-24

### Added

- Voice input: dictate prompts instead of typing. Click the mic button in the
  terminal header (or press `Cmd+D`), speak, and your words are typed into the
  active agent's terminal — press Enter to send, exactly as if you had typed.
  A floating pill shows the live transcript while you speak; nothing is ever
  auto-submitted. Works in Chrome, Edge, and Safari over HTTPS or localhost
  (for remote access, use `tailscale serve` — see `docs/REMOTE.md`).
- The microphone is deliberately bounded so it can never stay hot unnoticed:
  it stops after ~1 minute without delivered speech, always after 5 minutes,
  when you switch or close agents, when an agent's shell ends, and when the
  browser tab is hidden — each stop except the hidden-tab one flashes an
  on-screen notice explaining why (a hidden tab can't show one; that stop is
  announced to screen readers).
- Screen-reader support for dictation: the mic button announces its
  pressed state and voice start/stop/errors are read out via a live region.

### Changed

- Global keyboard shortcuts (`Cmd+1..9`, `Cmd+E`, `Cmd+N`, and the new
  `Cmd+D`) now fire only on exact Cmd chords: combos with Ctrl or Alt also
  held, and held-key repeats, no longer trigger them. The page and the
  terminal now share one shortcut list, so no chord is blocked in the
  terminal but dead on the page.
- The docs now spell out the voice privacy trade-off: Chrome and Edge process
  speech on vendor servers, so dictated content leaves the machine even inside
  a tailnet — don't dictate secrets. They also note that transcripts arrive as
  keystrokes, so single-key prompts (pagers, y/n confirmations) react to
  speech like typing.

## [0.1.0.1] - 2026-08-01

### Added

- The README now shows a screenshot of the app: the pixel office running four
  agents alongside a live agent terminal. The README had referenced
  `docs/screenshot.png` since the initial commit, but the image was never
  captured, so the link rendered broken on GitHub.
- Version tracking via a `VERSION` file and this changelog.
- CI: a GitHub Actions workflow that runs the test suite on pushes to `main` and
  on every pull request. The README's Tests badge had pointed at
  `.github/workflows/test.yml` since the initial commit, but no workflow existed,
  so the badge never resolved.

### Changed

- README image markup now carries descriptive alt text and no longer keeps the
  placeholder comment that specified the screenshot before it existed.
