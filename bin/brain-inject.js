#!/usr/bin/env node
// Sandpaper SessionStart hook — surface the durable brain digest to either supported agent.
// Zero deps; successful output is provider-neutral and hook input is intentionally ignored.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const html = readFileSync(join(process.cwd(), 'brain', 'index.html'), 'utf8');
  const m = html.match(/<script type="application\/json" id="brain-state">([\s\S]*?)<\/script>/);
  if (!m) process.exit(0);
  const d = JSON.parse(m[1]);
  const complete = d && typeof d === 'object' && !Array.isArray(d)
    && typeof d.project === 'string' && d.project
    && typeof d.phase === 'string' && d.phase
    && typeof d.updated === 'string' && d.updated
    && d.focus && typeof d.focus === 'object' && !Array.isArray(d.focus)
    && typeof d.focus.one === 'string' && d.focus.one
    && (!Object.hasOwn(d.focus, 'ref') || typeof d.focus.ref === 'string')
    && (!Object.hasOwn(d, 'worklog') || (Array.isArray(d.worklog)
      && d.worklog.every((entry) => entry && typeof entry.one === 'string')))
    && (!Object.hasOwn(d, 'open') || (Array.isArray(d.open)
      && d.open.every((entry) => typeof entry === 'string')));
  if (!complete) process.exit(0);
  const out = [
    `🪵 Sandpaper brain · ${d.project} · ${d.phase} · stamped ${d.updated}`,
    `NOW — ${d.focus.one}${d.focus.ref ? ` (${d.focus.ref})` : ''}`,
    `Recent: ${(d.worklog || []).map((w) => w.one).join(' · ')}`,
    (d.open && d.open.length) ? `Needs you: ${d.open.join(', ')}` : '',
    `Canvas (board-first) — for a substantial recap, architecture, comparison, walkthrough, or analysis, the board is the reply: replace the current board in brain/index.html's BRAIN:CANVAS region, demote the prior board to Earlier, cap the stack at five, and leave one short canvas pointer in the terminal. Keep short answers and back-and-forth in the terminal.`,
    `Read brain/index.html to navigate. After substantive work, follow the installed Sandpaper workflow and managed instructions to stamp the shared brain.`,
  ].filter(Boolean).join('\n');
  process.stdout.write(out + '\n');
} catch { /* no brain / unreadable — stay silent, never break the agent */ }
process.exit(0);
