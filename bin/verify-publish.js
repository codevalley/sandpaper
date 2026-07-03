#!/usr/bin/env node
// verify-publish.js — the gate before any npm publish (local or CI). Zero deps.
// Codifies the checks that used to be manual: the tarball ships only the tool
// (never site/ or brain content), stays within an expected size/file envelope
// (a silent jump is the first sign of an accidental inclusion), and carries no
// obvious secrets. Exit 0 = safe to publish; exit 1 = do not publish, read why.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FORBIDDEN_PREFIXES = ['site/', 'test/', '.github/', '.sandpaper/', '.vercel/'];
const MAX_FILES = 45; // today: 30. A jump past this means something new is shipping — look before raising it.
const MAX_UNPACKED_KB = 400; // today: ~218 KB.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{10,}['"]/i,
  /password\s*[:=]\s*['"][^'"]{4,}['"]/i,
];

const bad = (m) => { console.error('  ✗ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('  ✓ ' + m);

const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }))[0];
const files = pack.files.map((f) => f.path);

const forbidden = files.filter((f) => FORBIDDEN_PREFIXES.some((p) => f.startsWith(p)));
if (forbidden.length) bad(`forbidden paths in the tarball: ${forbidden.join(', ')}`);
else ok(`no forbidden paths (checked against ${FORBIDDEN_PREFIXES.join(', ')})`);

if (files.length > MAX_FILES) bad(`${files.length} files exceeds the expected envelope (${MAX_FILES}) — new files? review and raise MAX_FILES if intentional`);
else ok(`${files.length} files (within the ${MAX_FILES}-file envelope)`);

const unpackedKb = Math.round(pack.unpackedSize / 1024);
if (unpackedKb > MAX_UNPACKED_KB) bad(`${unpackedKb} KB unpacked exceeds the expected envelope (${MAX_UNPACKED_KB} KB)`);
else ok(`${unpackedKb} KB unpacked (within the ${MAX_UNPACKED_KB} KB envelope)`);

let hits = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; } // binary or unreadable — skip
  for (const re of SECRET_PATTERNS) if (re.test(text)) { bad(`possible secret in ${f} (matched ${re})`); hits++; }
}
if (!hits) ok('no secret patterns found');

if (process.exitCode) { console.error('\n  ✗ verify-publish failed — do not run npm publish.\n'); }
else console.log('\n  ✓ safe to publish.\n');
