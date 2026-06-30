---
description: Elevate an explanation into a rich board on the cover's canvas (not the terminal)
---

Write the current (or named) summary/explanation as a **board** on the cover's canvas — the
`<!-- BRAIN:CANVAS -->` region of `brain/index.html`, a white `.whiteboard` container — instead of
leaving it in the terminal. The terminal steers; the canvas shows.

A board is freeform, self-contained, **theme-skinned** rich HTML: lead with the point, then make it
*visual* where that helps — a CSS/SVG diagram, a comparison table, code, a side-by-side. It is NOT
the `.entry` grammar (boards are working output; lavish is fine), but it must use the project's
theme classes so it matches the rest of the surface.

The canvas is a **whiteboard, not a notebook**: the newest board is the CURRENT one (full + live);
older boards fold into a collapsed *Earlier* stack, capped at five.

Steps:
1. The new board becomes the CURRENT one — replace the `<article class="board board--live"
   data-cid="board-NNNN" data-kind="board" data-date="YYYY-MM-DD" data-ref="<source>">` inside
   `.whiteboard`, with a `.board-head` (dot · title · `MM-DD · board NNN`), a rich `.board-body`, and a
   `.board-foot`.
2. Move the previously-current board to the TOP of the `.canvas-earlier` list (below the whiteboard) as
   a collapsed `<details class="board board--past"><summary class="board-row">…dot · `MM-DD · NNN` · title · ›…</summary>…body + foot…</details>`.
   Remove any `.canvas-empty` placeholder.
3. Cap the stack at **5 boards total** — drop the oldest `<details>`. Update the `canvas-count` and
   the `Earlier · N` label.
4. In the terminal, leave one line: `📋 <gist> → on the canvas`.

Keep boards for things worth a second screen (architecture, comparisons, walkthroughs, analyses);
short answers stay in the terminal. Durable boards are **promoted** into the brain later via the
STAMP — the canvas never writes straight into the wiki or decisions.
