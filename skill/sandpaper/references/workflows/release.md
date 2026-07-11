# Release workflow

Cut a release of the package. Treat the remaining user arguments as an optional requested semver
bump. The brain narrates every session, so draft from it rather than from scratch.

## 1. Range

Find the last release tag with `git describe --tags --abbrev=0`; if none exists, use the whole
history. Read every `brain/log.html` worklog entry since the tag date and every in-range
`brain/decisions.html` entry. This is the release source and is richer than raw commit messages.

## 2. Propose and confirm the bump

Read the range for signal, then use the native structured user-input/confirmation mechanism to ask
the owner to confirm:

- **major:** breaking changes such as removed or renamed commands or flags, incompatible file format
  changes, or anything else that breaks an existing install.
- **minor:** shipped capability such as a new action, CLI flag, or brain feature.
- **patch:** fixes, polish, docs, or internal-only changes.

If the remaining user arguments name a bump, preselect it but still ask. A human confirms every version bump.

## 3. Draft and show the notes

Draft a `## [X.Y.Z] — YYYY-MM-DD` section for `CHANGELOG.md` in Keep-a-Changelog style, using
`### Added`, `### Changed`, `### Fixed`, and `### Security` only when applicable. Write one line per
real change in plain user-facing language rather than worklog jargon. Fold in any content still under
`## [Unreleased]`. Show the draft before writing it.

## 4. Start clean, write, then stamp

Before changing anything, run:

```sh
git status --porcelain
```

The clean-tree check must happen before any release file is written. Stop if it prints anything; do
not stash, discard, or sweep unrelated work into a release.

Once clean, insert the confirmed `## [X.Y.Z] — YYYY-MM-DD` section above the previous version, keep
`[Unreleased]` empty at the top, and update the compare-links footer. Then execute the canonical `stamp` workflow
completely for the release. The stamp must happen before the tag so the tagged
commit includes the release worklog, NOW, digest, and release task or map status.

## 5. Stage only the release record

Stage the known changelog and stamp paths explicitly, verify the staged names, and commit before any
version command:

```sh
git add -- CHANGELOG.md brain/index.html brain/log.html brain/project/index.html brain/map.html
git diff --cached --check
git diff --cached --name-only
git commit -m "chore: prepare vX.Y.Z release"
git status --porcelain
```

The staged-name list may contain only those five paths. Stop if final status is not clean. Never use
`git add .`, `git add -A`, or a force option in this workflow.

## 6. Run the release gates

While the repository remains untagged, run every release-candidate gate and stop on the first
failure:

```sh
npm run check:syntax
npm test
npm run test:browser
npm run test:package
node bin/cli.js doctor
npm run verify-publish
git diff --check
git status --porcelain
```

The last command must remain empty. Show the gate results.

## 7. Final human confirmation

Use the native structured user-input/confirmation mechanism to obtain a separate final human confirmation
for the version, tag, and push step. The earlier bump and notes approval does not
authorize a push.

## 8. Version, verify tag, then push

Only after final confirmation, create the version commit and tag:

```sh
npm version <bump> -m "chore(release): v%s"
```

`npm version` updates `package.json` and `package-lock.json`, creates the version commit, and tags
`vX.Y.Z`. Before presenting or running any push, verify both the package version and that the exact
tag resolves to the version commit at `HEAD`:

```sh
test "$(node -p "require('./package.json').version")" = "X.Y.Z" &&
  test "$(git rev-parse --verify "vX.Y.Z^{commit}")" = "$(git rev-parse HEAD)"
```

Stop immediately if either verification command fails; do not run the push. Only after both commands
succeed, push the verified version commit and tag:

```sh
git push --follow-tags
```

Do not hand-edit the version, bypass the clean-tree check, force a tag, force-push, or publish
directly.

## 9. CI publish handoff

Tell the owner that the pushed tag triggers `.github/workflows/release.yml`, which runs tests,
`verify-publish`, `npm publish --provenance`, and GitHub Release creation. It requires either an
`NPM_TOKEN` repository secret containing an npm **Automation** token, which is required when the npm
account uses `auth-and-writes` 2FA because only Automation tokens skip an interactive OTP, or npm
Trusted Publishing configured for the repository and workflow. Never publish to npm directly from
this workflow; CI verifies and publishes.
