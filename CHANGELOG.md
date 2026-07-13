# Changelog

All notable changes to Sandpaper are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/).

Each entry is drafted from `brain/log.html` — the same record the agent keeps of its
own work — via `/sandpaper:release`, never written from scratch.

## [Unreleased]

## [0.3.0] — 2026-07-13

### Added
- Codex is now a first-class provider alongside Claude Code, with saved `codex login`
  authentication, diagnostics, resumable provider-scoped sessions, and native token usage.
- The floating toolbar now provides provider selection, an explicit `Make default` action,
  isolated histories, and transactional `New session` reset.
- Installation now provisions both Claude and Codex integrations by default, with explicit
  single-provider options available.

### Changed
- Provider dispatch now uses one provider-neutral registry across hooks, workflows, manifests,
  setup, diagnostics, lifecycle recovery, and package contracts.
- Toolbar turns, transcripts, usage, edits, and resets are provider-tagged without hidden context
  transfer.
- Claude reports supplied cost while Codex reports supplied token totals.

### Fixed
- GitHub Release creation now has the repository context required after npm publication.
- Unavailable providers fail explicitly without silent fallback.
- Provider installation, sessions, transcript restoration, and direct-edit recovery preserve
  authoritative bytes across failures and races.
- Legacy installations preserve existing brain counters, remove duplicate historical hooks,
  safely reject concurrent counter changes, and direct populated brains to `open` rather than
  `init`.

### Security
- Provider installation uses bounded, transactional, non-following filesystem operations.
- Provider preferences, sessions, mutations, and browser state validate ownership and structure.
- External-path reporting remains best-effort and never promises unverifiable undo coverage.

## [0.2.1] — 2026-07-11

### Added
- Node 18/20/22 integration coverage, Chromium interaction coverage, shipped-JavaScript syntax
  checks, and a fresh-install package smoke that exercises the installed CLI and server.

### Changed
- The living brain now derives mechanical progress and counts in the browser, while `doctor`
  independently checks stamped fallbacks, digest state, source metadata, and repository links.
- README, product/engineering specs, and brain wiki/map language now agree on the shipped
  Claude-only provider boundary, Hands behavior, undo support, and current roadmap status.
- CI and release automation now install prerequisites explicitly, inspect the actual tarball,
  require an exact tag/lockfile/changelog match, and block publishing on every release gate.

### Fixed
- Server turns now reserve one truthful lifecycle across SSE replay, terminal status, byte hashes,
  bounded snapshots, undo, runner failures, and page/client-scoped reload attribution.
- Directory serving falls back to closeable per-directory watchers where recursive `fs.watch` is
  unavailable, preserving Node 18 Linux support.
- The toolbar now recovers drafts and controls after rejected requests, makes Pick and Hands
  exclusive, rolls back failed direct edits exactly, and repairs search, keyboard, focus, motion,
  ARIA, and host-style isolation behavior.
- Release-note extraction keeps the post-`v0.2.0` literal `awk` heading match, now fails on a
  missing or empty exact version section, and never invents fallback notes after publishing.

### Security
- A shared canonical repository-path policy allows intended source and `.github` links while
  denying traversal, escaping symlinks, runtime state, hidden namespaces, and secret-shaped files.
- Every local mutation and SSE connection now requires a process-only token, loopback host,
  same-origin browser context, valid client identity, and structured size/content validation.

## [0.2.0] — 2026-07-03

### Added
- `/sandpaper:release` — draft release notes and a semver bump from
  `brain/log.html`, then `npm version` + tag + push.
- `bin/verify-publish.js` (`npm run verify-publish`) — tarball-safety gate:
  no `site/`, no secrets, size envelope.
- `.github/workflows/ci.yml` — tests + verify-publish on every push/PR,
  Node 18/20/22.
- `.github/workflows/release.yml` — a pushed tag runs tests → verify-publish
  → `npm publish --provenance` → a GitHub Release.
- `.github/dependabot.yml` — weekly Actions + npm dependency checks.

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

[Unreleased]: https://github.com/codevalley/sandpaper/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/codevalley/sandpaper/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/codevalley/sandpaper/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/codevalley/sandpaper/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/codevalley/sandpaper/releases/tag/v0.1.0
