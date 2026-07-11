import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as setup from '../src/setup.js';
import { installIntegrations } from '../src/integrations.js';

const PACKAGE = new URL('..', import.meta.url).pathname;
const META = '<meta name="sandpaper:source" content="https://github.com/example/fixture/blob/HEAD/" data-pkg="@fixture/brain" />';

function write(target, relative, contents) {
  const file = join(target, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, contents);
}

function thrown(fn) {
  let error;
  assert.throws(fn, (value) => { error = value; return true; });
  return error;
}

function page(body, meta = META) {
  return `<!doctype html><html><head>${meta}</head><body>${body}</body></html>`;
}

function repositorySnapshot(target) {
  const entries = [];
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = lstatSync(file);
      if (stats.isDirectory()) {
        entries.push({ path: `${relative}/`, type: 'directory', mode: stats.mode & 0o777 });
        walk(file, relative);
      } else {
        const type = stats.isSymbolicLink() ? 'symlink' : stats.isFile() ? 'file' : 'special';
        entries.push({
          path: relative,
          type,
          mode: stats.mode & 0o777,
          bytes: type === 'file' ? readFileSync(file).toString('base64') : null,
        });
      }
    }
  };
  walk(target);
  return entries;
}

const ACTIONS = ['canvas', 'decide', 'help', 'init', 'learn', 'log', 'open', 'plan', 'release', 'serve', 'stamp', 'sync', 'theme'];
const BEGIN = '<!-- sandpaper:begin -->';
const END = '<!-- sandpaper:end -->';

function quietInstall(target, options, dependencies) {
  const log = console.log;
  console.log = () => {};
  try { setup.installSkill(target, PACKAGE, options, dependencies); } finally { console.log = log; }
}

function managedCount(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split(BEGIN).length - 1;
}

function assertExactIntegrationBytes(target) {
  for (const action of ACTIONS) {
    const wrapper = join(target, '.claude', 'commands', 'sandpaper', `${action}.md`);
    const workflowSource = join(PACKAGE, 'skill', 'sandpaper', 'references', 'workflows', `${action}.md`);
    assert.deepEqual(readFileSync(wrapper), readFileSync(join(PACKAGE, 'skill', 'sandpaper', 'commands', `${action}.md`)));
    assert.deepEqual(readFileSync(join(target, '.claude', 'commands', 'sandpaper', 'references', 'workflows', `${action}.md`)), readFileSync(workflowSource));
    assert.deepEqual(readFileSync(join(target, '.agents', 'skills', 'sandpaper', 'references', 'workflows', `${action}.md`)), readFileSync(workflowSource));
  }
  assert.deepEqual(
    readFileSync(join(target, '.agents', 'skills', 'sandpaper', 'SKILL.md')),
    readFileSync(join(PACKAGE, 'skill', 'sandpaper', 'SKILL.md')),
  );
}

test('default installation creates exact Claude and Codex integration trees from canonical bytes', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-dual-integration-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/dual' }));

  quietInstall(target);

  assert.deepEqual(
    readdirSync(join(target, '.claude', 'commands', 'sandpaper')).sort(),
    [...ACTIONS.map((action) => `${action}.md`), 'references'].sort(),
  );
  assert.deepEqual(
    readdirSync(join(target, '.agents', 'skills', 'sandpaper')).sort(),
    ['SKILL.md', 'references'],
  );
  assertExactIntegrationBytes(target);
  assert.equal(managedCount(join(target, 'CLAUDE.md')), 1);
  assert.equal(managedCount(join(target, 'AGENTS.md')), 1);
  const claudeBlock = readFileSync(join(target, 'CLAUDE.md'), 'utf8');
  const codexBlock = readFileSync(join(target, 'AGENTS.md'), 'utf8');
  assert.match(claudeBlock, /brain\/index\.html/);
  assert.match(claudeBlock, /\/sandpaper:<action>/);
  assert.match(codexBlock, /brain\/index\.html/);
  assert.match(codexBlock, /\$sandpaper <action>/);
  assert.doesNotMatch(claudeBlock + codexBlock, /canvas\|decide|release ordering|stamp checklist/i);
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart, [{
    matcher: '*',
    hooks: [{ type: 'command', command: 'node .sandpaper/hooks/brain-inject.js', timeout: 10 }],
  }]);
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.codex', 'hooks.json'), 'utf8')).hooks, {
    SessionStart: [{
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command: 'node .sandpaper/hooks/brain-inject.js', timeout: 10 }],
    }],
    Stop: [{
      hooks: [{ type: 'command', command: 'node .sandpaper/hooks/brain-stamp-check.js', timeout: 20 }],
    }],
  });
  for (const script of ['brain-inject.js', 'brain-stamp-check.js']) {
    assert.deepEqual(
      readFileSync(join(target, '.sandpaper', 'hooks', script)),
      readFileSync(join(PACKAGE, 'bin', script)),
    );
  }
});

test('solo and no-hooks installations keep hook wiring truthful while always copying scripts', (t) => {
  for (const provider of ['claude', 'codex']) {
    const target = mkdtempSync(join(tmpdir(), `sandpaper-solo-hooks-${provider}-`));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    write(target, 'package.json', JSON.stringify({ name: `@fixture/${provider}` }));
    quietInstall(target, { integrations: [provider], defaultProvider: provider, hooksEnabled: true });
    assert.equal(existsSync(join(target, provider === 'claude' ? '.claude/settings.json' : '.codex/hooks.json')), true);
    assert.equal(existsSync(join(target, provider === 'claude' ? '.codex/hooks.json' : '.claude/settings.json')), false);
    for (const script of ['brain-inject.js', 'brain-stamp-check.js']) {
      assert.deepEqual(readFileSync(join(target, '.sandpaper/hooks', script)), readFileSync(join(PACKAGE, 'bin', script)));
    }
  }

  const disabled = mkdtempSync(join(tmpdir(), 'sandpaper-no-hooks-'));
  t.after(() => rmSync(disabled, { recursive: true, force: true }));
  write(disabled, 'package.json', JSON.stringify({ name: '@fixture/no-hooks' }));
  quietInstall(disabled, { integrations: ['claude', 'codex'], defaultProvider: 'claude', hooksEnabled: false });
  assert.equal(existsSync(join(disabled, '.claude/settings.json')), false);
  assert.equal(existsSync(join(disabled, '.codex/hooks.json')), false);
  for (const script of ['brain-inject.js', 'brain-stamp-check.js']) {
    assert.deepEqual(readFileSync(join(disabled, '.sandpaper/hooks', script)), readFileSync(join(PACKAGE, 'bin', script)));
  }
});

test('install output states the Codex project and per-command trust boundary', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-hook-trust-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/trust' }));
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { setup.installSkill(target, PACKAGE); } finally { console.log = log; }
  const output = lines.join('\n');
  assert.match(output, /Codex hook configuration.*written/i);
  assert.match(output, /project.*reviewed.*trusted/i);
  assert.match(output, /each command hook.*reviewed.*trusted/i);
  assert.match(output, /startup review|\/hooks/i);
  assert.doesNotMatch(output, /Codex hooks (?:are )?active/i);
  assert.match(output, /✓\s+13 slash commands/);
  assert.match(output, /✓\s+Codex skill/);
  assert.match(output, /✓\s+manifest/);
  assert.match(output, /✓\s+Claude hook config/);
  assert.match(output, /✓\s+Codex hook config/);
});

test('rolled-back installation output never claims transaction-owned surfaces succeeded', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-install-output-rollback-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/output-rollback' }));
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    assert.throws(() => setup.installSkill(target, PACKAGE, undefined, {
      integrationHooks: {
        afterInstall({ label }) {
          if (label === 'codex-hooks') throw new Error('injected output rollback');
        },
      },
    }), /Could not commit Sandpaper integration transaction/);
  } finally {
    console.log = log;
  }

  const output = lines.join('\n');
  assert.doesNotMatch(output, /✓\s+13 slash commands/);
  assert.doesNotMatch(output, /✓\s+Codex skill/);
  assert.doesNotMatch(output, /✓\s+manifest/);
  assert.doesNotMatch(output, /✓\s+Claude hook config/);
  assert.doesNotMatch(output, /✓\s+Codex hook config/);
  assert.match(output, /✓\s+design system/);
  assert.match(output, /✓\s+multi-page shell/);
});

