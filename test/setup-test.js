import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as setup from '../src/setup.js';

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
