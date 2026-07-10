import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { get as httpGet, request as httpRequest } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createSandpaperServer } from '../src/server.js';
import { runTurn } from '../src/claude.js';
import { createFakeRunner, makeRepo, openEvents, requestJson } from './helpers/server-fixture.js';

const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];

async function fixture(t, { brain = false, watch, now = () => 1_000 } = {}) {
  const repo = makeRepo();
  const fakeRunner = createFakeRunner();
  let uuidIndex = 0;
  const controller = createSandpaperServer(brain ? repo.root : repo.pageFile,
    { brain, snapshotLimit: 2 }, {
      runner: fakeRunner,
      uuid: () => IDS[uuidIndex++],
      tokenFactory: () => 'test-token',
      now,
      watch,
    });
  const url = await controller.listen();
  t.after(async () => {
    await controller.close();
    repo.cleanup();
  });
  return { ...repo, fakeRunner, controller, url };
}

function controlledWatch() {
  let callback = null;
  let closed = false;
  return {
    watch(_root, _options, onChange) {
      callback = onChange;
      return { close() { closed = true; } };
    },
    emit(filename, event = 'change') {
      assert.equal(closed, false);
      assert.ok(callback, 'watch callback is registered');
      callback(event, filename);
    },
  };
}

async function noFrame(events, wait = 180) {
  await assert.rejects(events.next(wait), /timed out waiting for SSE frame/);
}

async function noMatchingFrame(events, predicate, wait = 80) {
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    try {
      const frame = await events.next(Math.max(1, deadline - Date.now()));
      assert.equal(predicate(frame), false, `unexpected SSE frame: ${JSON.stringify(frame)}`);
    } catch (error) {
      if (/timed out waiting for SSE frame/.test(error.message)) return;
      throw error;
    }
  }
}

async function nextFrame(events, predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = await events.next(Math.max(1, deadline - Date.now()));
    if (predicate(frame)) return frame;
  }
  throw new Error('timed out waiting for matching SSE frame');
}

function startReceivingTurn(baseUrl) {
  const url = new URL('/__sandpaper/turn', baseUrl);
  let responseResolve;
  let responseReject;
  const response = new Promise((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });
  const req = httpRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sandpaper-Token': 'test-token',
      'X-Sandpaper-Client': 'client-a',
      Origin: baseUrl.replace(/\/$/, ''),
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      responseResolve({ status: res.statusCode, json: JSON.parse(text) });
    });
  });
  req.on('error', responseReject);
  req.write('{"page":"/","prompt":"first"');
  return { req, response };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

function getText(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

const mutations = [
  ['/__sandpaper/turn', { page: '/', prompt: 'Change it' }, 1_000_000],
  ['/__sandpaper/write', { page: '/', cid: 'main', html: 'Changed' }, 2_000_000],
  ['/__sandpaper/dom', { page: '/', cid: 'main', op: 'delete' }, 100_000],
  ['/__sandpaper/undo', { turnId: IDS[0], page: '/' }, 100_000],
  ['/__sandpaper/undo-direct', { page: '/' }, 10_000],
];

test('auth token is injected into served HTML', async (t) => {
  const { url } = await fixture(t);
  const response = await getText(url);
  assert.equal(response.status, 200);
  assert.match(response.text, /<script[^>]*type="module"[^>]*data-sandpaper-token="test-token"[^>]*>/);
});

for (const [path, body, limit] of mutations) {
  test(`auth rejects missing and wrong token for ${path}`, async (t) => {
    const { url } = await fixture(t);
    for (const token of [null, 'wrong-token']) {
      const response = await requestJson(url, path, { body, token });
      assert.equal(response.status, 403);
      assert.deepEqual(Object.keys(response.json || {}), ['ok', 'error']);
      assert.equal(response.json.ok, false);
      assert.equal(typeof response.json.error.code, 'string');
      assert.equal(typeof response.json.error.message, 'string');
    }
  });

  test(`origin rejects absent and foreign Origin for ${path}`, async (t) => {
    const { url } = await fixture(t);
    for (const origin of [null, 'https://foreign.example']) {
      const response = await requestJson(url, path, { body, origin });
      assert.equal(response.status, 403);
      assert.equal(response.json.ok, false);
      assert.equal(response.json.error.code, 'invalid_origin');
    }
  });

  test(`auth rejects a foreign Host for ${path}`, async (t) => {
    const { url } = await fixture(t);
    const response = await requestJson(url, path, {
      body,
      headers: { Host: 'foreign.example', Origin: 'http://foreign.example' },
      origin: null,
    });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, 'invalid_host');
  });

  test(`content rejects non-JSON, malformed JSON, and oversized JSON for ${path}`, async (t) => {
    const { url } = await fixture(t);
    const unsupported = await requestJson(url, path, { body, contentType: 'text/plain' });
    assert.equal(unsupported.status, 415);
    assert.equal(unsupported.json.error.code, 'unsupported_media_type');

    const malformed = await requestJson(url, path, { rawBody: '{', contentType: 'application/json' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error.code, 'malformed_json');

    const oversizedBody = JSON.stringify({ pad: 'x'.repeat(limit) });
    assert.ok(Buffer.byteLength(oversizedBody) > limit);
    const oversized = await requestJson(url, path, { rawBody: oversizedBody });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.json.error.code, 'payload_too_large');
  });
}

