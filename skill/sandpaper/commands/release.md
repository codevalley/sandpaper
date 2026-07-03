---
description: Cut a release — draft notes from the brain, pick a semver bump, tag, push
argument-hint: "[optional: force patch | minor | major]"
---

Cut a release of this package $ARGUMENTS. The brain already narrates every session — draft
from it, never from scratch.

1. **RANGE** — find the last release tag (`git describe --tags --abbrev=0`; none = the whole
   history). Read every `brain/log.html` worklog entry since that tag's date, plus any
   `brain/decisions.html` entries in range — that's the real source, richer than raw commit
   messages.

2. **PROPOSE THE BUMP** — read the range for signal, then ask the owner to confirm (AskUserQuestion,
   never assume silently):
   - **major** — a breaking change: a removed/renamed CLI flag or command, an incompatible file
     format change, anything that breaks an existing install.
   - **minor** — new capability shipped (a new command, a new CLI flag, a new brain feature).
   - **patch** — fixes, polish, docs, internal-only changes.
   If `$ARGUMENTS` already names one, propose it pre-selected but still confirm — a human okays
   every version bump.

3. **DRAFT THE NOTES** — write a `## [X.Y.Z] — YYYY-MM-DD` section for `CHANGELOG.md` in
   Keep-a-Changelog style (`### Added` / `### Changed` / `### Fixed` / `### Security` as they
   apply), one line per real change, in plain user-facing language — not log-entry jargon. Fold
   in anything still under `## [Unreleased]`. Show the draft to the owner before writing it.

4. **WRITE + TAG** — insert the new section into `CHANGELOG.md` above the previous version (keep
   `[Unreleased]` empty at the top), update the compare-links footer, then:
   ```
   npm version <bump> -m "chore(release): v%s"
   git push --follow-tags
   ```
   `npm version` bumps `package.json`, commits, and tags `vX.Y.Z` in one step — don't hand-edit
   the version number.

5. **STAMP** — run the rest of `/sandpaper:stamp`: a log row for the release, the cover's NOW,
   the digest, and a plan-board tick if a task tracked this work.

6. **HANDOFF** — tell the owner the pushed tag will trigger `.github/workflows/release.yml`
   (tests → `verify-publish` → `npm publish --provenance` → a GitHub Release), which needs either
   an `NPM_TOKEN` repo secret (an npm **Automation** token — required if the account has
   `auth-and-writes` 2FA, since only Automation tokens skip the interactive OTP prompt) or npm
   Trusted Publishing configured for this repo + workflow. Never publish to npm directly from
   here — that's the release workflow's job, and it verifies before it publishes.
