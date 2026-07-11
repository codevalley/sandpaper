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

let input;
try {
  const raw = readFileSync(0, 'utf8');
  if (!raw.trim()) process.exit(0);
  input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || Array.isArray(input)) process.exit(0);
} catch { process.exit(0); }
if (input.stop_hook_active) process.exit(0); // guard #1: don't re-block a continuation

try { readFileSync('brain/index.html'); }
catch { process.exit(0); }

let changed = [];
try {
  const status = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const records = status.split('\0');
  if (records.at(-1) === '') records.pop();
  for (const record of records) {
    const state = record.slice(0, 2);
    const path = record.slice(3);
    if (record[2] !== ' ' || /[RC]/.test(state) || !path || path.length > 240
      || !/^[A-Za-z0-9._@+ /-]+$/.test(path)
      || path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../')) {
      process.exit(0);
    }
    changed.push(path);
  }
} catch { process.exit(0); } // not a git repo / git missing — stay silent

const isProject = (f) => /\.(js|css|html|md|json|ya?ml)$/.test(f)
  && f !== '.sandpaper' && !f.startsWith('.sandpaper/')
  && f !== 'node_modules' && !f.startsWith('node_modules/') && !f.includes('/node_modules/');
const brainTouched = changed.some((f) => f.startsWith('brain/'));          // any safe brain path is a stamp
const proj = changed.filter(isProject);
const nonBrain = proj.filter((f) => !f.startsWith('brain/') && f !== 'CLAUDE.md' && f !== 'AGENTS.md');

if (nonBrain.length && !brainTouched) {
  const visiblePaths = nonBrain.slice(0, 6).map((path) => (
    /(?:secret|credential|token|api[-_]?key|private[-_]?key)/i.test(path) ? '[sensitive path]' : path
  ));
  const reason =
    `🪵 The brain isn't stamped. This turn changed ${nonBrain.length} project file(s) ` +
    `(${visiblePaths.join(', ')}${nonBrain.length > 6 ? ', …' : ''}) but nothing under brain/. ` +
    `Before finishing, stamp the shared Sandpaper brain: prepend one log row, refresh the cover NOW and ` +
    `brain-state digest, flip any plan-board tasks, and add a decision or learning when one applies. ` +
    `If this turn genuinely warrants no brain update, just stop again.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}
process.exit(0);
