# Changelog

All notable changes to Agent 007 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses a four-part `MAJOR.MINOR.PATCH.MICRO` version.

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
