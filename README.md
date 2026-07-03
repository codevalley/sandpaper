# Sandpaper

A **living project brain** for Claude Code projects. Sandpaper scaffolds a small static
site in `brain/` — a cover, three lenses (product / engineering / project), and three
books (log, decisions, learnings) — and teaches your agent to keep it current. After every
substantive turn, Claude *stamps* the brain: logs the work, refreshes the digest a fresh
session reads to rehydrate, flips plan tasks, records decisions and gotchas. The brain is
the **eyes** (state made visible); the terminal stays the **mouth** (steering). It never
copies your docs — every entry **links** to the canonical anchor in your spec or source.

No framework, no build step, no database. Plain HTML on disk, maintained by the agent,
readable by you.

## Quick start

```bash
# in your repo:
npx @nynb/sandpaper install-skill
```

Then, inside Claude Code:

```
/sandpaper:init      # discovers your repo, asks a few questions, fills the brain
```

And to view it:

```bash
npx @nynb/sandpaper open      # serves the repo + opens brain/index.html
```

(Or install straight from GitHub, no npm account needed: `npx github:codevalley/sandpaper install-skill`.)

## What you get

- **`brain/`** — a multi-page static site: a **cover** (`index.html`) with a
  machine-readable `#brain-state` digest, a one-line NOW, and derived progress;
  **lenses** (`product/`, `engineering/`, `project/` — the plan board); **books**
  (`log.html`, `decisions.html`, `learnings.html`). One `assets/theme.css` re-skins
  everything.
- **The canvas** — a whiteboard on the cover. When Claude produces an explanation worth
  keeping, it lands there as a readable board instead of scrolling past in the terminal
  (last 5 kept, older ones fold away).
- **The refine toolbar** — serve the brain (or any HTML doc) locally and get an on-page
  overlay: **Sand** (a scoped AI edit of the element you click), **Hands** (direct edit,
  no AI), **Sling** (copies a terminal-ready instruction for bigger work). The file on
  disk stays the single source of truth; the page live-reloads from it.

## The CLI (plumbing — no AI)

| command | what it does |
|---|---|
| `sandpaper install-skill` | install the `/sandpaper:*` commands + hooks into this repo (also scaffolds `brain/`) |
| `sandpaper init` | scaffold `brain/` — assets, `.sandpaper/manifest.json`, a starter multi-page skeleton |
| `sandpaper upgrade` | bring an existing brain up to date (assets · hooks · commands · canvas), preserving your `theme.css` |
| `sandpaper rebuild` | full reset — back up the old brain to `brain.bak-<date>/`, lay down a fresh skeleton |
| `sandpaper doctor` | health-check a setup: assets, digest, links, source meta, manifest, hooks |
| `sandpaper open` | serve this repo's brain + open it in a browser |
| `sandpaper <doc.html \| dir>` | serve any doc or directory with the on-page refine toolbar |
| `sandpaper help` | usage |

Serves on `127.0.0.1:4848` by default (`$SANDPAPER_PORT` or the manifest's pinned `port`
override it; the server auto-bumps if the port is taken). `install-skill --no-hooks`
skips hook wiring and prints the settings snippet instead.

## The commands (intelligence — inside Claude Code)

`/sandpaper:help` lists them all.

**Maintain the brain**

- `/sandpaper:stamp` — the full update after a substantive turn (log · NOW · digest · decisions · learnings · plan)
- `/sandpaper:log` — add one work-log row (the heartbeat)
- `/sandpaper:plan` — add or flip a task/initiative on the plan board
- `/sandpaper:decide` — record a decision, or open/resolve a question
- `/sandpaper:learn` — record a gotcha or verdict
- `/sandpaper:canvas` — elevate an explanation into a board on the cover's canvas
- `/sandpaper:sync` — reconcile the brain against the code; find and flag drift
- `/sandpaper:release` — cut a release: draft notes from the brain, pick a semver bump, tag, push

**Set up & run**

- `/sandpaper:init` — discover the repo, run a short wizard, generate the brain
- `/sandpaper:open` — start the server and open the brain
- `/sandpaper:serve` — serve the brain (or any doc) with the refine toolbar
- `/sandpaper:theme` — re-skin from a brand colour or preset

## The auto-updating brain

Two hooks keep the brain current without prodding. `install-skill` wires them into
`.claude/settings.json` (merged, deduped, your existing settings preserved); pass
`--no-hooks` to opt out, or remove the entries later to disable.

- **SessionStart** (`brain-inject.js`) — surfaces the brain's digest so a fresh `claude`
  rehydrates from project state automatically.
- **Stop** (`brain-stamp-check.js`) — if a turn ends with uncommitted project changes but
  nothing changed under `brain/`, it blocks once and asks the agent to stamp.
  Self-limiting: it never loops, and the agent can decline by stopping again.

## Releasing (this repo's own npm package)

Versioning is a Sandpaper feature, not a side process: `/sandpaper:release` reads
`brain/log.html` since the last tag, proposes a semver bump with reasoning, drafts
`CHANGELOG.md` from what actually happened (not from scratch), then runs `npm version`
and `git push --follow-tags`. Pushing the tag hands off to
[`.github/workflows/release.yml`](.github/workflows/release.yml), which re-runs tests
and [`verify-publish`](bin/verify-publish.js) (the same tarball-safety checks — no
`site/`, no secrets, size within envelope), then `npm publish --provenance` and cuts a
GitHub Release from the changelog section.

CI publishing needs one of:
- an **`NPM_TOKEN`** repo secret — generate an **Automation** token from your npm
  account (Access Tokens → Generate New Token → Automation). A regular Publish token
  won't work if your account requires 2FA for writes — it still demands an interactive
  OTP, which a CI runner can't provide.
- or npm **Trusted Publishing** (OIDC) configured for this exact repo + workflow, if
  your account offers it — no token to store or rotate.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same tests + `verify-publish`
on every push and PR, across Node 18/20/22. [`.github/dependabot.yml`](.github/dependabot.yml)
keeps pinned Actions (and any future dependency) patched.

## Publishing the brain

`brain/` is always publishable — point GitHub Pages, Vercel, Netlify, or Cloudflare at
the folder as-is; there is no build step. Links out of the brain (into your source and
specs) are written relative, and each page carries a `sandpaper:source` meta (set
automatically from your git origin); when the brain is served *away* from its repo, an
on-page resolver detects it and rewrites out-links to your source host at click time
instead of 404ing. See the deploy guide that ships inside every scaffolded brain:
[`brain/README.md`](brain/README.md).

## Conventions & requirements

- **Node ≥ 18**, ESM, **zero runtime dependencies** — built-ins only.
- The document on disk is the single source of truth; the page reflects disk, never ahead of it.
- The brain **links, never copies** — roadmap, risks, and specs stay canonical in your docs.
- The server binds to `127.0.0.1` only.

## License

MIT
