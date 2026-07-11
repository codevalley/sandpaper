import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServeArguments, runCli } from '../bin/cli.js';

test('CLI module imports without running and parses provider before or after target', () => {
  assert.deepEqual(parseServeArguments(['--provider', 'codex', 'brain/index.html']), {
    target: 'brain/index.html', provider: 'codex',
  });
  assert.deepEqual(parseServeArguments(['brain/index.html', '--provider', 'claude']), {
    target: 'brain/index.html', provider: 'claude',
  });
  assert.deepEqual(parseServeArguments([]), { target: null, provider: null });
});

test('CLI parsing rejects duplicate, missing, unknown, and unrelated options', () => {
  assert.throws(() => parseServeArguments(['--provider']), /requires a value/);
  assert.throws(() => parseServeArguments(['--provider', 'other', 'brain']), /Unknown provider/);
  assert.throws(
    () => parseServeArguments(['--provider', 'codex', 'brain', '--provider', 'claude']),
    /only be specified once/,
  );
  assert.throws(() => parseServeArguments(['--verbose', 'brain']), /Unknown option/);
  assert.throws(() => parseServeArguments(['-v', 'brain']), /Unknown option/);
  assert.throws(() => parseServeArguments(['one', 'two']), /one target/);
});

test('CLI parsing requires the delimiter for a target beginning with dashes', () => {
  assert.throws(() => parseServeArguments(['--brain']), /Unknown option/);
  assert.deepEqual(parseServeArguments(['--', '-brain']), { target: '-brain', provider: null });
  assert.deepEqual(parseServeArguments(['--', '--brain']), { target: '--brain', provider: null });
  assert.deepEqual(parseServeArguments(['--provider', 'codex', '--', '--brain']), {
    target: '--brain', provider: 'codex',
  });
  assert.throws(() => parseServeArguments(['--', '--brain', 'extra']), /one target/);
});

function cliFixture({ preference = 'claude' } = {}) {
  const calls = {
    preferenceReads: 0, starts: [], registries: 0, preferences: 0, sessions: 0,
    preferenceRoots: [], sessionRoots: [],
  };
  const preferences = {
    getDefaultProvider() { calls.preferenceReads += 1; return preference; },
  };
  const sessions = {};
  const registry = {};
  const deps = {
    cwd: () => '/repo',
    existsSync: () => true,
    statSync: (target) => ({ isDirectory: () => target === '/repo' }),
    startServer: async (...args) => { calls.starts.push(args); return 'http://127.0.0.1:4848/'; },
    createFirstPartyRegistry: () => { calls.registries += 1; return registry; },
    createProviderPreferenceStore: (root) => {
      calls.preferences += 1; calls.preferenceRoots.push(root); return preferences;
    },
    createSessionStore: (root) => {
      calls.sessions += 1; calls.sessionRoots.push(root); return sessions;
    },
    execFile() {},
    platform: 'darwin',
    log() {},
  };
  return { calls, deps, preferences, sessions, registry };
}

test('explicit provider wins for bare-path launch without reading or rewriting preference', async () => {
  const fixture = cliFixture({ preference: 'claude' });
  await runCli(['--provider', 'codex', '.'], fixture.deps);
  assert.equal(fixture.calls.preferenceReads, 0);
  assert.equal(fixture.calls.registries, 1);
  assert.equal(fixture.calls.preferences, 1);
  assert.equal(fixture.calls.sessions, 1);
  assert.deepEqual(fixture.calls.starts, [[
    '/repo', 4848,
    {
      brain: true,
      initialProvider: 'codex',
      registry: fixture.registry,
      preferences: fixture.preferences,
      sessions: fixture.sessions,
    },
  ]]);
});

test('open launch uses the local preference only when no explicit provider exists', async () => {
  const fixture = cliFixture({ preference: 'codex' });
  await runCli(['open'], fixture.deps);
  assert.equal(fixture.calls.preferenceReads, 1);
  assert.equal(fixture.calls.starts[0][0], '/repo');
  assert.equal(fixture.calls.starts[0][2].initialProvider, 'codex');

  const explicit = cliFixture({ preference: 'codex' });
  await runCli(['open', '--provider', 'claude'], explicit.deps);
  assert.equal(explicit.calls.preferenceReads, 0);
  assert.equal(explicit.calls.starts[0][2].initialProvider, 'claude');
});

test('open stays scoped to cwd and rejects every positional target form', async () => {
  const fixture = cliFixture();
  for (const argv of [
    ['open', 'some-existing-directory'],
    ['open', '--', 'some-existing-directory'],
    ['open', '--', '--dash-looking-directory'],
  ]) {
    await assert.rejects(runCli(argv, fixture.deps), /open does not accept a target/);
  }
  assert.equal(fixture.calls.starts.length, 0);

  await runCli(['open'], fixture.deps);
  await runCli(['open', '--provider', 'codex'], fixture.deps);
  assert.equal(fixture.calls.starts[0][0], '/repo');
  assert.equal(fixture.calls.starts[1][2].initialProvider, 'codex');
  await assert.rejects(runCli(['open', '--provider'], fixture.deps), /requires a value/);
  await assert.rejects(runCli(['open', '--provider', 'other'], fixture.deps), /Unknown provider/);
  await assert.rejects(
    runCli(['open', '--provider', 'codex', '--provider', 'claude'], fixture.deps),
    /only be specified once/,
  );
});

