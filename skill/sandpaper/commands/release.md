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

4. **START CLEAN, WRITE, THEN STAMP** — before changing anything, run
   ```
   git status --porcelain
   ```
   Stop if it prints anything: do not stash, discard, or sweep unrelated work into a release.
   Once clean, insert the confirmed `## [X.Y.Z] — YYYY-MM-DD` section above the previous version
   (keep `[Unreleased]` empty at the top), update the compare-links footer, then run the complete
   `/sandpaper:stamp` for the release. The stamp happens before the tag so the tagged commit carries
   the release worklog, NOW, digest, and any release task/map status.

5. **STAGE ONLY THE RELEASE RECORD** — stage the known changelog/stamp files explicitly, verify
   the staged names, and commit them before running any version command:
   ```
   git add -- CHANGELOG.md brain/index.html brain/log.html brain/project/index.html brain/map.html
   git diff --cached --check
   git diff --cached --name-only
   git commit -m "chore: prepare vX.Y.Z release"
   git status --porcelain
   ```
   The staged-name list may contain only those five paths. Stop if the final status is not clean.
   Never use `git add .`, `git add -A`, or a force option in this flow.

6. **RUN THE RELEASE GATES** — while the repository is still untagged, run every release-candidate
   gate and stop on the first failure:
   ```
   npm run check:syntax
   npm test
   npm run test:browser
   npm run test:package
   node bin/cli.js doctor
   npm run verify-publish
   git diff --check
   git status --porcelain
   ```
   The last command must remain empty. Show the gate results and ask the owner to confirm the final
   version/tag/push step; the earlier bump and notes approval does not silently authorize a push.

7. **VERSION, TAG, THEN PUSH** — only after that final owner confirmation, run:
   ```
   npm version <bump> -m "chore(release): v%s"
   git push --follow-tags
   ```
   `npm version` updates `package.json` and `package-lock.json`, creates the version commit, and tags
   `vX.Y.Z`. Confirm that exact tag points at the version commit before pushing. Do not hand-edit the
   version, bypass the clean-tree check, force a tag, force-push, or publish directly.

8. **HANDOFF** — tell the owner the pushed tag will trigger `.github/workflows/release.yml`
   (tests → `verify-publish` → `npm publish --provenance` → a GitHub Release), which needs either
   an `NPM_TOKEN` repo secret (an npm **Automation** token — required if the account has
   `auth-and-writes` 2FA, since only Automation tokens skip the interactive OTP prompt) or npm
   Trusted Publishing configured for this repo + workflow. Never publish to npm directly from
   here — that's the release workflow's job, and it verifies before it publishes.