test('content accepts application/json charset with matching loopback origin', async (t) => {
  const { url } = await fixture(t);
  const response = await requestJson(url, '/__sandpaper/write', {
    body: { page: '/', cid: 'main', html: 'Changed' },
    contentType: 'application/json; charset=utf-8',
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
});

test('SSE auth rejects missing credentials and accepts token with client ID', async (t) => {
  const { url } = await fixture(t);
  const missingToken = await openEvents(url, { token: null });
  assert.equal(missingToken.status, 403);
  assert.equal(missingToken.json.error.code, 'invalid_token');

  const missingClient = await openEvents(url, { clientId: null });
  assert.equal(missingClient.status, 403);
  assert.equal(missingClient.json.error.code, 'invalid_client');

  const events = await openEvents(url);
  t.after(() => events.close());
  assert.equal(events.status, 200);
  assert.deepEqual(await events.next(), { type: 'status', state: 'idle', label: 'idle' });
});

test('turn reservation accepts exactly one request while the first body is receiving', async (t) => {
  const { url, fakeRunner } = await fixture(t);
  const first = startReceivingTurn(url);
  await new Promise((resolve) => setImmediate(resolve));

  const second = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', prompt: 'second' }, clientId: 'client-b',
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'turn_in_progress');

  first.req.end('}');
  const accepted = await first.response;
  assert.equal(accepted.status, 202);
  assert.equal(fakeRunner.calls.length, 1);
});

test('turn SSE replays the current turn ID, page, phase, and latest status', async (t) => {
  const { url, fakeRunner } = await fixture(t);
  const accepted = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'think' } });
  fakeRunner.emit({ type: 'status', state: 'thinking', label: 'thinking…' });
  fakeRunner.emit({ type: 'assistant_delta', kind: 'text', text: 'partial reply' });

  const events = await openEvents(url, { clientId: 'late-client' });
  t.after(() => events.close());
  const replay = await events.next();
  assert.equal(replay.turnId, accepted.json.turnId);
  assert.equal(replay.page, '/');
  assert.equal(replay.phase, 'running');
  assert.equal(replay.state, 'thinking');
});

test('late terminal frames from turn 1 cannot clear or relabel turn 2', async (t) => {
  const { url, fakeRunner } = await fixture(t);
  await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'one' } });
  fakeRunner.complete(0);
  const second = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'two' } });
  fakeRunner.emit({ type: 'status', state: 'thinking', label: 'second thinking' }, 1);
  fakeRunner.fail('late failure', 0);

  const events = await openEvents(url, { clientId: 'late-client' });
  t.after(() => events.close());
  const replay = await events.next();
  assert.equal(replay.turnId, second.json.turnId);
  assert.equal(replay.state, 'thinking');
  assert.equal(replay.label, 'second thinking');
});

test('changed state is false and snapshot removed when an edit frame leaves bytes unchanged', async (t) => {
  const { url, fakeRunner, root } = await fixture(t);
  const accepted = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'same' } });
  fakeRunner.emit({ type: 'edit', tool: 'Edit', file: 'index.html', hunks: [] });
  fakeRunner.complete();

  const events = await openEvents(url, { clientId: 'late-client' });
  t.after(() => events.close());
  const terminal = await events.next();
  assert.equal(terminal.changed, false);
  assert.equal(terminal.undoable, false);
  assert.equal(existsSync(join(root, '.sandpaper', 'snapshots', `${accepted.json.turnId}.html`)), false);
});

test('changed state is true without an edit frame and exposes an existing snapshot', async (t) => {
  const { url, fakeRunner, pageFile } = await fixture(t);
  await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'write silently' } });
  writeFileSync(pageFile, '<!doctype html><html><body>Changed silently</body></html>');
  fakeRunner.complete();

  const events = await openEvents(url, { clientId: 'late-client' });
  t.after(() => events.close());
  const terminal = await events.next();
  assert.equal(terminal.changed, true);
  assert.equal(terminal.undoable, true);
});

