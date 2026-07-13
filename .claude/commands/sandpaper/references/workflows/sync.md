# Sync workflow

Audit the brain against reality and report drift:

1. Read `#brain-state`, the plan board, and the component map.
2. Check each claim against code, git history, file structure, and actual source. Flag stale facts,
   changed component statuses, decisions overtaken by events, plan tasks that are already done or
   blocked, mismatched counts, and every `data-ref` whose anchor no longer exists.
3. Present the drift as a concise list.
4. With the owner's approval through the native structured user-input/confirmation mechanism, heal
   drift by executing the applicable canonical `stamp` operations: flip statuses, append entries,
   and supersede stale decisions with a new entry carrying `data-rel="supersedes:<id>"`. Never
   silently rewrite history.

This workflow is the manual companion to the stop hook: the hook prevents new drift and sync heals
existing drift.
