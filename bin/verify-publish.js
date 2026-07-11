#!/usr/bin/env node
// Final local/CI publish gate: build and extract the real tarball, then inspect
// its exact paths, bytes, import closure, size, and secret surface.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_FILE_RULES,
  MAX_PACKED_KB,
  MAX_UNPACKED_KB,
  assertNoRuntimeDependencyMetadata,
  containsSecretPattern,
  expectedPackedPaths,
  isForbiddenPackagePath,
  isSecretPackagePath,
  normalizePackagePath,
  relativeEsmImports,
} from '../src/package-contract.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MAX_ARTIFACT_BYTES = MAX_UNPACKED_KB * 1024;
const ok = (message) => console.log(`  ✓ ${message}`);

function fail(message) {
  throw new Error(message);
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function minimalEnvironment(scratch) {
  const home = join(scratch, 'home');
  const cache = join(scratch, 'npm-cache');
  const temporary = join(scratch, 'tmp');
  mkdirSync(home);
  mkdirSync(cache);
  mkdirSync(temporary);
  const userConfig = join(scratch, 'empty-user-npmrc');
  const globalConfig = join(scratch, 'empty-global-npmrc');
  writeFileSync(userConfig, '');
  writeFileSync(globalConfig, '');
  const env = {
    HOME: home,
    USERPROFILE: home,
    PATH: process.env.PATH || '',
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    NO_COLOR: '1',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_PREFER_OFFLINE: 'true',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
  };
  for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

function run(command, args, { cwd = ROOT, env, timeout = 120_000 } = {}) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
}

function regularSourceFile(path) {
  const normalized = normalizePackagePath(path);
  const file = join(ROOT, ...normalized.split('/'));
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`contract source is not a regular non-symlink file: ${normalized}`);
  const canonical = realpathSync(file);
  const containment = relative(realpathSync(ROOT), canonical);
  if (containment === '..' || containment.startsWith(`..${sep}`) || resolve(canonical) === resolve(ROOT)) {
    fail(`contract source escapes the package root: ${normalized}`);
  }
  return file;
}

function readRegularBounded(file, label, budget) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  let descriptor;
  try {
    descriptor = openSync(file, flags);
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) fail(`${label} is not a regular file`);
    if (stat.size > MAX_ARTIFACT_BYTES || budget.bytes + stat.size > MAX_ARTIFACT_BYTES) {
      fail(`${label} exceeds bounded artifact reads`);
    }
    const bytes = Buffer.from(readFileSync(descriptor));
    budget.bytes += bytes.length;
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function extractedFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      const path = relative(root, file).split(sep).join('/');
      if (stat.isSymbolicLink()) fail(`symlink in extracted tarball: ${path}`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push(file);
      else fail(`special file in extracted tarball: ${path}`);
    }
  };
  visit(root);
  return files;
}

