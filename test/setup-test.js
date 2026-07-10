import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
