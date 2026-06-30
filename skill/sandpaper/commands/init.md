---
description: Scaffold a living Sandpaper brain for this repo — discover widely, run a wizard, generate
---

Build a living project brain (`brain/`) for this repo in three movements: **DISCOVER** (scan the
whole repo, not just code), **WIZARD** (interactive — fill the gaps + shape the brain), **GENERATE**.

## 1. DISCOVER — cast a wide net; classify by content, not filename
Projects are organised every which way, so don't assume fixed paths. Glob broadly
(`**/*.md`, `docs/**`, `spec/**`, `rfc*/**`, `adr/**`, `design/**`), read what you find, and group it:

- **Code** — the manifest (`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / …), entry
  points, the source layout + module graph, tests, the build/CI config.
- **Specs & design** — `SPEC*.md`, RFCs, ADRs (`docs/adr/`, `decisions/`), `ARCHITECTURE.md`,
  design docs, anything spec-shaped by its contents.
- **Work history & plans** — `CHANGELOG.md`, `TODO.md`, `ROADMAP.md`, `NOTES`, the `git log`, and
  any issue/PR references in commit messages.
- **Meta** — `README`, `CONTRIBUTING`, a `docs/` site, the `LICENSE`.
- **External pointers** — links in the README/docs to a Notion / wiki / Figma / issue tracker. You
  can't read those; note them and raise them in the wizard.

From all of it infer: the project's name + what it is, its components + their status, the recent
work, the apparent roadmap, and any decisions/gotchas already written down somewhere.

## 2. WIZARD — interactive; never guess what you can ask
Show the owner a short summary of what you found, **grouped** (code · specs · logs · docs ·
external links). Then run a brief wizard — ask in small batches, not a wall:

**a. Fill discovery gaps.** "Did I miss anything? Where's your spec / design / roadmap if I didn't
find it? Any external docs (Notion / wiki / Figma) I should fold in by hand?" Let them point you at
artifacts the scan missed — and paste/summarise anything you can't reach.

**b. Shape the brain** — confirm what *this* project's brain should hold (don't impose the full
template):
- Which **lenses** matter — product, engineering, project (the plan board), a subset, or a custom one?
- Which **books** — decisions, learnings, a glossary, a stats page? (default: decisions + learnings + log)
- The current **focus**, near-term **goals**, and any **open decisions/risks** you couldn't infer.
- A **theme** — a brand colour to skin it (else the warm default)?
- Do they think in **phases / milestones / rungs**? (to seed the plan board's grouping)

Keep it to ~5–8 questions total; infer everything else.

## 3. GENERATE — seeded with REAL content, shaped by the answers
Write the brain from the shipped templates (`theme.css` + `brain.css` + `brain.js` copied verbatim)
and the `.entry` grammar (`data-cid`→`id`, `data-kind`, `data-status`, `data-date`, ≥1 `data-ref`,
optional `data-lens`). **Link, never copy** — `data-ref` points at the real artifacts you
discovered (a spec's heading anchor if it has one, else the source file / README section). Generate
ONLY the lenses + books the owner chose; dim any deferred chrome so nothing dangles. Seed the plan
board from the discovered state (shipped = `done`; gaps between the code and the README/spec = the
honest backlog), the log from the git history, and the decisions/learnings books from anything
already written down. Stamp the first log row, verify the `#brain-state` JSON parses and links
resolve, then offer `/sandpaper:open` to view it.
