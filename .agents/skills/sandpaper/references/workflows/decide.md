# Decide workflow

Append the decision or question described by the remaining user arguments to
`brain/decisions.html`.

Use `<article class="entry entry--decision" data-kind="decision" data-status="accepted" data-date
data-ref data-lens id="d-…" data-cid="d-…">` with **Decision / Because / Instead-of** fields and a
link to the canonical anchor. Use the next monotonic `D-NNN` identifier.

- To resolve a question, flip its `data-status`.
- To reverse a prior call, append a new entry with `data-rel="supersedes:<id>"`; never rewrite the
  old entry.

Then execute the canonical `log` workflow and increment the cover's `<b data-count="decision">`
count.
