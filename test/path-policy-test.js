import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PATH_REASONS,
  classifyRepositoryRelative,
  resolveRepositoryPath,
} from '../src/path-policy.js';
import { checkBrainLinks } from '../src/setup.js';

const cases = [
  ['README.md', true],
  ['src/server.js', true],
  ['.github/workflows/release.yml', true],
  ['.git/config', false],
  ['.sandpaper/session.json', false],
  ['.env', false],
  ['.env.local', false],
  ['.npmrc', false],
  ['.netrc', false],
  ['.codex/config.toml', false],
  ['keys/id_ed25519', false],
  ['keys/private.pem', false],
  ['keys/client.p12', false],
];

test('classifies the repository path allowlist and secret denylist', () => {
  for (const [relative, expected] of cases) {
    assert.equal(
      classifyRepositoryRelative(relative).ok,
      expected,
      `${relative} should be ${expected ? 'allowed' : 'denied'}`,
    );
  }
});

test('mutable paths reject every hidden path including .github', () => {
  for (const relative of ['.github/workflows/release.yml', '.git/config', '.codex/config.toml']) {
    assert.deepEqual(classifyRepositoryRelative(relative, { mutable: true }), {
      ok: false,
      reason: PATH_REASONS.HIDDEN_PATH,
    });
  }
});

test('resolver rejects lexical and canonical escapes and denied aliases', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'sandpaper-policy-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const root = join(parent, 'repo');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), '[core]\n');
  const outside = join(parent, 'outside.txt');
  writeFileSync(outside, 'outside\n');
  symlinkSync(outside, join(root, 'outside-alias'));
  symlinkSync(join(root, '.git', 'config'), join(root, 'innocent-name'));

  assert.deepEqual(resolveRepositoryPath(root, outside), {
    ok: false,
    reason: PATH_REASONS.OUTSIDE_ROOT,
  });
  assert.deepEqual(resolveRepositoryPath(root, join(root, 'outside-alias')), {
    ok: false,
    reason: PATH_REASONS.OUTSIDE_ROOT,
  });
  assert.deepEqual(resolveRepositoryPath(root, join(root, 'innocent-name')), {
    ok: false,
    reason: PATH_REASONS.HIDDEN_PATH,
  });
});

test('resolver permits a missing safe path only when existence is optional', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const missing = join(root, 'docs', 'future.html');

  assert.deepEqual(resolveRepositoryPath(root, missing), {
    ok: false,
    reason: PATH_REASONS.MISSING,
  });
  assert.deepEqual(resolveRepositoryPath(root, missing, { mustExist: false }), {
    ok: true,
    file: join(realpathSync(root), 'docs', 'future.html'),
    relative: 'docs/future.html',
  });
});

test('resolver distinguishes unreadable paths from missing paths', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync('loop', join(root, 'loop'));

  assert.deepEqual(resolveRepositoryPath(root, join(root, 'loop')), {
    ok: false,
    reason: PATH_REASONS.UNREADABLE,
  });
});

test('resolver rejects an existing dangling symlink when existence is optional', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alias = join(root, 'outside-alias');
  symlinkSync(join(dirname(root), 'outside-new-file'), alias);

  assert.deepEqual(resolveRepositoryPath(root, alias, { mustExist: false }), {
    ok: false,
    reason: PATH_REASONS.UNREADABLE,
  });
});

test('resolver rejects a missing child beneath a dangling symlink', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alias = join(root, 'outside-directory-alias');
  symlinkSync(join(dirname(root), 'outside-new-directory'), alias);

  assert.deepEqual(resolveRepositoryPath(root, join(alias, 'new-file'), { mustExist: false }), {
    ok: false,
    reason: PATH_REASONS.UNREADABLE,
  });
});

test('doctor link checks allow safe and .github references but report hidden references', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-doctor-policy-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));

  const brain = join(target, 'brain');
  mkdirSync(join(target, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(target, '.codex'), { recursive: true });
  mkdirSync(brain);
  writeFileSync(join(target, 'README.md'), '# Safe\n');
  writeFileSync(join(target, '.github', 'workflows', 'release.yml'), 'name: release\n');
  writeFileSync(join(target, '.codex', 'config.toml'), 'secret = true\n');
  writeFileSync(join(brain, 'index.html'), [
    '<main>',
    '  <article data-ref="../README.md"></article>',
    '  <article data-ref="../.github/workflows/release.yml"></article>',
    '  <article data-ref="../.codex/config.toml"></article>',
    '</main>',
  ].join('\n'));

  const problems = checkBrainLinks(target, brain);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].page, 'brain/index.html');
  assert.equal(problems[0].reference, '../.codex/config.toml');
  assert.equal(problems[0].reason, PATH_REASONS.HIDDEN_PATH);
  assert.equal(typeof problems[0].message, 'string');
  assert.ok(problems[0].message.length > 0);
});
