---
description: Add or update a task/initiative on the Sandpaper plan board
argument-hint: "flip t-NNNN done | add \"<task>\" to <initiative> | new initiative \"<name>\" in phase <0|1>"
---

Update `brain/project/index.html` per: $ARGUMENTS.

- **FLIP a task** = change ONE `data-status` (todo→doing→done|blocked). On `done`, set
  `data-session` and prepend a log row.
- **ADD a task** = next monotonic `t-NNNN` under the right `data-initiative`, status `todo`.
- **ADD an initiative** = a new `.entry--initiative` with `data-phase`, `data-lens="project"`, and
  an empty `data-rollup` / `data-progress` (brain.js fills them).

Never reuse a cid; re-scoping = append a new task + flip the old one to done/blocked. Never type a
progress number — `brain.js` derives every bar from task status. Then run the rest of the STAMP if
the turn was substantive (`/sandpaper:stamp`).
