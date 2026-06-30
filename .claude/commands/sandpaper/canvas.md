---
description: Elevate an explanation into a rich board on the cover's canvas (not the terminal)
---

Write the current (or named) explanation as a **board** on the cover's canvas — the scrollable feed
in the `<!-- BRAIN:CANVAS -->` region of `brain/index.html` — instead of leaving it in the terminal.
The terminal steers; the canvas shows.

A board is freeform, self-contained, **theme-skinned** rich HTML: lead with the point, then make it
*visual* where that helps — a CSS/SVG diagram, a comparison table, code, a side-by-side. It is NOT
the `.entry` grammar (boards are working output; lavish is fine), but it must use the project's
theme classes so it matches the rest of the surface.

Steps:
1. Prepend `<article class="board board--live" data-cid="board-NNNN" data-kind="board"
   data-date="YYYY-MM-DD" data-ref="<source>">` to the top of the `BRAIN:CANVAS` feed (`.canvas-feed`),
   with a `.board-head` (dot · title · `MM-DD · board NNN`), a rich `.board-body`, and a `.board-foot`.
2. Drop `board--live` from the previously-newest board; remove any `.canvas-empty` placeholder.
3. Update the `data-cid="canvas-count"` label (e.g. `3 boards`).
4. In the terminal, leave one line: `📋 <gist> → on the canvas`.

Keep boards for things worth a second screen (architecture, comparisons, walkthroughs, analyses);
short answers stay in the terminal. Durable boards are **promoted** into the brain later via the
STAMP — the canvas never writes straight into the wiki or decisions.
