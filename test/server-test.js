import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, get as httpGet, request as httpRequest } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createSandpaperServer, startServer } from '../src/server.js';
import { runClaudeTurn } from '../src/claude.js';
import {
  createFakeProviderServices, createFakeRunner, makeRepo, openEvents,
  requestJson as rawRequestJson,
} from './helpers/server-fixture.js';

const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];

async function fixture(t, {
  brain = false, watch, now = () => 1_000, runner, writeFile, restoreFile,
  providerServices, initialProvider,
} = {}) {
  const repo = makeRepo();
  const fakeRunner = runner || createFakeRunner();
  const runnerImpl = runner || fakeRunner;
  const services = providerServices || createFakeProviderServices({
    runners: { claude: runnerImpl },
  });
  let uuidIndex = 0;
  const controller = createSandpaperServer(brain ? repo.root : repo.pageFile,
    { brain, snapshotLimit: 2, initialProvider }, {
      registry: services.registry,
      preferences: services.preferences,
      sessions: services.sessions,
      uuid: () => IDS[uuidIndex++],
      tokenFactory: () => 'test-token',
      now,
      watch,
      writeFile,
      restoreFile,
    });
  const url = await controller.listen();
  t.after(async () => {
    await controller.close();
    repo.cleanup();
  });
  return { ...repo, fakeRunner, providerServices: services, controller, url };
}

function requestJson(baseUrl, path, options = {}) {
  const body = options.body;
  if (path === '/__sandpaper/turn' && body && typeof body === 'object' && !Array.isArray(body)
      && !Object.hasOwn(body, 'provider')) {
    return rawRequestJson(baseUrl, path, { ...options, body: { ...body, provider: 'claude' } });
  }
  return rawRequestJson(baseUrl, path, options);
}

function controlledTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback) {
      const timer = { id: nextId++, callback, cleared: false };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    get size() { return timers.size; },
    runAll() {
      for (const timer of timers.values()) timer.callback();
      timers.clear();
    },
  };
}

async function waitUntil(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setImmediate(resolve));
  }
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

async function drainInitialReplay(events) {
  const first = await events.next();
  const second = await events.next();
  assert.equal(first.type, 'status');
  assert.equal(second.type, 'lifecycle');
  return { status: first, lifecycle: second };
}

function startReceivingTurn(baseUrl, clientId = 'client-a') {
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
      'X-Sandpaper-Client': clientId,
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
  req.write('{"page":"/","provider":"claude","prompt":"first"');
  return { req, response };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
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

function getRawPath(baseUrl, path) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    httpRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method: 'GET',
      headers: { Host: target.host },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* expose plain responses through text */ }
        resolve({ status: res.statusCode, text, json });
      });
    }).on('error', reject).end();
  });
}

const mutations = [
  ['/__sandpaper/turn', { page: '/', prompt: 'Change it' }, 1_000_000],
  ['/__sandpaper/provider-default', { provider: 'claude' }, 10_000],
  ['/__sandpaper/session/reset', { page: '/', provider: 'claude' }, 10_000],
  ['/__sandpaper/write', { page: '/', cid: 'main', html: 'Changed' }, 2_000_000],
  ['/__sandpaper/dom', { page: '/', cid: 'main', op: 'delete' }, 100_000],
  ['/__sandpaper/undo', { turnId: IDS[0], page: '/' }, 100_000],
  ['/__sandpaper/undo-direct', { page: '/' }, 10_000],
];

function decodeBootstrap(html) {
  const match = html.match(/data-sandpaper-bootstrap="([^"]+)"/);
  assert.ok(match, 'toolbar script has bootstrap data');
  const decoded = match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
  return JSON.parse(decoded);
}

test('served HTML injects escaped stable provider bootstrap with distinct initial and default providers', async (t) => {
  const diagnostics = [
    { id: 'claude', label: 'Claude &quot; <script>', available: true, compatible: true, authMethod: 'subscription' },
    { id: 'codex', label: 'Codex', available: true, compatible: true, authMethod: 'chatgpt' },
  ];
  const providerServices = createFakeProviderServices({ defaultProvider: 'claude', diagnostics });
  const { url, root } = await fixture(t, { initialProvider: 'codex', providerServices });
  const firstText = (await getText(url)).text;
  assert.doesNotMatch(firstText, /data-sandpaper-bootstrap="[^"]*<script>/);
  const first = decodeBootstrap(firstText);
  assert.match(first.projectId, /^[a-f0-9]{16}$/);
  assert.equal(first.initialProvider, 'codex');
  assert.equal(first.defaultProvider, 'claude');
  assert.deepEqual(first.providers, diagnostics);

  const secondServices = createFakeProviderServices({ defaultProvider: 'claude', diagnostics });
  const secondController = createSandpaperServer(join(root, 'index.html'), { initialProvider: 'codex' }, {
    registry: secondServices.registry,
    preferences: secondServices.preferences,
    sessions: secondServices.sessions,
    tokenFactory: () => 'test-token-2',
    watch: () => ({ close() {} }),
  });
  const secondUrl = await secondController.listen();
  t.after(() => secondController.close());
  const second = decodeBootstrap((await getText(secondUrl)).text);
  assert.equal(second.projectId, first.projectId);
});

test('turn rejects missing, unknown, and unavailable providers before any reservation or side effect', async (t) => {
  const providerServices = createFakeProviderServices({ diagnostics: [
    { id: 'claude', label: 'Claude Code', available: true, compatible: true, authMethod: 'subscription' },
    { id: 'codex', label: 'Codex', available: false, compatible: true, authMethod: null, unavailableCode: 'not_authenticated' },
  ] });
  const { url, root } = await fixture(t, { providerServices });
  const events = await openEvents(url, { clientId: 'validation-observer' });
  t.after(() => events.close());
  assert.equal((await events.next()).state, 'idle');

  const missing = await rawRequestJson(url, '/__sandpaper/turn', {
    body: { page: '/', prompt: 'missing provider' },
  });
  const unknown = await rawRequestJson(url, '/__sandpaper/turn', {
    body: { page: '/', provider: 'unknown', prompt: 'unknown provider' },
  });
  const unavailable = await rawRequestJson(url, '/__sandpaper/turn', {
    body: { page: '/', provider: 'codex', prompt: 'unavailable provider' },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'invalid_provider');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, 'invalid_provider');
  assert.equal(unavailable.status, 409);
  assert.equal(unavailable.json.error.code, 'provider_unavailable');
  assert.equal(providerServices.runners.claude.calls.length, 0);
  assert.equal(providerServices.runners.codex.calls.length, 0);
  assert.deepEqual(providerServices.sessionCalls, []);
  assert.equal(existsSync(join(root, '.sandpaper', 'snapshots')), false);
  await noMatchingFrame(events, (frame) => frame.busy === true || frame.state === 'receiving');
});

