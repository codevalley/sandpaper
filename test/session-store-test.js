import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionStore } from '../src/session-store.js';
import { createProviderPreferenceStore } from '../src/provider-preferences.js';

function assertCorruptSession(t, state, label) {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, '.sandpaper');
  const file = join(directory, 'session.json');
  mkdirSync(directory);
  const original = JSON.stringify(state, null, 2) + '\n';
  writeFileSync(file, original);
  const store = createSessionStore(root);
  assert.deepEqual(store.inspect(), { version: 2, pages: {}, corrupt: true }, label);
  assert.equal(store.get({ page: '/', provider: 'claude' }), null, label);
  assert.throws(
    () => store.set({ page: '/', provider: 'claude', resumeId: 'replacement' }),
    /Session state is corrupt/,
    label,
  );
  assert.throws(() => store.clear({ page: '/', provider: 'claude' }), /Session state is corrupt/, label);
  assert.equal(readFileSync(file, 'utf8'), original, label);
}

test('empty session state starts at version 2 without creating a file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  assert.equal(store.get({ page: '/', provider: 'claude' }), null);
  assert.deepEqual(store.inspect(), { version: 2, pages: {} });
  assert.equal(existsSync(join(root, '.sandpaper', 'session.json')), false);
});

test('session store scopes resume IDs by page and provider', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  store.set({ page: '/', provider: 'claude', resumeId: 'claude-1' });
  store.set({ page: '/', provider: 'codex', resumeId: 'codex-1' });
  store.set({ page: '/other.html', provider: 'codex', resumeId: 'codex-2' });
  assert.equal(store.get({ page: '/', provider: 'claude' }), 'claude-1');
  assert.equal(store.get({ page: '/', provider: 'codex' }), 'codex-1');
  assert.equal(store.get({ page: '/other.html', provider: 'codex' }), 'codex-2');
  store.clear({ page: '/', provider: 'codex' });
  assert.equal(store.get({ page: '/', provider: 'codex' }), null);
  assert.equal(store.get({ page: '/', provider: 'claude' }), 'claude-1');
});

test('legacy session migrates to the requested page Claude entry', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.sandpaper'));
  writeFileSync(join(root, '.sandpaper', 'session.json'), '{"sessionId":"legacy-1"}\n');
  const store = createSessionStore(root, { legacyPage: '/' });
  assert.equal(store.get({ page: '/', provider: 'claude' }), 'legacy-1');
  assert.equal(store.inspect().version, 2);
});

test('nested legacy Claude session is claimed once by the current page', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, 'brain');
  mkdirSync(join(brain, '.sandpaper'), { recursive: true });
  const legacyFile = join(brain, '.sandpaper', 'session.json');
  const legacyBytes = '{"sessionId":"nested-legacy"}\n';
  writeFileSync(join(brain, 'index.html'), '<!doctype html>');
  writeFileSync(join(brain, 'decisions.html'), '<!doctype html>');
  writeFileSync(legacyFile, legacyBytes);
  const store = createSessionStore(root);

  assert.equal(store.claimLegacy({
    page: '/brain/index.html', provider: 'claude', pageFile: join(brain, 'index.html'),
  }), 'nested-legacy');
  assert.equal(store.get({ page: '/brain/index.html', provider: 'claude' }), 'nested-legacy');
  assert.equal(store.get({ page: '/brain/index.html', provider: 'codex' }), null);
  assert.equal(store.claimLegacy({
    page: '/brain/decisions.html', provider: 'claude', pageFile: join(brain, 'decisions.html'),
  }), null);
  assert.equal(store.get({ page: '/brain/decisions.html', provider: 'claude' }), null);
  store.clear({ page: '/brain/index.html', provider: 'claude' });
  assert.equal(store.claimLegacy({
    page: '/brain/index.html', provider: 'claude', pageFile: join(brain, 'index.html'),
  }), null);
  assert.equal(readFileSync(legacyFile, 'utf8'), legacyBytes);
});

