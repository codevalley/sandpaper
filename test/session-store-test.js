import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionStore } from '../src/session-store.js';
import { createProviderPreferenceStore } from '../src/provider-preferences.js';

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