test('turn dispatches the validated provider with provider-scoped resume and labels response and frames', async (t) => {
  const providerServices = createFakeProviderServices();
  providerServices.sessionValues.set('/\0claude', 'claude-resume');
  providerServices.sessionValues.set('/\0codex', 'codex-resume');
  const { url } = await fixture(t, { providerServices });
  const events = await openEvents(url, { clientId: 'codex-observer' });
  t.after(() => events.close());
  await events.next();

  const accepted = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', provider: 'codex', prompt: 'Codex turn' },
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.json.provider, 'codex');
  assert.equal(providerServices.runners.claude.calls.length, 0);
  assert.equal(providerServices.runners.codex.calls.length, 1);
  assert.equal(providerServices.runners.codex.calls[0].resumeId, 'codex-resume');
  providerServices.runners.codex.session('codex-next');
  providerServices.runners.codex.emit({ type: 'assistant', text: 'Hello' });
  providerServices.runners.codex.complete();

  assert.ok(providerServices.sessionCalls.some(([name, value]) => name === 'set'
    && value.page === '/' && value.provider === 'codex' && value.resumeId === 'codex-next'));
  const assistant = await nextFrame(events, (frame) => frame.type === 'assistant');
  assert.equal(assistant.provider, 'codex');
  const terminal = await nextFrame(events, (frame) => frame.state === 'done');
  assert.equal(terminal.provider, 'codex');

  const replay = await openEvents(url, { clientId: 'codex-replay' });
  t.after(() => replay.close());
  const current = await replay.next();
  assert.equal(current.provider, 'codex');
  assert.equal(current.turnId, accepted.json.turnId);

  const claude = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', provider: 'claude', prompt: 'Claude turn' },
  });
  assert.equal(claude.status, 202);
  assert.equal(providerServices.runners.claude.calls[0].resumeId, 'claude-resume');
  assert.notEqual(providerServices.runners.claude.calls[0].resumeId, 'codex-next');
  providerServices.runners.claude.complete();
});

test('global lifecycle is provider-tagged across pages and releases exactly once on terminal success', async (t) => {
  const providerServices = createFakeProviderServices();
  const { url } = await fixture(t, { brain: true, providerServices });
  const rootEvents = await openEvents(url, { clientId: 'root-life', page: '/' });
  const otherEvents = await openEvents(url, { clientId: 'other-life', page: '/other.html' });
  t.after(() => { rootEvents.close(); otherEvents.close(); });
  await Promise.all([rootEvents.next(), otherEvents.next()]);

  const accepted = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', provider: 'codex', prompt: 'busy' },
  });
  const busy = await nextFrame(otherEvents, (frame) => frame.type === 'lifecycle' && frame.busy);
  assert.deepEqual(busy, {
    type: 'lifecycle', busy: true, turnId: accepted.json.turnId, provider: 'codex', page: '/',
  });
  const reconnect = await openEvents(url, { clientId: 'reconnect-life', page: '/other.html' });
  t.after(() => reconnect.close());
  assert.equal((await nextFrame(reconnect, (frame) => frame.type === 'lifecycle')).busy, true);
  const concurrent = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/other.html', provider: 'claude', prompt: 'must wait' },
  });
  assert.equal(concurrent.status, 409);
  assert.equal(providerServices.runners.claude.calls.length, 0);

  providerServices.runners.codex.complete();
  const idle = await nextFrame(otherEvents, (frame) => frame.type === 'lifecycle' && !frame.busy);
  assert.deepEqual(idle, { ...busy, busy: false });
  await noMatchingFrame(otherEvents, (frame) => frame.type === 'lifecycle' && !frame.busy, 60);

  const next = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/other.html', provider: 'claude', prompt: 'next' },
  });
  assert.equal(next.status, 202);
});

test('provider default persists only a ready provider and leaves launch selection unchanged', async (t) => {
  const providerServices = createFakeProviderServices();
  const { url } = await fixture(t, { initialProvider: 'claude', providerServices });
  const changed = await requestJson(url, '/__sandpaper/provider-default', { body: { provider: 'codex' } });
  assert.deepEqual(changed.json, { ok: true, defaultProvider: 'codex' });
  const bootstrap = decodeBootstrap((await getText(url)).text);
  assert.equal(bootstrap.initialProvider, 'claude');
  assert.equal(bootstrap.defaultProvider, 'codex');

  const invalid = await requestJson(url, '/__sandpaper/provider-default', { body: { provider: 'unknown' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'invalid_provider');
  assert.equal(providerServices.defaultProvider, 'codex');
});

test('provider default rejects while any provider turn is active without persisting', async (t) => {
  const providerServices = createFakeProviderServices();
  const { url } = await fixture(t, { providerServices });
  await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', provider: 'claude', prompt: 'active' },
  });
  const rejected = await requestJson(url, '/__sandpaper/provider-default', {
    body: { provider: 'codex' },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.error.code, 'turn_in_progress');
  assert.equal(providerServices.defaultProvider, 'claude');
  assert.equal(providerServices.preferenceCalls.some(([name]) => name === 'set'), false);
});

test('provider default persistence failure returns a structured error without changing the preference', async (t) => {
  const providerServices = createFakeProviderServices();
  providerServices.preferences.setDefaultProvider = () => { throw new Error('disk failure'); };
  const { url } = await fixture(t, { providerServices });
  const failed = await requestJson(url, '/__sandpaper/provider-default', {
    body: { provider: 'codex' },
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error.code, 'internal_error');
  assert.equal(providerServices.defaultProvider, 'claude');
});

test('session reset clears only one mutable page/provider and rejects active turns and store failure', async (t) => {
  const providerServices = createFakeProviderServices();
  providerServices.sessionValues.set('/\0claude', 'root-claude');
  providerServices.sessionValues.set('/\0codex', 'root-codex');
  providerServices.sessionValues.set('/other.html\0codex', 'other-codex');
  const { url } = await fixture(t, { brain: true, providerServices });

  const cleared = await requestJson(url, '/__sandpaper/session/reset', {
    body: { page: '/', provider: 'codex' },
  });
  assert.deepEqual(cleared.json, { ok: true, page: '/', provider: 'codex' });
  assert.equal(providerServices.sessionValues.has('/\0codex'), false);
  assert.equal(providerServices.sessionValues.get('/\0claude'), 'root-claude');
  assert.equal(providerServices.sessionValues.get('/other.html\0codex'), 'other-codex');

  const invalidPage = await requestJson(url, '/__sandpaper/session/reset', {
    body: { page: '/missing.html', provider: 'codex' },
  });
  assert.equal(invalidPage.status, 400);
  assert.equal(invalidPage.json.error.code, 'invalid_page');

  await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', provider: 'claude', prompt: 'active' },
  });
  const busy = await requestJson(url, '/__sandpaper/session/reset', {
    body: { page: '/other.html', provider: 'codex' },
  });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.error.code, 'turn_in_progress');
  providerServices.runners.claude.complete();

  providerServices.sessions.clear = () => { throw new Error('disk failure'); };
  const failed = await requestJson(url, '/__sandpaper/session/reset', {
    body: { page: '/other.html', provider: 'codex' },
  });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error.code, 'internal_error');
  assert.equal(providerServices.sessionValues.get('/other.html\0codex'), 'other-codex');
});