test('invalid second-provider config aborts before either config or Task 3 surfaces change', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-hook-preflight-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/hook-preflight' }));
  write(target, '.codex/hooks.json', '{invalid');
  const before = taskFourSnapshot(target);

  assert.throws(() => quietInstall(target), /hook|file transaction|integration transaction/i);
  assert.deepEqual(taskFourSnapshot(target), before);
});

test('hook script target symlinks and special path components reject without outside writes or blocking', {
  skip: process.platform === 'win32',
}, (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'sandpaper-hook-script-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));

  const symlinked = mkdtempSync(join(tmpdir(), 'sandpaper-hook-script-link-'));
  t.after(() => rmSync(symlinked, { recursive: true, force: true }));
  write(symlinked, 'package.json', JSON.stringify({ name: '@fixture/hook-link' }));
  mkdirSync(join(symlinked, '.sandpaper'));
  symlinkSync(outside, join(symlinked, '.sandpaper/hooks'));
  assert.throws(() => quietInstall(symlinked), /symlink/i);
  assert.deepEqual(readdirSync(outside), []);

  const fifo = mkdtempSync(join(tmpdir(), 'sandpaper-hook-script-fifo-'));
  t.after(() => rmSync(fifo, { recursive: true, force: true }));
  write(fifo, 'package.json', JSON.stringify({ name: '@fixture/hook-fifo' }));
  mkdirSync(join(fifo, '.sandpaper'));
  execFileSync('mkfifo', [join(fifo, '.sandpaper/hooks')]);
  const started = Date.now();
  assert.throws(() => quietInstall(fifo), /non-directory|special/i);
  assert.ok(Date.now() - started < 1000);
});

test('hook-config commit failure rolls back both configs, scripts, manifest, and Task 3 surfaces', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-hook-commit-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/hook-commit' }));
  write(target, '.claude/settings.json', '{"user":"claude"}\n');
  write(target, '.codex/hooks.json', '{"user":"codex"}\n');
  const before = taskFourSnapshot(target);

  assert.throws(() => quietInstall(target, undefined, {
    integrationHooks: {
      afterInstall({ label }) {
        if (label === 'codex-hooks') throw new Error('injected Codex hook commit failure');
      },
    },
  }), /Could not commit Sandpaper integration transaction/);
  assert.deepEqual(taskFourSnapshot(target), before);
});

test('fresh solo installations create only the selected namespace and a truthful manifest', (t) => {
  for (const provider of ['claude', 'codex']) {
    const target = mkdtempSync(join(tmpdir(), `sandpaper-${provider}-only-`));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    write(target, 'package.json', JSON.stringify({ name: `@fixture/${provider}` }));
    quietInstall(target, {
      integrations: [provider],
      defaultProvider: provider,
      hooksEnabled: true,
    });

    const manifest = JSON.parse(readFileSync(join(target, '.sandpaper', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.integrations, [provider]);
    assert.equal(manifest.defaultProvider, provider);
    assert.equal(manifest.hooksEnabled, true);
    assert.equal(existsSync(join(target, '.claude', 'commands', 'sandpaper')), provider === 'claude');
    assert.equal(existsSync(join(target, '.agents', 'skills', 'sandpaper')), provider === 'codex');
    assert.equal(managedCount(join(target, 'CLAUDE.md')), provider === 'claude' ? 1 : 0);
    assert.equal(managedCount(join(target, 'AGENTS.md')), provider === 'codex' ? 1 : 0);
  }
});

test('dual and solo transitions refresh owned namespaces while preserving every unrelated byte and mode', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-transition-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/transitions' }));
  write(target, 'CLAUDE.md', '# Claude user prose\nNo clobber.');
  write(target, 'AGENTS.md', '# Codex user prose\r\nNo clobber.\r\n');
  write(target, '.claude/commands/user.md', 'custom claude command\n');
  write(target, '.claude/commands/sibling.txt', 'claude sibling\n');
  write(target, '.agents/skills/user/SKILL.md', 'custom codex skill\n');
  write(target, '.agents/sibling.txt', 'codex sibling\n');
  chmodSync(join(target, '.claude', 'commands', 'user.md'), 0o640);
  chmodSync(join(target, '.agents', 'skills', 'user', 'SKILL.md'), 0o600);
  const unrelated = [
    '.claude/commands/user.md',
    '.claude/commands/sibling.txt',
    '.agents/skills/user/SKILL.md',
    '.agents/sibling.txt',
  ].map((relative) => ({
    relative,
    bytes: readFileSync(join(target, relative)),
    mode: statSync(join(target, relative)).mode & 0o777,
  }));

  quietInstall(target, { integrations: ['claude', 'codex'], defaultProvider: 'claude', hooksEnabled: false });
  write(target, '.claude/commands/sandpaper/stale.md', 'stale\n');
  write(target, '.agents/skills/sandpaper/stale.md', 'stale\n');
  writeFileSync(join(target, '.claude', 'commands', 'sandpaper', 'help.md'), 'changed generated bytes\n');

  quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  assert.equal(existsSync(join(target, '.claude', 'commands', 'sandpaper', 'stale.md')), false);
  assert.deepEqual(
    readFileSync(join(target, '.claude', 'commands', 'sandpaper', 'help.md')),
    readFileSync(join(PACKAGE, 'skill', 'sandpaper', 'commands', 'help.md')),
  );
  assert.equal(existsSync(join(target, '.agents', 'skills', 'sandpaper')), false);
  assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), '# Codex user prose\r\nNo clobber.\r\n');
  assert.equal(managedCount(join(target, 'CLAUDE.md')), 1);

  for (const entry of unrelated) {
    assert.deepEqual(readFileSync(join(target, entry.relative)), entry.bytes, entry.relative);
    if (process.platform !== 'win32') assert.equal(statSync(join(target, entry.relative)).mode & 0o777, entry.mode, entry.relative);
  }

  quietInstall(target, { integrations: ['claude', 'codex'], defaultProvider: 'codex', hooksEnabled: false });
  assertExactIntegrationBytes(target);
  assert.equal(managedCount(join(target, 'CLAUDE.md')), 1);
  assert.equal(managedCount(join(target, 'AGENTS.md')), 1);
  const manifest = JSON.parse(readFileSync(join(target, '.sandpaper', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.integrations, ['claude', 'codex']);
  assert.equal(manifest.defaultProvider, 'codex');
  assert.equal(manifest.hooksEnabled, false);

  const stableIntegration = repositorySnapshot(target).filter((entry) => (
    entry.path.startsWith('.claude/commands/')
    || entry.path.startsWith('.agents/')
    || entry.path === 'CLAUDE.md'
    || entry.path === 'AGENTS.md'
    || entry.path === '.sandpaper/manifest.json'
  ));
  quietInstall(target, { integrations: ['claude', 'codex'], defaultProvider: 'codex', hooksEnabled: false });
  assert.deepEqual(repositorySnapshot(target).filter((entry) => (
    entry.path.startsWith('.claude/commands/')
    || entry.path.startsWith('.agents/')
    || entry.path === 'CLAUDE.md'
    || entry.path === 'AGENTS.md'
    || entry.path === '.sandpaper/manifest.json'
  )), stableIntegration);
});

test('integration preflight rejects unsafe package and target trees before changing either provider', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-integration-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  const target = join(root, 'target');
  mkdirSync(target);
  cpSync(join(PACKAGE, 'skill'), join(packageRoot, 'skill'), { recursive: true });
  write(target, 'CLAUDE.md', 'user claude\n');
  write(target, 'AGENTS.md', 'user codex\n');

  const workflow = join(packageRoot, 'skill', 'sandpaper', 'references', 'workflows', 'help.md');
  const workflowBytes = readFileSync(workflow);
  rmSync(workflow);
  symlinkSync(join(PACKAGE, 'skill', 'sandpaper', 'references', 'workflows', 'help.md'), workflow);
  const beforeUnsafeSource = repositorySnapshot(target);
  assert.throws(
    () => installIntegrations(target, packageRoot, { integrations: ['claude', 'codex'] }),
    /Sandpaper source tree.*symlink/i,
  );
  assert.deepEqual(repositorySnapshot(target), beforeUnsafeSource);

  rmSync(workflow);
  writeFileSync(workflow, workflowBytes);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  mkdirSync(join(target, '.agents'), { recursive: true });
  symlinkSync(outside, join(target, '.agents', 'skills'));
  const beforeUnsafeTarget = repositorySnapshot(target);
  assert.throws(
    () => installIntegrations(target, packageRoot, { integrations: ['claude', 'codex'] }),
    /Sandpaper destination path.*symlink/i,
  );
  assert.deepEqual(repositorySnapshot(target), beforeUnsafeTarget);
  assert.deepEqual(readdirSync(outside), []);
});

