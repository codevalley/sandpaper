---
name: sandpaper
description: >-
  Use when working in a repo that has (or should have) a Sandpaper "project brain" — a
  brain/ folder of static HTML that is a living service-manual mirroring the project's
  state. Invoke to STAMP the brain after substantive turns (log the work, refresh the
  digest, flip plan tasks, record decisions/learnings), to scaffold a new brain, to serve
  it, or to re-skin it. Keeps the brain current and link-never-copy.
---

# Sandpaper — the living project brain

Sandpaper turns a project's state into a navigable, always-current web **service manual**
(`brain/`) that the agent maintains. A fresh `claude` reads the brain to rehydrate; after
each substantive turn the agent **stamps** it. The brain is the **eyes** (state made
visible); steering stays in the terminal (the **mouth**).

## Layout
- `brain/index.html` — the cover/portal: a `#brain-state` JSON **digest** (read first), the
  **NOW** line, derived progress, **needs-you**, **latest**.
- Lenses: `product/`, `engineering/`, `project/` (the **plan board**) — the prose home per lens.
- Books: `log.html` (work log), `decisions.html` (ledger), `learnings.html` (gotchas), `wiki/`.
- `assets/theme.css` — one file re-skins everything; `assets/brain.js` derives all numbers.

## Grammar
Every durable fact is an `.entry` carrying `data-cid` (mirrored to `id`), `data-kind`,
`data-status`, `data-date`, at least one `data-ref` into a canonical anchor, and an optional
`data-lens`. **Link, never copy** — point at the canonical doc; don't restate it (the wiki is
the one prose exception). Every block carries `data-cid`; an agent must never strip cids.

## STAMP — after every substantive turn (not optional)
Templated, never free-form. Regenerate whole regions; never prose-edit inside one.
1. **LOG** — prepend exactly one row to the top of `log.html` (verb-led, ≤12 words, ends in a
   link). Never edit a prior row.
2. **NOW** — overwrite the cover's `<!-- BRAIN:NOW -->…` region with one present-tense
   sentence (≤120 chars) + a link to what you touched. Replace, never append.
3. **DIGEST** — overwrite `#brain-state` so `focus`, the newest worklog line, and `open` match.
4. **DECISIONS** — if a call was made/resolved: append a status-typed entry, or flip ONE
   `data-status`. A reversal is a NEW entry with `data-rel="supersedes:<id>"` — never rewrite.
5. **LEARNINGS** — if a gotcha bit, append one callout.
6. **PLAN** — flip the relevant task's `data-status`; progress **derives** (never type a number).
7. **CANVAS** — if the turn produced a substantive summary or explanation, lay it as the current
   board on the whiteboard (see below) — demote the previous current into *Earlier*, cap at 5. This
   is how the canvas stays current **without relying on memory**: it rides the same enforced routine.

## CANVAS — elevate the turn's summary / substantial explanations onto the cover (not the scrollback)
The cover hosts a **canvas** (the `<!-- BRAIN:CANVAS -->` region of `index.html`): a **whiteboard** —
a white `.whiteboard` container whose content scrolls inside it. The newest board sits full and live
in the whiteboard; older ones fold into a collapsed *Earlier* stack below it (normal page flow). When
you'd otherwise write a substantial summary or explanation in the terminal — the recap of a turn, an
architecture, a comparison, a walkthrough, an analysis — write the *elevated* version as the current
board instead, and leave the terminal one line pointing at it. The terminal **steers**; the canvas **shows**.

- **A board** is freeform, self-contained, theme-skinned rich HTML (SVG/CSS diagrams, tables, code,
  side-by-sides — the things that die in a terminal). NOT the `.entry` grammar — boards are working
  output; lavish is fine.
- **To add one:** the new board becomes the CURRENT one — replace the `<article class="board board--live"
  data-cid="board-NNNN" …>…</article>` inside `.whiteboard`. Move the previously-current board to the
  TOP of the `.canvas-earlier` list (below the whiteboard) as a collapsed `<details class="board board--past">
  <summary class="board-row"><span class="board-row-dot"></span><span class="board-row-when">MM-DD · NNN</span><span
  class="board-row-title">…</span><span class="board-row-chev">›</span></summary>…body + foot…</details>`.
  Cap the stack at **5 total** — drop the oldest `<details>`. Update the `canvas-count` and the
  `Earlier · N` label. Then in the terminal: `📋 <gist> → on the canvas`.
- **When NOT to:** short answers, direct edits, confirmations, lookups — those stay in the terminal.
  Don't over-produce; a board is for something worth a second screen.
- **Canvas → brain.** Boards are the *working* layer; the brain (wiki/decisions/learnings) is the
  *settled* layer. Promote a board only when it proves durable — via the STAMP — and never write
  live explanations straight into the wiki. `/sandpaper:canvas <topic>` forces a board on demand.

## Plan model
`phase → initiative → task → session`. Initiatives carry `data-phase`; tasks carry
`data-initiative`/`data-status`/`data-session`. `brain.js` sums task status into the
initiative, phase, and overall bars. The only operations: FLIP a task's status, APPEND a
task/initiative, STAMP a session. Never reuse a cid; re-scope = append + flip the old one.

## Auto-update — the brain stays current without prodding
Two Claude Code hooks (scripts in `bin/`):
- **SessionStart → `bin/brain-inject.js`** — surfaces the digest so a fresh session
  rehydrates from the brain automatically.
- **Stop → `bin/brain-stamp-check.js`** — if a turn changed project files but didn't touch
  `brain/`, it **blocks once** with a reminder to STAMP. Self-limiting: it honors
  `stop_hook_active` (never loops), is idempotent (stops firing once `brain/` is touched), and
  the agent can override by simply stopping again.

Enable by merging into `.claude/settings.json` (project) or `~/.claude/settings.json` (user):

```json
{
  "hooks": {
    "SessionStart": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node bin/brain-inject.js", "timeout": 10 }] }],
    "Stop":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node bin/brain-stamp-check.js", "timeout": 20 }] }]
  }
}
```

Remove either entry to disable. This is the difference between the brain being a discipline
you might forget and a system that cannot silently drift.

## Commands
`/help` (this list) · `/init` (harvest → interview → generate a brain) · `/stamp` (the 6-step
stamp) · `/canvas` (elevate an explanation into a board on the cover) · `/plan` · `/decide` ·
`/learn` · `/log` · `/sync` (reconcile + heal drift) ·
`/open` (serve + open the brain in a browser) · `/serve` (on-page refine toolbar) · `/theme`
(re-skin from a brand hex). Run `/sandpaper:help` for the full grouped list.

## Serve / refine in place
`npx sandpaper <dir>` serves the brain with an on-page toolbar — **Sand** (scoped AI edit),
**✎ Hands** (direct edit, no AI), **❯ Sling** (hand a terminal-ready instruction over).