test('auth token is injected into served HTML', async (t) => {
  const { url } = await fixture(t);
  const response = await getText(url);
  assert.equal(response.status, 200);
  assert.match(response.text, /<script[^>]*type="module"[^>]*data-sandpaper-token="test-token"[^>]*>/);
});

test('rejects raw and percent-encoded dot segments before URL normalization', async (t) => {
  const { url } = await fixture(t, { brain: true });
  for (const path of [
    '/brain/../README.md',
    '/./index.html',
    '/brain/%2e%2e/README.md',
    '/%2E/index.html',
    '/foo%2F..%2Findex.html',
    '/foo%5C..%5Cindex.html',
  ]) {
    const response = await getRawPath(url, `${path}?from=../query`);
    assert.equal(response.status, 400, path);
    assert.equal(response.json?.ok, false, path);
    assert.equal(response.json?.error?.code, 'invalid_path', path);
  }
  const valid = await getRawPath(url, '/index.html?from=../query');
  assert.equal(valid.status, 200);
  assert.match(valid.text, /data-sandpaper-token=/);
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

for (const path of ['/__sandpaper/provider-default', '/__sandpaper/session/reset']) {
  test(`provider control rejects non-POST method and missing client ID for ${path}`, async (t) => {
    const { url } = await fixture(t);
    const get = await requestJson(url, path, { method: 'GET' });
    assert.equal(get.status, 405);
    assert.equal(get.json.error.code, 'method_not_allowed');
    const missingClient = await requestJson(url, path, { clientId: null });
    assert.equal(missingClient.status, 403);
    assert.equal(missingClient.json.error.code, 'invalid_client');
  });
}

test('provider controls reject missing fields, unavailable defaults, and unsafe page bodies', async (t) => {
  const providerServices = createFakeProviderServices({ diagnostics: [
    { id: 'claude', label: 'Claude Code', available: true, compatible: true, authMethod: 'subscription' },
    { id: 'codex', label: 'Codex', available: false, compatible: true, authMethod: null, unavailableCode: 'not_authenticated' },
  ] });
  const { url } = await fixture(t, { providerServices, brain: true });
  const missingDefault = await rawRequestJson(url, '/__sandpaper/provider-default', { body: {} });
  assert.equal(missingDefault.json.error.code, 'invalid_provider');
  const unavailable = await requestJson(url, '/__sandpaper/provider-default', { body: { provider: 'codex' } });
  assert.equal(unavailable.json.error.code, 'provider_unavailable');
  const missingResetProvider = await rawRequestJson(url, '/__sandpaper/session/reset', { body: { page: '/' } });
  assert.equal(missingResetProvider.json.error.code, 'invalid_provider');
  const missingPage = await requestJson(url, '/__sandpaper/session/reset', { body: { provider: 'claude' } });
  assert.equal(missingPage.json.error.code, 'invalid_page');
  const unsafePage = await requestJson(url, '/__sandpaper/session/reset', {
    body: { page: '/../outside.html', provider: 'claude' },
  });
  assert.equal(unsafePage.json.error.code, 'invalid_page');
});

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

test('SSE origin rejects absent and foreign Origin', async (t) => {
  const { url } = await fixture(t);
  for (const origin of [null, 'https://foreign.example']) {
    const events = await openEvents(url, { origin, clientId: origin === null ? 'missing-origin' : 'foreign-origin' });
    events.close();
    assert.equal(events.status, 403);
    assert.equal(events.json.error.code, 'invalid_origin');
  }
});

test('SSE accepts Chromium same-origin fetch metadata when native EventSource omits Origin', async (t) => {
  const { url } = await fixture(t);
  const events = await openEvents(url, {
    origin: null,
    clientId: 'native-event-source',
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      Referer: new URL('/index.html', url).href,
    },
  });
  t.after(() => events.close());
  assert.equal(events.status, 200);
  assert.deepEqual(await events.next(), { type: 'status', state: 'idle', label: 'idle' });
});

test('SSE rejects missing Origin when same-origin fetch metadata is incomplete or foreign', async (t) => {
  const { url } = await fixture(t);
  for (const headers of [
    { 'Sec-Fetch-Site': 'same-origin' },
    { 'Sec-Fetch-Site': 'cross-site', Referer: new URL('/index.html', url).href },
    { 'Sec-Fetch-Site': 'same-origin', Referer: 'https://foreign.example/page.html' },
    { 'Sec-Fetch-Site': 'same-origin', Referer: 'not a url' },
    { 'Sec-Fetch-Site': 'same-origin', Referer: new URL('/index.html', url).href.replace('127.0.0.1', 'localhost') },
  ]) {
    const events = await openEvents(url, { origin: null, clientId: 'bad-event-source', headers });
    events.close();
    assert.equal(events.status, 403);
    assert.equal(events.json.error.code, 'invalid_origin');
  }
});

test('valid JSON requires an object body for turn and direct mutations', async (t) => {
  const cases = [
    ['/__sandpaper/turn', null],
    ['/__sandpaper/turn', []],
    ['/__sandpaper/turn', 'text'],
    ['/__sandpaper/turn', 7],
    ['/__sandpaper/turn', true],
    ['/__sandpaper/write', null],
    ['/__sandpaper/write', []],
    ['/__sandpaper/write', false],
  ];
  for (const [path, body] of cases) {
    await t.test(`${path} rejects ${JSON.stringify(body)}`, async (subtest) => {
      const { url } = await fixture(subtest);
      const response = await requestJson(url, path, { body });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, 'invalid_body');
    });
  }
});

