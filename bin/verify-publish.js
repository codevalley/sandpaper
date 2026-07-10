#!/usr/bin/env node
// The final local/CI publish gate: build the real tarball, require its file list to
// equal the reviewed package manifest, extract it, and inspect the actual bytes.
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APPROVED_FILE_RULES = [
  'bin/brain-inject.js',
  'bin/brain-stamp-check.js',
  'bin/cli.js',
  'bin/syntax-check.js',
  'bin/verify-publish.js',
  'src/claude.js',
  'src/edit.js',
  'src/path-policy.js',
  'src/server.js',
  'src/setup.js',
  'public/sp-client.js',
  'public/sp-markdown.js',
  'public/toolbar.css',
  'public/toolbar.js',
  'skill/sandpaper/SKILL.md',
  'skill/sandpaper/commands/canvas.md',
  'skill/sandpaper/commands/decide.md',
  'skill/sandpaper/commands/help.md',
  'skill/sandpaper/commands/init.md',
  'skill/sandpaper/commands/learn.md',
  'skill/sandpaper/commands/log.md',
  'skill/sandpaper/commands/open.md',
  'skill/sandpaper/commands/plan.md',
  'skill/sandpaper/commands/release.md',
  'skill/sandpaper/commands/serve.md',
  'skill/sandpaper/commands/stamp.md',
  'skill/sandpaper/commands/sync.md',
  'skill/sandpaper/commands/theme.md',
  'brain/assets/brain.css',
  'brain/assets/brain.js',
  'brain/assets/theme.css',
  '!brain/README.md',
  'README.md',
  'CHANGELOG.md',
];
const MAX_PACKED_KB = 100; // reviewed candidate: ~86 KB; 14 KB headroom
const MAX_UNPACKED_KB = 300; // reviewed candidate: ~279 KB; 21 KB headroom
const FORBIDDEN_PATH = /^(?:\.agents|\.claude|\.codex|\.github|\.playwright-mcp|\.sandpaper|\.superpowers|\.vercel|docs|node_modules|playwright-report|site|test|test-results)(?:\/|$)|^(?:AGENTS\.md|CLAUDE\.md|engg-spec\.html|playwright\.config\.js|sandpaper\.html)$/;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.git-credentials$|\.netrc$|\.npmrc$|\.pypirc$|credentials\.json$|id_(?:dsa|ecdsa|ed25519|rsa)$|service-account\.json$)|\.(?:cer|crt|key|p12|pem|pfx)$/i;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{10,}['"]/i,
  /password\s*[:=]\s*['"][^'"]{4,}['"]/i,
];

const bad = (message) => { console.error(`  ✗ ${message}`); process.exitCode = 1; };
const ok = (message) => console.log(`  ✓ ${message}`);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    ...options,
  });
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedPackedPaths(manifest) {
  if (!sameList(manifest.files || [], APPROVED_FILE_RULES)) {
    bad('package.json files changed from the reviewed exact allowlist');
  }
  const positive = APPROVED_FILE_RULES.filter((rule) => !rule.startsWith('!'));
  const tracked = run('git', ['ls-files', '--', ...positive]).split('\n').filter(Boolean);
  const expected = new Set(['LICENSE', 'package.json', ...tracked]);
  for (const rule of APPROVED_FILE_RULES.filter((entry) => entry.startsWith('!'))) expected.delete(rule.slice(1));
  return [...expected].sort();
}

function extractedFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        bad(`symlink in tarball: ${relative(root, file)}`);
      } else if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

const scratch = mkdtempSync(join(tmpdir(), 'sandpaper-verify-publish-'));
try {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (Object.keys(manifest.dependencies || {}).length) bad('runtime dependencies must remain empty');
  else ok('zero runtime dependencies');

  const packDirectory = join(scratch, 'pack');
  const extractDirectory = join(scratch, 'extract');
  mkdirSync(packDirectory);
  mkdirSync(extractDirectory);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDirectory]))[0];
  const packedPaths = packed.files.map(({ path }) => path).sort();
  const expectedPaths = expectedPackedPaths(manifest);

  const unexpected = packedPaths.filter((path) => !expectedPaths.includes(path));
  const missing = expectedPaths.filter((path) => !packedPaths.includes(path));
  if (unexpected.length) bad(`unexpected tarball paths: ${unexpected.join(', ')}`);
  if (missing.length) bad(`missing tarball paths: ${missing.join(', ')}`);
  if (!unexpected.length && !missing.length) ok(`exact reviewed packlist (${packedPaths.length} files)`);

  const forbidden = packedPaths.filter((path) => FORBIDDEN_PATH.test(path));
  const secretFiles = packedPaths.filter((path) => SECRET_PATH.test(path));
  if (forbidden.length) bad(`forbidden paths in tarball: ${forbidden.join(', ')}`);
  else ok('no forbidden package paths');
  if (secretFiles.length) bad(`secret-shaped filenames in tarball: ${secretFiles.join(', ')}`);
  else ok('no secret-shaped filenames');

  const packedKb = Math.ceil(packed.size / 1024);
  const unpackedKb = Math.ceil(packed.unpackedSize / 1024);
  if (packedKb > MAX_PACKED_KB) bad(`${packedKb} KB packed exceeds ${MAX_PACKED_KB} KB envelope`);
  else ok(`${packedKb} KB packed (within ${MAX_PACKED_KB} KB envelope)`);
  if (unpackedKb > MAX_UNPACKED_KB) bad(`${unpackedKb} KB unpacked exceeds ${MAX_UNPACKED_KB} KB envelope`);
  else ok(`${unpackedKb} KB unpacked (within ${MAX_UNPACKED_KB} KB envelope)`);

  run('tar', ['-xzf', join(packDirectory, packed.filename), '-C', extractDirectory], { timeout: 30_000 });
  const extractedRoot = join(extractDirectory, 'package');
  const files = extractedFiles(extractedRoot);
  const actualPaths = files.map((file) => relative(extractedRoot, file).split('\\').join('/')).sort();
  if (!sameList(actualPaths, packedPaths)) bad('extracted tarball paths differ from npm pack JSON');
  else ok('extracted tarball matches npm pack JSON');

  let hits = 0;
  for (const file of files) {
    const path = relative(extractedRoot, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (!pattern.test(text)) continue;
      bad(`possible secret in packed bytes for ${path} (matched ${pattern})`);
      hits += 1;
    }
  }
  if (!hits) ok('no secret patterns in extracted tarball bytes');
} catch (error) {
  bad(`could not verify packed artifact: ${error.message}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (process.exitCode) console.error('\n  ✗ verify-publish failed — do not run npm publish.\n');
else console.log('\n  ✓ safe to publish.\n');