test('unknown session schemas fail closed without changing their bytes', (t) => {
  const cases = [
    ['future version', { version: 3, pages: {} }, true],
    ['future version with legacy id', { version: 3, sessionId: 'do-not-migrate' }, true],
    ['unknown object', { sessionId: 'legacy', extra: true }, false],
    ['array', ['legacy'], false],
  ];
  for (const [label, value, unsupportedVersion] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, '.sandpaper');
    mkdirSync(directory);
    const file = join(directory, 'session.json');
    const original = JSON.stringify(value, null, 2) + '\n';
    writeFileSync(file, original);
    const store = createSessionStore(root);
    assert.deepEqual(store.inspect(), {
      version: 2, pages: {}, corrupt: true, ...(unsupportedVersion ? { unsupportedVersion: true } : {}),
    }, label);
    assert.equal(store.get({ page: '/', provider: 'claude' }), null, label);
    assert.throws(
      () => store.set({ page: '/', provider: 'claude', resumeId: 'replacement' }),
      /Session state is corrupt/,
      label,
    );
    assert.throws(() => store.clear({ page: '/', provider: 'claude' }), /Session state is corrupt/, label);
    assert.equal(readFileSync(file, 'utf8'), original, label);
    assert.doesNotMatch(JSON.stringify(store.inspect()), /do-not-migrate|legacy/);
  }
});

test('session writes replace the file atomically and reject corrupt state', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  store.set({ page: '/brain/index.html', provider: 'codex', resumeId: 'codex-1' });
  const directory = join(root, '.sandpaper');
  const file = join(directory, 'session.json');
  assert.equal(existsSync(file), true);
  assert.deepEqual(readdirSync(directory), ['session.json']);
  writeFileSync(file, '{not json}\n');
  assert.deepEqual(store.inspect(), { version: 2, pages: {}, corrupt: true });
  assert.throws(
    () => store.set({ page: '/', provider: 'claude', resumeId: 'claude-1' }),
    /Session state is corrupt/,
  );
  assert.throws(() => store.clear({ page: '/', provider: 'claude' }), /Session state is corrupt/);
});

test('version 2 session state rejects an array pages collection without mutating it', (t) => {
  assertCorruptSession(t, { version: 2, pages: [] }, 'array pages');
});

test('version 2 session state rejects malformed page, provider, and resume records', (t) => {
  const cases = [
    ['invalid page key', { version: 2, pages: { 'brain/index.html': { claude: { resumeId: 'claude-1' } } } }],
    ['array page record', { version: 2, pages: { '/': [] } }],
    ['unknown provider key', { version: 2, pages: { '/': { other: { resumeId: 'other-1' } } } }],
    ['array provider record', { version: 2, pages: { '/': { claude: [] } } }],
    ['empty resume ID', { version: 2, pages: { '/': { claude: { resumeId: '' } } } }],
    ['non-string resume ID', { version: 2, pages: { '/': { codex: { resumeId: 42 } } } }],
  ];
  for (const [label, state] of cases) assertCorruptSession(t, state, label);
});

test('session store strictly validates keys and resume IDs', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  assert.throws(() => store.get({ page: 'brain/index.html', provider: 'claude' }), /Invalid session key/);
  assert.throws(() => store.get({ page: '/', provider: 'other' }), /Invalid session key/);
  assert.throws(() => store.set({ page: '/', provider: 'codex', resumeId: '' }), /Invalid resume ID/);
});

test('preference defaults legacy manifests to Claude and preserves unrelated fields', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-pref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.sandpaper'));
  const file = join(root, '.sandpaper', 'manifest.json');
  writeFileSync(file, '{"version":1,"project":"Fixture","port":4848}\n');
  const prefs = createProviderPreferenceStore(root);
  assert.equal(prefs.getDefaultProvider(), 'claude');
  prefs.setDefaultProvider('codex');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    version: 1, project: 'Fixture', port: 4848, defaultProvider: 'codex',
  });
});

test('preference store preserves bytes when the effective provider is unchanged', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-pref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.sandpaper'));
  const file = join(root, '.sandpaper', 'manifest.json');
  const original = '{ "version": 1, "project": "Fixture" }\n';
  writeFileSync(file, original);
  const prefs = createProviderPreferenceStore(root);
  assert.equal(prefs.getDefaultProvider(), 'claude');
  prefs.setDefaultProvider('claude');
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('preference store validates provider IDs and rejects corrupt manifests', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-pref-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.sandpaper'));
  const file = join(root, '.sandpaper', 'manifest.json');
  const prefs = createProviderPreferenceStore(root);
  assert.throws(() => prefs.setDefaultProvider('other'), /Invalid provider/);
  writeFileSync(file, '{not json}\n');
  assert.throws(() => prefs.getDefaultProvider(), /Provider preferences are corrupt/);
  assert.throws(() => prefs.setDefaultProvider('codex'), /Provider preferences are corrupt/);
});
