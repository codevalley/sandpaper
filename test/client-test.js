import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError, createSandpaperClient } from '../public/sp-client.js';

function response(status, value, { malformed = false } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (malformed) throw new SyntaxError('bad json');
      return value;
    },
  };
}

test('post sends JSON with the Sandpaper token and page client ID', async () => {
  let request;
  const client = createSandpaperClient({
    base: '/__sandpaper/',
    token: 'response-token',
    clientId: 'page-client',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(202, { ok: true, turnId: 'turn-1' });
    },
  });

  const result = await client.post('/turn', { prompt: 'Hello', page: '/' });

  assert.deepEqual(result, { ok: true, turnId: 'turn-1' });
  assert.equal(request.url, '/__sandpaper/turn');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(request.init.headers, {
    'Content-Type': 'application/json',
    'X-Sandpaper-Token': 'response-token',
    'X-Sandpaper-Client': 'page-client',
  });
  assert.equal(request.init.body, '{"prompt":"Hello","page":"/"}');
});

test('eventUrl URL-encodes the response token and page client ID', () => {
  const client = createSandpaperClient({
    base: '/__sandpaper',
    token: 'a token/+?&',
    clientId: 'tab id/+',
    fetchImpl: async () => response(200, { ok: true }),
  });

  assert.equal(
    client.eventUrl(),
    '/__sandpaper/events?token=a%20token%2F%2B%3F%26&clientId=tab%20id%2F%2B',
  );
});

test('post preserves a structured server error', async () => {
  const client = createSandpaperClient({
    base: '/__sandpaper', token: 'token', clientId: 'client',
    fetchImpl: async () => response(409, {
      ok: false,
      error: { code: 'turn_in_progress', message: 'A turn is already in progress' },
    }),
  });

  await assert.rejects(
    client.post('/turn', {}),
    (error) => error instanceof ApiError &&
      error.status === 409 &&
      error.code === 'turn_in_progress' &&
      error.message === 'A turn is already in progress',
  );
});

test('post rejects an unstructured non-2xx response as http_error', async () => {
  const client = createSandpaperClient({
    base: '/__sandpaper', token: 'token', clientId: 'client',
    fetchImpl: async () => response(503, { message: 'proxy failed' }),
  });

  await assert.rejects(
    client.post('/turn', {}),
    (error) => error instanceof ApiError &&
      error.status === 503 &&
      error.code === 'http_error' &&
      error.message === 'Sandpaper request failed (503)',
  );
});

test('post rejects malformed JSON responses as invalid_response', async () => {
  const client = createSandpaperClient({
    base: '/__sandpaper', token: 'token', clientId: 'client',
    fetchImpl: async () => response(200, null, { malformed: true }),
  });

  await assert.rejects(
    client.post('/turn', {}),
    (error) => error instanceof ApiError &&
      error.status === 200 &&
      error.code === 'invalid_response' &&
      error.message === 'Sandpaper returned an invalid response',
  );
});

test('post rejects network failures as network_error', async () => {
  const client = createSandpaperClient({
    base: '/__sandpaper', token: 'token', clientId: 'client',
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });

  await assert.rejects(
    client.post('/turn', {}),
    (error) => error instanceof ApiError &&
      error.status === 0 &&
      error.code === 'network_error' &&
      error.message === 'Failed to fetch',
  );
});

test('provider control helpers post exact route payloads', async () => {
  const requests = [];
  const client = createSandpaperClient({
    base: '/__sandpaper', token: 'token', clientId: 'client',
    fetchImpl: async (url, init) => {
      requests.push([url, JSON.parse(init.body)]);
      return response(200, { ok: true });
    },
  });

  await client.setDefaultProvider('codex');
  await client.resetSession({ page: '/brain/index.html', provider: 'claude' });
  assert.deepEqual(requests, [
    ['/__sandpaper/provider-default', { provider: 'codex' }],
    ['/__sandpaper/session/reset', { page: '/brain/index.html', provider: 'claude' }],
  ]);
});

test('provider control helpers preserve structured ApiError behavior', async () => {
  const client = createSandpaperClient({
    base: '/__sandpaper', token: 'token', clientId: 'client',
    fetchImpl: async () => response(409, {
      ok: false,
      error: { code: 'provider_unavailable', message: 'Codex is unavailable' },
    }),
  });
  await assert.rejects(
    client.setDefaultProvider('codex'),
    (error) => error instanceof ApiError && error.status === 409
      && error.code === 'provider_unavailable' && error.message === 'Codex is unavailable',
  );
});