test('turn body and validation rejections create no reservation or lifecycle side effect', async (t) => {
  const cases = [
    ['malformed', { rawBody: '{' }, 400],
    ['oversized', { rawBody: JSON.stringify({ pad: 'x'.repeat(1_000_000) }) }, 413],
    ['invalid page', { body: { page: '/missing.html', prompt: 'nope' } }, 400],
  ];
  for (const [name, request, status] of cases) {
    await t.test(name, async (subtest) => {
      const { url } = await fixture(subtest);
      const events = await openEvents(url, { clientId: `${name.replace(' ', '-')}-observer` });
      subtest.after(() => events.close());
      await drainInitialReplay(events);

      const response = await requestJson(url, '/__sandpaper/turn', request);
      assert.equal(response.status, status);
      await noMatchingFrame(events, (frame) => frame.type === 'lifecycle' || frame.state === 'receiving');
    });
  }

  await t.test('aborted body', async (subtest) => {
    const { url } = await fixture(subtest);
    const events = await openEvents(url, { clientId: 'aborted-observer' });
    subtest.after(() => events.close());
    await drainInitialReplay(events);
    const receiving = startReceivingTurn(url);
    receiving.response.catch(() => {});
    await noMatchingFrame(events, (frame) => frame.type === 'lifecycle' || frame.state === 'receiving', 60);
    receiving.req.destroy();
    await noMatchingFrame(events, (frame) => frame.type === 'lifecycle' || frame.state === 'receiving', 60);
  });
});

test('turn runner startup failure broadcasts one terminal error and ignores its late callback', async (t) => {
  let calls = 0;
  let lateCallbackRan = false;
  const runner = ({ onFrame }) => {
    calls += 1;
    if (calls === 1) {
      onFrame({ type: 'status', state: 'thinking', label: 'thinking…' });
      queueMicrotask(() => {
        lateCallbackRan = true;
        onFrame({ type: 'status', state: 'done', label: 'late done', done: true });
      });
      throw new Error('startup exploded');
    }
    return { killed: false, kill() { this.killed = true; } };
  };
  const { url } = await fixture(t, { runner });
  const events = await openEvents(url, { clientId: 'startup-observer' });
  t.after(() => events.close());
  await drainInitialReplay(events);

  const failed = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'fail startup' } });
  assert.equal(failed.status, 500);
  assert.equal(failed.json.error.code, 'runner_start_failed');
  const busy = await nextFrame(events, (frame) => frame.type === 'lifecycle' && frame.busy);
  const terminal = await nextFrame(events, (frame) => frame.state === 'error');
  assert.equal(terminal.phase, 'error');
  assert.equal(terminal.changed, false);
  assert.equal(terminal.undoable, false);
  const idle = await nextFrame(events, (frame) => frame.type === 'lifecycle' && !frame.busy);
  assert.deepEqual(idle, { ...busy, busy: false });
  await noMatchingFrame(events, (frame) => frame.type === 'lifecycle' && !frame.busy, 60);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateCallbackRan, true);

  const replay = await openEvents(url, { clientId: 'startup-late-observer' });
  t.after(() => replay.close());
  assert.deepEqual(await replay.next(), terminal);
  const accepted = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'next turn' } });
  assert.equal(accepted.status, 202);
});

test('turn reservation begins only after a complete validated body', async (t) => {
  const { url, fakeRunner } = await fixture(t);
  const first = startReceivingTurn(url);
  await new Promise((resolve) => setImmediate(resolve));

  const second = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', prompt: 'second' }, clientId: 'client-b',
  });
  assert.equal(second.status, 202);

  first.req.end('}');
  const rejected = await first.response;
  assert.equal(rejected.status, 409);
  assert.equal(rejected.json.error.code, 'turn_in_progress');
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

test('SSE rejects nonexistent and non-HTML page IDs instead of falling back to the root page', async (t) => {
  const { url, root } = await fixture(t, { brain: true });
  writeFileSync(join(root, 'notes.txt'), 'not an HTML page');
  for (const page of ['/missing.html', '/notes.txt']) {
    const response = await openEvents(url, { page, clientId: `invalid-${page.slice(1, 4)}` });
    assert.equal(response.status, 400);
    assert.equal(response.json?.ok, false);
    assert.equal(response.json?.error?.code, 'invalid_page');
  }
  const single = await fixture(t);
  const singlePage = await openEvents(single.url, { page: '/other.html', clientId: 'invalid-single' });
  assert.equal(singlePage.status, 400);
  assert.equal(singlePage.json?.error?.code, 'invalid_page');
});