test('solo integration preflight requires only the selected provider sources', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-selected-sources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const claudePackage = join(root, 'claude-package');
  cpSync(join(PACKAGE, 'skill'), join(claudePackage, 'skill'), { recursive: true });
  rmSync(join(claudePackage, 'skill', 'sandpaper', 'SKILL.md'));
  const claudeTarget = join(root, 'claude-target');
  mkdirSync(claudeTarget);
  installIntegrations(claudeTarget, claudePackage, { integrations: ['claude'] });
  assert.equal(existsSync(join(claudeTarget, '.claude', 'commands', 'sandpaper', 'help.md')), true);
  assert.equal(existsSync(join(claudeTarget, '.agents', 'skills', 'sandpaper')), false);

  const codexPackage = join(root, 'codex-package');
  cpSync(join(PACKAGE, 'skill'), join(codexPackage, 'skill'), { recursive: true });
  rmSync(join(codexPackage, 'skill', 'sandpaper', 'commands'), { recursive: true });
  const codexTarget = join(root, 'codex-target');
  mkdirSync(codexTarget);
  installIntegrations(codexTarget, codexPackage, { integrations: ['codex'] });
  assert.equal(existsSync(join(codexTarget, '.agents', 'skills', 'sandpaper', 'SKILL.md')), true);
  assert.equal(existsSync(join(codexTarget, '.claude', 'commands', 'sandpaper')), false);
});

test('integration preflight rejects a symlink in a package source path component', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-source-component-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  const outsideSkill = join(root, 'outside-skill');
  const target = join(root, 'target');
  mkdirSync(packageRoot);
  mkdirSync(target);
  cpSync(join(PACKAGE, 'skill'), outsideSkill, { recursive: true });
  symlinkSync(outsideSkill, join(packageRoot, 'skill'));
  write(target, 'CLAUDE.md', 'user bytes\n');
  const before = repositorySnapshot(target);

  assert.throws(
    () => installIntegrations(target, packageRoot, { integrations: ['claude'] }),
    /Sandpaper source path.*symlink/i,
  );
  assert.deepEqual(repositorySnapshot(target), before);
});

test('invalid managed markers abort integration refresh before namespace mutation', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-marker-preflight-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, '.claude/commands/sandpaper/old.md', 'old namespace bytes\n');
  write(target, 'AGENTS.md', `user\n${BEGIN}\nunmatched\n`);
  const before = repositorySnapshot(target);

  assert.throws(
    () => installIntegrations(target, PACKAGE, { integrations: ['claude', 'codex'] }),
    /Invalid Sandpaper managed markers/,
  );
  assert.deepEqual(repositorySnapshot(target), before);
});

test('repositorySnapshot classifies special files before reading bytes', {
  skip: process.platform === 'win32',
}, (t) => {
  assert.match(repositorySnapshot.toString(), /isFile\(\)/);
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-special-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('mkfifo', [join(root, 'pipe')]);
  assert.deepEqual(repositorySnapshot(root), [{
    path: 'pipe',
    type: 'special',
    mode: lstatSync(join(root, 'pipe')).mode & 0o777,
    bytes: null,
  }]);
});

function taskThreeSnapshot(target) {
  if (!existsSync(target)) return [];
  return repositorySnapshot(target).filter((entry) => (
    entry.path === '.sandpaper/manifest.json'
    || entry.path === 'CLAUDE.md'
    || entry.path === 'AGENTS.md'
    || entry.path.startsWith('.claude/commands/sandpaper')
    || entry.path.startsWith('.agents/skills/sandpaper')
  ));
}

function taskFourSnapshot(target) {
  const taskThreePaths = new Set(taskThreeSnapshot(target).map((entry) => entry.path));
  return repositorySnapshot(target).filter((entry) => (
    taskThreePaths.has(entry.path)
    || entry.path === '.claude/settings.json'
    || entry.path === '.codex/hooks.json'
    || entry.path.startsWith('.sandpaper/hooks/')
  ));
}

test('multi-surface integration commit failure rolls back every selected namespace and block', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-multi-rollback-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'CLAUDE.md', 'claude user\n');
  write(target, 'AGENTS.md', 'codex user\n');
  const before = taskThreeSnapshot(target);
  let renames = 0;

  assert.throws(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude', 'codex'] },
    {
      fs: {
        renameSync(from, to) {
          renames += 1;
          if (renames === 4) throw Object.assign(new Error('injected surface commit failure'), { code: 'EIO' });
          return renameSync(from, to);
        },
      },
    },
  ), /Could not commit Sandpaper integration transaction/);

  assert.deepEqual(taskThreeSnapshot(target), before);
  assert.deepEqual(readdirSync(target).filter((name) => name.startsWith('.sandpaper-integrations-')), []);
});

test('multi-surface rollback preserves concurrent user data and its recovery backup', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-multi-recovery-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, '.claude/commands/sandpaper/old.md', 'old namespace\n');
  write(target, 'CLAUDE.md', 'user claude\n');
  const namespace = join(target, '.claude', 'commands', 'sandpaper');
  const displaced = join(target, 'displaced-installed');

  const error = thrown(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude', 'codex'] },
    {
      hooks: {
        afterInstall(operation) {
          if (operation.label !== 'claude-namespace') return;
          renameSync(namespace, displaced);
          mkdirSync(namespace);
          writeFileSync(join(namespace, 'concurrent.md'), 'concurrent user data\n');
          throw new Error('injected later failure');
        },
      },
    },
  ));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(namespace, 'concurrent.md'), 'utf8'), 'concurrent user data\n');
  assert.equal(readFileSync(join(displaced, 'help.md'), 'utf8'), readFileSync(join(PACKAGE, 'skill/sandpaper/commands/help.md'), 'utf8'));
  assert.equal(readFileSync(join(error.recoveryPath, 'previous-0', 'old.md'), 'utf8'), 'old namespace\n');
});

test('multi-surface stage, backup, and install faults leave every surface unchanged', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-multi-phases-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runCase = (name, dependencies, pattern) => {
    const target = join(root, name);
    mkdirSync(target);
    write(target, '.claude/commands/sandpaper/old.md', 'old claude\n');
    write(target, 'CLAUDE.md', 'claude user\n');
    write(target, 'AGENTS.md', 'codex user\n');
    const before = taskThreeSnapshot(target);
    assert.throws(
      () => installIntegrations(target, PACKAGE, { integrations: ['claude', 'codex'] }, dependencies),
      pattern,
    );
    assert.deepEqual(taskThreeSnapshot(target), before, name);
    assert.deepEqual(readdirSync(target).filter((entry) => entry.startsWith('.sandpaper-integrations-')), []);
  };

  runCase('stage', {
    fs: { writeFileSync() { throw Object.assign(new Error('stage fault'), { code: 'EIO' }); } },
  }, /Could not prepare Sandpaper integration transaction/);

  let backupRenames = 0;
  runCase('backup', {
    fs: {
      renameSync(from, to) {
        backupRenames += 1;
        if (backupRenames === 1) throw Object.assign(new Error('backup fault'), { code: 'EIO' });
        return renameSync(from, to);
      },
    },
  }, /Could not commit Sandpaper integration transaction/);

  let installRenames = 0;
  runCase('install', {
    fs: {
      renameSync(from, to) {
        installRenames += 1;
        if (installRenames === 2) throw Object.assign(new Error('install fault'), { code: 'EIO' });
        return renameSync(from, to);
      },
    },
  }, /Could not commit Sandpaper integration transaction/);
});

