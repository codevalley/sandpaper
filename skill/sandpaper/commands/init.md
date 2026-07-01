---
description: Scaffold a living Sandpaper brain for this repo — discover widely, run a wizard, generate
---

Build a living project brain (`brain/`) for this repo. Five movements: **INTRODUCE**, **DISCOVER**
(scan widely), **WIZARD** (interactive — fill the gaps + shape the brain), **GENERATE**, **WELCOME**.

## 0. INTRODUCE — a premium, human welcome (then a go-ahead gate)
Make the first impression feel crafted, not chatty. **Open with the banner, printed verbatim in a code block:**

```
  ___                _
 / __| __ _ _ _  __| |_ __  __ _ _ __  ___ _ _
 \__ \/ _` | ' \/ _` | '_ \/ _` | '_ \/ -_) '_|
 |___/\__,_|_||_\__,_| .__/\__,_| .__/\___|_|
                     |_|        |_|
        refine on the page
```

Then a **short, warm, plain-language** intro — no jargon, no wall of text. In ~3 lines the owner
actually cares about:
- **What you'll get** — a living "brain" for this repo: a small local website that shows what the
  project is, its plan, the decisions, and its history — and stays current as you work. Your project,
  made legible at a glance.
- **What happens now** — I skim the repo, ask you a few quick questions, then build it.
- **You're in control** — stop me anytime; it's all local files, nothing leaves your machine.

Keep it human and brief — a welcome, not a manual.

Then **gate on a go-ahead with the AskUserQuestion tool** (never plain prose — it breaks the flow and
forces typing). Do a quick, cheap size read first (count source files, list top dirs — don't read
everything). **Be honest about time:** building a real brain is a lot of writing, so even a SMALL repo
is roughly **15–30 minutes** and a fair chunk of tokens; bigger repos take longer — never lowball it.
Ask: header "Build it?", question e.g. *"~N source files. Building the brain runs ~15–30 min and uses
a fair few tokens — a one-time setup. Go?"*, options **Build it** · **Scope it down (just code)** ·
**Not now**. Begin DISCOVER only once they pick; honor a scoped choice.

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
external links). Then run a brief wizard — **use the AskUserQuestion tool for the shaping choices**
(lenses, books, theme, phases), not a wall of prose; ask in small batches:

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
- A **port** — if they run Sandpaper for several repos at once, suggest pinning a distinct
  `port` in `.sandpaper/manifest.json` (default 4848; the server auto-bumps if it's taken).

Keep it to ~5–8 questions total; infer everything else.

## 3. GENERATE — seeded with REAL content, shaped by the answers
The design-system assets are **already in `brain/assets/`** (`theme.css` + `brain.css` + `brain.js`) —
`install-skill` scaffolded them from the Sandpaper package, along with a starter `brain/index.html`.
**Use them as-is.** Do NOT regenerate the assets, and **NEVER read, copy, or take templates / a
reference brain from any other directory or sibling project on disk** — that's someone else's repo,
not the Sandpaper package, and it won't exist on a distributed install. If `brain/assets/` is somehow
missing, stop and run `npx sandpaper init` (or ask the owner for the package path) — never go hunting.

Build the cover (including the `<!-- BRAIN:CANVAS -->` canvas region) and the chosen books with the
`.entry` grammar (`data-cid`→`id`, `data-kind`, `data-status`, `data-date`, ≥1 `data-ref`,
optional `data-lens`). **Link, never copy** — `data-ref` points at the real artifacts you
discovered (a spec's heading anchor if it has one, else the source file / README section). Generate
ONLY the lenses + books the owner chose; dim any deferred chrome so nothing dangles. Seed the plan
board from the discovered state (shipped = `done`; gaps between the code and the README/spec = the
honest backlog), the log from the git history, and the decisions/learnings books from anything
already written down. **Keep the scaffolded canvas** on the cover as-is — the `<!-- BRAIN:CANVAS -->`
region with its plain-language empty state; don't rewrite that copy into jargon (it fills with boards
as you work). Stamp the first log row, verify the `#brain-state` JSON parses and links resolve.

## 4. WELCOME — a tight close, then OPEN it (the money shot)
Don't spread this into blabber. A short, confident close, then the payoff:
- **One line of what got built** — e.g. *"Your brain is live: a cover, 3 lenses, and 4 books, all
  seeded from the real repo."*
- **One line on using it** — refine on the page with **Sand** (say a change) · **✎ Hands** (edit
  directly) · **❯ Sling** (hand a job to the terminal); it also stays current on its own as you work.

Then **OPEN it yourself — the payoff must not be left to chance.** Serve the brain + open the browser
by running the `open` command **in the background** (so it keeps serving without blocking the turn):
read the `pkg` in `.sandpaper/manifest.json` and run `node <pkg>/bin/cli.js open` in the background
(or `sandpaper open` if it's on PATH). It opens their browser on the brain and greets them with the
one-time tour. Actually do it — don't just suggest it; if it genuinely can't run, hand them the one
exact command.

Keep the whole close under ~8 lines. `/sandpaper:help` lists every command. If you didn't commit
(e.g. a branch rule you discovered), offer that as the very last line.