test('validated reservation broadcasts global lifecycle while init remains page-scoped', async (t) => {
  const { url } = await fixture(t, { brain: true });
  const clientA = await openEvents(url, { clientId: 'lifecycle-a', page: '/' });
  const clientB = await openEvents(url, { clientId: 'lifecycle-b', page: '/' });
  const otherPage = await openEvents(url, { clientId: 'lifecycle-c', page: '/other.html' });
  t.after(() => { clientA.close(); clientB.close(); otherPage.close(); });
  await Promise.all([drainInitialReplay(clientA), drainInitialReplay(clientB), drainInitialReplay(otherPage)]);

  const receiving = startReceivingTurn(url, 'lifecycle-a');
  receiving.response.catch(() => {});
  await Promise.all([noFrame(clientA, 60), noFrame(clientB, 60), noFrame(otherPage, 60)]);

  receiving.req.end('}');
  const accepted = await receiving.response;
  for (const events of [clientA, clientB, otherPage]) {
    const lifecycle = await nextFrame(events, (frame) => frame.type === 'lifecycle' && frame.busy);
    assert.equal(lifecycle.turnId, accepted.json.turnId);
  }
  const init = await nextFrame(clientB, (frame) => frame.turnId === accepted.json.turnId && frame.state === 'init');
  assert.equal(init.page, '/');
  await noMatchingFrame(otherPage, (frame) => frame.type === 'status' && frame.turnId === accepted.json.turnId);
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
  const events = await openEvents(url, { clientId: 'terminal-failure' });
  t.after(() => events.close());
  await drainInitialReplay(events);
  await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'fail after write' } });
  writeFileSync(pageFile, '<!doctype html><html><body>Partial write</body></html>');
  fakeRunner.fail('process failed');

  const busy = await nextFrame(events, (frame) => frame.type === 'lifecycle' && frame.busy);
  const terminal = await nextFrame(events, (frame) => frame.state === 'error');
  assert.equal(terminal.state, 'error');
  assert.equal(terminal.changed, true);
  assert.equal(terminal.undoable, true);
  assert.deepEqual(await nextFrame(events, (frame) => frame.type === 'lifecycle' && !frame.busy), {
    ...busy, busy: false,
  });
  await noMatchingFrame(events, (frame) => frame.type === 'lifecycle' && !frame.busy, 60);
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

test('listen close owns pending EADDRINUSE retry and prevents reopen', async (t) => {
  const blocker = createHttpServer((_req, res) => res.end());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => blocker.close(() => resolve())));

  const repo = makeRepo();
  t.after(() => repo.cleanup());
  const watched = controlledWatch();
  const timers = controlledTimers();
  const controller = createSandpaperServer(repo.pageFile, {}, {
    ...createFakeProviderServices(),
    initialProvider: 'claude',
    tokenFactory: () => 'test-token',
    watch: watched.watch,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  t.after(() => controller.close());

  const occupiedPort = blocker.address().port;
  const pending = controller.listen(occupiedPort);
  const observed = pending.then(() => 'resolved', () => 'rejected');
  await waitUntil(() => timers.size > 0);
  await controller.close();
  timers.runAll(); // deliberately invoke even cleared callbacks to prove the closed guard
  await new Promise((resolve) => setImmediate(resolve));
  const outcome = await Promise.race([
    observed,
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);
  const reopened = controller.server.listening;
  if (reopened) await new Promise((resolve) => controller.server.close(() => resolve()));
  assert.equal(outcome, 'rejected');
  assert.equal(reopened, false);
});

test('default server runner resumes and persists its page-scoped Claude session', async (t) => {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.root, '.sandpaper'));
  const sessionFile = join(repo.root, '.sandpaper', 'session.json');
  writeFileSync(sessionFile, '{"sessionId":"legacy-session"}\n');
  const child = fakeChild();
  let invocation = null;
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  const providerServices = createFakeProviderServices({ runners: {
    claude: (input) => runClaudeTurn(input, {
      spawn: (...args) => { invocation = args; return child; },
      onClaudePlan: () => false,
    }),
  } });
  const controller = createSandpaperServer(repo.pageFile, {}, {
    registry: providerServices.registry,
    preferences: providerServices.preferences,
    tokenFactory: () => 'test-token',
    watch: () => ({ close() {} }),
  });
  t.after(() => controller.close());
  const url = await controller.listen();

  const accepted = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', prompt: 'continue' },
  });
  assert.equal(accepted.status, 202);
  assert.ok(invocation, 'default runner uses the injected Claude process');
  assert.deepEqual(invocation[1].slice(-2), ['--resume', 'legacy-session']);

  child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'new-session' })}\n`);
  child.stdout.end(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`);
  child.emit('close', 0);
  assert.equal(
    JSON.parse(readFileSync(sessionFile, 'utf8')).pages['/'].claude.resumeId,
    'new-session',
  );
});

test('repository serve migrates the nested v0.2.1 Claude session to its current page', async (t) => {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  const brain = join(repo.root, 'brain');
  mkdirSync(join(brain, '.sandpaper'), { recursive: true });
  writeFileSync(join(brain, 'index.html'), '<!doctype html><body>brain</body>');
  writeFileSync(join(brain, '.sandpaper', 'session.json'), '{"sessionId":"nested-session"}\n');
  const child = fakeChild();
  let invocation;
  const providerServices = createFakeProviderServices({ runners: {
    claude: (input) => runClaudeTurn(input, {
      spawn: (...args) => { invocation = args; return child; },
      onClaudePlan: () => false,
    }),
  } });
  const controller = createSandpaperServer(repo.root, { brain: true }, {
    registry: providerServices.registry,
    preferences: providerServices.preferences,
    tokenFactory: () => 'test-token',
    watch: () => ({ close() {} }),
  });
  t.after(() => controller.close());
  const url = await controller.listen();

  const accepted = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/brain/index.html', prompt: 'continue' },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(invocation[1].slice(-2), ['--resume', 'nested-session']);
  const canonical = JSON.parse(readFileSync(join(repo.root, '.sandpaper', 'session.json'), 'utf8'));
  assert.equal(canonical.pages['/brain/index.html'].claude.resumeId, 'nested-session');
});

