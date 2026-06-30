# 🪵 Sandpaper

A **living project brain** for Claude Code projects — a navigable, always-current web
"service manual" (`brain/`) that the agent maintains, plus a refine-in-place toolbar for
the rendered HTML. The brain is the **eyes** (state made visible); the terminal stays the
**mouth** (steering).

## Quick start

```bash
# in your repo, with Claude Code:
npx sandpaper install-skill     # adds the /sandpaper commands + the auto-update hooks
#   → then, in Claude Code:
/sandpaper:init                 # harvests the repo, asks a few questions, generates the brain
npx sandpaper open              # serve it + open in your browser
```

## The CLI (the plumbing — no AI)

| command | what it does |
|---|---|
| `sandpaper install-skill` | copy the `/sandpaper:*` commands → `.claude/commands/`, the hooks → `.sandpaper/hooks/`, and print the opt-in `settings.json` snippet |
| `sandpaper init` | scaffold `brain/` (the design-system assets + a `.sandpaper/manifest.json` + a starter cover). Idempotent — never clobbers a customised skin or the id counters |
| `sandpaper doctor` | health-check a setup (assets present, `theme.css` imported, digest parses, links resolve, manifest valid, hooks installed) |
| `sandpaper open` | serve the repo + open `brain/index.html` in the browser |
| `sandpaper <doc.html \| dir>` | serve with the on-page refine toolbar |

## The commands (the intelligence — in Claude Code)

`/sandpaper:help` lists them. **Maintain the brain:** `/stamp` `/log` `/plan` `/decide`
`/learn` `/sync`. **Set up & run:** `/init` `/open` `/serve` `/theme`.

## The auto-updating brain (opt-in)

Two hooks keep the brain current without prodding: **SessionStart** surfaces the digest so a
fresh session rehydrates; **Stop** nudges the agent to stamp if a turn changed code but not
the brain. Enable by merging the snippet `install-skill` prints into `.claude/settings.json`
(remove it to disable).

## Conventions

Zero runtime dependencies (Node ≥18 built-ins, ESM). The document on disk is the single
source of truth. The brain is static HTML — **link, never copy**.

MIT.
