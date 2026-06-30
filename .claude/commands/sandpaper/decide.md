---
description: Record a decision (or open/resolve a question) in the brain ledger
argument-hint: "<the decision, and why>"
---

Append a decision to `brain/decisions.html`: $ARGUMENTS.

Use the grammar: `<article class="entry entry--decision" data-kind="decision" data-status="accepted"
data-date data-ref data-lens id="d-…" data-cid="d-…">` with **Decision / Because / Instead-of**
fields and a link to the canonical anchor. Next monotonic `D-NNN`.

- To **resolve** a question, flip its `data-status`.
- To **reverse** a prior call, add a NEW entry with `data-rel="supersedes:<id>"` — never rewrite
  the old one.

Then LOG it (`/sandpaper:log`) and bump the cover's `<b data-count="decision">` count.