test('server dispatches through injected provider services and persists their session', async (t) => {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  const child = fakeChild();
  const calls = [];
  const sessions = {
    get(key) { calls.push(['get', key]); return 'injected-session'; },
    set(value) { calls.push(['set', value]); },
  };
  const preferences = {
    getDefaultProvider() { return 'claude'; },
    setDefaultProvider() {},
  };
  const registry = {
    diagnostics() {
      return [{ id: 'claude', label: 'Claude Code', available: true, compatible: true, authMethod: 'subscription' }];
    },
    get(id) {
      return id === 'claude' ? {
        runTurn: (input) => runClaudeTurn(input, { spawn: () => child, onClaudePlan: () => false }),
      } : null;
    },
  };
  const controller = createSandpaperServer(repo.pageFile, { initialProvider: 'codex' }, {
    registry, preferences, sessions,
    tokenFactory: () => 'test-token',
    watch: () => ({ close() {} }),
  });
  t.after(() => controller.close());
  const url = await controller.listen();

  const accepted = await requestJson(url, '/__sandpaper/turn', {
    body: { page: '/', prompt: 'continue' },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(calls, [['get', { page: '/', provider: 'claude' }]]);

  child.stdout.end(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'new-session' })}\n`);
  child.emit('close', 1);
  assert.deepEqual(calls[1], ['set', {
    page: '/', provider: 'claude', resumeId: 'new-session',
  }]);
});

test('startServer forwards provider service identities into the server dependency boundary', async () => {
  const registry = {};
  const preferences = {};
  const sessions = {};
  let received;
  const result = await startServer('/repo/brain', 7777, {
    brain: true,
    initialProvider: 'codex',
    registry,
    preferences,
    sessions,
  }, {
    createServer(target, opts, deps) {
      received = { target, opts, deps };
      return { listen: async (port) => `listening:${port}` };
    },
  });

  assert.equal(result, 'listening:7777');
  assert.equal(received.target, '/repo/brain');
  assert.deepEqual(received.opts, { brain: true, initialProvider: 'codex' });
  assert.strictEqual(received.deps.registry, registry);
  assert.strictEqual(received.deps.preferences, preferences);
  assert.strictEqual(received.deps.sessions, sessions);
});

test('Claude uses the controlled invocation contract and emits one terminal frame', (t) => {
  const withResult = fakeChild();
  let invocation;
  const sessions = [];
  const resultFrames = [];
  const originalSentinel = process.env.SANDPAPER_ENV_SENTINEL;
  const originalClaudeCode = process.env.CLAUDECODE;
  const originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.SANDPAPER_ENV_SENTINEL = 'kept';
  process.env.CLAUDECODE = 'nested';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'nested-entry';
  t.after(() => {
    for (const [key, value] of [
      ['SANDPAPER_ENV_SENTINEL', originalSentinel],
      ['CLAUDECODE', originalClaudeCode],
      ['CLAUDE_CODE_ENTRYPOINT', originalEntrypoint],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const handle = runClaudeTurn({
    pageFile: '/tmp/project/page.html',
    prompt: 'prompt',
    resumeId: 'claude-session',
    onSession: (sessionId) => sessions.push(sessionId),
    onFrame: (frame) => resultFrames.push(frame),
  }, {
    spawn: (...args) => {
      invocation = args;
      return withResult;
    },
  });
  assert.equal(handle, withResult);
  assert.equal(typeof handle.kill, 'function');
  handle.kill();
  assert.equal(withResult.killed, true);
  assert.equal(invocation[0], 'claude');
  assert.deepEqual(
    invocation[1].slice(0, 12),
    [
      '-p', 'prompt',
      '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,MultiEdit',
      '--append-system-prompt', invocation[1][11],
    ],
  );
  assert.match(invocation[1][11], /editing engine behind Sandpaper/);
  assert.deepEqual(invocation[1].slice(12), ['--resume', 'claude-session']);
  assert.equal(invocation[2].cwd, '/tmp/project');
  assert.deepEqual(invocation[2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(invocation[2].env.SANDPAPER_ENV_SENTINEL, 'kept');
  assert.equal('CLAUDECODE' in invocation[2].env, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in invocation[2].env, false);
  withResult.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'new-session' })}\n`);
  withResult.stdout.end(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`);
  withResult.emit('close', 0);
  assert.deepEqual(sessions, ['new-session']);
  assert.equal(resultFrames.filter((frame) => frame.type === 'status' && frame.done).length, 1);
  assert.deepEqual(
    resultFrames.filter((frame) => frame.type === 'status').map((frame) => frame.state),
    ['init', 'init', 'done'],
  );
});

test('Claude contains malformed blocks and session callback failures until one terminal', () => {
  const child = fakeChild();
  const frames = [];
  runClaudeTurn({
    pageFile: '/tmp/project/page.html', prompt: 'prompt', resumeId: null,
    onSession() { throw new Error('secret session persistence failure'); },
    onFrame: (frame) => frames.push(frame),
  }, { spawn: () => child, onClaudePlan: () => false });
  child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'new-session' })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: 'assistant', message: { content: [null, 7, { type: 'tool_use', name: 'MultiEdit', input: { edits: [null, {}] } }] },
  })}\n`);
  child.stdout.end(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`);
  child.emit('close', 0);
  assert.ok(frames.some((frame) => frame.type === 'warning'));
  assert.doesNotMatch(JSON.stringify(frames), /secret session persistence failure/);
  const terminals = frames.filter((frame) => frame.type === 'status'
    && (frame.done || frame.state === 'done' || frame.state === 'error'));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].state, 'done');
});

test('Claude contains a transient frame callback failure', () => {
  const child = fakeChild();
  const frames = [];
  let first = true;
  runClaudeTurn({
    pageFile: '/tmp/project/page.html', prompt: 'prompt', resumeId: null, onSession() {},
    onFrame(frame) {
      if (first) { first = false; throw new Error('frame consumer failed'); }
      frames.push(frame);
    },
  }, { spawn: () => child, onClaudePlan: () => false });
  child.stdout.end(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' })}\n`);
  child.emit('close', 0);
  const terminals = frames.filter((frame) => frame.type === 'status'
    && (frame.done || frame.state === 'done' || frame.state === 'error'));
  assert.equal(terminals.length, 1);
});

test('Claude retries terminal delivery on close after a transient child-error callback failure', () => {
  const child = fakeChild();
  const frames = [];
  let rejectFirstError = true;
  runClaudeTurn({
    pageFile: '/tmp/project/page.html', prompt: 'prompt', resumeId: null, onSession() {},
    onFrame(frame) {
      if (frame.state === 'error' && rejectFirstError) {
        rejectFirstError = false;
        throw new Error('terminal consumer failed once');
      }
      frames.push(frame);
    },
  }, { spawn: () => child, onClaudePlan: () => false });
  child.emit('error', new Error('child failed'));
  child.emit('close', 1);
  const terminals = frames.filter((frame) => frame.type === 'status'
    && (frame.done || frame.state === 'done' || frame.state === 'error'));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].state, 'error');
});

