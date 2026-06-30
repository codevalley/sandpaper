---
description: Re-skin the Sandpaper brain from a brand colour or preset
argument-hint: "<a brand hex like #2E6F95, or \"preset: <name>\">"
---

Re-skin by editing ONLY `brain/assets/theme.css` (the single token file): $ARGUMENTS.

Derive a coherent palette from the brand hex — a paper/ink base plus an accent and supporting
hues (a green, an amber, a red) — keeping contrast and legibility (WCAG AA for text). Touch no
other file: every brain surface reads its colour from `theme.css`, so one edit re-skins the whole
manual. If the owner also wants the injected toolbar reskinned, keep its `#sp-panel` `--sp-*`
mirror in `public/toolbar.css` in sync (it's deliberately host-independent).
