import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  APPROVED_FILE_RULES,
  FORBIDDEN_PATH,
  MAX_PACKED_KB,
  MAX_UNPACKED_KB,
  RUNTIME_DEPENDENCY_FIELDS,
  SECRET_PATH,
  SECRET_PATTERNS,
  assertNoRuntimeDependencyMetadata,
  containsSecretPattern,
  expectedPackedPaths,
  isForbiddenPackagePath,
  isSecretPackagePath,
  normalizePackagePath,
  relativeEsmImports,
} from '../src/package-contract.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const dependencyMetadataValues = {
  dependencies: { runtime: '1.0.0' },
  optionalDependencies: { optional: '1.0.0' },
  peerDependencies: { peer: '1.0.0' },
  peerDependenciesMeta: { peer: { optional: true } },
  bundledDependencies: ['bundled'],
  bundleDependencies: ['bundle-alias'],
  overrides: { transitive: '1.0.0' },
};

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

test('runtime dependency metadata is rejected from one shared field inventory', () => {
  assert.deepEqual(RUNTIME_DEPENDENCY_FIELDS, Object.keys(dependencyMetadataValues));
  assert.doesNotThrow(() => assertNoRuntimeDependencyMetadata({
    name: 'fixture',
    devDependencies: { '@playwright/test': '^1.61.1' },
  }));
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    assert.throws(
      () => assertNoRuntimeDependencyMetadata({
        name: 'fixture',
        devDependencies: { testOnly: '1.0.0' },
        [field]: dependencyMetadataValues[field],
      }),
      new RegExp(field),
      field,
    );
    const empty = field === 'bundledDependencies' || field === 'bundleDependencies' ? [] : {};
    assert.throws(() => assertNoRuntimeDependencyMetadata({ [field]: empty }), new RegExp(field), `${field}:empty`);
  }
});

test('verify-publish exits nonzero for every runtime dependency metadata field', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'sandpaper-verifier-dependencies-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'bin'));
  mkdirSync(join(fixture, 'src'));
  copyFileSync(join(ROOT, 'bin', 'verify-publish.js'), join(fixture, 'bin', 'verify-publish.js'));
  copyFileSync(join(ROOT, 'src', 'package-contract.js'), join(fixture, 'src', 'package-contract.js'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({
      ...manifest,
      [field]: dependencyMetadataValues[field],
    }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [join(fixture, 'bin', 'verify-publish.js')], {
      cwd: fixture,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, field);
    assert.match(result.stderr, new RegExp(field), field);
  }
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
    "const lazyTemplate = import(`./lazy-template.js`);",
    "import/* reviewed */ './commented.js';",
    "export /* reviewed */ { three } from './three.js';",
    "import // side-effect note",
    "  './side-line.js';",
    "import { four } from // from note",
    "  './from-line.js';",
    "import { six } from /* from block note */ './from-block.js';",
    "export { five } from /* export note */ './export-block.js';",
    "export { seven } from // export line note",
    "  './export-line.js';",
    "const dynamicBlock = import( /* dynamic note */ './dynamic-block.js');",
    "const dynamicLine = import( // dynamic line note",
    "  './dynamic-line.js');",
    "const dynamicOptions = import('./dynamic-options.json', { assert: { type: 'json' } });",
    "import '\\x2e/escaped-hex.js';",
    "const escapedUnicode = import('\\u002e/escaped-unicode.js');",
    "import value from 'node:fs';",
    "api.import('./member-call.js');",
    "api?.import('./optional-member-call.js');",
    "api /* member note */ . /* call note */ import('./commented-member-call.js');",
    "import.meta.resolve('./import-meta.js');",
    `const example = "import './not-real.js'";`,
    "const template = `import('./not-real-template.js')`;",
    "const regex = /import\\(['\"]\\.\\/not-real-regex\\.js['\"]\\)/;",
    "// import './not-real-either.js';",
    "/* export * from './also-not-real.js'; */",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), [
    './side-effect.js', '../one.js', './two.js', './lazy.js', './lazy-template.js', './commented.js', './three.js',
    './side-line.js', './from-line.js', './from-block.js', './export-block.js', './export-line.js',
    './dynamic-block.js', './dynamic-line.js', './dynamic-options.json', './escaped-hex.js',
    './escaped-unicode.js',
  ]);
});

