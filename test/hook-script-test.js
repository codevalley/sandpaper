import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGE = new URL('..', import.meta.url).pathname;
const INJECT = join(PACKAGE, 'bin', 'brain-inject.js');
const STAMP = join(PACKAGE, 'bin', 'brain-stamp-check.js');

function fixture(t, { brain = true, git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-hook-script-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (git) execFileSync('git', ['init', '-q', root]);
  if (brain) {
    write(root, 'brain/index.html', `<script type="application/json" id="brain-state">${JSON.stringify({
      project: 'Fixture', phase: 'Build', updated: '2026-07-11',
      focus: { one: 'Wire shared hooks', ref: 'docs/plan.md' },
      worklog: [{ one: 'Reviewed provider schema' }], open: ['Trust review'],
    })}</script>`);
  }
  if (git) {
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', [
      '-C', root,
      '-c', 'user.name=Sandpaper Test',
      '-c', 'user.email=sandpaper@example.invalid',
      'commit', '--allow-empty', '-qm', 'fixture baseline',
    ]);
  }
  return root;
}

function write(root, relative, value) {
  const file = join(root, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, value);
  return file;
}

function run(script, root, input = '') {
  return spawnSync(process.execPath, [script], { cwd: root, input, encoding: 'utf8' });
}

test('SessionStart emits a complete provider-neutral digest without session or auth input', (t) => {
  const root = fixture(t);
  const result = run(INJECT, root, JSON.stringify({ session_id: 'SECRET', api_key: 'SECRET' }));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Sandpaper brain · Fixture · Build · stamped 2026-07-11/);
  assert.match(result.stdout, /Wire shared hooks/);
  assert.match(result.stdout, /managed instructions|installed Sandpaper workflow/i);
  assert.doesNotMatch(result.stdout, /SECRET|session|Claude|CLAUDE\.md|\/sandpaper:/i);
});

test('SessionStart stays silent for missing, unreadable, missing-digest, invalid, or incomplete brain state', (t) => {
  const roots = [
    fixture(t, { brain: false }),
    fixture(t),
    fixture(t),
    fixture(t),
    fixture(t),
  ];
  write(roots[1], 'brain/index.html', '<html>no digest</html>');
  write(roots[2], 'brain/index.html', '<script type="application/json" id="brain-state">{bad</script>');
  write(roots[3], 'brain/index.html', '<script type="application/json" id="brain-state">{"project":"Partial"}</script>');
  if (process.platform !== 'win32') chmodSync(join(roots[4], 'brain/index.html'), 0o000);
  for (const root of roots) {
    const result = run(INJECT, root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('Stop handles Claude and Codex payloads and emits exactly one compact continuation object', (t) => {
  for (const payload of [{ hook_event_name: 'Stop' }, { event: 'Stop', thread_id: 'secret-thread' }]) {
    const root = fixture(t);
    write(root, 'src/changed.js', 'export const changed = true;\n');
    const result = run(STAMP, root, JSON.stringify(payload));
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const output = JSON.parse(lines[0]);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /agent|Sandpaper|shared brain/i);
    assert.doesNotMatch(output.reason, /secret-thread|Claude|CLAUDE\.md|\/sandpaper:/i);
  }
});

test('Stop is silent for active continuation, missing brain, brain changes, instruction-only changes, git failure, and invalid stdin', (t) => {
  const active = fixture(t);
  write(active, 'src/a.js', 'a\n');
  assert.equal(run(STAMP, active, '{"stop_hook_active":true}').stdout, '');

  const noBrain = fixture(t, { brain: false });
  write(noBrain, 'src/a.js', 'a\n');
  assert.equal(run(STAMP, noBrain, '{}').stdout, '');

  const stamped = fixture(t);
  write(stamped, 'src/a.js', 'a\n');
  write(stamped, 'brain/log.html', 'stamp\n');
  assert.equal(run(STAMP, stamped, '{}').stdout, '');

  for (const instruction of ['CLAUDE.md', 'AGENTS.md']) {
    const root = fixture(t);
    write(root, instruction, 'instructions\n');
    assert.equal(run(STAMP, root, '{}').stdout, '', instruction);
  }

  const ignored = fixture(t);
  write(ignored, '.sandpaper/state.json', '{}\n');
  write(ignored, 'node_modules/pkg/index.js', 'x\n');
  assert.equal(run(STAMP, ignored, '{}').stdout, '');

  const noGit = fixture(t, { git: false });
  write(noGit, 'src/a.js', 'a\n');
  assert.equal(run(STAMP, noGit, '{}').stdout, '');
  const invalid = fixture(t);
  write(invalid, 'src/a.js', 'a\n');
  assert.equal(run(STAMP, invalid, '{bad').stdout, '');
  assert.equal(run(STAMP, invalid, '').stdout, '');
});

test('Stop bounds its path summary to six and fails silent on unusual porcelain paths', (t) => {
  const root = fixture(t);
  for (let index = 0; index < 8; index += 1) write(root, `src/file-${index}.js`, `${index}\n`);
  const output = JSON.parse(run(STAMP, root, '{}').stdout);
  assert.match(output.reason, /8 project file/);
  assert.match(output.reason, /…/);
  assert.equal((output.reason.match(/src\/file-/g) || []).length, 6);

  const unusual = fixture(t);
  write(unusual, 'src/line\nbreak.js', 'x\n');
  assert.equal(run(STAMP, unusual, '{}').stdout, '');
});

test('Stop redacts sensitive-looking path names from its bounded summary', (t) => {
  const root = fixture(t);
  write(root, 'src/private-api-token-secret.js', 'x\n');
  const output = JSON.parse(run(STAMP, root, '{}').stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /\[sensitive path\]/);
  assert.doesNotMatch(output.reason, /private-api-token-secret/);
});

test('hook scripts contain no Claude-only routing or prose', () => {
  const source = readFileSync(INJECT, 'utf8') + readFileSync(STAMP, 'utf8');
  assert.doesNotMatch(source, /fresh `claude`|Claude Code|Claude session|CLAUDE\.md\s*(?:→|->)|\/sandpaper:/i);
});
