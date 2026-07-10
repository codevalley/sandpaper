#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';

const SHIPPED_DIRECTORIES = ['bin', 'src', 'public', 'brain/assets'];

let files;
let untracked;
try {
  files = execFileSync('git', ['ls-files', '--', ...SHIPPED_DIRECTORIES], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.js'));
  untracked = execFileSync('git', [
    'ls-files', '--others', '--exclude-standard', '--', ...SHIPPED_DIRECTORIES,
  ], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => file.endsWith('.js'));
} catch (error) {
  console.error(`  ✗ could not list tracked shipped JavaScript: ${error.message}`);
  process.exit(1);
}

if (untracked.length) {
  console.error(`  ✗ untracked shipped JavaScript would bypass syntax coverage: ${untracked.join(', ')}`);
  process.exit(1);
}

if (!files.length) {
  console.error('  ✗ no tracked shipped JavaScript files found');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`  ✗ ${file}: ${result.error.message}`);
  if (result.error || result.status !== 0) failures += 1;
}

if (failures) {
  console.error(`  ✗ syntax check failed for ${failures} of ${files.length} tracked shipped JavaScript files`);
  process.exit(1);
}

console.log(`  ✓ syntax checked ${files.length} tracked shipped JavaScript files`);