test('template raw text stays ignored while every nested substitution is lexed', () => {
  const source = [
    "const raw = `raw import('./raw-template.js')`;",
    "const direct = `before ${import('./template-expression.js')} after`;",
    "const nested = `outer ${`inner raw import('./raw-inner.js') ${import('./nested-template.js')}`} tail`;",
    "const complex = `raw ${(() => {",
    "  const text = \"import('./template-string.js')\";",
    "  // import('./template-comment.js')",
    "  if (ok) /import(\".\\/template-regex.js\")/.test(value);",
    "  return { nested: { value: import('./template-deep.js') } };",
    "})()} end`;",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), [
    './template-expression.js', './nested-template.js', './template-deep.js',
  ]);
});

test('only the initial hashbang line is skipped before real imports are scanned', () => {
  const source = [
    "#!/usr/bin/env -S node --import './loader.js'",
    "import './real-after-hashbang.js';",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), ['./real-after-hashbang.js']);
});

test('regex literals after control flow and division never become fake imports', () => {
  const source = [
    "if (ok) /import(\".\\/if-fake.js\")/.test(value);",
    "while (ok) /import(\".\\/while-fake.js\")/.exec(value);",
    "if (ok) run(); else /import(\".\\/else-fake.js\")/.test(value);",
    "do /import(\".\\/do-fake.js\")/.test(value); while (false);",
    "for (; ok;) /import(\".\\/for-fake.js\")/.test(value);",
    "const ratio = 6 / /import(\".\\/division-fake.js\")/.source.length;",
    "const loaded = total / import('./division-real.js');",
    "import './real-after-regex.js';",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), ['./division-real.js', './real-after-regex.js']);
});

test('module-name reserved words do not hide static relative imports', () => {
  const source = [
    "import { export as importedValue } from './import-reserved.js';",
    "export { import as exportedValue } from './export-reserved.js';",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), [
    './import-reserved.js',
    './export-reserved.js',
  ]);
});

test('regex literals after statement boundaries stay ignored', () => {
  const source = [
    "/import(\".\\/standalone-fake.js\")/.test(value);",
    "{} /import(\".\\/block-fake.js\")/.test(value);",
    "function finished() {} /import(\".\\/function-fake.js\")/.test(value);",
    "try {} catch {} /import(\".\\/catch-fake.js\")/.test(value);",
    "import './statement-boundary-real.js';",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), ['./statement-boundary-real.js']);
});

test('division after object literals and reserved-word members preserves genuine imports', () => {
  const source = [
    "const objectRatio = ({ value: 12 }).value / import('./object-division.js');",
    "const returnRatio = api.return / import('./member-return.js');",
    "const deleteRatio = api.delete / import('./member-delete.js');",
    "const awaitRatio = api.await / import('./member-await.js');",
    "const doRatio = api.do / import('./member-do.js');",
    "const elseRatio = api.else / import('./member-else.js');",
    "const yieldRatio = api.yield / import('./member-yield.js');",
  ].join('\n');
  assert.deepEqual(relativeEsmImports(source), [
    './object-division.js',
    './member-return.js',
    './member-delete.js',
    './member-await.js',
    './member-do.js',
    './member-else.js',
    './member-yield.js',
  ]);
});

test('semicolon-free export stress has deterministic linear work', () => {
  for (const count of [4_000, 8_000, 12_000]) {
    const source = Array.from({ length: count }, (_, index) => `export const v${index}=0\n`).join('');
    const metrics = {};
    assert.deepEqual(relativeEsmImports(source, { metrics }), []);
    assert.equal(metrics.characters, source.length);
    assert.ok(metrics.work <= source.length * 8, `${count} exports used ${metrics.work} work for ${source.length} chars`);
  }
});

test('malformed or unterminated lexical and delimiter input fails closed', () => {
  for (const source of [
    "'unterminated string",
    '/* unterminated block comment',
    '`unterminated template',
    "`unterminated substitution ${ import('./hidden.js') }",
    '/unterminated[regex/',
    "import('./missing-close.js'",
    "export { missingClose from './missing-close-export.js';",
    "import('\\xZZ/malformed-escape.js');",
    "import('\\uZZZZ/malformed-unicode.js');",
  ]) {
    assert.throws(() => relativeEsmImports(source), /unterminated|malformed|unbalanced/i, source);
  }
});
