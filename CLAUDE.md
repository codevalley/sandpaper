# Sandpaper

Local tool that lets you refine a Claude-generated HTML document **in the browser**:
a small bridge drives `claude -p` to edit the file on disk, and the page live-reloads.
The product spec is `sandpaper.html` (open it — it's a Sandpaper document).

## Run
```
node bin/cli.js sandpaper.html      # serves http://127.0.0.1:4848
npm test                            # parser checks (no live model call)
```

## Layout
- `bin/cli.js` — CLI entry (`sandpaper <doc.html>`)
- `src/server.js` — HTTP server: serves the doc (toolbar injected), `/__sandpaper/turn`, SSE `/__sandpaper/events`, file-watch reload
- `src/claude.js` — spawns `claude -p` in stream-json mode, maps events → status, persists the session id
- `public/toolbar.js` / `.css` — on-page overlay (status chip, prompt box, click-to-scope)
- `test/` — recorded stream sample + parser test

## Conventions
- **Zero runtime dependencies.** Node ≥18 built-ins only (`http`, `child_process`, `fs`). ESM.
- The **document on disk is the single source of truth** — both the user (direct edits) and Claude (Edit/Write) mutate the same file; the page reflects disk, never ahead of it.
- The bridge is a dumb pipe: Claude edits the file with its tools; the watcher triggers reload. Never assemble HTML from stdout.
- Bind to `127.0.0.1` only.

## Roadmap
P0 (now): the spine — serve+inject, claude round-trip, live reload, status chip, click-to-scope.
P1: direct manipulation (drag/delete → file write, no AI) + paste-a-screenshot.
P2+: durable `data-cid` anchoring, branching, long-lived watch session. See `sandpaper.html` §06.

## The project brain — stamp it after every substantive turn (NOT optional)

The living brain is `brain/index.html` (the cover) plus `brain/log.html`, `brain/decisions.html`, `brain/map.html`, `brain/learnings.html`. After ANY turn that changed a decision, a component's status, an open question, a gotcha, or build progress, perform the **STAMP** — a fixed, templated checklist. Never free-form. Never copy prose from `sandpaper.html` / `engg-spec.html` — **LINK** to their `#data-cid` anchors with a short `data-ref`.

1. **LOG** — Prepend exactly one templated row to the top of `brain/log.html`:
   `<li class="entry entry--worklog" data-kind="worklog" id="w-NNNN" data-cid="w-NNNN" data-date="YYYY-MM-DD" data-ref="<canonical>#<anchor>"><span class="log-when">MM-DD</span><span class="log-what">…</span><span class="log-link"><a class="ref" href="…">→</a></span></li>`
   Summary verb-led, ≤12 words, ends in a link. Never edit a prior row.
2. **NOW** — In `brain/index.html`, overwrite the whole `<!-- BRAIN:NOW -->…<!-- /BRAIN:NOW -->` region with ONE present-tense sentence (≤120 chars) + a link to what you are touching. Replace, never append. One focus only — NOW is not a backlog.
3. **DIGEST** — Overwrite the `<script type="application/json" id="brain-state">` block at the top of `brain/index.html` so `focus`, the newest `worklog` line, and the `open` list match what you just did. This is the first thing a fresh `claude` reads to rehydrate.
4. **DECISIONS** — If a call was made or a question opened/resolved: APPEND a status-typed `<article class="entry entry--decision|entry--question" data-status="…">` to `brain/decisions.html`, or flip ONE existing `data-status`. A reversal is a NEW entry with `data-rel="supersedes:<id>"` — never rewrite the old one.
5. **LEARNINGS** — If a gotcha bit, append one `<aside class="entry entry--learning callout">` to `brain/learnings.html`.
6. **MAP** — If a module was added/renamed or changed build status, edit that component card's `data-status` + badge in `brain/map.html`.
7. **CANVAS (board-first)** — When your reply would be a substantial summary or explanation, the **board IS the reply** (not an afterthought): write the elevated version as the **current board** in the `<!-- BRAIN:CANVAS -->` region of `brain/index.html` (the `.whiteboard`) — replace the live `<article class="board board--live">`, demote the previous current to the top of `.canvas-earlier` as a collapsed `<details class="board board--past">`, cap the stack at 5, update `canvas-count` + the `Earlier · N` label — and leave only a one-line `📋 … → on the canvas` pointer in the terminal. Don't write it twice. Short answers, confirmations, and back-and-forth stay in the terminal. This is a default, not a hard lock (boarding a judgment can't be enforced like stamping); the pointer is the tripwire — no pointer means nothing was boarded.

**Rules.** Regenerate whole regions/blocks — never prose-edit inside one. Every block carries `data-cid` (mirrored to `id`), `data-kind`, `data-status`, `data-date`, and at least one `data-ref` into a canonical anchor; a linkless or >2-sentence block is wrong. **Budget: 1 cover + 4 books — do NOT add pages or top-level sections; new info becomes an `entry` in an existing book.** Counts/freshness are derived by the dev sidecar — leave them as-is when running without it rather than guessing. Roadmap and risks are canonical in `sandpaper.html` §06/§07 — link them, never restate. The brain is the **eyes** (state to consult); steering stays in the terminal (the **mouth**).

**The wiki** (`brain/wiki/`) is a SECOND layer with a lighter cadence — it is NOT part of the per-turn stamp. Regenerate a whole wiki section only when the capability / architecture / tech-choice it describes actually changes. The wiki holds real readable prose (it's the canonical "understand the project" docs); the living books keep link-never-copy.

**Refining the brain in-house:** `node bin/cli.js brain/` serves the brain with the on-page toolbar — **Sand** refines one page in place (scoped, single-file); **⇥ Sling** copies a terminal-ready instruction for cross-cutting / multi-file work. Run from the repo root (`node bin/cli.js .`, open `/brain/index.html`) if you also want the `spec ↗` / `engg ↗` links to resolve while serving.
<!-- sandpaper:begin -->
## Sandpaper project brain

Repository files are the shared truth for implementation and rendered output. `brain/` is the shared truth for durable intent, decisions, plans, progress, work history, and learnings.
Read `brain/index.html` first. Enter through `/sandpaper:<action>` when working with the shared brain.
<!-- sandpaper:end -->