test('top-level managed-file backup validation restores rename-wrapper byte and mode edits', {
  skip: process.platform === 'win32',
}, (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-managed-backup-race-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const instructions = join(target, 'CLAUDE.md');
  write(target, 'CLAUDE.md', 'original user instructions\n');
  chmodSync(instructions, 0o640);
  const originalInode = statSync(instructions).ino;

  const error = thrown(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude'] },
    {
      fs: {
        renameSync(from, to) {
          const result = renameSync(from, to);
          if (from === instructions) {
            writeFileSync(to, 'concurrent backup instructions\n');
            chmodSync(to, 0o600);
          }
          return result;
        },
      },
    },
  ));

  assert.match(error.message, /Could not commit Sandpaper integration transaction/);
  assert.equal(statSync(instructions).ino, originalInode);
  assert.equal(readFileSync(instructions, 'utf8'), 'concurrent backup instructions\n');
  assert.equal(statSync(instructions).mode & 0o777, 0o600);
  assert.equal(existsSync(join(target, '.claude', 'commands', 'sandpaper')), false);
});

test('multi-surface restore failure retains the only namespace backup for recovery', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-multi-restore-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, '.claude/commands/sandpaper/old.md', 'only namespace backup\n');
  let renames = 0;

  const error = thrown(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude', 'codex'] },
    {
      fs: {
        renameSync(from, to) {
          renames += 1;
          if (renames === 2 || renames === 3) throw Object.assign(new Error('restore fault'), { code: 'EIO' });
          return renameSync(from, to);
        },
      },
    },
  ));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(error.message, 'Sandpaper transaction recovery required');
  assert.equal(readFileSync(join(error.recoveryPath, 'previous-0', 'old.md'), 'utf8'), 'only namespace backup\n');
  assert.equal(existsSync(join(target, '.claude/commands/sandpaper')), false);
});

test('multi-surface cleanup rejects data injected before its cleanup ownership baseline', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-multi-owned-baseline-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, '.claude/commands/sandpaper/old.md', 'old namespace\n');
  let transaction;

  const error = thrown(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude', 'codex'] },
    {
      hooks: {
        afterInstall() {
          if (transaction) return;
          transaction = join(target, readdirSync(target).find((name) => name.startsWith('.sandpaper-integrations-')));
          writeFileSync(join(transaction, 'unowned-user.md'), 'must survive\n');
        },
      },
    },
  ));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(error.recoveryPath, transaction);
  assert.equal(readFileSync(join(error.recoveryPath, 'unowned-user.md'), 'utf8'), 'must survive\n');
  assert.equal(readFileSync(join(error.recoveryPath, 'previous-0', 'old.md'), 'utf8'), 'old namespace\n');
});

test('multi-surface quarantine rename failure reports the retained original transaction', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-multi-quarantine-rename-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, '.claude/commands/sandpaper/old.md', 'old namespace\n');

  const error = thrown(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude', 'codex'] },
    {
      fs: {
        renameSync(from, to) {
          if (to.includes('.sandpaper-quarantine-') && to.endsWith('transaction')) {
            throw Object.assign(new Error('injected quarantine rename failure'), { code: 'EIO' });
          }
          return renameSync(from, to);
        },
      },
    },
  ));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(readFileSync(join(error.recoveryPath, 'previous-0', 'old.md'), 'utf8'), 'old namespace\n');
});

test('multi-surface post-move cleanup failure reports the quarantined transaction itself', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-multi-quarantine-post-move-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, '.claude/commands/sandpaper/old.md', 'old namespace\n');

  const error = thrown(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude', 'codex'] },
    {
      hooks: {
        beforeRecursiveCleanup() { throw new Error('injected post-move failure'); },
      },
    },
  ));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(readFileSync(join(error.recoveryPath, 'previous-0', 'old.md'), 'utf8'), 'old namespace\n');
});

test('multi-surface rollback propagates its quarantined recovery transaction', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-multi-rollback-quarantine-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, '.claude/commands/sandpaper/old.md', 'old namespace\n');

  const error = thrown(() => installIntegrations(
    target,
    PACKAGE,
    { integrations: ['claude', 'codex'] },
    {
      hooks: {
        afterInstall(operation) {
          if (operation.label === 'claude-namespace') throw new Error('injected commit failure');
        },
        beforeRecursiveCleanup() { throw new Error('injected rollback cleanup failure'); },
      },
    },
  ));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(target, '.claude/commands/sandpaper/old.md'), 'utf8'), 'old namespace\n');
  assert.deepEqual(
    readFileSync(join(error.recoveryPath, 'failed-0', 'help.md')),
    readFileSync(join(PACKAGE, 'skill/sandpaper/commands/help.md')),
  );
});

test('fresh install keeps manifest and integration intent absent when later setup work fails', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-fresh-atomic-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/fresh-atomic' }));
  const before = taskThreeSnapshot(target);

  assert.throws(() => quietInstall(target, {
    integrations: ['codex'],
    defaultProvider: 'codex',
    hooksEnabled: false,
  }, {
    beforeIntegrationCommit() { throw new Error('injected hook or asset failure'); },
  }), /injected hook or asset failure/);

  assert.deepEqual(taskThreeSnapshot(target), before);
});

test('existing install keeps prior manifest and surfaces when later setup work fails', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-existing-atomic-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/existing-atomic' }));
  quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const before = taskThreeSnapshot(target);

  assert.throws(() => quietInstall(target, {
    integrations: ['codex'],
    defaultProvider: 'codex',
    hooksEnabled: false,
  }, {
    beforeIntegrationCommit() { throw new Error('injected hook or asset failure'); },
  }), /injected hook or asset failure/);

  assert.deepEqual(taskThreeSnapshot(target), before);
});

test('manifest staging failure leaves fresh and existing Task 3 state unchanged', (t) => {
  for (const existing of [false, true]) {
    const target = mkdtempSync(join(tmpdir(), `sandpaper-manifest-stage-${existing}-`));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    write(target, 'package.json', JSON.stringify({ name: `@fixture/manifest-${existing}` }));
    if (existing) quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
    const before = taskThreeSnapshot(target);

    assert.throws(() => quietInstall(target, {
      integrations: ['codex'],
      defaultProvider: 'codex',
      hooksEnabled: false,
    }, {
      integrationFs: {
        openSync(path, ...args) {
          if (typeof path === 'string' && path.includes('next-manifest')) {
            throw Object.assign(new Error('injected manifest stage failure'), { code: 'EIO' });
          }
          return openSync(path, ...args);
        },
      },
    }), /Could not prepare Sandpaper integration transaction/);

    assert.deepEqual(taskThreeSnapshot(target), before, `existing=${existing}`);
  }
});

test('integration commit failure leaves fresh and existing manifest selection consistent with surfaces', (t) => {
  for (const existing of [false, true]) {
    const target = mkdtempSync(join(tmpdir(), `sandpaper-install-commit-${existing}-`));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    write(target, 'package.json', JSON.stringify({ name: `@fixture/commit-${existing}` }));
    if (existing) quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
    const before = taskThreeSnapshot(target);
    let renames = 0;

    assert.throws(() => quietInstall(target, {
      integrations: ['codex'],
      defaultProvider: 'codex',
      hooksEnabled: false,
    }, {
      integrationFs: {
        renameSync(from, to) {
          renames += 1;
          if (renames === 2) throw Object.assign(new Error('injected integration commit failure'), { code: 'EIO' });
          return renameSync(from, to);
        },
      },
    }), /Could not commit Sandpaper integration transaction/);

    assert.deepEqual(taskThreeSnapshot(target), before, `existing=${existing}`);
  }
});

