# Plan workflow

Update `brain/project/index.html` according to the remaining user arguments.

- **Flip a task:** change exactly one `data-status` through `todo`, `doing`, `done`, or `blocked`.
  When marking it `done`, set `data-session` and prepend a log row.
- **Add a task:** assign the next monotonic `t-NNNN`, place it under the correct
  `data-initiative`, and set status `todo`.
- **Add an initiative:** append an `.entry--initiative` with `data-phase`,
  `data-lens="project"`, and empty `data-rollup` and `data-progress` attributes for `brain.js` to
  populate.

Never reuse a cid. Re-scoping means appending a new task and flipping the old task to `done` or
`blocked`. Never type a progress number; `brain.js` derives every bar from task status. If the turn
was substantive, execute the rest of the canonical `stamp` workflow.
