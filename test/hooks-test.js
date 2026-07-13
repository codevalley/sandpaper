import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeClaudeHooks, mergeCodexHooks } from '../src/hooks.js';

const INJECT = 'node .sandpaper/hooks/brain-inject.js';
const STAMP = 'node .sandpaper/hooks/brain-stamp-check.js';

function fixture(t, prefix = 'sandpaper-hooks-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relative, value) {
  const file = join(root, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, value);
  return file;
}

function config(root, provider) {
  return join(root, provider === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
}

function exactHandler(command, timeout) {
  return { type: 'command', command, timeout };
}

test('fresh Claude and Codex merges use their exact supported schemas', (t) => {
  const claude = fixture(t, 'sandpaper-claude-hooks-');
  const codex = fixture(t, 'sandpaper-codex-hooks-');

  assert.deepEqual(mergeClaudeHooks(claude, { enabled: true }), { ok: true, changed: true });
  assert.deepEqual(JSON.parse(readFileSync(config(claude, 'claude'), 'utf8')), {
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [exactHandler(INJECT, 10)] }],
      Stop: [{ matcher: '*', hooks: [exactHandler(STAMP, 20)] }],
    },
  });
  assert.deepEqual(mergeCodexHooks(codex, { enabled: true }), { ok: true, changed: true });
  assert.deepEqual(JSON.parse(readFileSync(config(codex, 'codex'), 'utf8')), {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [exactHandler(INJECT, 10)] }],
      Stop: [{ hooks: [exactHandler(STAMP, 20)] }],
    },
  });
});

test('Claude merge replaces exact self-hosted legacy Sandpaper hooks without claiming similar user hooks', (t) => {
  const root = fixture(t, 'sandpaper-claude-legacy-hooks-');
  const legacyInject = 'node bin/brain-inject.js';
  const legacyStamp = 'node bin/brain-stamp-check.js';
  const similar = { type: 'command', command: `${legacyInject} --user-mode`, timeout: 10 };
  write(root, '.claude/settings.json', `${JSON.stringify({
    $comment: 'preserve user configuration',
    hooks: {
      SessionStart: [
        { matcher: '*', hooks: [exactHandler(legacyInject, 10)] },
        { matcher: '*', hooks: [similar] },
      ],
      Stop: [{ matcher: '*', hooks: [exactHandler(legacyStamp, 20)] }],
    },
  }, null, 2)}\n`);

  assert.deepEqual(mergeClaudeHooks(root, { enabled: true }), { ok: true, changed: true });
  const after = JSON.parse(readFileSync(config(root, 'claude'), 'utf8'));
  assert.equal(after.$comment, 'preserve user configuration');
  assert.deepEqual(after.hooks.SessionStart, [
    { matcher: '*', hooks: [similar] },
    { matcher: '*', hooks: [exactHandler(INJECT, 10)] },
  ]);
  assert.deepEqual(after.hooks.Stop, [
    { matcher: '*', hooks: [exactHandler(STAMP, 20)] },
  ]);
});

test('Codex merge preserves order and unrelated bytes semantically while deduping only exact ownership', (t) => {
  const root = fixture(t);
  const similar = [
    { type: 'command', command: STAMP, timeout: 21 },
    { type: 'command', command: 'node elsewhere/brain-stamp-check.js', timeout: 20 },
    { type: 'command', command: STAMP, timeout: 20, async: false },
  ];
  const before = {
    prose: 'keep me exactly',
    hooks: {
      Unknown: [{ matcher: 'z', hooks: [{ prompt: 'stay' }] }],
      Stop: [
        { matcher: 'user', hooks: [{ type: 'command', command: 'node first.js' }] },
        { hooks: [similar[0], exactHandler(STAMP, 20), { type: 'command', command: 'node middle.js' }] },
        { hooks: [exactHandler(STAMP, 20), ...similar.slice(1)] },
      ],
    },
  };
  write(root, '.codex/hooks.json', JSON.stringify(before));

  assert.equal(mergeCodexHooks(root, { enabled: true }).ok, true);
  const after = JSON.parse(readFileSync(config(root, 'codex'), 'utf8'));
  assert.equal(after.prose, before.prose);
  assert.deepEqual(after.hooks.Unknown, before.hooks.Unknown);
  assert.deepEqual(after.hooks.Stop[0], before.hooks.Stop[0]);
  assert.deepEqual(after.hooks.Stop, [...before.hooks.Stop, { hooks: [exactHandler(STAMP, 20)] }]);
  assert.deepEqual(after.hooks.SessionStart.at(-1), {
    matcher: 'startup|resume|clear|compact', hooks: [exactHandler(INJECT, 10)],
  });
});