test('identical reinstall repairs manifest mode to 0600 without leaking a transaction', {
  skip: process.platform === 'win32',
}, (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-manifest-mode-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/manifest-mode' }));
  quietInstall(target, { integrations: ['claude', 'codex'], defaultProvider: 'claude', hooksEnabled: false });
  const manifest = join(target, '.sandpaper', 'manifest.json');
  const bytes = readFileSync(manifest);
  chmodSync(manifest, 0o644);

  quietInstall(target, { integrations: ['claude', 'codex'], defaultProvider: 'claude', hooksEnabled: false });

  assert.deepEqual(readFileSync(manifest), bytes);
  assert.equal(statSync(manifest).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(target).filter((name) => name.startsWith('.sandpaper-integrations-')), []);
});

function quietLifecycle(operation, ...args) {
  const log = console.log;
  console.log = () => {};
  try { return operation(...args); } finally { console.log = log; }
}

function customizeLifecycleState(target, { defaultProvider, integrations, hooksEnabled }) {
  const manifest = join(target, '.sandpaper', 'manifest.json');
  const value = JSON.parse(readFileSync(manifest, 'utf8'));
  const customized = {
    ...value,
    defaultProvider,
    integrations,
    hooksEnabled,
    project: 'Preserved Project',
    created: '2024-02-03',
    counters: { ...value.counters, w: 91, custom: 7 },
    identity: { seed: 'brain-identity', nested: { keep: true } },
    unknownFutureField: { nested: ['preserve', 42] },
  };
  writeFileSync(manifest, `${JSON.stringify(customized, null, 2)}\n`);
  writeFileSync(join(target, 'brain/assets/theme.css'), '/* custom skin */\n:root { --ink: plum; }\n');
  chmodSync(join(target, 'brain/assets/theme.css'), 0o640);
  write(target, '.sandpaper/session.json', '{"version":2,"pages":{"/":{"claude":{"resumeId":"opaque-resume"}}}}\n');
  write(target, '.codex/user-owned.txt', 'keep codex user bytes\n');
  write(target, '.claude/user-owned.txt', 'keep claude user bytes\n');
  return customized;
}

test('upgrade preserves effective solo/default/hook intent and exact user lifecycle state', {
  skip: process.platform === 'win32',
}, (t) => {
  for (const options of [
    { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false },
    { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false },
    { integrations: ['claude', 'codex'], defaultProvider: 'codex', hooksEnabled: true },
  ]) {
    const target = mkdtempSync(join(tmpdir(), `sandpaper-upgrade-preserve-${options.defaultProvider}-`));
    t.after(() => rmSync(target, { recursive: true, force: true }));
    write(target, 'package.json', JSON.stringify({ name: '@fixture/upgrade-preserve' }));
    quietInstall(target, options);
    const expectedManifest = customizeLifecycleState(target, options);
    const theme = readFileSync(join(target, 'brain/assets/theme.css'));
    const session = readFileSync(join(target, '.sandpaper/session.json'));

    quietLifecycle(setup.upgrade, target, PACKAGE);

    assert.deepEqual(JSON.parse(readFileSync(join(target, '.sandpaper/manifest.json'), 'utf8')), expectedManifest);
    assert.deepEqual(readFileSync(join(target, 'brain/assets/theme.css')), theme);
    assert.equal(statSync(join(target, 'brain/assets/theme.css')).mode & 0o777, 0o640);
    assert.deepEqual(readFileSync(join(target, '.sandpaper/session.json')), session);
    assert.equal(readFileSync(join(target, '.codex/user-owned.txt'), 'utf8'), 'keep codex user bytes\n');
    assert.equal(readFileSync(join(target, '.claude/user-owned.txt'), 'utf8'), 'keep claude user bytes\n');
    assert.equal(existsSync(join(target, '.claude/commands/sandpaper')), options.integrations.includes('claude'));
    assert.equal(existsSync(join(target, '.agents/skills/sandpaper')), options.integrations.includes('codex'));
    if (!options.hooksEnabled) {
      const claude = existsSync(join(target, '.claude/settings.json')) ? readFileSync(join(target, '.claude/settings.json'), 'utf8') : '';
      const codex = existsSync(join(target, '.codex/hooks.json')) ? readFileSync(join(target, '.codex/hooks.json'), 'utf8') : '';
      assert.doesNotMatch(claude + codex, /brain-(?:inject|stamp-check)\.js/);
    }

    const converged = repositorySnapshot(target);
    quietLifecycle(setup.upgrade, target, PACKAGE);
    assert.deepEqual(repositorySnapshot(target), converged);
  }
});

test('rebuild backs up only brain and preserves manifest, session, integrations, and custom theme', {
  skip: process.platform === 'win32',
}, (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-preserve-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-preserve' }));
  const options = { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false };
  quietInstall(target, options);
  const expectedManifest = customizeLifecycleState(target, options);
  const session = readFileSync(join(target, '.sandpaper/session.json'));
  write(target, 'brain/operator-note.txt', 'old brain is retained\n');
  const date = new Date().toISOString().slice(0, 10);

  quietLifecycle(setup.rebuild, target, PACKAGE);

  const backup = join(target, `brain.bak-${date}`);
  assert.equal(readFileSync(join(backup, 'operator-note.txt'), 'utf8'), 'old brain is retained\n');
  assert.equal(existsSync(join(target, 'brain/operator-note.txt')), false);
  assert.equal(readFileSync(join(target, 'brain/assets/theme.css'), 'utf8'), '/* custom skin */\n:root { --ink: plum; }\n');
  assert.equal(statSync(join(target, 'brain/assets/theme.css')).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.sandpaper/manifest.json'), 'utf8')), expectedManifest);
  assert.deepEqual(readFileSync(join(target, '.sandpaper/session.json')), session);
  assert.equal(readFileSync(join(target, '.codex/user-owned.txt'), 'utf8'), 'keep codex user bytes\n');
  assert.equal(existsSync(join(target, '.claude/commands/sandpaper')), false);
  assert.equal(existsSync(join(target, '.agents/skills/sandpaper')), true);

  const converged = repositorySnapshot(target);
  quietLifecycle(setup.upgrade, target, PACKAGE);
  assert.deepEqual(repositorySnapshot(target), converged);
});

test('rebuild treats dangling backup symlinks as occupied and leaves them untouched', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-backup-name-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-backup-name' }));
  quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  write(target, 'brain/original.txt', 'old brain\n');
  const date = new Date().toISOString().slice(0, 10);
  const dangling = join(target, `brain.bak-${date}`);
  symlinkSync(join(target, 'missing-backup-target'), dangling);

  quietLifecycle(setup.rebuild, target, PACKAGE);

  assert.equal(lstatSync(dangling).isSymbolicLink(), true);
  assert.equal(readFileSync(join(target, `brain.bak-${date}-2`, 'original.txt'), 'utf8'), 'old brain\n');
});

test('rebuild rejects unsafe brain paths before any lifecycle mutation', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-unsafe-brain-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-unsafe-brain' }));
  quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  rmSync(join(target, 'brain'), { recursive: true, force: true });
  symlinkSync(join(target, 'outside-brain'), join(target, 'brain'));
  const before = repositorySnapshot(target);

  assert.throws(() => quietLifecycle(setup.rebuild, target, PACKAGE), /brain.*symlink|unsafe/i);
  assert.deepEqual(repositorySnapshot(target), before);
});

test('rebuild restores the exact old active brain when work fails after backup', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-rollback-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-rollback' }));
  quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  customizeLifecycleState(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  write(target, 'brain/exact-old.txt', 'restore me exactly\n');
  const before = repositorySnapshot(target);

  assert.throws(() => quietLifecycle(setup.rebuild, target, PACKAGE, {}, {
    afterBrainBackup() { throw new Error('injected after brain backup'); },
  }), /injected after brain backup/);

  assert.deepEqual(repositorySnapshot(target), before);
});

