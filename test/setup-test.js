import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
        entries.push({
          path: relative,
          type: stats.isSymbolicLink() ? 'symlink' : 'file',
          mode: stats.mode & 0o777,
          bytes: stats.isSymbolicLink() ? null : readFileSync(file).toString('base64'),
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

function quietInstall(target, options) {
  const log = console.log;
  console.log = () => {};
  try { setup.installSkill(target, PACKAGE, options); } finally { console.log = log; }
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
