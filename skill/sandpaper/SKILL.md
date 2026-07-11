---
name: sandpaper
description: Use when a repository contains or needs a Sandpaper project brain.
---

# Sandpaper

Sandpaper maintains `brain/`, a navigable service manual for the repository. Repository files are canonical truth
for implementation and rendered output. The brain is canonical truth for durable
intent, decisions, plans, progress, work history, and learnings. Provider sessions are noncanonical compute context
and must not become a competing source of truth.

## Brain context

- `brain/index.html` is the cover and contains the `#brain-state` digest, NOW, needs-you, latest,
  and canvas.
- Lens pages live under `product/`, `engineering/`, and `project/`; books include `log.html`,
  `decisions.html`, `learnings.html`, and `wiki/`.
- `assets/theme.css` skins the brain and `assets/brain.js` derives counts and progress.

Durable facts use `.entry` elements with `data-cid` mirrored to `id`, `data-kind`, `data-status`,
`data-date`, at least one canonical `data-ref`, and optional `data-lens`. Link to canonical material;
do not copy it. Never remove or reuse cids.

## Invocation grammar

Use `$sandpaper <action> [arguments]`.

## Action dispatch

Read the first word after `$sandpaper` as the action. Supported actions are `canvas`, `decide`,
`help`, `init`, `learn`, `log`, `open`, `plan`, `release`, `serve`, `stamp`, `sync`, and `theme`.
Read and execute `references/workflows/<action>.md`, treating the remaining words as arguments.
If the action is absent or unknown, execute `references/workflows/help.md`.
Use the normal user-input mechanism whenever the workflow requires human confirmation.