test('turn error after a partial write retains truthful changed and undo state', async (t) => {
  const { url, fakeRunner, pageFile } = await fixture(t);
  await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'fail after write' } });
  writeFileSync(pageFile, '<!doctype html><html><body>Partial write</body></html>');
  fakeRunner.fail('process failed');

  const events = await openEvents(url, { clientId: 'late-client' });
  t.after(() => events.close());
  const terminal = await events.next();
  assert.equal(terminal.state, 'error');
  assert.equal(terminal.changed, true);
  assert.equal(terminal.undoable, true);
});

test('turn cleanup kills an active runner handle', async (t) => {
  const { url, fakeRunner, controller } = await fixture(t);
  await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'stay active' } });
  const handle = fakeRunner.calls[0].handle;
  await controller.close();
  assert.equal(handle.killed, true);
});

test('turn controller close terminates a request whose body is still receiving', async (t) => {
  const { url, controller } = await fixture(t);
  const receiving = startReceivingTurn(url);
  receiving.response.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  const closing = controller.close();
  let timeout;
  const outcome = await Promise.race([
    closing.then(() => 'closed'),
    new Promise((resolve) => { timeout = setTimeout(() => resolve('timed-out'), 250); }),
  ]);
  clearTimeout(timeout);
  if (outcome !== 'closed') receiving.req.destroy();
  await closing;
  assert.equal(outcome, 'closed');
});

