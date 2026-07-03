# Changelog

All notable changes to Sandpaper are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/).

Each entry is drafted from `brain/log.html` — the same record the agent keeps of its
own work — via `/sandpaper:release`, never written from scratch.

## [Unreleased]

## [0.1.0] — 2026-07-03

Initial public release.

### Added
- The living brain: cover, three lenses (product/engineering/project), three books
  (log/decisions/learnings), a canvas for elevated explanations.
- The refine-in-place toolbar (Sand / Hands / Sling) for local editing.
- `sandpaper install-skill` / `init` / `upgrade` / `rebuild` / `doctor` / `open` — the
  zero-AI CLI plumbing.
- 12 `/sandpaper:*` slash commands — the Claude Code-side intelligence.
- Auto-updating hooks (SessionStart digest injection, Stop stamp-check).
- The out-link resolver — `brain/` is always publishable, detached or not.
- The cyanotype "as-built" identity, shared by the brain and the landing page.
- Published to npm as `@nynb/sandpaper` (`sandpaper` was taken; `sand-paper`
  blocked by npm's anti-squatting policy — see `brain/decisions.html#d-npm-scope`).

[Unreleased]: https://github.com/codevalley/sandpaper/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/codevalley/sandpaper/releases/tag/v0.1.0