function assertRelativeImportClosure(paths, bytesByPath) {
  const shipped = new Set(paths);
  for (const importer of paths.filter((path) => path.endsWith('.js'))) {
    const source = bytesByPath.get(importer).toString('utf8');
    for (const specifier of relativeEsmImports(source)) {
      if (specifier.includes('?') || specifier.includes('#')) {
        fail(`relative ESM import uses an unsupported suffix in ${importer}`);
      }
      const resolved = posix.normalize(posix.join(posix.dirname(importer), specifier));
      if (!shipped.has(resolved)) fail(`relative ESM import from ${importer} is not shipped: ${specifier}`);
    }
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'sandpaper-verify-publish-'));
let failed = false;
try {
  const env = minimalEnvironment(scratch);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assertNoRuntimeDependencyMetadata(manifest);
  ok('no runtime dependency metadata');

  const lifecycle = ['prepack', 'prepare', 'postpack', 'prepublishOnly']
    .filter((name) => Object.hasOwn(manifest.scripts || {}, name));
  if (lifecycle.length) fail(`unreviewed publish lifecycle scripts: ${lifecycle.join(', ')}`);
  ok('no publish lifecycle scripts');

  if (!sameList(manifest.files || [], APPROVED_FILE_RULES)) {
    fail('package.json files changed from the shared exact allowlist');
  }
  for (const rule of APPROVED_FILE_RULES) {
    const path = rule.startsWith('!') ? rule.slice(1) : rule;
    normalizePackagePath(path);
    if (!rule.startsWith('!')) regularSourceFile(path);
  }
  for (const path of ['LICENSE', 'package.json']) regularSourceFile(path);
  ok(`shared package contract (${APPROVED_FILE_RULES.length} rules)`);

  const packDirectory = join(scratch, 'pack');
  const extractDirectory = join(scratch, 'extract');
  mkdirSync(packDirectory);
  mkdirSync(extractDirectory);
  const packedOutput = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], { env });
  const packed = JSON.parse(packedOutput)[0];
  if (!packed?.filename || !Array.isArray(packed.files)) fail('npm pack returned an unreadable artifact description');
  const packedPaths = packed.files.map(({ path }) => normalizePackagePath(path)).sort();
  const expectedPaths = expectedPackedPaths();
  if (!sameList(packedPaths, expectedPaths)) {
    const unexpected = packedPaths.filter((path) => !expectedPaths.includes(path));
    const missing = expectedPaths.filter((path) => !packedPaths.includes(path));
    fail(`tarball path mismatch; unexpected: ${unexpected.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`);
  }
  ok(`exact reviewed packlist (${packedPaths.length} files)`);

  const forbidden = packedPaths.filter(isForbiddenPackagePath);
  const secretPaths = packedPaths.filter(isSecretPackagePath);
  if (forbidden.length) fail(`forbidden paths in tarball: ${forbidden.join(', ')}`);
  if (secretPaths.length) fail(`secret-shaped paths in tarball: ${secretPaths.join(', ')}`);
  ok('no forbidden or secret-shaped package paths');

  const packedKb = Math.ceil(packed.size / 1024);
  const unpackedKb = Math.ceil(packed.unpackedSize / 1024);
  if (packedKb > MAX_PACKED_KB) fail(`${packedKb} KB packed exceeds ${MAX_PACKED_KB} KB envelope`);
  if (unpackedKb > MAX_UNPACKED_KB) fail(`${unpackedKb} KB unpacked exceeds ${MAX_UNPACKED_KB} KB envelope`);
  ok(`${packedKb} KB packed / ${unpackedKb} KB unpacked within explicit envelopes`);

  run('tar', ['-xzf', join(packDirectory, packed.filename), '-C', extractDirectory], { env, timeout: 30_000 });
  const extractedRoot = join(extractDirectory, 'package');
  const files = extractedFiles(extractedRoot);
  const actualPaths = files.map((file) => normalizePackagePath(relative(extractedRoot, file).split(sep).join('/'))).sort();
  if (!sameList(actualPaths, packedPaths)) fail('extracted tarball paths differ from npm pack JSON');

  const budget = { bytes: 0 };
  const bytesByPath = new Map();
  for (const path of actualPaths) {
    const extracted = readRegularBounded(join(extractedRoot, ...path.split('/')), `extracted ${path}`, budget);
    const source = readFileSync(regularSourceFile(path));
    if (!extracted.equals(source)) fail(`extracted bytes differ from reviewed source: ${path}`);
    if (containsSecretPattern(extracted)) fail(`possible secret pattern in packed bytes: ${path}`);
    bytesByPath.set(path, extracted);
  }
  ok('extracted regular-file bytes exactly match reviewed sources');
  ok('no secret patterns in bounded extracted bytes');

  assertRelativeImportClosure(actualPaths, bytesByPath);
  ok('relative ESM imports close over shipped files');
} catch (error) {
  failed = true;
  console.error(`  ✗ ${error.message}`);
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); }
  catch { /* best effort; never mask the verification result */ }
}

if (failed) {
  console.error('\n  ✗ verify-publish failed — do not run npm publish.\n');
  process.exitCode = 1;
} else {
  console.log('\n  ✓ safe to publish.\n');
}