test('Claude removes the API key only when subscription auth is active', (t) => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'api-secret';
  t.after(() => {
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });
  const environments = [];
  for (const subscription of [false, true]) {
    runClaudeTurn({
      pageFile: '/tmp/page.html', prompt: 'prompt', resumeId: null,
      onSession() {}, onFrame() {},
    }, {
      onClaudePlan: () => subscription,
      spawn: (_command, _args, options) => {
        environments.push(options.env);
        return fakeChild();
      },
    });
  }
  assert.equal(environments[0].ANTHROPIC_API_KEY, 'api-secret');
  assert.equal('ANTHROPIC_API_KEY' in environments[1], false);
});

test('Claude close without result emits one error terminal', () => {
  const withoutResult = fakeChild();
  const missingFrames = [];
  runClaudeTurn({
    pageFile: '/tmp/page.html',
    prompt: 'prompt',
    resumeId: null,
    onSession() {},
    onFrame: (frame) => missingFrames.push(frame),
  }, { spawn: () => withoutResult });
  withoutResult.stdout.end();
  withoutResult.emit('close', 0);
  assert.deepEqual(missingFrames.filter((frame) => frame.state === 'error').length, 1);
  assert.equal(missingFrames.some((frame) => frame.state === 'idle'), false);
});

test('Claude flushes a final result line without a trailing newline', async () => {
  const child = fakeChild();
  const frames = [];
  runClaudeTurn({
    pageFile: '/tmp/page.html', prompt: 'prompt', resumeId: null,
    onSession() {}, onFrame: (frame) => frames.push(frame),
  }, { spawn: () => child });
  const ended = new Promise((resolve) => child.stdout.once('end', resolve));
  child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.25 }));
  await ended;
  child.emit('close', 0);
  assert.deepEqual(frames.at(-1), {
    type: 'status', state: 'done', label: 'done', cost: 0.25, done: true,
  });
});

test('Claude reports a synchronous spawn throw once and returns null', () => {
  const frames = [];
  const handle = runClaudeTurn({
    pageFile: '/tmp/page.html', prompt: 'prompt', resumeId: null,
    onSession() {}, onFrame: (frame) => frames.push(frame),
  }, { spawn: () => { throw new Error('spawn exploded'); } });
  assert.equal(handle, null);
  assert.deepEqual(frames, [{
    type: 'status', state: 'error', label: 'Could not start claude', detail: 'spawn exploded',
  }]);
});

test('Claude reports one child process error even if close follows', () => {
  const child = fakeChild();
  const frames = [];
  runClaudeTurn({
    pageFile: '/tmp/page.html', prompt: 'prompt', resumeId: null,
    onSession() {}, onFrame: (frame) => frames.push(frame),
  }, { spawn: () => child });
  child.emit('error', new Error('binary disappeared'));
  child.emit('close', 1);
  assert.deepEqual(frames.filter((frame) => frame.state === 'error'), [{
    type: 'status', state: 'error',
    label: 'claude not found — is it installed?', detail: 'binary disappeared',
  }]);
});

