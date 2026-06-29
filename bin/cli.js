#!/usr/bin/env node
// Sandpaper CLI — `sandpaper <document.html>` serves one doc; `sandpaper <dir>` serves a folder
// (e.g. the project brain) with the on-page toolbar on every page.
import { resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { startServer } from '../src/server.js';

const arg = process.argv[2];
if (!arg || arg === '-h' || arg === '--help') {
  console.log('usage: sandpaper <document.html | directory>');
  process.exit(arg ? 0 : 1);
}

const target = resolve(process.cwd(), arg);
if (!existsSync(target)) {
  console.error(`sandpaper: not found: ${target}`);
  process.exit(1);
}
const isDir = statSync(target).isDirectory();

const port = Number(process.env.SANDPAPER_PORT || 4848);
startServer(target, port, { brain: isDir }).then((url) => {
  console.log('');
  console.log('  🪵  Sandpaper');
  console.log(isDir ? `  ↳ serving  ${target}` : `  ↳ editing  ${target}`);
  console.log(`  ↳ open     ${url}`);
  console.log('');
  console.log('  Point at the page, say what to change — or ⇥ Sling to the terminal. Ctrl-C to stop.');
}).catch((err) => {
  console.error('sandpaper: failed to start —', err.message);
  process.exit(1);
});
