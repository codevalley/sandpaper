#!/usr/bin/env node
// Sandpaper SessionStart hook — surface the brain digest so a fresh `claude` rehydrates
// from the brain FIRST, automatically (no "read the brain" prompt needed).
// Zero deps; prints the digest to stdout, which Claude Code adds to the session context.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

try {
  const html = readFileSync(join(process.cwd(), 'brain', 'index.html'), 'utf8');
  const m = html.match(/<script type="application\/json" id="brain-state">([\s\S]*?)<\/script>/);
  if (!m) process.exit(0);
  const d = JSON.parse(m[1]);
  const out = [
    `🪵 Sandpaper brain · ${d.project} · ${d.phase} · session ${d.session} · stamped ${d.updated}`,
    `NOW — ${d.focus?.one || ''}${d.focus?.ref ? ` (${d.focus.ref})` : ''}`,
    `Recent: ${(d.worklog || []).map((w) => w.one).join(' · ')}`,
    (d.open && d.open.length) ? `Needs you: ${d.open.join(', ')}` : '',
    `Canvas — when you work through something substantial (an architecture, a comparison, a walkthrough, a non-trivial analysis), write the ELEVATED version as a board into brain/index.html's <!-- BRAIN:CANVAS --> region and leave just a one-line pointer in the terminal; don't fill the scrollback. The cover hosts the canvas. See the CANVAS discipline in the skill; /sandpaper:canvas forces one.`,
    `Read brain/index.html to navigate. Stamp the brain after substantive turns (CLAUDE.md → "The project brain").`,
  ].filter(Boolean).join('\n');
  process.stdout.write(out + '\n');
} catch { /* no brain / unreadable — stay silent, never break the session */ }
process.exit(0);
