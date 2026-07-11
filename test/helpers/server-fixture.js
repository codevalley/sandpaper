import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_PAGE = '<!doctype html><html><body><main data-cid="main">Hello</main></body></html>';

export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-server-'));
  const pageFile = join(root, 'index.html');
  const otherFile = join(root, 'other.html');
  writeFileSync(pageFile, DEFAULT_PAGE);
  writeFileSync(otherFile, '<!doctype html><html><body><p data-cid="other">Other</p></body></html>');
  return {
    root,
    pageFile,
    otherFile,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

export function requestJson(baseUrl, path, {
  method = 'POST', body = {}, rawBody, headers = {}, token = 'test-token',
  clientId = 'client-a', origin = baseUrl.replace(/\/$/, ''), contentType = 'application/json',
} = {}) {
  const url = new URL(path, baseUrl);
  const payload = rawBody === undefined ? JSON.stringify(body) : rawBody;
  const requestHeaders = { ...headers };
  if (contentType !== null) requestHeaders['Content-Type'] = contentType;
  if (token !== null) requestHeaders['X-Sandpaper-Token'] = token;
  if (clientId !== null) requestHeaders['X-Sandpaper-Client'] = clientId;
  if (origin !== null) requestHeaders.Origin = origin;
  if (payload !== undefined) requestHeaders['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* expose non-JSON through text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

export function openEvents(baseUrl, {
  token = 'test-token', clientId = 'client-a', page = '/', headers = {},
  origin = baseUrl.replace(/\/$/, ''), timeout = 1_000,
} = {}) {
  const url = new URL('/__sandpaper/events', baseUrl);
  if (token !== null) url.searchParams.set('token', token);
  if (clientId !== null) url.searchParams.set('clientId', clientId);
  if (page !== null) url.searchParams.set('page', page);

  const requestHeaders = { ...headers };
  if (origin !== null) requestHeaders.Origin = origin;

  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: requestHeaders }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try { json = JSON.parse(text); } catch { /* expose text */ }
          resolve({ status: res.statusCode, text, json, close() {} });
        });
        return;
      }

      let buffer = '';
      const frames = [];
      const waiters = [];
      const deliver = (frame) => {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(frame);
        else frames.push(frame);
      };
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event.split('\n').filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6)).join('\n');
          if (!data) continue;
          try { deliver(JSON.parse(data)); } catch { /* ignore malformed server frames */ }
        }
      });
      res.on('error', (error) => {
        while (waiters.length) waiters.shift().reject(error);
      });

      resolve({
        status: res.statusCode,
        next(waitMs = timeout) {
          if (frames.length) return Promise.resolve(frames.shift());
          return new Promise((resolveFrame, rejectFrame) => {
            const waiter = { resolve: resolveFrame, reject: rejectFrame };
            waiters.push(waiter);
            waiter.timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              rejectFrame(new Error('timed out waiting for SSE frame'));
            }, waitMs);
            waiter.resolve = (frame) => { clearTimeout(waiter.timer); resolveFrame(frame); };
          });
        },
        close() {
          req.destroy();
          res.destroy();
          while (waiters.length) waiters.shift().reject(new Error('SSE closed'));
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export function createFakeRunner() {
  const calls = [];
  const get = (index = calls.length - 1) => {
    const call = calls[index];
    if (!call) throw new Error(`fake runner call ${index} does not exist`);
    return call;
  };

  const runner = ({ pageFile, prompt, resumeId, onSession, onFrame }) => {
    const handle = { killed: false, kill() { this.killed = true; } };
    calls.push({ pageFile, prompt, resumeId, onSession, onFrame, handle });
    return handle;
  };
  runner.calls = calls;
  runner.emit = (frame, index) => get(index).onFrame({ ...frame });
  runner.edit = (html, index) => {
    const call = get(index);
    writeFileSync(call.pageFile, html);
    call.onFrame({ type: 'edit', tool: 'Edit', file: call.pageFile, hunks: [] });
  };
  runner.fail = (detail = 'runner failed', index) => {
    get(index).onFrame({ type: 'status', state: 'error', label: 'turn failed', detail });
  };
  runner.complete = (index) => {
    get(index).onFrame({ type: 'status', state: 'done', label: 'done', done: true });
  };
  runner.session = (resumeId, index) => get(index).onSession(resumeId);
  return runner;
}

export function createFakeProviderServices({
  defaultProvider = 'claude',
  diagnostics = [
    { id: 'claude', label: 'Claude Code', available: true, compatible: true, authMethod: 'subscription' },
    { id: 'codex', label: 'Codex', available: true, compatible: true, authMethod: 'chatgpt' },
  ],
  runners = {},
} = {}) {
  const providerRunners = {
    claude: runners.claude || createFakeRunner(),
    codex: runners.codex || createFakeRunner(),
  };
  const diagnosticValues = diagnostics.map((entry) => ({ ...entry }));
  const entries = new Map(diagnosticValues.map((diagnostic) => [diagnostic.id, {
    id: diagnostic.id,
    label: diagnostic.label,
    runTurn: providerRunners[diagnostic.id],
  }]));
  const sessionValues = new Map();
  const sessionCalls = [];
  const sessionKey = ({ page, provider }) => `${page}\0${provider}`;
  let currentDefault = defaultProvider;
  const preferenceCalls = [];

  return {
    runners: providerRunners,
    registry: {
      get(id) { return entries.get(id) || null; },
      diagnostics() { return diagnosticValues.map((entry) => ({ ...entry })); },
    },
    preferences: {
      getDefaultProvider() { preferenceCalls.push(['get']); return currentDefault; },
      setDefaultProvider(provider) {
        preferenceCalls.push(['set', provider]);
        currentDefault = provider;
      },
    },
    sessions: {
      get(key) { sessionCalls.push(['get', { ...key }]); return sessionValues.get(sessionKey(key)) || null; },
      claimLegacy(key) { sessionCalls.push(['claimLegacy', { ...key }]); return null; },
      set(value) {
        sessionCalls.push(['set', { ...value }]);
        sessionValues.set(sessionKey(value), value.resumeId);
      },
      clear(key) {
        sessionCalls.push(['clear', { ...key }]);
        sessionValues.delete(sessionKey(key));
      },
    },
    sessionValues,
    sessionCalls,
    preferenceCalls,
    get defaultProvider() { return currentDefault; },
  };
}
