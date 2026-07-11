import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codexArgs,
  codexChildEnv,
  getCodexThreadId,
  mapCodexEvent,
  runCodexTurn,
} from '../src/codex.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function input(child, frames) {
  return {
    pageFile: '/tmp/project/index.html',
    prompt: 'Tighten the title',
    resumeId: null,
    onSession() {},
    onFrame: (frame) => frames.push(frame),
  };
}

function terminals(frames) {
  return frames.filter((frame) => frame.type === 'status'
    && (frame.done || frame.state === 'done' || frame.state === 'error'));
}

test('Codex args keep global safety flags before exec and explicit resume ID after it', () => {
  const fresh = codexArgs({ prompt: 'Tighten the title', resumeId: null });
  assert.ok(fresh.indexOf('--ask-for-approval') < fresh.indexOf('exec'));
  assert.deepEqual(fresh.slice(-2), ['--json', 'Tighten the title']);
  const resumed = codexArgs({ prompt: 'Continue', resumeId: 'thread-1' });
  assert.deepEqual(resumed.slice(-4), ['--json', 'resume', 'thread-1', 'Continue']);
  assert.ok(resumed.includes('web_search="disabled"'));
  assert.ok(resumed.includes('sandbox_workspace_write.network_access=false'));
  assert.deepEqual(resumed.slice(0, resumed.indexOf('exec')), [
    '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
    '--config', 'web_search="disabled"',
    '--config', 'sandbox_workspace_write.network_access=false',
    '--disable', 'multi_agent', '--disable', 'apps',
  ]);
  assert.equal(resumed.includes('-C'), false);
  assert.equal(resumed.includes('--cd'), false);
});