test('rebuild rolls back the active brain and every provider surface when integration commit fails', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-integration-rollback-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-integration-rollback' }));
  quietInstall(target, { integrations: ['claude', 'codex'], defaultProvider: 'codex', hooksEnabled: true });
  customizeLifecycleState(target, { integrations: ['claude', 'codex'], defaultProvider: 'codex', hooksEnabled: true });
  write(target, 'brain/exact-old.txt', 'restore after transaction failure\n');
  const before = repositorySnapshot(target);

  assert.throws(() => quietLifecycle(setup.rebuild, target, PACKAGE, {}, {
    integrationHooks: {
      afterInstall({ label }) {
        if (label === 'claude-namespace') throw new Error('injected rebuild integration failure');
      },
    },
  }), /Could not commit Sandpaper integration transaction/);

  assert.deepEqual(repositorySnapshot(target), before);
});

test('upgrade transaction failure preserves brain and provider state exactly', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-upgrade-integration-rollback-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/upgrade-integration-rollback' }));
  quietInstall(target, { integrations: ['claude', 'codex'], defaultProvider: 'codex', hooksEnabled: true });
  customizeLifecycleState(target, { integrations: ['claude', 'codex'], defaultProvider: 'codex', hooksEnabled: true });
  const before = repositorySnapshot(target);

  assert.throws(() => quietLifecycle(setup.upgrade, target, PACKAGE, {}, {
    integrationHooks: {
      afterInstall({ label }) {
        if (label === 'claude-namespace') throw new Error('injected upgrade integration failure');
      },
    },
  }), /Could not commit Sandpaper integration transaction/);

  assert.deepEqual(repositorySnapshot(target), before);
});

