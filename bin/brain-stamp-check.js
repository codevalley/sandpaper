#!/usr/bin/env node
// Sandpaper Stop hook — the brain's immune system. When a turn changed project files but DID NOT
// touch the brain, block once and tell the agent to stamp it. Automatic; no user prodding.
//
// Self-limiting (never loops):
//   1. `stop_hook_active` in the hook payload → we're already in a continuation, so allow the stop.
//   2. The check is idempotent — once the agent stamps (brain/ changes), it no longer fires.
//   3. The agent can override ("this turn needs no brain update") by simply stopping again.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no/!json stdin */ }
if (input.stop_hook_active) process.exit(0); // guard #1: don't re-block a continuation

let changed = [];
try {
  changed = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').filter(Boolean).map((l) => l.slice(3).trim());
} catch { process.exit(0); } // not a git repo / git missing — stay silent

const isProject = (f) => /\.(js|css|html|md|json)$/.test(f) && !f.startsWith('.sandpaper') && !f.includes('node_modules');
const proj = changed.filter(isProject);
const brainTouched = proj.some((f) => f.startsWith('brain/'));            // guard #2: stamped → won't fire
const nonBrain = proj.filter((f) => !f.startsWith('brain/') && f !== 'CLAUDE.md');

if (nonBrain.length && !brainTouched) {
  const reason =
    `🪵 The brain isn't stamped. This turn changed ${nonBrain.length} project file(s) ` +
    `(${nonBrain.slice(0, 6).join(', ')}${nonBrain.length > 6 ? ', …' : ''}) but nothing under brain/. ` +
    `Before finishing, STAMP the brain (CLAUDE.md → "The project brain"): prepend one log row, refresh the ` +
    `cover NOW + #brain-state digest, flip any plan-board tasks, add a decision/learning if one applies — then commit. ` +
    `If this turn genuinely warrants no brain update, just stop again.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}
process.exit(0);
