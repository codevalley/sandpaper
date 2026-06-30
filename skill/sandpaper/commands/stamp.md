---
description: Stamp the Sandpaper brain after a substantive turn (the 6-step update)
argument-hint: "[optional one-line summary of the turn]"
---

Update the project brain in `brain/` to reflect the work just done $ARGUMENTS. Follow the STAMP
contract exactly (`skill/sandpaper/SKILL.md` → STAMP / the project's CLAUDE.md). Do every step
that applies, regenerating WHOLE regions — never prose-edit inside one:

1. **LOG** — prepend exactly one `<li>` row to the top of `brain/log.html` AND the cover's
   `<!-- BRAIN:LOG -->` feed. Verb-led, ≤12 words, ends in a link to a canonical anchor. Use the
   next monotonic `w-NNNN` cid. Never edit a prior row.
2. **NOW** — overwrite the cover's `<!-- BRAIN:NOW -->…` region with one present-tense sentence
   (≤120 chars) + a link to what you touched. Replace, never append.
3. **DIGEST** — overwrite `#brain-state` so `focus`, the newest worklog line, and `open` match.
4. **DECISIONS** — if a call was made or a question opened/resolved, append a status-typed
   `.entry` to `brain/decisions.html` (or flip ONE `data-status`). A reversal is a NEW entry with
   `data-rel="supersedes:<id>"` — never rewrite the old one.
5. **LEARNINGS** — if a gotcha bit, append one callout to `brain/learnings.html`.
6. **PLAN** — flip the relevant task's `data-status` in `brain/project/index.html`. Progress is
   DERIVED — never type a number. Append a task/initiative if the work was new.

Keep it link-never-copy and respect the `.entry` grammar (data-cid→id, data-kind, data-status,
data-date, ≥1 data-ref, optional data-lens). Then verify `#brain-state` still parses and the new
links resolve, and commit.
