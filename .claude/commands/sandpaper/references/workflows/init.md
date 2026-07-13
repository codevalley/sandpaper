# Init workflow

Build a living project brain in `brain/` for the repository. Use five movements:
**INTRODUCE**, **DISCOVER**, **WIZARD**, **GENERATE**, and **WELCOME**.

## 0. Introduce — crafted welcome and go-ahead gate

Open with this banner verbatim in a code block:

```text
  ░█▀▀░█▀█░█▀█░█▀▄░█▀█░█▀█░█▀█░█▀▀░█▀▄
  ░▀▀█░█▀█░█░█░█░█░█▀▀░█▀█░█▀▀░█▀▀░█▀▄
  ░▀▀▀░▀░▀░▀░▀░▀▀░░▀░░░▀░▀░▀░░░▀▀▀░▀░▀
        refine on the page
```

Follow with a short, warm, plain-language introduction of about three lines:

- What the owner gets: a living local website showing what the project is, its plan, decisions,
  and history, kept current as work continues.
- What happens next: skim the repository, ask a few quick questions, then build it.
- The owner remains in control: they may stop at any time; all files stay local and nothing leaves
  the machine.

Before asking for approval, make a quick, cheap size estimate by counting source files and listing
top-level directories; do not read everything yet. Be honest that even a small repository normally
takes roughly **15–30 minutes** and a fair amount of tokens, with larger repositories taking longer.

Use the native structured user-input/confirmation mechanism for a go-ahead gate. Use header
`Build it?`, a question such as `~N source files. Building the brain runs ~15–30 min and uses a fair
few tokens — a one-time setup. Go?`, and choices **Build it**, **Scope it down (just code)**, and
**Not now**. Begin discovery only after approval and honor the scoped choice.

## 1. Discover — scan widely and classify by content

Projects use varied layouts, so do not assume fixed paths. Search broadly for `**/*.md`, `docs/**`,
`spec/**`, `rfc*/**`, `adr/**`, and `design/**`. Read the relevant results and group them by content:

- **Code:** manifest such as `package.json`, `pyproject.toml`, `go.mod`, or `Cargo.toml`; entry
  points; source layout and module graph; tests; build and CI configuration.
- **Specs and design:** spec-shaped documents, RFCs, ADRs, architecture documents, and design docs.
- **Work history and plans:** changelog, TODO, roadmap, notes, git log, and issue or pull-request
  references in commit messages.
- **Meta:** README, contributing guide, documentation site, and license.
- **External pointers:** links to a wiki, design file, issue tracker, or other external source. Note
  inaccessible sources and raise them in the wizard.

Infer the project name and purpose, components and status, recent work, apparent roadmap, and any
decisions or gotchas already recorded.

## 2. Wizard — fill gaps and shape the brain

Show a short grouped discovery summary covering code, specs, logs, docs, and external links. Use the
native structured user-input/confirmation mechanism for shaping choices, in small batches rather
than one wall of prose.

First ask what discovery missed: where the spec, design, or roadmap lives and whether external docs
need to be folded in manually. Let the owner point to missed artifacts and paste or summarize sources
that cannot be reached.

Then confirm the brain's shape without imposing the entire template:

- Which lenses matter: product, engineering, project plan board, a subset, or a custom lens?
- Which books matter: decisions, learnings, glossary, stats? Default to decisions, learnings, and log.
- What are the current focus, near-term goals, and open decisions or risks not already inferred?
- What brand colour should skin it, or should it use the warm default?
- Does the owner organize work into phases, milestones, or rungs for the plan board?
- Should `.sandpaper/manifest.json` pin a distinct port for concurrent repositories? The default is
  4848 and the server auto-increments when occupied.

Ask about five to eight questions total and infer everything else.

## 3. Generate — real content shaped by the answers

The design-system assets already exist at `brain/assets/`: `theme.css`, `brain.css`, and `brain.js`.
The installation also scaffolded `brain/index.html`. Use those assets as-is. Do not regenerate them,
and never read, copy, or use a template or reference brain from another directory or sibling project.
If `brain/assets/` is missing, stop and run `npx sandpaper init`, or ask the owner for the package
path; never hunt elsewhere.

The multi-page skeleton already contains the cover, `product/index.html`,
`engineering/index.html`, `project/index.html`, `log.html`, `decisions.html`, and `learnings.html`,
with shared-shell navigation using relative paths. Fill the existing pages by replacing `<!-- FILL:
… -->` stubs with real content.

Keep the brain multi-page: every lens and book remains a separate HTML file. Never collapse it into
one page or replace navigation with in-page anchors. Use the `.entry` grammar: `data-cid` mirrored to
`id`, `data-kind`, `data-status`, `data-date`, at least one `data-ref`, and optional `data-lens`. Link,
never copy: `data-ref` points to a discovered source artifact, preferably a heading anchor and
otherwise the source file or README section.

Generate only the chosen lenses and books; dim deferred chrome so nothing dangles. Seed the plan
board from reality: shipped work is `done`, while gaps between code and README or specs become the
honest backlog. Seed the log from git history and the decisions and learnings books from existing
evidence. Keep the scaffolded `<!-- BRAIN:CANVAS -->` region and its plain-language empty state
unchanged. Stamp the first log row, verify that `#brain-state` JSON parses, and verify links resolve.

## 4. Welcome — concise close and open the result

Keep the close under about eight lines:

- One line describing what was built, such as `Your brain is live: a cover, 3 lenses, and 4 books,
  all seeded from the real repo.`
- One line explaining on-page use: **Sand** requests a change, **✎ Hands** edits directly, and
  **❯ Sling** hands a terminal-ready task back to the terminal; the brain also stays current as work
  continues.

Then execute the canonical `open` workflow in the background so serving does not block the turn.
Read `pkg` from `.sandpaper/manifest.json` and run `node <pkg>/bin/cli.js open` in the background, or
use `sandpaper open` when it is on `PATH`. Do this directly rather than merely suggesting it. If it
cannot run, provide the owner one exact command.

Mention that the canonical `help` workflow lists every action. If no commit was made because of a
repository rule discovered during setup, offer the commit as the final line.
