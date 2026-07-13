# Stamp workflow

Update `brain/` to reflect the work just completed, using the remaining user arguments as an
optional one-line summary. Follow the brain's STAMP contract exactly. Perform every applicable step,
regenerating whole regions rather than prose-editing inside one.

1. **LOG:** prepend exactly one `<li>` row to both `brain/log.html` and the cover's
   `<!-- BRAIN:LOG -->` feed. Use the next monotonic `w-NNNN` cid. Make it verb-led, no more than 12
   words, and end it with a link to a canonical anchor. Never edit a prior row.
2. **NOW:** replace the cover's `<!-- BRAIN:NOW -->…` region with one present-tense sentence of at
   most 120 characters plus a link to the touched artifact. Replace; never append.
3. **DIGEST:** overwrite `#brain-state` so `focus`, the newest worklog line, and `open` match.
4. **DECISIONS:** when a call was made or a question opened or resolved, append a status-typed
   `.entry` to `brain/decisions.html`, or flip exactly one `data-status`. A reversal is a new entry
   with `data-rel="supersedes:<id>"`; never rewrite the old entry.
5. **LEARNINGS:** when a gotcha occurred, append one callout to `brain/learnings.html`.
6. **PLAN:** flip the relevant task's `data-status` in `brain/project/index.html`. Progress is
   derived; never type a number. Append a task or initiative if the work was new.

Keep the result link-never-copy and preserve the `.entry` grammar: `data-cid` mirrored to `id`,
`data-kind`, `data-status`, `data-date`, at least one `data-ref`, and optional `data-lens`. Verify
that `#brain-state` still parses and new links resolve, then commit.