test('rebuild retains a recovery path instead of deleting concurrent content inside the fresh brain', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-concurrent-brain-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-concurrent-brain' }));
  quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  write(target, 'brain/old-only.txt', 'old user brain\n');

  const error = thrown(() => quietLifecycle(setup.rebuild, target, PACKAGE, {}, {
    afterScaffold({ brain }) {
      writeFileSync(join(brain, 'concurrent-user.txt'), 'concurrent user bytes\n');
      throw new Error('injected concurrent fresh-brain content');
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(target, 'brain/concurrent-user.txt'), 'utf8'), 'concurrent user bytes\n');
  assert.equal(readFileSync(join(error.recoveryPath, 'old-only.txt'), 'utf8'), 'old user brain\n');
});

test('rebuild keeps the fresh brain when provider destinations committed but cleanup needs recovery', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-postcommit-recovery-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-postcommit-recovery' }));
  quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  write(target, 'brain/old-only.txt', 'successful old brain backup\n');
  const date = new Date().toISOString().slice(0, 10);

  const error = thrown(() => quietLifecycle(setup.rebuild, target, PACKAGE, {}, {
    integrationHooks: {
      beforeQuarantineRename() { throw new Error('injected provider cleanup failure'); },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(error.phase, 'postcommit_cleanup');
  assert.equal(error.destinationsCommitted, true);
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(existsSync(join(target, 'brain/old-only.txt')), false);
  assert.equal(readFileSync(join(target, `brain.bak-${date}`, 'old-only.txt'), 'utf8'), 'successful old brain backup\n');
  assert.equal(existsSync(join(target, '.agents/skills/sandpaper/SKILL.md')), true);
});

test('upgrade finishes its editorial phase when provider cleanup needs recovery', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-upgrade-postcommit-recovery-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/upgrade-postcommit-recovery' }));
  quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  writeFileSync(join(target, 'brain/assets/brain.css'), 'stale engine bytes\n');

  const error = thrown(() => quietLifecycle(setup.upgrade, target, PACKAGE, {}, {
    integrationHooks: {
      beforeQuarantineRename() { throw new Error('injected provider cleanup failure'); },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(error.phase, 'postcommit_cleanup');
  assert.equal(error.destinationsCommitted, true);
  assert.deepEqual(readFileSync(join(target, 'brain/assets/brain.css')), readFileSync(join(PACKAGE, 'brain/assets/brain.css')));
});

test('rebuild retains partial fresh brain and old backup when failure precedes a complete inventory', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-partial-inventory-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-partial-inventory' }));
  quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  write(target, 'brain/old-only.txt', 'old brain retained\n');

  const error = thrown(() => quietLifecycle(setup.rebuild, target, PACKAGE, {}, {
    beforeScaffold({ brain }) {
      write(brain, 'partial-user.txt', 'partial or concurrent bytes\n');
      throw new Error('injected before complete inventory');
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(target, 'brain/partial-user.txt'), 'utf8'), 'partial or concurrent bytes\n');
  assert.equal(readFileSync(join(error.recoveryPath, 'old-only.txt'), 'utf8'), 'old brain retained\n');
});

test('rebuild cleanup revalidates fresh brain after quarantine check-gap injection', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-cleanup-gap-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-cleanup-gap' }));
  quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  write(target, 'brain/old-only.txt', 'old brain retained\n');

  const error = thrown(() => quietLifecycle(setup.rebuild, target, PACKAGE, {}, {
    beforeIntegrationCommit() { throw new Error('injected precommit failure'); },
    brainCleanupHooks: {
      beforeQuarantineRename({ transaction }) {
        write(transaction, 'concurrent-gap.txt', 'do not delete\n');
      },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(target, 'brain/concurrent-gap.txt'), 'utf8'), 'do not delete\n');
  assert.equal(readFileSync(join(error.brainBackupPath, 'old-only.txt'), 'utf8'), 'old brain retained\n');
});

test('upgrade rejects internal brain symlinks before provider preparation or outside writes', {
  skip: process.platform === 'win32',
}, (t) => {
  const cases = [
    {
      name: 'assets-directory',
      mutate(target, outside) {
        rmSync(join(target, 'brain/assets'), { recursive: true });
        symlinkSync(outside, join(target, 'brain/assets'));
      },
    },
    {
      name: 'asset-file',
      mutate(target, outside) {
        rmSync(join(target, 'brain/assets/brain.css'));
        symlinkSync(join(outside, 'outside.css'), join(target, 'brain/assets/brain.css'));
      },
    },
    {
      name: 'nested-directory',
      mutate(target, outside) {
        rmSync(join(target, 'brain/product'), { recursive: true });
        symlinkSync(outside, join(target, 'brain/product'));
      },
    },
    {
      name: 'nested-page',
      mutate(target, outside) {
        rmSync(join(target, 'brain/log.html'));
        symlinkSync(join(outside, 'outside.html'), join(target, 'brain/log.html'));
      },
    },
  ];

  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), `sandpaper-upgrade-${item.name}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const target = join(root, 'target');
    const outside = join(root, 'outside');
    mkdirSync(target);
    mkdirSync(outside);
    write(target, 'package.json', JSON.stringify({ name: `@fixture/${item.name}` }));
    write(outside, 'outside.css', 'outside css bytes\n');
    write(outside, 'outside.html', '<!doctype html><p>outside html bytes</p>\n');
    quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
    item.mutate(target, outside);
    const providerBefore = taskThreeSnapshot(target);
    const outsideBefore = repositorySnapshot(outside);
    let providerPreparation = 0;

    assert.throws(() => quietLifecycle(setup.upgrade, target, PACKAGE, {}, {
      integrationHooks: { beforeStage() { providerPreparation += 1; } },
    }), /brain.*symlink|editorial.*unsafe/i, item.name);

    assert.equal(providerPreparation, 0, item.name);
    assert.deepEqual(taskThreeSnapshot(target), providerBefore, item.name);
    assert.deepEqual(repositorySnapshot(outside), outsideBefore, item.name);
  }
});

test('upgrade rejects symlinked package editorial assets before provider preparation', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-upgrade-package-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target');
  const packageRoot = join(root, 'package');
  const outside = join(root, 'outside.css');
  mkdirSync(target);
  write(target, 'package.json', JSON.stringify({ name: '@fixture/package-assets' }));
  quietInstall(target, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  cpSync(join(PACKAGE, 'skill'), join(packageRoot, 'skill'), { recursive: true });
  cpSync(join(PACKAGE, 'bin'), join(packageRoot, 'bin'), { recursive: true });
  cpSync(join(PACKAGE, 'brain'), join(packageRoot, 'brain'), { recursive: true });
  writeFileSync(outside, 'outside package bytes\n');
  rmSync(join(packageRoot, 'brain/assets/brain.css'));
  symlinkSync(outside, join(packageRoot, 'brain/assets/brain.css'));
  const before = repositorySnapshot(target);
  let providerPreparation = 0;

  assert.throws(() => quietLifecycle(setup.upgrade, target, packageRoot, {}, {
    integrationHooks: { beforeStage() { providerPreparation += 1; } },
  }), /package.*asset.*symlink|editorial.*unsafe/i);

  assert.equal(providerPreparation, 0);
  assert.deepEqual(repositorySnapshot(target), before);
  assert.equal(readFileSync(outside, 'utf8'), 'outside package bytes\n');
});

test('rebuild rejects a symlinked theme parent before backup or provider preparation', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-rebuild-theme-parent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target');
  const outside = join(root, 'outside');
  mkdirSync(target);
  mkdirSync(outside);
  write(target, 'package.json', JSON.stringify({ name: '@fixture/rebuild-theme-parent' }));
  quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  write(outside, 'theme.css', 'outside theme bytes\n');
  rmSync(join(target, 'brain/assets'), { recursive: true });
  symlinkSync(outside, join(target, 'brain/assets'));
  const before = repositorySnapshot(target);
  const outsideBefore = repositorySnapshot(outside);
  let providerPreparation = 0;

  assert.throws(() => quietLifecycle(setup.rebuild, target, PACKAGE, {}, {
    integrationHooks: { beforeStage() { providerPreparation += 1; } },
  }), /brain.*symlink|theme.*unsafe/i);

  assert.equal(providerPreparation, 0);
  assert.deepEqual(repositorySnapshot(target), before);
  assert.deepEqual(repositorySnapshot(outside), outsideBefore);
});

test('upgrade and rebuilt canvas lifecycle prose is provider neutral', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-lifecycle-prose-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/lifecycle-prose' }));
  quietInstall(target, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    setup.upgrade(target, PACKAGE);
    setup.rebuild(target, PACKAGE);
  } finally {
    console.log = log;
  }

  const cover = readFileSync(join(target, 'brain/index.html'), 'utf8');
  assert.doesNotMatch(cover, /Claude|\/sandpaper:init/);
  assert.match(cover, /agent|Sandpaper workflow/i);
  assert.doesNotMatch(lines.join('\n'), /in Claude Code|\/sandpaper:init/);
});

function populatedBrain(t) {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-inspect-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({
    name: '@fixture/brain',
    repository: 'https://github.com/example/fixture.git',
  }));
  write(target, 'brain/assets/theme.css', ':root {}\n');
  write(target, 'brain/assets/brain.css', '@import "theme.css";\n');
  write(target, 'brain/assets/brain.js', '\n');
  write(target, 'brain/index.html', page(`
    <script type="application/json" id="brain-state">{
      "updated":"2026-07-10",
      "focus":{"one":"Ship derived truth.","ref":"project/index.html#t-1"},
      "worklog":[{"date":"2026-07-10","one":"Ship derived truth.","cid":"w-0002"}],
      "open":["decisions.html#q-open"]
    }</script>
    <p class="now-line" id="now" data-date="2026-07-10" data-ref="./project/index.html#t-1">Ship derived truth.</p>
    <b data-count="question:open">1</b>
    <b data-count="decision">1</b>
    <b data-count="learning">1</b>
    <span data-count="component:built">1</span>/<span data-count="component:total">2</span> built
    <ul data-open-list><li><a href="./decisions.html#q-open">Open item</a></li></ul>
  `));
  write(target, 'brain/project/index.html', page(`
    <div data-phase="0"><span data-phase-label="0">1/1 · 100%</span></div>
    <article class="entry--initiative" data-phase="0"><li class="task" id="t-1" data-status="done"></li></article>
    <div data-phase="2"><span data-phase-label="2">0/1 · 0%</span></div>
    <article class="entry--initiative" data-phase="2"><li class="task" id="t-2" data-status="todo"></li></article>
    <span id="plan-overall">1/2 · 50%</span>
  `));
  write(target, 'brain/decisions.html', page(`
    <article class="entry--decision" id="d-1" data-kind="decision" data-status="accepted"></article>
    <article class="entry--question" id="q-open" data-kind="question" data-status="open"></article>
    <article class="entry--question" id="q-closed" data-kind="question" data-status="resolved"></article>
  `));
  write(target, 'brain/learnings.html', page('<aside class="entry--learning" id="l-1" data-kind="learning"></aside>'));
  write(target, 'brain/map.html', page(`
    <article class="component" id="c-built" data-status="built"></article>
    <article class="component" id="c-planned" data-status="stub"></article>
  `));
  write(target, 'brain/log.html', page(`
    <ol><li class="entry--worklog" id="w-0002" data-kind="worklog" data-cid="w-0002" data-date="2026-07-10"><span class="log-what">Ship derived truth.</span></li></ol>
  `));
  return target;
}

function inspect(target) {
  assert.equal(typeof setup.inspectBrain, 'function', 'inspectBrain must be exported');
  return setup.inspectBrain(target);
}

function problemCodes(result) {
  return result.problems.map((problem) => problem.code);
}

test('deriveBrainFacts reports independent task, phase, book, and component truth', (t) => {
  const target = populatedBrain(t);
  assert.equal(typeof setup.deriveBrainFacts, 'function', 'deriveBrainFacts must be exported');
  assert.deepEqual(setup.deriveBrainFacts(target), {
    tasks: { done: 1, total: 2 },
    phases: {
      0: { done: 1, total: 1 },
      2: { done: 0, total: 1 },
    },
    decisions: 1,
    openQuestions: ['q-open'],
    learnings: 1,
    components: { built: 1, total: 2 },
  });
});

test('inspectBrain accepts a correct populated brain', (t) => {
  const result = inspect(populatedBrain(t));
  assert.deepEqual(result.problems, []);
});

test('a populated brain without #brain-state is unhealthy', (t) => {
  const target = populatedBrain(t);
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8')
    .replace(/<script type="application\/json" id="brain-state">[\s\S]*?<\/script>/, ''));

  assert.ok(problemCodes(inspect(target)).includes('missing-digest'));

  const previousExitCode = process.exitCode;
  const log = console.log;
  console.log = () => {};
  try {
    setup.doctor(target);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = log;
    process.exitCode = previousExitCode;
  }
});

test('inspectBrain accepts a fresh scaffold as a healthy empty editorial state', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-scaffold-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({
    name: '@fixture/fresh',
    repository: 'https://github.com/example/fresh.git',
  }));
  const log = console.log;
  console.log = () => {};
  try { setup.scaffold(target, PACKAGE); } finally { console.log = log; }

  assert.deepEqual(JSON.parse(readFileSync(join(target, '.sandpaper', 'manifest.json'), 'utf8')), {
    version: 2,
    project: '@fixture/fresh',
    created: new Date().toISOString().slice(0, 10),
    theme: 'brain/assets/theme.css',
    pkg: PACKAGE,
    port: 4848,
    lenses: ['product', 'engineering', 'project'],
    books: ['log', 'decisions', 'learnings'],
    cidPrefixes: { worklog: 'w', task: 't', decision: 'd', learning: 'l', initiative: 'i' },
    counters: { w: 1, t: 0, d: 0, l: 0, i: 0 },
    defaultProvider: 'claude',
    integrations: ['claude', 'codex'],
    hooksEnabled: true,
  });

  const result = inspect(target);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.facts, {
    tasks: { done: 0, total: 0 },
    phases: {},
    decisions: 0,
    openQuestions: [],
    learnings: 0,
    components: { built: 0, total: 0 },
  });
});

test('scaffold forwards an explicit provider into a fresh v2 manifest', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-scaffold-provider-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/provider' }));
  const log = console.log;
  console.log = () => {};
  try {
    setup.scaffold(target, PACKAGE, {
      integrations: ['claude', 'codex'],
      defaultProvider: 'codex',
      hooksEnabled: true,
    });
  } finally {
    console.log = log;
  }

  const manifest = JSON.parse(readFileSync(join(target, '.sandpaper', 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.equal(manifest.defaultProvider, 'codex');
  assert.deepEqual(manifest.integrations, ['claude', 'codex']);
  assert.equal(manifest.hooksEnabled, true);
  assert.deepEqual(manifest.counters, { w: 1, t: 0, d: 0, l: 0, i: 0 });
});

test('explicit init provider updates an existing scaffold manifest without losing identity', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-scaffold-existing-provider-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/existing-provider' }));
  const log = console.log;
  console.log = () => {};
  try {
    setup.scaffold(target, PACKAGE);
    const file = join(target, '.sandpaper', 'manifest.json');
    const before = JSON.parse(readFileSync(file, 'utf8'));
    before.brainIdentity = { id: 'brain-existing' };
    before.counters.w = 41;
    before.integrations = ['codex'];
    before.defaultProvider = 'codex';
    before.hooksEnabled = false;
    writeFileSync(file, `${JSON.stringify(before, null, 2)}\n`);

    setup.scaffold(target, PACKAGE, {
      integrations: ['claude', 'codex'],
      defaultProvider: 'codex',
      hooksEnabled: true,
    });

    const after = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(after.defaultProvider, 'codex');
    assert.deepEqual(after.integrations, ['codex']);
    assert.equal(after.hooksEnabled, false);
    assert.deepEqual(after.brainIdentity, { id: 'brain-existing' });
    assert.equal(after.counters.w, 41);
    assert.equal(after.project, '@fixture/existing-provider');

    const stableBytes = readFileSync(file, 'utf8');
    assert.throws(
      () => setup.scaffold(target, PACKAGE, {
        integrations: ['claude', 'codex'],
        defaultProvider: 'claude',
        hooksEnabled: true,
      }),
      /not installed/,
    );
    assert.equal(readFileSync(file, 'utf8'), stableBytes);
  } finally {
    console.log = log;
  }
});

test('scaffold rejects an incompatible existing provider before changing the repository tree', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-scaffold-preflight-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  write(target, 'package.json', JSON.stringify({ name: '@fixture/preflight' }));
  write(target, '.sandpaper/manifest.json', `${JSON.stringify({
    version: 2,
    project: '@fixture/preflight',
    created: '2026-07-11',
    port: 4848,
    counters: { w: 17 },
    defaultProvider: 'codex',
    integrations: ['codex'],
    hooksEnabled: false,
  }, null, 2)}\n`);
  const before = repositorySnapshot(target);
  const log = console.log;
  console.log = () => {};
  try {
    assert.throws(
      () => setup.scaffold(target, PACKAGE, {
        integrations: ['claude', 'codex'],
        defaultProvider: 'claude',
        hooksEnabled: true,
      }),
      /not installed/,
    );
  } finally {
    console.log = log;
  }

  assert.deepEqual(repositorySnapshot(target), before);
});

test('inspectBrain reports stale stamped fallback counts and progress', (t) => {
  const target = populatedBrain(t);
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8')
    .replace('data-count="question:open">1', 'data-count="question:open">9')
    .replace('data-count="decision">1', 'data-count="decision">9')
    .replace('data-count="learning">1', 'data-count="learning">9')
    .replace('data-count="component:built">1', 'data-count="component:built">9'));
  const plan = join(target, 'brain/project/index.html');
  writeFileSync(plan, readFileSync(plan, 'utf8')
    .replace('1/2 · 50%', '0/2 · 0%')
    .replace('0/1 · 0%', '1/1 · 100%'));

  const codes = problemCodes(inspect(target));
  for (const code of [
    'fallback-question-count',
    'fallback-decision-count',
    'fallback-learning-count',
    'fallback-component-count',
    'fallback-plan-progress',
    'fallback-phase-progress',
  ]) assert.ok(codes.includes(code), `expected ${code}`);
});

test('inspectBrain reports a stale explicit component total fallback', (t) => {
  const target = populatedBrain(t);
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8')
    .replace('data-count="component:total">2', 'data-count="component:total">9'));

  assert.ok(problemCodes(inspect(target)).includes('fallback-component-total'));
});

test('inspectBrain compares package identity even when pages agree with each other', (t) => {
  const target = populatedBrain(t);
  for (const relative of ['index.html', 'project/index.html', 'decisions.html', 'learnings.html', 'map.html', 'log.html']) {
    const file = join(target, 'brain', relative);
    writeFileSync(file, readFileSync(file, 'utf8').replace('data-pkg="@fixture/brain"', 'data-pkg="wrong-package"'));
  }
  assert.ok(problemCodes(inspect(target)).includes('source-package'));
});

test('inspectBrain compares source URLs to repoSource rather than only for consistency', (t) => {
  const target = populatedBrain(t);
  for (const relative of ['index.html', 'project/index.html', 'decisions.html', 'learnings.html', 'map.html', 'log.html']) {
    const file = join(target, 'brain', relative);
    writeFileSync(file, readFileSync(file, 'utf8').replace('/blob/HEAD/', '/blob/stale/'));
  }
  assert.ok(problemCodes(inspect(target)).includes('source-url'));
});

test('inspectBrain reports digest focus versus NOW mismatch', (t) => {
  const target = populatedBrain(t);
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8').replace('project/index.html#t-1', 'project/index.html#t-2'));
  assert.ok(problemCodes(inspect(target)).includes('digest-focus'));
});

test('inspectBrain reports digest newest worklog versus ledger mismatch', (t) => {
  const target = populatedBrain(t);
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8').replace('"cid":"w-0002"', '"cid":"w-0001"'));
  assert.ok(problemCodes(inspect(target)).includes('digest-worklog'));
});

test('inspectBrain reports digest open list versus open-question status mismatch', (t) => {
  const target = populatedBrain(t);
  const decisions = join(target, 'brain/decisions.html');
  writeFileSync(decisions, readFileSync(decisions, 'utf8').replace('id="q-open" data-kind="question" data-status="open"', 'id="q-open" data-kind="question" data-status="resolved"'));
  assert.ok(problemCodes(inspect(target)).includes('digest-open'));
});

test('inspectBrain reports a data-ref blocked by repository path policy', (t) => {
  const target = populatedBrain(t);
  write(target, '.codex/private.txt', 'secret\n');
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8').replace('</body>', '<article data-ref="../.codex/private.txt"></article></body>'));
  const result = inspect(target);
  assert.ok(result.problems.some((problem) => problem.code === 'brain-link' && problem.reason === 'hidden-path'));
});

test('doctor anchor checks require an actual id or name attribute', (t) => {
  const target = populatedBrain(t);
  write(target, 'docs/spec.html', '<article data-cid="s-real"></article>');
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8').replace('</body>', '<a href="../docs/spec.html#s-real">spec</a></body>'));
  const problems = setup.checkBrainLinks(target, join(target, 'brain'));
  assert.ok(problems.some((problem) => problem.reason === 'missing-anchor'));
});

test('doctor anchor checks ignore id and name attributes inside HTML comments', (t) => {
  const target = populatedBrain(t);
  write(target, 'docs/spec.html', '<!-- <article id="comment-only"></article> -->');
  const cover = join(target, 'brain/index.html');
  writeFileSync(cover, readFileSync(cover, 'utf8')
    .replace('</body>', '<a href="../docs/spec.html#comment-only">spec</a></body>'));

  const problems = setup.checkBrainLinks(target, join(target, 'brain'));
  assert.ok(problems.some((problem) => problem.reason === 'missing-anchor'));
});
