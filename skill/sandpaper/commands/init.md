---
description: Scaffold a new Sandpaper brain for this repository
---

Create a living project brain (`brain/`) for this repo, following the Sandpaper layout
(`skill/sandpaper/SKILL.md`). Work in four steps:

1. **HARVEST** — read the repo: `package.json`/README/source layout, the recent `git log`, and any
   specs or docs. Infer the project's name, what it is, its components + their status, and the
   recent work. Don't ask for what you can read.
2. **INTERVIEW** — ask the owner 3–5 short questions ONLY for what you can't infer: the current
   focus, near-term goals, and any open decisions/risks.
3. **GENERATE** — write the brain seeded with REAL harvested content:
   - `brain/index.html` (cover: a `#brain-state` digest, the NOW line, derived progress, needs-you,
     latest), `brain/assets/theme.css` + `brain.css` + `brain.js`.
   - Lenses: `product/`, `engineering/`, and `project/index.html` (the plan board — initiatives →
     tasks, grouped by `data-phase`, progress derived).
   - Books: `log.html`, `decisions.html`, `learnings.html`.
   Use the `.entry` grammar everywhere; **link, never copy** (point at canonical docs). Stamp the
   first log row.
4. **OFFER** — point them at `npx sandpaper brain/` to serve it with the on-page toolbar, and the
   opt-in auto-update hooks (`SKILL.md` → Auto-update).