test('turn runner close after result stays terminal, while close without result emits one error', async (t) => {
  assert.equal(runTurn.length, 4, 'runTurn needs a controllable fourth dependency argument');

  const withResult = fakeChild();
  const resultFrames = [];
  runTurn(join(t.mock?.name || '/tmp', 'page.html'), 'prompt', (frame) => resultFrames.push(frame), {
    spawn: () => withResult,
  });
  withResult.stdout.end(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`);
  withResult.emit('close', 0);
  assert.deepEqual(resultFrames.filter((frame) => frame.type === 'status').map((frame) => frame.state), ['init', 'done']);

  const withoutResult = fakeChild();
  const missingFrames = [];
  runTurn('/tmp/page.html', 'prompt', (frame) => missingFrames.push(frame), { spawn: () => withoutResult });
  withoutResult.stdout.end();
  withoutResult.emit('close', 0);
  assert.deepEqual(missingFrames.filter((frame) => frame.state === 'error').length, 1);
  assert.equal(missingFrames.some((frame) => frame.state === 'idle'), false);
});

test('same-page AI and direct undo return 409 during a turn', async (t) => {
  const { url, fakeRunner, pageFile } = await fixture(t);
  const old = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'old' } });
  writeFileSync(pageFile, '<!doctype html><html><body><main data-cid="main">Old changed</main></body></html>');
  fakeRunner.complete();

  const direct = await requestJson(url, '/__sandpaper/write', {
    body: { page: '/', cid: 'main', html: 'Direct changed' },
  });
  assert.equal(direct.status, 200);
  await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'active' } });

  const aiUndo = await requestJson(url, '/__sandpaper/undo', { body: { turnId: old.json.turnId, page: '/' } });
  const directUndo = await requestJson(url, '/__sandpaper/undo-direct', { body: { page: '/' } });
  assert.equal(aiUndo.status, 409);
  assert.equal(directUndo.status, 409);
});

test('undo consumes its snapshot and restores the original bytes', async (t) => {
  const { url, fakeRunner, pageFile, root } = await fixture(t);
  const original = readFileSync(pageFile, 'utf8');
  const accepted = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'change' } });
  writeFileSync(pageFile, '<!doctype html><html><body>Changed</body></html>');
  fakeRunner.complete();

  const restored = await requestJson(url, '/__sandpaper/undo', { body: { turnId: accepted.json.turnId, page: '/' } });
  assert.equal(restored.status, 200);
  assert.equal(readFileSync(pageFile, 'utf8'), original);
  assert.equal(existsSync(join(root, '.sandpaper', 'snapshots', `${accepted.json.turnId}.html`)), false);
  const consumed = await requestJson(url, '/__sandpaper/undo', { body: { turnId: accepted.json.turnId, page: '/' } });
  assert.equal(consumed.status, 404);
});

test('third retained turn prunes the oldest snapshot from memory and disk', async (t) => {
  const { url, fakeRunner, pageFile, root } = await fixture(t);
  const turns = [];
  for (let index = 0; index < 3; index++) {
    const accepted = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: `change ${index}` } });
    turns.push(accepted.json.turnId);
    writeFileSync(pageFile, `<!doctype html><html><body>Changed ${index}</body></html>`);
    fakeRunner.complete(index);
  }

  const snapshotDir = join(root, '.sandpaper', 'snapshots');
  const retained = readdirSync(snapshotDir).filter((name) => name.endsWith('.html'));
  assert.equal(retained.length, 2);
  assert.equal(existsSync(join(snapshotDir, `${turns[0]}.html`)), false);
  const oldest = await requestJson(url, '/__sandpaper/undo', { body: { turnId: turns[0], page: '/' } });
  assert.equal(oldest.status, 404);
});

test('reload after direct write excludes its client and other pages, then suppresses only its matching watcher hash', async (t) => {
  const watched = controlledWatch();
  const { url, pageFile } = await fixture(t, { brain: true, watch: watched.watch });
  const clientA = await openEvents(url, { clientId: 'client-a', page: '/' });
  const clientB = await openEvents(url, { clientId: 'client-b', page: '/' });
  const otherPage = await openEvents(url, { clientId: 'client-c', page: '/other.html' });
  t.after(() => { clientA.close(); clientB.close(); otherPage.close(); });
  await Promise.all([clientA.next(), clientB.next(), otherPage.next()]);

  const written = await requestJson(url, '/__sandpaper/write', {
    clientId: 'client-a', body: { page: '/', cid: 'main', html: 'Direct write' },
  });
  assert.equal(written.status, 200);
  assert.deepEqual(await clientB.next(), { type: 'reload', page: '/' });
  await Promise.all([noFrame(clientA, 60), noFrame(otherPage, 60)]);

  watched.emit('index.html');
  await Promise.all([noFrame(clientA), noFrame(clientB), noFrame(otherPage)]);

  writeFileSync(pageFile, '<!doctype html><html><body><main data-cid="main">External write</main></body></html>');
  watched.emit('index.html');
  assert.deepEqual(await clientA.next(), { type: 'reload', page: '/' });
  assert.deepEqual(await clientB.next(), { type: 'reload', page: '/' });
  await noMatchingFrame(otherPage, (frame) => frame.type === 'reload');
});

test('reload debounce is independent for two pages changed in one interval', async (t) => {
  const watched = controlledWatch();
  const { url, pageFile, otherFile } = await fixture(t, { brain: true, watch: watched.watch });
  const cover = await openEvents(url, { clientId: 'cover-client', page: '/' });
  const other = await openEvents(url, { clientId: 'other-client', page: '/other.html' });
  t.after(() => { cover.close(); other.close(); });
  await Promise.all([cover.next(), other.next()]);

  writeFileSync(pageFile, '<!doctype html><html><body>Cover external</body></html>');
  writeFileSync(otherFile, '<!doctype html><html><body>Other external</body></html>');
  watched.emit('index.html');
  watched.emit('other.html');

  assert.deepEqual(await cover.next(), { type: 'reload', page: '/' });
  assert.deepEqual(await other.next(), { type: 'reload', page: '/other.html' });
});

test('reload for an AI change reaches all same-page clients only after the terminal status', async (t) => {
  const watched = controlledWatch();
  const { url, fakeRunner, pageFile } = await fixture(t, { brain: true, watch: watched.watch });
  const clientA = await openEvents(url, { clientId: 'client-a', page: '/' });
  const clientB = await openEvents(url, { clientId: 'client-b', page: '/' });
  const otherPage = await openEvents(url, { clientId: 'client-c', page: '/other.html' });
  t.after(() => { clientA.close(); clientB.close(); otherPage.close(); });
  await Promise.all([clientA.next(), clientB.next(), otherPage.next()]);

  const accepted = await requestJson(url, '/__sandpaper/turn', {
    clientId: 'client-a', body: { page: '/', prompt: 'AI write' },
  });
  writeFileSync(pageFile, '<!doctype html><html><body>AI write</body></html>');
  watched.emit('index.html');
  await new Promise((resolve) => setTimeout(resolve, 150));
  fakeRunner.complete();

  for (const events of [clientA, clientB]) {
    const terminal = await nextFrame(events, (frame) => frame.turnId === accepted.json.turnId && frame.phase === 'done');
    assert.equal(terminal.changed, true);
    assert.deepEqual(await events.next(), { type: 'reload', page: '/' });
  }
  await noMatchingFrame(otherPage, (frame) => frame.type === 'reload');
});
