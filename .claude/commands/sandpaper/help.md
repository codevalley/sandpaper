---
description: List the Sandpaper commands and what each one does
---

Show the user the Sandpaper command set, grouped like this, then offer to run one:

**Maintain the brain**
- `/sandpaper:stamp` — stamp the brain after a substantive turn (the 6-step update)
- `/sandpaper:log` — add one work-log row (the heartbeat)
- `/sandpaper:plan` — add or flip a task / initiative on the plan board
- `/sandpaper:decide` — record a decision, or open/resolve a question
- `/sandpaper:learn` — record a gotcha or verdict learning
- `/sandpaper:sync` — reconcile the brain against the code; find + heal drift

**Set up & run**
- `/sandpaper:init` — scaffold a new brain for this repo (harvest → interview → generate)
- `/sandpaper:open` — start the server and open the brain in your browser
- `/sandpaper:serve` — serve the brain (or any doc) with the on-page refine toolbar
- `/sandpaper:theme` — re-skin the whole brain from one brand colour
- `/sandpaper:help` — this list

Then note: the brain also auto-maintains via two hooks — **SessionStart** rehydrates from the
digest, **Stop** nudges you to stamp if a turn changed code but not the brain
(`skill/sandpaper/SKILL.md` → Auto-update). Keep it concise; don't dump file contents.