test('Codex lifecycle maps the recorded thread, message, file change, and usage without invented detail', () => {
  const events = readFileSync(join(HERE, 'codex-stream-sample.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(getCodexThreadId(events[0]), '019c0011-2222-7333-8444-555566667777');
  assert.equal(getCodexThreadId({ type: 'thread.started', thread_id: 42 }), null);
  assert.deepEqual(mapCodexEvent({ type: 'turn.started' }, 'index.html'), [
    { type: 'status', state: 'thinking', label: 'thinking…' },
  ]);

  const frames = events.flatMap((event) => mapCodexEvent(event, 'index.html'));
  assert.ok(frames.some((frame) => frame.type === 'status' && frame.state === 'tool_using'));
  assert.ok(frames.some((frame) => frame.type === 'assistant_delta'
    && frame.kind === 'thinking' && /smallest targeted change/.test(frame.text)));
  assert.ok(frames.some((frame) => frame.type === 'assistant_delta'
    && frame.kind === 'text' && frame.text === 'Tightened the title.'));
  const changed = frames.find((frame) => frame.type === 'edit');
  assert.deepEqual(changed, {
    type: 'edit', tool: 'Codex', file: 'index.html',
    paths: [{ path: 'index.html', kind: 'update' }],
  });
  assert.equal('hunks' in changed, false);
  assert.equal('cids' in changed, false);

  const usage = frames.find((frame) => frame.type === 'usage');
  assert.deepEqual(usage, {
    type: 'usage', provider: 'codex', inputTokens: 1200,
    cachedInputTokens: 400, outputTokens: 300, totalTokens: 1500,
  });
  const done = frames.find((frame) => frame.type === 'status' && frame.done);
  assert.deepEqual(done, {
    type: 'status', state: 'done', label: 'done',
    usage: { input_tokens: 1200, cached_input_tokens: 400, output_tokens: 300 },
    done: true,
  });
  assert.equal('cost' in done, false);
});

test('Codex maps top-level and item errors as warnings but turn failure as terminal', () => {
  assert.deepEqual(mapCodexEvent({ type: 'error', message: 'retrying transport' }, 'index.html'), [{
    type: 'warning', label: 'Codex warning', detail: 'retrying transport',
  }]);
  assert.deepEqual(mapCodexEvent({
    type: 'item.completed', item: { type: 'error', message: 'tool output unavailable' },
  }, 'index.html'), [{
    type: 'warning', label: 'Codex warning', detail: 'tool output unavailable',
  }]);
  assert.deepEqual(mapCodexEvent({
    type: 'turn.failed', error: { message: 'model failed' },
  }, 'index.html'), [{
    type: 'status', state: 'error', label: 'turn failed', detail: 'model failed',
  }]);
});

test('Codex success uses the controlled invocation, saved auth environment, and one terminal', async (t) => {
  const child = fakeChild();
  const frames = [];
  const sessions = [];
  let invocation;
  const sourceEnv = {
    PATH: '/bin', SANDPAPER_ENV_SENTINEL: 'kept',
    CODEX_API_KEY: 'codex-override', OPENAI_API_KEY: 'openai-override',
  };
  const handle = runCodexTurn({
    pageFile: '/tmp/project/index.html',
    prompt: 'Tighten the title',
    resumeId: 'thread-old',
    onSession: (id) => sessions.push(id),
    onFrame: (frame) => frames.push(frame),
  }, {
    env: sourceEnv,
    spawn: (...args) => { invocation = args; return child; },
  });
  assert.equal(handle, child);
  handle.kill();
  assert.equal(child.killed, true);
  assert.equal(invocation[0], 'codex');
  assert.deepEqual(invocation[1], codexArgs({ prompt: 'Tighten the title', resumeId: 'thread-old' }));
  assert.equal(invocation[2].cwd, '/tmp/project');
  assert.deepEqual(invocation[2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(invocation[2].env.SANDPAPER_ENV_SENTINEL, 'kept');
  assert.equal('CODEX_API_KEY' in invocation[2].env, false);
  assert.equal('OPENAI_API_KEY' in invocation[2].env, false);
  assert.equal(sourceEnv.CODEX_API_KEY, 'codex-override');

  const ended = new Promise((resolve) => child.stdout.once('end', resolve));
  child.stdout.end(readFileSync(join(HERE, 'codex-stream-sample.jsonl')));
  await ended;
  child.emit('close', 0, null);
  child.emit('close', 7, null);
  assert.deepEqual(sessions, ['019c0011-2222-7333-8444-555566667777']);
  assert.equal(terminals(frames).length, 1);
  assert.equal(terminals(frames)[0].state, 'done');
});

test('Codex ignores malformed JSON noise and emits one failure terminal', () => {
  const child = fakeChild();
  const frames = [];
  runCodexTurn(input(child, frames), { spawn: () => child });
  child.stdout.write('not json\n');
  child.stdout.write(`${JSON.stringify({ type: 'error', message: 'temporary trouble' })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'turn.failed', error: { message: 'request failed' } })}\n`);
  child.stdout.end();
  child.emit('close', 1, null);
  assert.equal(frames.filter((frame) => frame.type === 'warning').length, 1);
  assert.deepEqual(terminals(frames), [{
    type: 'status', state: 'error', label: 'turn failed', detail: 'request failed',
  }]);
});

test('Codex reports synchronous spawn throws and asynchronous spawn errors exactly once', () => {
  const thrownFrames = [];
  const thrown = runCodexTurn({ ...input(null, thrownFrames) }, {
    spawn: () => { throw new Error('spawn exploded'); },
  });
  assert.equal(thrown, null);
  assert.deepEqual(terminals(thrownFrames), [{
    type: 'status', state: 'error', label: 'Could not start codex', detail: 'spawn exploded',
  }]);

  const child = fakeChild();
  const errorFrames = [];
  runCodexTurn(input(child, errorFrames), { spawn: () => child });
  child.emit('error', new Error('binary disappeared'));
  child.emit('close', 1, null);
  assert.deepEqual(terminals(errorFrames), [{
    type: 'status', state: 'error',
    label: 'codex not found — is it installed?', detail: 'binary disappeared',
  }]);
});

test('Codex reports interruption and nonzero close with stderr as one terminal each', () => {
  const interrupted = fakeChild();
  const interruptedFrames = [];
  runCodexTurn(input(interrupted, interruptedFrames), { spawn: () => interrupted });
  interrupted.stdout.end();
  interrupted.emit('close', null, 'SIGTERM');
  assert.deepEqual(terminals(interruptedFrames), [{
    type: 'status', state: 'error', label: 'codex interrupted (SIGTERM)', detail: '',
  }]);

  const failed = fakeChild();
  const failedFrames = [];
  runCodexTurn(input(failed, failedFrames), { spawn: () => failed });
  failed.stderr.write('permission denied');
  failed.stdout.end();
  failed.emit('close', 7, null);
  assert.deepEqual(terminals(failedFrames), [{
    type: 'status', state: 'error', label: 'codex exited (7)', detail: 'permission denied',
  }]);
});

test('Codex flushes a final unterminated terminal line', async () => {
  const child = fakeChild();
  const frames = [];
  runCodexTurn(input(child, frames), { spawn: () => child });
  const ended = new Promise((resolve) => child.stdout.once('end', resolve));
  child.stdout.end(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
  }));
  await ended;
  child.emit('close', 0, null);
  assert.equal(terminals(frames).length, 1);
  assert.equal(terminals(frames)[0].state, 'done');
});

test('Codex EOF without a terminal event synthesizes exactly one terminal error', () => {
  const child = fakeChild();
  const frames = [];
  runCodexTurn(input(child, frames), { spawn: () => child });
  child.stdout.end(`${JSON.stringify({ type: 'turn.started' })}\n`);
  child.emit('close', 0, null);
  assert.deepEqual(terminals(frames), [{
    type: 'status', state: 'error', label: 'codex exited without a terminal event', detail: '',
  }]);
});

test('codexChildEnv removes API-key overrides without mutating its source', () => {
  const source = { HOME: '/tmp/home', CODEX_API_KEY: 'codex', OPENAI_API_KEY: 'openai' };
  assert.deepEqual(codexChildEnv(source), { HOME: '/tmp/home' });
  assert.deepEqual(source, {
    HOME: '/tmp/home', CODEX_API_KEY: 'codex', OPENAI_API_KEY: 'openai',
  });
});