test('Claude includes stderr in a nonzero close terminal', () => {
  const child = fakeChild();
  const frames = [];
  runClaudeTurn({
    pageFile: '/tmp/page.html', prompt: 'prompt', resumeId: null,
    onSession() {}, onFrame: (frame) => frames.push(frame),
  }, { spawn: () => child });
  child.stderr.write('permission denied');
  child.stdout.end();
  child.emit('close', 7);
  assert.deepEqual(frames.filter((frame) => frame.state === 'error'), [{
    type: 'status', state: 'error', label: 'claude exited (7)', detail: 'permission denied',
  }]);
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

test('direct mutation reports undoable only when a usable snapshot exists', async (t) => {
  const { url } = await fixture(t);
  const changed = await requestJson(url, '/__sandpaper/write', {
    body: { page: '/', cid: 'main', html: 'Changed' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.undoable, true);

  const noop = await requestJson(url, '/__sandpaper/write', {
    body: { page: '/', cid: 'main', html: 'Changed' },
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.json.undoable, false);
});

test('direct mutation succeeds without exposing undo when snapshot creation fails', async (t) => {
  const repo = makeRepo();
  writeFileSync(join(repo.root, '.sandpaper'), 'blocks the snapshot directory');
  const controller = createSandpaperServer(repo.pageFile, {}, {
    ...createFakeProviderServices(),
    tokenFactory: () => 'test-token',
  });
  const url = await controller.listen();
  t.after(async () => {
    await controller.close();
    repo.cleanup();
  });

  const changed = await requestJson(url, '/__sandpaper/write', {
    body: { page: '/', cid: 'main', html: 'Changed without snapshot' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.undoable, false);

  const undo = await requestJson(url, '/__sandpaper/undo-direct', { body: { page: '/' } });
  assert.equal(undo.status, 404);
});

test('direct write restores exact disk bytes when persistence corrupts then throws', async (t) => {
  const writeFile = (file) => {
    writeFileSync(file, '<!doctype html><html><body>CORRUPTED</body></html>');
    throw new Error('disk write failed');
  };
  const { url, pageFile } = await fixture(t, { writeFile });
  const original = readFileSync(pageFile, 'utf8');

  const response = await requestJson(url, '/__sandpaper/write', {
    body: { page: '/', cid: 'main', html: 'Changed' },
  });
  assert.equal(response.status, 500);
  assert.equal(response.json.error.code, 'write_failed');
  assert.equal(readFileSync(pageFile, 'utf8'), original);

  const undo = await requestJson(url, '/__sandpaper/undo-direct', { body: { page: '/' } });
  assert.equal(undo.status, 404);
});

test('direct write retains its snapshot when immediate restoration also fails', async (t) => {
  let restorationFails = true;
  const writeFile = (file) => {
    writeFileSync(file, '<!doctype html><html><body>CORRUPTED</body></html>');
    throw new Error('disk write failed');
  };
  const restoreFile = (snapshot, pageFile) => {
    if (restorationFails) throw new Error('restore failed');
    copyFileSync(snapshot, pageFile);
  };
  const { url, pageFile } = await fixture(t, { writeFile, restoreFile });
  const original = readFileSync(pageFile, 'utf8');

  const response = await requestJson(url, '/__sandpaper/write', {
    body: { page: '/', cid: 'main', html: 'Changed' },
  });
  assert.equal(response.status, 500);
  assert.notEqual(readFileSync(pageFile, 'utf8'), original);

  restorationFails = false;
  const recovered = await requestJson(url, '/__sandpaper/undo-direct', { body: { page: '/' } });
  assert.equal(recovered.status, 200);
  assert.equal(readFileSync(pageFile, 'utf8'), original);
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

test('AI undo binds the snapshot to payload.page and leaves bytes untouched on a cross-page request', async (t) => {
  const { url, fakeRunner, pageFile, otherFile } = await fixture(t, { brain: true });
  const original = readFileSync(pageFile, 'utf8');
  const otherOriginal = readFileSync(otherFile, 'utf8');
  const accepted = await requestJson(url, '/__sandpaper/turn', { body: { page: '/', prompt: 'change root' } });
  writeFileSync(pageFile, '<!doctype html><html><body><main data-cid="main">Changed root</main></body></html>');
  fakeRunner.complete();

  const crossPage = await requestJson(url, '/__sandpaper/undo', {
    body: { turnId: accepted.json.turnId, page: '/other.html' },
  });
  assert.equal(crossPage.status, 409);
  assert.equal(crossPage.json?.error?.code, 'page_mismatch');
  assert.notEqual(readFileSync(pageFile, 'utf8'), original);
  assert.equal(readFileSync(otherFile, 'utf8'), otherOriginal);

  const valid = await requestJson(url, '/__sandpaper/undo', {
    body: { turnId: accepted.json.turnId, page: '/' },
  });
  assert.equal(valid.status, 200);
  assert.equal(readFileSync(pageFile, 'utf8'), original);
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
  await Promise.all([drainInitialReplay(clientA), drainInitialReplay(clientB), drainInitialReplay(otherPage)]);

  const written = await requestJson(url, '/__sandpaper/write', {
    clientId: 'client-a', body: { page: '/', cid: 'main', html: 'Direct write' },
  });
  assert.equal(written.status, 200);
  assert.deepEqual(await nextFrame(clientB, (frame) => frame.type === 'reload'), { type: 'reload', page: '/' });
  await Promise.all([noFrame(clientA, 60), noFrame(otherPage, 60)]);

  watched.emit('index.html');
  await Promise.all([noFrame(clientA), noFrame(clientB), noFrame(otherPage)]);

  writeFileSync(pageFile, '<!doctype html><html><body><main data-cid="main">External write</main></body></html>');
  watched.emit('index.html');
  assert.deepEqual(await nextFrame(clientA, (frame) => frame.type === 'reload'), { type: 'reload', page: '/' });
  assert.deepEqual(await nextFrame(clientB, (frame) => frame.type === 'reload'), { type: 'reload', page: '/' });
  await noMatchingFrame(otherPage, (frame) => frame.type === 'reload');
});

test('reload debounce is independent for two pages changed in one interval', async (t) => {
  const watched = controlledWatch();
  const { url, pageFile, otherFile } = await fixture(t, { brain: true, watch: watched.watch });
  const cover = await openEvents(url, { clientId: 'cover-client', page: '/' });
  const other = await openEvents(url, { clientId: 'other-client', page: '/other.html' });
  t.after(() => { cover.close(); other.close(); });
  await Promise.all([drainInitialReplay(cover), drainInitialReplay(other)]);

  writeFileSync(pageFile, '<!doctype html><html><body>Cover external</body></html>');
  writeFileSync(otherFile, '<!doctype html><html><body>Other external</body></html>');
  watched.emit('index.html');
  watched.emit('other.html');

  assert.deepEqual(await nextFrame(cover, (frame) => frame.type === 'reload'), { type: 'reload', page: '/' });
  assert.deepEqual(await nextFrame(other, (frame) => frame.type === 'reload'), { type: 'reload', page: '/other.html' });
});

test('reload for an AI change reaches all same-page clients only after the terminal status', async (t) => {
  const watched = controlledWatch();
  const { url, fakeRunner, pageFile } = await fixture(t, { brain: true, watch: watched.watch });
  const clientA = await openEvents(url, { clientId: 'client-a', page: '/' });
  const clientB = await openEvents(url, { clientId: 'client-b', page: '/' });
  const otherPage = await openEvents(url, { clientId: 'client-c', page: '/other.html' });
  t.after(() => { clientA.close(); clientB.close(); otherPage.close(); });
  await Promise.all([drainInitialReplay(clientA), drainInitialReplay(clientB), drainInitialReplay(otherPage)]);

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
    assert.deepEqual(await nextFrame(events, (frame) => frame.type === 'reload'), { type: 'reload', page: '/' });
  }
  await noMatchingFrame(otherPage, (frame) => frame.type === 'reload');
});

test('directory watching falls back when recursive fs.watch is unavailable and closes every watcher', async (t) => {
  const repo = makeRepo();
  const nested = join(repo.root, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'page.html'), '<!doctype html><html><body>Nested</body></html>');

  const calls = [];
  const handles = [];
  const callbacks = new Map();
  const watch = (directory, options, onChange) => {
    calls.push({ directory, options });
    if (options.recursive) {
      const error = new Error('The feature watch recursively is unavailable on the current platform');
      error.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
      throw error;
    }
    callbacks.set(directory, onChange);
    const handle = { closed: false, close() { this.closed = true; } };
    handles.push(handle);
    return handle;
  };

  const controller = createSandpaperServer(repo.root, { brain: true }, {
    ...createFakeProviderServices(),
    tokenFactory: () => 'test-token',
    watch,
  });
  t.after(async () => {
    await controller.close();
    repo.cleanup();
  });

  const url = await controller.listen(0);
  const events = await openEvents(url, { clientId: 'fallback-client', page: '/nested/page.html' });
  t.after(() => events.close());
  await drainInitialReplay(events);

  assert.equal(calls[0].options.recursive, true);
  const fallbackRoot = calls[1].directory;
  const nestedDirectory = join(fallbackRoot, 'nested');
  assert.ok(callbacks.has(fallbackRoot));
  assert.ok(callbacks.has(nestedDirectory));
  writeFileSync(join(nested, 'page.html'), '<!doctype html><html><body>Changed</body></html>');
  callbacks.get(nestedDirectory)('change', 'page.html');
  assert.deepEqual(await nextFrame(events, (frame) => frame.type === 'reload'), { type: 'reload', page: '/nested/page.html' });

  await controller.close();
  assert.ok(handles.length >= 2);
  assert.equal(handles.every((handle) => handle.closed), true);
});
