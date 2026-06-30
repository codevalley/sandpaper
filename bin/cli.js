#!/usr/bin/env node
// Sandpaper CLI. Subcommands are the "plumbing" (no AI); a bare path falls through to `serve`.
//   sandpaper install-skill | init | doctor | open | help | <doc.html|dir>
import { resolve, dirname, join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer } from '../src/server.js';
import { installSkill, scaffold, doctor } from '../src/setup.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const port = Number(process.env.SANDPAPER_PORT || 4848);

const usage = () => console.log(`
  🪵  sandpaper — a living project brain

  sandpaper install-skill      install the /sandpaper commands + hooks into this repo
  sandpaper init               scaffold brain/ (assets + manifest + a starter cover)
  sandpaper doctor             health-check a Sandpaper setup
  sandpaper open               serve this repo's brain + open it in a browser
  sandpaper <doc.html | dir>   serve with the on-page refine toolbar
  sandpaper help               this

  Fresh repo? → sandpaper install-skill, then /sandpaper:init in Claude Code.
`);

const serve = async (target, openBrowser) => {
  const isDir = statSync(target).isDirectory();
  const url = await startServer(target, port, { brain: isDir });
  console.log(`\n  🪵  Sandpaper\n  ↳ ${isDir ? 'serving' : 'editing'}  ${target}\n  ↳ open     ${url}\n`);
  if (openBrowser) {
    const u = isDir && existsSync(join(target, 'brain', 'index.html')) ? url + 'brain/index.html' : url;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [u], () => {}); // best-effort; ignore failures
  }
};

(async () => {
  try {
    if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return usage();
    if (cmd === 'install-skill') return installSkill(process.cwd(), PKG, { noHooks: rest.includes('--no-hooks') });
    if (cmd === 'init') return scaffold(process.cwd(), PKG);
    if (cmd === 'doctor') return doctor(process.cwd());
    if (cmd === 'open') return serve(process.cwd(), true);
    const target = resolve(process.cwd(), cmd);
    if (!existsSync(target)) { console.error(`\n  sandpaper: unknown command or path: ${cmd}`); usage(); process.exit(1); }
    return serve(target, false);
  } catch (e) { console.error('  sandpaper:', e.message); process.exit(1); }
})();