test('disabled merge removes exact owned handlers but preserves mixed groups and similar handlers', (t) => {
  const root = fixture(t);
  const user = { type: 'command', command: 'node user.js', timeout: 20 };
  write(root, '.claude/settings.json', `${JSON.stringify({
    env: { KEEP: 'yes' },
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [exactHandler(INJECT, 10), user] }],
      Stop: [
        { matcher: '*', hooks: [exactHandler(STAMP, 20)] },
        { matcher: '*', hooks: [{ ...exactHandler(STAMP, 20), statusMessage: 'user field' }] },
      ],
    },
  }, null, 2)}\n`);

  assert.deepEqual(mergeClaudeHooks(root, { enabled: false }), { ok: true, changed: true });
  const after = JSON.parse(readFileSync(config(root, 'claude'), 'utf8'));
  assert.deepEqual(after.env, { KEEP: 'yes' });
  assert.deepEqual(after.hooks.SessionStart, [{ matcher: '*', hooks: [exactHandler(INJECT, 10), user] }]);
  assert.deepEqual(after.hooks.Stop, [{ matcher: '*', hooks: [{ ...exactHandler(STAMP, 20), statusMessage: 'user field' }] }]);
});

test('group metadata makes Claude and Codex groups user-owned across enable, dedupe, and disable', (t) => {
  for (const provider of ['claude', 'codex']) {
    const root = fixture(t, `sandpaper-${provider}-group-owner-`);
    const isClaude = provider === 'claude';
    const sessionMatcher = isClaude ? '*' : 'startup|resume|clear|compact';
    const stopMatcher = isClaude ? { matcher: '*' } : {};
    const userSession = {
      matcher: sessionMatcher,
      note: 'user metadata',
      hooks: [exactHandler(INJECT, 10)],
    };
    const userStop = {
      ...stopMatcher,
      description: 'user-owned group',
      hooks: [exactHandler(STAMP, 20)],
    };
    const ownedSession = { matcher: sessionMatcher, hooks: [exactHandler(INJECT, 10)] };
    const ownedStop = { ...stopMatcher, hooks: [exactHandler(STAMP, 20)] };
    write(root, provider === 'claude' ? '.claude/settings.json' : '.codex/hooks.json', JSON.stringify({
      hooks: {
        SessionStart: [userSession, ownedSession, ownedSession],
        Stop: [userStop, ownedStop, ownedStop],
      },
    }));

    const merge = provider === 'claude' ? mergeClaudeHooks : mergeCodexHooks;
    assert.equal(merge(root, { enabled: true }).ok, true);
    const enabled = JSON.parse(readFileSync(config(root, provider), 'utf8'));
    assert.deepEqual(enabled.hooks.SessionStart, [userSession, ownedSession]);
    assert.deepEqual(enabled.hooks.Stop, [userStop, ownedStop]);

    assert.equal(merge(root, { enabled: false }).ok, true);
    const disabled = JSON.parse(readFileSync(config(root, provider), 'utf8'));
    assert.deepEqual(disabled.hooks.SessionStart, [userSession]);
    assert.deepEqual(disabled.hooks.Stop, [userStop]);

    const userOnly = fixture(t, `sandpaper-${provider}-group-user-only-`);
    const original = `  ${JSON.stringify({ hooks: { SessionStart: [userSession], Stop: [userStop] } })}`;
    write(userOnly, provider === 'claude' ? '.claude/settings.json' : '.codex/hooks.json', original);
    assert.deepEqual(merge(userOnly, { enabled: false }), { ok: true, changed: false });
    assert.equal(readFileSync(config(userOnly, provider), 'utf8'), original);
  }
});