test('a target outside cwd uses its own root for port, preference, and session state', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-cli-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'brain');
  mkdirSync(join(target, '.sandpaper'), { recursive: true });
  writeFileSync(join(target, '.sandpaper', 'manifest.json'), '{"port":6060,"defaultProvider":"codex"}\n');

  const fixture = cliFixture({ preference: 'codex' });
  fixture.deps.cwd = () => '/unrelated-launch-directory';
  fixture.deps.existsSync = () => true;
  fixture.deps.statSync = () => ({ isDirectory: () => true });
  fixture.deps.readFileSync = readFileSync;
  await runCli([target], fixture.deps);

  assert.deepEqual(fixture.calls.preferenceRoots, [target]);
  assert.deepEqual(fixture.calls.sessionRoots, [target]);
  assert.equal(fixture.calls.starts[0][1], 6060);
  assert.equal(fixture.calls.starts[0][2].initialProvider, 'codex');
});

test('explicit unavailable provider remains selected and does not mutate the target manifest', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-cli-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestDirectory = join(root, '.sandpaper');
  mkdirSync(manifestDirectory);
  const manifest = join(manifestDirectory, 'manifest.json');
  const original = '{"port":4848,"defaultProvider":"codex","project":"fixture"}\n';
  writeFileSync(manifest, original);
  const starts = [];
  await runCli(['--provider', 'claude', root], {
    cwd: () => '/unrelated-launch-directory',
    startServer: async (...args) => { starts.push(args); return 'http://127.0.0.1:4848/'; },
    createFirstPartyRegistry: () => ({
      get: () => ({ diagnose() { return { available: false }; } }),
    }),
    createSessionStore: () => ({}),
    log() {},
  });

  assert.equal(starts[0][2].initialProvider, 'claude');
  assert.equal(readFileSync(manifest, 'utf8'), original);
});

test('legacy preference fallback selects Claude when no explicit provider is supplied', async () => {
  const fixture = cliFixture({ preference: 'claude' });
  await runCli(['.'], fixture.deps);
  assert.equal(fixture.calls.preferenceReads, 1);
  assert.equal(fixture.calls.starts[0][2].initialProvider, 'claude');
});

test('setup subcommands forward normalized provider options and preserve lifecycle aliases', async () => {
  const calls = [];
  const deps = {
    cwd: () => '/repo',
    installSkill: (...args) => calls.push(['install', args]),
    scaffold: (...args) => calls.push(['scaffold', args]),
    upgrade: (...args) => calls.push(['upgrade', args]),
    rebuild: (...args) => calls.push(['rebuild', args]),
    doctor: (...args) => calls.push(['doctor', args]),
    log() {},
  };
  await runCli([
    'install-skill',
    '--integration', 'codex',
    '--provider', 'codex',
    '--no-hooks',
  ], deps);
  await runCli(['init', '--provider', 'codex'], deps);
  await runCli(['update'], deps);
  await runCli(['reset'], deps);
  await runCli(['doctor'], deps);
  assert.equal(calls[0][0], 'install');
  assert.deepEqual(calls[0][1][2], {
    integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false,
  });
  assert.equal(calls[1][0], 'scaffold');
  assert.deepEqual(calls[1][1][2], { defaultProvider: 'codex' });
  assert.deepEqual(calls.slice(2).map(([name]) => name), ['upgrade', 'rebuild', 'doctor']);
  assert.equal(calls[4][1][0], '/repo');
  assert.equal(calls[4][1][1], new URL('..', import.meta.url).pathname.replace(/\/$/, ''));
  await assert.rejects(runCli(['doctor', '--provider', 'codex'], deps), /does not accept options/);
  await assert.rejects(runCli(['init', '--integration', 'codex'], deps), /Unknown init option/);
  await assert.rejects(runCli(['init', '--no-hooks'], deps), /Unknown init option/);
  await assert.rejects(runCli(['init', '--unknown'], deps), /Unknown init option/);
});

test('help exposes the provider-aware setup grammar without changing serve overrides', async () => {
  const output = [];
  await runCli(['help'], { cwd: () => '/repo', log: (value) => output.push(value) });
  const help = output.join('\n');
  assert.match(help, /install-skill \[--integration claude\|codex\] \[--provider claude\|codex\] \[--no-hooks\]/);
  assert.match(help, /init \[--provider claude\|codex\]/);
  assert.match(help, /open \[--provider claude\|codex\]/);
});
