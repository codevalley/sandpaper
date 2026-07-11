#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APPROVED_FILE_RULES, normalizePackagePath } from '../src/package-contract.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const shippedJavaScript = APPROVED_FILE_RULES
  .filter((rule) => !rule.startsWith('!') && rule.endsWith('.js'))
  .map(normalizePackagePath);
const shippedSet = new Set(shippedJavaScript);
const shippedDirectories = [...new Set(shippedJavaScript.map((file) => dirname(file)))].sort();

function gitFiles(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.js'))
    .map(normalizePackagePath);
}

let repositoryJavaScript;
try {
  repositoryJavaScript = [
    ...gitFiles(['ls-files', '--', ...shippedDirectories]),
    ...gitFiles(['ls-files', '--others', '--exclude-standard', '--', ...shippedDirectories]),
  ];
} catch (error) {
  console.error(`  ✗ could not list shipped-directory JavaScript: ${error.message}`);
  process.exit(1);
}

const extra = [...new Set(repositoryJavaScript.filter((file) => !shippedSet.has(file)))].sort();
if (extra.length) {
  console.error(`  ✗ JavaScript absent from the package contract: ${extra.join(', ')}`);
  process.exit(1);
}

if (!shippedSet.has('src/package-contract.js')) {
  console.error('  ✗ package contract would bypass its own syntax coverage');
  process.exit(1);
}

let failures = 0;
for (const file of shippedJavaScript) {
  try {
    const stat = lstatSync(fileURLToPath(new URL(`../${file}`, import.meta.url)));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular non-symlink file');
  } catch (error) {
    console.error(`  ✗ ${file}: ${error.message}`);
    failures += 1;
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`  ✗ ${file}: ${result.error.message}`);
  if (result.error || result.status !== 0) failures += 1;
}

if (failures) {
  console.error(`  ✗ syntax check failed for ${failures} of ${shippedJavaScript.length} contracted JavaScript files`);
  process.exit(1);
}

console.log(`  ✓ syntax checked ${shippedJavaScript.length} contracted JavaScript files`);
