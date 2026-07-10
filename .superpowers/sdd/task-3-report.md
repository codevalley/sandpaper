# Task 3 report — hardened browser interaction contract

Status: implemented and verified; `t-0044` remains `doing` pending independent review.

## Outcome

- Added `ApiError` and `createSandpaperClient(...)` as the single authenticated JSON/SSE transport.
- Wired the injected response-only token and one per-page UUID into every toolbar mutation and EventSource URL.
- Made completion and recovery server-truthful: terminal `changed`/`undoable` drive Saved/Replied and AI undo, including runner errors after partial writes.
- Added one rejected-turn recovery path that restores draft/scope, transcript coherence, controls, actual error text, and composer focus.
- Added an explicit idle/Pick/Hands mode machine, latest-request-wins mode switching, and commit-before-switch behavior.
- Serialized optimistic direct writes. Text retains rich `innerHTML`; delete/move retain the original node at a comment anchor and restore exact DOM content/order without reload unless rollback itself is impossible.
- Made direct undo depend on a server-confirmed snapshot and disabled undo while conflicting AI/direct work is active.
- Repaired transcript rehydration before SSE replay so AI reloads retain exactly one completed turn.
- Repaired `.sp-diff-del` / `.sp-row-delete`, native timeline hiding, shortcut guards, ARIA disclosure/status state, welcome focus containment/restoration, reduced motion, and hostile host-CSS isolation.
- Installed `@playwright/test@1.61.1` as a development-only dependency and installed Playwright Chromium 149 locally.

## Cross-task integration fixes

Two real-browser gaps in the otherwise reviewed server contract required focused Task 3 extensions:

1. Direct mutation responses now return `undoable:true` only when a usable direct snapshot exists; no-op and snapshot-creation failure return `undoable:false`.
2. Native same-origin Chromium EventSource omits `Origin`. SSE still accepts an exact loopback `Origin`; when absent, it now requires both `Sec-Fetch-Site: same-origin` and an exact matching HTTP loopback `Referer`. Missing, cross-site, foreign, malformed, and host-mismatched proofs remain rejected.

## TDD evidence

### Client transport

- RED: `node --test test/client-test.js` failed with `ERR_MODULE_NOT_FOUND` for `public/sp-client.js`.
- GREEN: 6/6 unit tests pass for JSON headers/body, encoded SSE URL, structured server errors, HTTP fallback, malformed response, and network failure.

### Server integration extensions

- RED: direct mutation `undoable` assertions received `undefined`; GREEN: changed/snapshot, no-op, and forced snapshot-failure cases pass.
- RED: Chromium-compatible same-origin SSE metadata received `403 invalid_origin`; GREEN: accepted fallback and five rejection variants pass.

### Browser completion and recovery

- RED: 9/9 initial tests failed because toolbar requests omitted token/client headers, failures discarded drafts or left busy state, and hostile host CSS leaked into controls.
- GREEN: reply-only, real change, 409/auth/malformed/network/runner recovery, and AI/direct undo refusal/consumption pass through the real server plus fake runner.

### Mode and optimistic transactions

- RED: missing pressed state, no commit-before-switch, reload-based structural failure recovery, and two simultaneous direct requests.
- GREEN: 10 focused tests pass for exclusivity, delayed/latest mode selection, exact text/delete/move rollback, serialized requests, active-work undo disabling, snapshot-confirmed undo, and two-tab self/peer reload behavior.

### CSS, search, keyboard, motion, and accessibility

- RED: 8 expected failures and one existing focus-indicator pass.
- GREEN: all 9 focused tests pass for repaired selectors, native hidden, shortcut guards, status/transcript semantics, disclosure buttons, welcome focus, reduced motion, host CSS isolation, and visible focus.

### Self-review regression

- RED: an AI reload produced two completion tags because retained terminal SSE replay raced transcript hydration.
- GREEN: hydration now happens before EventSource setup, rebuilds turn records, and preserves exactly one user bubble, completion tag, and undo control.

## Fresh verification

Run after implementation and self-review fixes:

```text
node --test test/client-test.js
  6 passed, 0 failed

npx playwright test test/browser/toolbar.spec.js --project=chromium
  29 passed, 0 failed

npm test
  75 Node tests passed, 0 failed
  parser checks passed
  markdown parser checks passed
  edit-test: 21 assertions passed

git diff --check
  clean

node bin/cli.js doctor
  healthy; digest parses and internal links resolve
```

No live Claude/Codex runner was called. Browser tests used the real HTTP/SSE server with the deterministic fake runner. Runtime dependencies remain zero; Playwright and browser tests remain outside the published `files` allowlist.

## Brain stamp

Applied exactly one post-verification stamp:

- prepended `w-0220`;
- replaced NOW and digest focus/worklog;
- recorded the native EventSource origin-proof gotcha;
- updated toolbar/test map cards;
- kept `t-0044` as `doing` with `pending review`;
- left the canvas untouched.

## Self-review verdict

No known blocker remains. The intentional scope boundary is unchanged: keyboard/touch structural reorder/delete stays deferred to `t-0024`. Ready for independent review; not yet marked done.
