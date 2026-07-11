import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPROVED_FILE_RULES,
  FORBIDDEN_PATH,
  MAX_PACKED_KB,
  MAX_UNPACKED_KB,
  SECRET_PATH,
  SECRET_PATTERNS,
  containsSecretPattern,
  expectedPackedPaths,
  isForbiddenPackagePath,
  isSecretPackagePath,
  normalizePackagePath,
  relativeEsmImports,
} from '../src/package-contract.js';

test('the explicit package contract has 56 positive rules and 58 actual npm entries', () => {
  const positive = APPROVED_FILE_RULES.filter((rule) => !rule.startsWith('!'));
  assert.equal(positive.length, 56);
  assert.deepEqual(APPROVED_FILE_RULES.slice(-3), ['!brain/README.md', 'README.md', 'CHANGELOG.md']);
  assert.deepEqual(expectedPackedPaths(), ['LICENSE', 'package.json', ...positive].sort());
  assert.equal(expectedPackedPaths().length, 58);
  assert.ok(APPROVED_FILE_RULES.includes('src/package-contract.js'));
  assert.ok(APPROVED_FILE_RULES.includes('src/session-store.js'));
  assert.ok(APPROVED_FILE_RULES.includes('skill/sandpaper/references/workflows/release.md'));
  assert.ok(APPROVED_FILE_RULES.every((rule) => !/[?*\[\]{}]/.test(rule)));
  assert.ok(MAX_PACKED_KB > 0);
  assert.ok(MAX_UNPACKED_KB > MAX_PACKED_KB);
});

test('package paths normalize strictly before segment-aware forbidden checks', () => {
  assert.equal(normalizePackagePath('src/package-contract.js'), 'src/package-contract.js');
  for (const path of ['', '.', '..', '/absolute', 'C:/absolute', 'src//file.js', 'src/./file.js',
    'src/../file.js', 'src\\file.js', 'src/file.js\0tail']) {
    assert.throws(() => normalizePackagePath(path), /package path/i, path);
  }

  for (const path of [
    '.env', 'nested/.env.local', 'Nested/.CoDeX/hooks.json', 'src/.hidden/file.js',
    'test/example.js', 'nested/node_modules/pkg.js', 'AGENTS.md', 'nested/.github/workflow.yml',
  ]) {
    assert.equal(isForbiddenPackagePath(path), true, path);
    assert.equal(FORBIDDEN_PATH.test(path), true, path);
  }
  for (const path of ['README.md', 'src/manifest.js', 'brain/assets/theme.css']) {
    assert.equal(isForbiddenPackagePath(path), false, path);
  }
});

test('secret path and byte checks cover current token formats without stateful regexes', () => {
  for (const path of ['.npmrc', 'nested/.ENV.production', 'keys/client.pem', 'id_ed25519']) {
    assert.equal(isSecretPackagePath(path), true, path);
    assert.equal(SECRET_PATH.test(path), true, path);
  }
  const secrets = [
    `sk-proj-${'A'.repeat(32)}`,
    `sk-ant-api03-${'B'.repeat(32)}`,
    `github_pat_${'C'.repeat(32)}`,
    `npm_${'D'.repeat(32)}`,
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  ];
  for (const secret of secrets) {
    assert.equal(containsSecretPattern(Buffer.from(secret)), true, secret.slice(0, 24));
    assert.equal(containsSecretPattern(Buffer.from(secret)), true, 'repeat must be deterministic');
  }
  for (const example of ['sk-your-key', 'npm_TOKEN', '$OPENAI_API_KEY', 'github_pat_…']) {
    assert.equal(containsSecretPattern(Buffer.from(example)), false, example);
  }
  assert.ok(SECRET_PATTERNS.every((pattern) => pattern.global === false && pattern.sticky === false));
});

test('relative ESM import discovery covers static, re-export, side-effect, and dynamic imports', () => {
  const source = [
    "import './side-effect.js';",
    "import { one } from '../one.js';",
    "export { two } from './two.js';",
    "const lazy = import('./lazy.js');",
    "import/* reviewed */ './commented.js';",
    "export /* reviewed */ { three } from './three.js';",
    "import value from 'node:fs';",
    `const example = "import './not-real.js'";`,
    "// import './not-real-either.js';",
    "/* export * from './also-not-real.js'; */",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), [
    './side-effect.js', '../one.js', './two.js', './lazy.js', './commented.js', './three.js',
  ]);
});