test('no-op merge preserves bytes and mode while changed output is deterministic with one trailing newline', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = fixture(t);
  const first = mergeCodexHooks(root, { enabled: true });
  assert.equal(first.changed, true);
  const file = config(root, 'codex');
  assert.match(readFileSync(file, 'utf8'), /[^\n]\n$/);
  chmodSync(file, 0o640);
  const bytes = readFileSync(file);

  assert.deepEqual(mergeCodexHooks(root, { enabled: true }), { ok: true, changed: false });
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(statSync(file).mode & 0o777, 0o640);
});

test('invalid JSON and malformed relevant collections stay byte and mode identical', {
  skip: process.platform === 'win32',
}, (t) => {
  for (const [name, body] of [
    ['invalid', '{ nope'],
    ['hooks-array', JSON.stringify({ hooks: [] })],
    ['event-object', JSON.stringify({ hooks: { Stop: {} } })],
    ['group-string', JSON.stringify({ hooks: { Stop: ['unsafe'] } })],
    ['handlers-object', JSON.stringify({ hooks: { Stop: [{ hooks: {} }] } })],
  ]) {
    const root = fixture(t, `sandpaper-${name}-`);
    const file = write(root, '.codex/hooks.json', body);
    chmodSync(file, 0o640);
    const before = readFileSync(file);
    const result = mergeCodexHooks(root, { enabled: true });
    assert.equal(result.ok, false, name);
    assert.equal(result.changed, false, name);
    assert.deepEqual(readFileSync(file), before, name);
    assert.equal(statSync(file).mode & 0o777, 0o640, name);
  }
});

test('symlink components, dangling destinations, and FIFOs are rejected without outside mutation', {
  skip: process.platform === 'win32',
}, (t) => {
  const outside = fixture(t, 'sandpaper-hooks-outside-');
  const outsideFile = write(outside, 'hooks.json', '{"outside":true}\n');

  const component = fixture(t, 'sandpaper-hooks-component-');
  symlinkSync(outside, join(component, '.codex'));
  assert.equal(mergeCodexHooks(component, { enabled: true }).ok, false);
  assert.equal(readFileSync(outsideFile, 'utf8'), '{"outside":true}\n');

  const dangling = fixture(t, 'sandpaper-hooks-dangling-');
  mkdirSync(join(dangling, '.codex'));
  symlinkSync(join(dangling, 'missing'), config(dangling, 'codex'));
  assert.equal(mergeCodexHooks(dangling, { enabled: true }).ok, false);
  assert.equal(existsSync(join(dangling, 'missing')), false);

  try {
    const fifo = fixture(t, 'sandpaper-hooks-fifo-');
    mkdirSync(join(fifo, '.codex'));
    execFileSync('mkfifo', [config(fifo, 'codex')]);
    const started = Date.now();
    assert.equal(mergeCodexHooks(fifo, { enabled: true }).ok, false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(lstatSync(config(fifo, 'codex')).isFIFO(), true);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
});

test('concurrent in-place edits and destination replacements are retained and reported', (t) => {
  for (const replacement of [false, true]) {
    const root = fixture(t, `sandpaper-hooks-race-${replacement}-`);
    const file = write(root, '.codex/hooks.json', '{"hooks":{}}\n');
    let injected = false;
    const result = mergeCodexHooks(root, { enabled: true }, {
      hooks: {
        beforeStage(operation) {
          if (injected || operation.label !== 'codex-hooks') return;
          injected = true;
          if (replacement) {
            renameSync(file, `${file}.old`);
            writeFileSync(file, '{"concurrent":"replacement"}\n');
          } else {
            writeFileSync(file, '{"concurrent":"edit"}\n');
          }
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(readFileSync(file, 'utf8'), /concurrent/);
  }
});
