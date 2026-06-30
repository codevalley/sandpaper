---
description: Scaffold a living Sandpaper brain for this repo — discover widely, run a wizard, generate
---

Build a living project brain (`brain/`) for this repo. Five movements: **INTRODUCE**, **DISCOVER**
(scan widely), **WIZARD** (interactive — fill the gaps + shape the brain), **GENERATE**, **WELCOME**.

## 0. INTRODUCE — orient the owner before the (long) run
This command reads a lot and runs for a while, so don't dive in cold. Open with a short, friendly
framing (3–4 lines) so the owner knows what they've started:
- **What Sandpaper is** — a living project *brain*: a small, navigable web "service manual" that
  mirrors this project's state (what it is, the plan, decisions, the work log) and that you, the
  agent, keep current after each working turn — so the project never drifts out of sync with its docs.
- **What this command will do now** — scan the repo widely (code · specs · logs · docs), show you
  what it found, ask a handful of questions, then generate the brain. It reads a lot, **so it takes
  a few minutes and a fair chunk of tokens** — a one-time cost.
- **You're in control** — they can stop you at any point, and nothing is published anywhere.

Then begin the harvest.

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
already written down. Stamp the first log row, verify the `#brain-state` JSON parses and links resolve.

## 4. WELCOME — close the loop; don't just stop
After it's generated, give the owner a short, warm close so the payoff is obvious and they know what
to do next. Keep it to a handful of lines:
- **See it** — `npx sandpaper open` (or `/sandpaper:open`) serves the brain and opens it in a
  browser. The first visit greets them with a one-time tour of the page.
- **Refine it right on the page** — the on-page toolbar has three tools: **Sand** (say a change in
  plain words → the agent edits the file, scoped to what you clicked), **✎ Hands** (edit text, drag
  to reorder, or delete — directly, no AI), and **❯ Sling** (copy a terminal-ready instruction for
  bigger, cross-file work). Suggest a concrete first move: *re-skin it to your brand* with
  `/sandpaper:theme #yourhex`, or tweak the NOW line in place with Hands.
- **It stays current on its own** — the auto-update hooks stamp the brain as you work; or drive it
  by hand with `/sandpaper:stamp`, `/sandpaper:plan`, `/sandpaper:decide`, `/sandpaper:sync`.
- **Everything else** — `/sandpaper:help` lists every command.
