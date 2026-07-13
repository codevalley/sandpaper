# Canvas workflow

Use the remaining user arguments as the named topic when present. Write the current or named
summary/explanation as a **board** on the cover's canvas: the `<!-- BRAIN:CANVAS -->` region of
`brain/index.html`, inside the white `.whiteboard` container. The terminal steers; the canvas shows.

A board is freeform, self-contained, **theme-skinned** rich HTML. Lead with the point, then make it
visual where useful with a CSS/SVG diagram, comparison table, code, or side-by-side. A board does not
use the `.entry` grammar because boards are working output, but it must use the project's theme classes.

The canvas is a **whiteboard, not a notebook**: the newest board is current, full, and live. Older
boards fold into a collapsed *Earlier* stack capped at five boards total.

1. Make the new board current by replacing the `<article class="board board--live"
   data-cid="board-NNNN" data-kind="board" data-date="YYYY-MM-DD" data-ref="<source>">` inside
   `.whiteboard`. Include a `.board-head` with dot, title, and `MM-DD · board NNN`, a rich
   `.board-body`, and a `.board-foot`.
2. Move the previously current board to the top of `.canvas-earlier`, below the whiteboard, as a
   collapsed `<details class="board board--past">`. Its `.board-row` summary includes the dot,
   `MM-DD · NNN`, title, and chevron; retain its body and foot. Remove any `.canvas-empty` placeholder.
3. Keep at most five boards total by dropping the oldest `<details>`. Update `canvas-count` and the
   `Earlier · N` label.
4. Leave one terminal line: `📋 <gist> → on the canvas`.

Use boards for architecture, comparisons, walkthroughs, analyses, and other material worth a second
screen. Short answers stay in the terminal. Promote durable boards into the brain later by executing
the canonical `stamp` workflow; the canvas never writes directly into the wiki or decisions.
