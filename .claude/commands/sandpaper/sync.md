---
description: Reconcile the brain against the code — find and flag drift
---

Audit the brain against reality and report drift (the brain's periodic checkup):

1. Read `#brain-state`, the plan board, and the component map.
2. Check each claim against the code — the `git log`, the file structure, the actual source.
   Flag: stale facts, components whose status changed, decisions overtaken by events, plan tasks
   that are actually done/blocked, counts that no longer match, and any `data-ref` whose anchor no
   longer exists (a dangling link).
3. Present the drift as a concise list.
4. With the owner's OK, fix it via the STAMP ops — flip statuses, append entries, **supersede**
   stale decisions (a new entry with `data-rel="supersedes:<id>"`). Never silently rewrite history.

This is the manual companion to the Stop hook: the hook prevents NEW drift; `/sync` heals existing
drift.
