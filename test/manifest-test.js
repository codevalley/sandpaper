import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MANIFEST_VERSION,
  PROVIDERS,
  migrateManifest,
  readManifest,
  writeManifest,
} from '../src/manifest.js';
import { parseSetupOptions } from '../src/setup.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.sandpaper');
  const file = join(directory, 'manifest.json');
  mkdirSync(directory);
  return { root, directory, file };
}

test('v1 migration preserves identity, counters, and unknown fields exactly', () => {
  const legacy = {
    version: 1,
    project: 'Fixture',
    created: '2026-07-11',
    source: { base: 'https://example.test/repo' },
    port: 4999,
    theme: 'brain/assets/theme.css',
    lenses: ['product'],
    books: ['log'],
    cidPrefixes: { worklog: 'w' },
    counters: { w: 12 },
    brainIdentity: { id: 'brain-1' },
    futureField: { keep: true },
  };
  const original = structuredClone(legacy);

  assert.deepEqual(migrateManifest(legacy), {
    ...legacy,
    version: 2,
    defaultProvider: 'claude',
    integrations: ['claude', 'codex'],
    hooksEnabled: true,
  });
  assert.deepEqual(legacy, original);
  assert.equal(MANIFEST_VERSION, 2);
  assert.deepEqual(PROVIDERS, ['claude', 'codex']);
});

test('v2 normalization is canonical, deterministic, and idempotent', () => {
  const value = {
    version: 2,
    project: 'Fixture',
    defaultProvider: 'codex',
    integrations: ['codex', 'claude', 'codex'],
    hooksEnabled: false,
    custom: 'preserved',
  };
  const expected = {
    ...value,
    integrations: ['claude', 'codex'],
  };
  assert.deepEqual(migrateManifest(value), expected);
  assert.deepEqual(migrateManifest(migrateManifest(value)), expected);
  assert.deepEqual(migrateManifest({ version: 2 }), {
    version: 2,
    defaultProvider: 'claude',
    integrations: ['claude', 'codex'],
    hooksEnabled: true,
  });
});

test('manifest normalization rejects malformed and contradictory explicit state', () => {
  const cases = [
    [null, /plain object/],
    [[], /plain object/],
    ['manifest', /plain object/],
    [{}, /Missing manifest version/],
    [{ version: 3 }, /Unsupported manifest version: 3/],
    [{ version: 2, defaultProvider: 'other' }, /Invalid default provider/],
    [{ version: 2, integrations: 'claude' }, /Invalid integrations/],
    [{ version: 2, integrations: [] }, /at least one integration/],
    [{ version: 2, integrations: ['other'] }, /Invalid integration provider/],
    [{ version: 2, defaultProvider: 'codex', integrations: ['claude'] }, /not installed/],
    [{ version: 2, hooksEnabled: 'yes' }, /Invalid hooks flag/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => migrateManifest(value), pattern, JSON.stringify(value));
  }
});

test('reads normalize without rewriting original bytes and reject corrupt bytes unchanged', (t) => {
  const { file } = fixture(t);
  const legacyBytes = '{"version":1,"project":"Fixture","counter":9}\n';
  writeFileSync(file, legacyBytes);
  assert.deepEqual(readManifest(file), {
    version: 2,
    project: 'Fixture',
    counter: 9,
    defaultProvider: 'claude',
    integrations: ['claude', 'codex'],
    hooksEnabled: true,
  });
  assert.equal(readFileSync(file, 'utf8'), legacyBytes);

  for (const bytes of [
    '{not json}\n',
    '[]\n',
    '42\n',
    '{"project":"missing-version"}\n',
    '{"version":9}\n',
    '{"version":2,"defaultProvider":"other"}\n',
    '{"version":2,"integrations":[]}\n',
    '{"version":2,"hooksEnabled":"yes"}\n',
  ]) {
    writeFileSync(file, bytes);
    assert.throws(() => readManifest(file), /Manifest|manifest|provider|integration|hooks/);
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
});

test('writes normalize atomically with a newline and restrictive mode', (t) => {
  const { directory, file } = fixture(t);
  const written = writeManifest(file, { version: 1, project: 'Fixture', counters: { w: 7 } });
  assert.deepEqual(written, {
    version: 2,
    project: 'Fixture',
    counters: { w: 7 },
    defaultProvider: 'claude',
    integrations: ['claude', 'codex'],
    hooksEnabled: true,
  });
  const bytes = readFileSync(file, 'utf8');
  assert.equal(bytes.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(bytes), written);
  assert.deepEqual(readdirSync(directory), ['manifest.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('failed writes preserve existing corrupt or valid bytes and leave no temporary files', (t) => {
  const { directory, file } = fixture(t);
  const corrupt = '{not json}\n';
  writeFileSync(file, corrupt);
  assert.throws(
    () => writeManifest(file, { version: 2, defaultProvider: 'codex' }),
    /Manifest JSON is invalid/,
  );
  assert.equal(readFileSync(file, 'utf8'), corrupt);
  assert.deepEqual(readdirSync(directory), ['manifest.json']);

  rmSync(file);
  writeManifest(file, { version: 2, project: 'Fixture' });
  const valid = readFileSync(file, 'utf8');
  assert.throws(
    () => writeManifest(file, { version: 2, integrations: [] }),
    /at least one integration/,
  );
  assert.equal(readFileSync(file, 'utf8'), valid);
  assert.deepEqual(readdirSync(directory), ['manifest.json']);
  assert.equal(existsSync(`${file}.tmp-${process.pid}`), false);
});

test('setup option defaults keep installation and runtime preference separate', () => {
  assert.deepEqual(parseSetupOptions([]), {
    integrations: ['claude', 'codex'],
    defaultProvider: 'claude',
    hooksEnabled: true,
  });
  assert.deepEqual(
    parseSetupOptions(['--integration', 'codex', '--provider', 'codex', '--no-hooks']),
    { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false },
  );
  assert.deepEqual(parseSetupOptions(['--provider', 'codex']), {
    integrations: ['claude', 'codex'],
    defaultProvider: 'codex',
    hooksEnabled: true,
  });
  assert.deepEqual(
    parseSetupOptions(['--integration', 'codex', '--integration', 'claude', '--integration', 'codex']),
    { integrations: ['claude', 'codex'], defaultProvider: 'claude', hooksEnabled: true },
  );
});

test('setup option parsing rejects ambiguous partial and invalid input', () => {
  const cases = [
    [['--integration', 'claude', '--provider', 'codex'], /not installed/],
    [['--integration'], /requires a value/],
    [['--provider'], /requires a value/],
    [['--integration', '--provider', 'claude'], /requires a value/],
    [['--integration', 'other'], /Unknown integration/],
    [['--provider', 'other'], /Unknown provider/],
    [['--provider', 'claude', '--provider', 'codex'], /only be specified once/],
    [['--no-hooks', '--no-hooks'], /only be specified once/],
    [['--unknown'], /Unknown setup option/],
    [['codex'], /Unexpected setup argument/],
    [['--'], /Unknown setup option/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseSetupOptions(argv), pattern, argv.join(' '));
  }
});
