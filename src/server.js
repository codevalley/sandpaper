// server.js — the authenticated local bridge server.
// The document on disk is authoritative: the runner and direct-edit endpoints mutate it,
// the watcher reports those mutations, and the browser never gets ahead of persisted bytes.
import { createServer } from 'node:http';
import {
  readFile, readFileSync, writeFileSync, watch as watchFiles, copyFileSync, mkdirSync,
  existsSync, lstatSync, readdirSync, unlinkSync, realpathSync,
} from 'node:fs';
import { join, dirname, basename, extname, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { runTurn } from './claude.js';
import { replaceInner, removeElement, moveElement } from './edit.js';
import { resolveRepositoryPath } from './path-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json',
};

const BODY_LIMITS = Object.freeze({
  '/__sandpaper/turn': 1_000_000,
  '/__sandpaper/write': 2_000_000,
  '/__sandpaper/dom': 100_000,
  '/__sandpaper/undo': 100_000,
  '/__sandpaper/undo-direct': 10_000,
});

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let size = 0;
    let settled = false;
    let tooLarge = Number.isFinite(declared) && declared > limit;
    const chunks = [];
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('aborted', () => fail(new RequestError(400, 'request_aborted', 'Request body was aborted')));
    req.on('error', () => fail(new RequestError(400, 'request_aborted', 'Request body could not be read')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (tooLarge) {
        reject(new RequestError(413, 'payload_too_large', `JSON body exceeds ${limit} bytes`));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new RequestError(400, 'malformed_json', 'Request body is not valid JSON'));
        return;
      }
      if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
        reject(new RequestError(400, 'invalid_body', 'JSON body must be an object'));
        return;
      }
      resolve(payload);
    });
  });
}

function secureEqual(actual, expected) {
  const left = createHash('sha256').update(String(actual ?? '')).digest();
  const right = createHash('sha256').update(String(expected ?? '')).digest();
  return timingSafeEqual(left, right);
}

function loopbackHost(host) {
  if (typeof host !== 'string' || !host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function invalidBrowserOrigin(req) {
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (origin == null) {
    try {
      const referer = new URL(req.headers.referer);
      if (req.headers['sec-fetch-site'] !== 'same-origin' ||
          referer.protocol !== 'http:' ||
          referer.host.toLowerCase() !== host.toLowerCase() ||
          !loopbackHost(referer.host)) {
        throw new Error('invalid same-origin fetch metadata');
      }
      return null;
    } catch {
      return new RequestError(403, 'invalid_origin', 'Request origin must match this local server');
    }
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== host.toLowerCase() || !loopbackHost(parsed.host)) {
      throw new Error('foreign origin');
    }
  } catch {
    return new RequestError(403, 'invalid_origin', 'Request origin must match this local server');
  }
  return null;
}

export function validBrowserRequest(req, token) {
  const host = req.headers.host;
  if (!loopbackHost(host)) {
    return new RequestError(403, 'invalid_host', 'Request host must be loopback');
  }
  if (!secureEqual(req.headers['x-sandpaper-token'], token)) {
    return new RequestError(403, 'invalid_token', 'Invalid Sandpaper token');
  }
  const clientId = req.headers['x-sandpaper-client'];
  if (!CLIENT_ID.test(clientId || '')) {
    return new RequestError(403, 'invalid_client', 'Missing or invalid Sandpaper client ID');
  }
  return invalidBrowserOrigin(req);
}

function apiFailure(res, error) {
  if (res.destroyed || res.writableEnded) return;
  const status = error instanceof RequestError ? error.status : 500;
  const code = error instanceof RequestError ? error.code : 'internal_error';
  const message = error instanceof RequestError ? error.message : 'Internal server error';
  sendJson(res, status, { ok: false, error: { code, message } });
}

function jsonContentType(req) {
  const contentType = req.headers['content-type'];
  return typeof contentType === 'string' && /^application\/json(?:\s*;\s*charset=[^;\s]+)?$/i.test(contentType.trim());
}

function hasRawDotSegment(requestUrl) {
  const rawPath = String(requestUrl || '').split(/[?#]/, 1)[0];
  let decodedPath;
  try { decodedPath = decodeURIComponent(rawPath); }
  catch { return false; }
  return decodedPath.split(/[\\/]/).some((segment) => segment === '.' || segment === '..');
}

function fileHash(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
  catch { return null; }
}

function snapshotPath(root, turnId) {
  const safe = String(turnId || '');
  return /^[a-fA-F0-9-]+$/.test(safe) ? join(root, '.sandpaper', 'snapshots', `${safe}.html`) : null;
}

function takeSnapshot(pageFile, root, turnId) {
  const path = snapshotPath(root, turnId);
  if (!path) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(pageFile, path);
    return path;
  } catch {
    return null;
  }
}

function removeSnapshot(path) {
  if (!path) return;
  try { unlinkSync(path); } catch { /* best-effort cleanup */ }
}

function recursiveWatchUnavailable(error) {
  return error?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
    || /recursive.*(?:unavailable|not supported)/i.test(String(error?.message || ''));
}

function createFallbackTreeWatcher(root, watch, onChange) {
  const watchers = new Map();
  const skipped = new Set(['.agents', '.codex', '.git', '.sandpaper', 'node_modules']);
  let closed = false;

  const closeAll = () => {
    if (closed) return;
    closed = true;
    for (const handle of watchers.values()) {
      try { handle.close(); } catch { /* best-effort fallback cleanup */ }
    }
    watchers.clear();
  };

  const allowedDirectory = (directory) => {
    const rel = relative(root, directory);
    return !rel.split(sep).some((segment) => skipped.has(segment));
  };

  const pruneRemoved = () => {
    for (const [directory, handle] of watchers) {
      if (existsSync(directory)) continue;
      try { handle.close(); } catch { /* best-effort */ }
      watchers.delete(directory);
    }
  };

  const addDirectory = (directory) => {
    if (closed || watchers.has(directory) || !allowedDirectory(directory)) return;
    let stat;
    let entries;
    try {
      stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EACCES') return;
      throw error;
    }

    const handle = watch(directory, { persistent: true }, (event, filename) => {
      if (closed) return;
      const name = filename == null ? null : String(filename);
      const candidate = name ? join(directory, name) : null;
      const rel = candidate ? relative(root, candidate) : null;
      onChange(event, rel);
      if (event === 'rename') {
        if (candidate) {
          try { addDirectory(candidate); } catch { /* a new inaccessible subtree is not fatal */ }
        }
        pruneRemoved();
      }
    });
    watchers.set(directory, handle);

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) addDirectory(join(directory, entry.name));
    }
  };

  try { addDirectory(root); }
  catch (error) { closeAll(); throw error; }
  return { close: closeAll };
}

// `target` is a file (single-doc mode) or a directory (folder/brain mode, opts.brain=true).
export function createSandpaperServer(target, opts = {}, deps = {}) {
  const isDir = !!opts.brain;
  const root = realpathSync(isDir ? target : dirname(target));
  const defaultDoc = isDir ? 'index.html' : basename(target);
  const token = (deps.tokenFactory || (() => randomBytes(32).toString('base64url')))();
  const uuid = deps.uuid || randomUUID;
  const now = deps.now || Date.now;
  const snapshotLimit = opts.snapshotLimit || 20;
  const runner = deps.runner || (({ pageFile, prompt, onFrame }) => runTurn(pageFile, prompt, onFrame));
  const watch = deps.watch || watchFiles;
  const writePage = deps.writeFile || writeFileSync;
  const restoreFile = deps.restoreFile || copyFileSync;
  const scheduleRetry = deps.setTimeout || setTimeout;
  const cancelRetry = deps.clearTimeout || clearTimeout;

  const clients = new Map(); // clientId -> Set<ServerResponse>
  const clientMeta = new WeakMap(); // response -> { page }
  const turnSnapshots = new Map();
  const directSnaps = new Map();
  const expectedWatcherEchoes = new Map(); // page -> { hash, sourceClientId, expiresAt }
  const reloadTimers = new Map(); // page -> debounce timer
  const listenRetryTimers = new Set();
  const directSnapDir = join(root, '.sandpaper', 'snapshots', 'direct');
  let activeTurn = null;
  const currentStatusByPage = new Map();
  let watcher = null;
  let closed = false;

  const resolveUnder = (reqPath, { mutable = false } = {}) => {
    const rel = (reqPath === '/' || reqPath === '') ? defaultDoc : String(reqPath).replace(/^\/+/, '');
    const result = resolveRepositoryPath(root, join(root, rel), { mutable });
    return result.ok ? result.file : null;
  };

  const pageForFile = (file) => {
    if (!isDir) return '/';
    const rel = relative(root, file).split(sep).join('/');
    return rel === defaultDoc ? '/' : `/${rel}`;
  };

  const allResponses = () => {
    const responses = [];
    for (const set of clients.values()) responses.push(...set);
    return responses;
  };

  const writeFrame = (res, frame) => {
    try { res.write(`data: ${JSON.stringify(frame)}\n\n`); return true; }
    catch { return false; }
  };

  const removeClient = (clientId, res) => {
    const set = clients.get(clientId);
    if (!set) return;
    set.delete(res);
    if (!set.size) clients.delete(clientId);
  };

  const broadcast = (frame) => {
    for (const [clientId, set] of clients) {
      for (const res of set) if (!writeFrame(res, frame)) removeClient(clientId, res);
    }
  };

  const broadcastToClient = (clientId, frame) => {
    const set = clients.get(clientId);
    if (!set) return;
    for (const res of set) if (!writeFrame(res, frame)) removeClient(clientId, res);
  };

  const broadcastToPage = (page, frame) => {
    for (const [clientId, set] of clients) {
      for (const res of set) {
        if (clientMeta.get(res)?.page !== page) continue;
        if (!writeFrame(res, frame)) removeClient(clientId, res);
      }
    }
  };

  const broadcastReload = (page, exceptClientId = null) => {
    const frame = isDir ? { type: 'reload', page } : { type: 'reload' };
    for (const [clientId, set] of clients) {
      if (clientId === exceptClientId) continue;
      for (const res of set) {
        if (clientMeta.get(res)?.page !== page) continue;
        if (!writeFrame(res, frame)) removeClient(clientId, res);
      }
    }
  };

  const publishStatus = (frame, { page = frame.page, clientId = null } = {}) => {
    if (page) {
      currentStatusByPage.set(page, frame);
      broadcastToPage(page, frame);
      return;
    }
    if (clientId) broadcastToClient(clientId, frame);
  };

  const releaseReceivingTurn = (record) => {
    if (activeTurn !== record || record.phase !== 'receiving') return;
    record.terminal = true;
    activeTurn = null;
    publishStatus({ type: 'status', state: 'idle', label: 'idle' }, {
      page: record.page,
      clientId: record.clientId,
    });
  };

  const takeDirectSnap = (pageFile) => {
    try {
      mkdirSync(directSnapDir, { recursive: true });
      const rel = relative(root, pageFile) || basename(pageFile);
      const snap = join(directSnapDir, `${createHash('sha1').update(rel).digest('hex').slice(0, 16)}.html`);
      copyFileSync(pageFile, snap);
      return snap;
    } catch {
      return null;
    }
  };

  const sameActivePage = (pageFile) => activeTurn && activeTurn.pageFile === pageFile && !activeTurn.terminal;

  const applyDirect = (pageFile, clientId, compute) => {
    if (sameActivePage(pageFile)) throw new RequestError(409, 'turn_in_progress', 'An AI turn is editing this page');
    let src;
    try { src = readFileSync(pageFile, 'utf8'); }
    catch { throw new RequestError(404, 'unreadable_page', 'Page could not be read'); }
    const out = compute(src);
    if (out == null) throw new RequestError(409, 'element_not_found', 'Element was not found');
    if (out === src) return { ok: true, noop: true, undoable: false };
    const snap = takeDirectSnap(pageFile);
    try { writePage(pageFile, out); }
    catch {
      let restored = false;
      if (snap) {
        try {
          restoreFile(snap, pageFile);
          restored = true;
        } catch { /* preserve the snapshot below for explicit recovery */ }
      }
      if (restored) {
        directSnaps.delete(pageFile);
        removeSnapshot(snap);
      } else if (snap) {
        directSnaps.set(pageFile, snap);
      }
      throw new RequestError(500, 'write_failed', 'Page could not be written');
    }
    if (snap) directSnaps.set(pageFile, snap);
    return { ok: true, clientId, page: pageForFile(pageFile), hash: fileHash(pageFile), undoable: !!snap };
  };

  const serveFile = (file, req, res) => {
    readFile(file, (error, data) => {
      if (error) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  };

  const injectToolbar = (html) => {
    const safeToken = String(token).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const tag = '\n<link rel="stylesheet" href="/__sandpaper/toolbar.css">' +
      `\n<script type="module" src="/__sandpaper/toolbar.js" data-sandpaper-token="${safeToken}"></script>\n`;
    return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag;
  };

  const requireMutationContract = (req) => {
    const invalid = validBrowserRequest(req, token);
    if (invalid) throw invalid;
    if (!jsonContentType(req)) {
      throw new RequestError(415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    return req.headers['x-sandpaper-client'];
  };

  const resolveMutablePage = (page) => {
    const pageFile = resolveUnder(typeof page === 'string' ? page : '/', { mutable: true });
    if (!pageFile || extname(pageFile) !== '.html' || !existsSync(pageFile)) {
      throw new RequestError(400, 'invalid_page', 'Unknown or immutable page');
    }
    return pageFile;
  };

  const handleTurn = async (req, res, clientId) => {
    if (activeTurn && !activeTurn.terminal) {
      throw new RequestError(409, 'turn_in_progress', 'A turn is already in progress');
    }

    const record = {
      id: uuid(), page: isDir ? null : '/', pageFile: null, clientId,
      phase: 'receiving',
      status: { type: 'status', state: 'receiving', label: 'receiving…' },
      beforeHash: null, snapshot: null, reloadPending: false, terminal: false,
      runnerHandle: null,
    };
    activeTurn = record;
    publishStatus({ ...record.status, turnId: record.id, page: record.page, phase: record.phase }, {
      page: record.page,
      clientId: record.clientId,
    });

    let payload;
    try { payload = await readJson(req, BODY_LIMITS['/__sandpaper/turn']); }
    catch (error) { releaseReceivingTurn(record); throw error; }

    try {
      record.pageFile = resolveMutablePage(payload.page);
      record.page = pageForFile(record.pageFile);
    } catch (error) {
      releaseReceivingTurn(record);
      throw error;
    }
    record.snapshot = takeSnapshot(record.pageFile, root, record.id);
    if (record.snapshot) turnSnapshots.set(record.id, record);
    record.beforeHash = fileHash(record.pageFile);
    record.phase = 'running';
    record.status = { type: 'status', state: 'init', label: 'starting…' };
    publishStatus({ ...record.status, turnId: record.id, page: record.page, phase: record.phase }, {
      page: record.page,
    });

    try {
      const handle = runner({
        pageFile: record.pageFile,
        prompt: buildPrompt(payload, basename(record.pageFile)),
        onFrame(frame) {
          if (record.terminal) return;
          const terminal = frame.type === 'status' && (frame.done || frame.state === 'done' || frame.state === 'error' || frame.state === 'idle');
          let enriched = { ...frame, turnId: record.id, page: record.page, phase: terminal ? (frame.state === 'error' ? 'error' : 'done') : 'running' };
          if (terminal) {
            const changed = record.beforeHash !== fileHash(record.pageFile);
            const undoable = changed && !!record.snapshot && existsSync(record.snapshot);
            enriched = { ...enriched, changed, undoable };
            if (!undoable) {
              removeSnapshot(record.snapshot);
              turnSnapshots.delete(record.id);
              record.snapshot = null;
            } else {
              while (turnSnapshots.size > snapshotLimit) {
                const [oldestId, oldest] = turnSnapshots.entries().next().value;
                turnSnapshots.delete(oldestId);
                removeSnapshot(oldest.snapshot);
                oldest.snapshot = null;
              }
            }
          }
          if (frame.type === 'status') {
            record.status = enriched;
            publishStatus(enriched, { page: record.page });
          } else {
            broadcast(enriched);
          }
          if (!terminal) return;
          record.phase = enriched.phase;
          record.terminal = true;
          if (activeTurn === record) activeTurn = null;
          if (record.reloadPending) broadcastReload(record.page);
        },
      });
      record.runnerHandle = handle || null;
    } catch (error) {
      if (record.runnerHandle && typeof record.runnerHandle.kill === 'function') {
        try { record.runnerHandle.kill(); } catch { /* best-effort startup cleanup */ }
      }
      removeSnapshot(record.snapshot);
      turnSnapshots.delete(record.id);
      record.snapshot = null;
      record.phase = 'error';
      record.terminal = true;
      if (activeTurn === record) activeTurn = null;
      const terminal = {
        type: 'status', state: 'error', label: 'runner failed to start',
        detail: String(error?.message || '').slice(0, 300),
        turnId: record.id, page: record.page, phase: record.phase,
        changed: record.beforeHash !== fileHash(record.pageFile), undoable: false,
      };
      record.status = terminal;
      publishStatus(terminal, { page: record.page });
      throw new RequestError(500, 'runner_start_failed', 'Runner could not be started');
    }

    sendJson(res, 202, { ok: true, turnId: record.id });
  };

  const handleUndo = (payload) => {
    const record = turnSnapshots.get(payload.turnId);
    if (!record || !record.snapshot || !existsSync(record.snapshot)) {
      throw new RequestError(404, 'snapshot_not_found', 'No snapshot exists for that turn');
    }
    const pageFile = resolveMutablePage(payload.page);
    if (pageFile !== record.pageFile) {
      throw new RequestError(409, 'page_mismatch', 'Snapshot belongs to a different page');
    }
    if (sameActivePage(record.pageFile)) {
      throw new RequestError(409, 'turn_in_progress', 'An AI turn is editing this page');
    }
    try { restoreFile(record.snapshot, record.pageFile); }
    catch { throw new RequestError(500, 'undo_failed', 'Snapshot could not be restored'); }
    turnSnapshots.delete(record.id);
    removeSnapshot(record.snapshot);
    return { ok: true };
  };

  const handleMutation = async (req, res, path) => {
    try {
      const clientId = requireMutationContract(req);
      if (path === '/__sandpaper/turn') {
        await handleTurn(req, res, clientId);
        return;
      }

      const payload = await readJson(req, BODY_LIMITS[path]);
      let result;
      if (path === '/__sandpaper/write') {
        const pageFile = resolveMutablePage(payload.page);
        if (typeof payload.cid !== 'string' || !/^[\w:-]{1,64}$/.test(payload.cid) || typeof payload.html !== 'string') {
          throw new RequestError(400, 'invalid_write', 'Write request is invalid');
        }
        result = applyDirect(pageFile, clientId, (src) => replaceInner(src, payload.cid, payload.html));
      } else if (path === '/__sandpaper/dom') {
        const pageFile = resolveMutablePage(payload.page);
        const okCid = (value) => typeof value === 'string' && /^[\w:-]{1,64}$/.test(value);
        if (!okCid(payload.cid) || (payload.op !== 'delete' && payload.op !== 'move') ||
            (payload.op === 'move' && !okCid(payload.target))) {
          throw new RequestError(400, 'invalid_dom_operation', 'DOM operation is invalid');
        }
        const mode = payload.mode === 'after' ? 'after' : 'before';
        result = applyDirect(pageFile, clientId, (src) => {
          const output = payload.op === 'delete'
            ? removeElement(src, payload.cid)
            : moveElement(src, payload.cid, payload.target, mode);
          return output ? output.html : null;
        });
      } else if (path === '/__sandpaper/undo') {
        result = handleUndo(payload);
      } else {
        const pageFile = resolveMutablePage(payload.page);
        if (sameActivePage(pageFile)) {
          throw new RequestError(409, 'turn_in_progress', 'An AI turn is editing this page');
        }
        const snap = directSnaps.get(pageFile);
        if (!snap || !existsSync(snap)) throw new RequestError(404, 'snapshot_not_found', 'Nothing to undo');
        try { restoreFile(snap, pageFile); }
        catch { throw new RequestError(500, 'undo_failed', 'Snapshot could not be restored'); }
        directSnaps.delete(pageFile);
        removeSnapshot(snap);
        result = { ok: true };
      }
      if ((path === '/__sandpaper/write' || path === '/__sandpaper/dom') && !result.noop) {
        expectedWatcherEchoes.set(result.page, {
          hash: result.hash,
          sourceClientId: clientId,
          expiresAt: now() + 800,
        });
        broadcastReload(result.page, clientId);
      }
      sendJson(res, 200, result);
    } catch (error) {
      apiFailure(res, error);
    }
  };

  const server = createServer((req, res) => {
    let url;
    let path;
    if (hasRawDotSegment(req.url)) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'invalid_path', message: 'Path dot segments are not allowed' },
      });
      return;
    }
    try {
      url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      path = decodeURIComponent(url.pathname);
      if (path.includes('\0')) throw new URIError('NUL path');
    } catch {
      res.writeHead(400);
      res.end('bad request');
      return;
    }

    if (path === '/__sandpaper/events') {
      if (!loopbackHost(req.headers.host)) {
        apiFailure(res, new RequestError(403, 'invalid_host', 'Request host must be loopback'));
        return;
      }
      if (!secureEqual(url.searchParams.get('token'), token)) {
        apiFailure(res, new RequestError(403, 'invalid_token', 'Invalid Sandpaper token'));
        return;
      }
      const clientId = url.searchParams.get('clientId');
      if (!CLIENT_ID.test(clientId || '')) {
        apiFailure(res, new RequestError(403, 'invalid_client', 'Missing or invalid Sandpaper client ID'));
        return;
      }
      const invalidOrigin = invalidBrowserOrigin(req);
      if (invalidOrigin) {
        apiFailure(res, invalidOrigin);
        return;
      }
      const requestedPage = url.searchParams.get('page') || '/';
      let pageFile;
      try {
        if (!isDir && requestedPage !== '/') {
          throw new RequestError(400, 'invalid_page', 'Unknown or immutable page');
        }
        pageFile = resolveMutablePage(requestedPage);
        if (extname(pageFile) !== '.html') {
          throw new RequestError(400, 'invalid_page', 'Unknown or immutable page');
        }
      } catch (error) {
        apiFailure(res, error);
        return;
      }
      const page = pageForFile(pageFile);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      writeFrame(res, currentStatusByPage.get(page) || { type: 'status', state: 'idle', label: 'idle' });
      const set = clients.get(clientId) || new Set();
      set.add(res);
      clients.set(clientId, set);
      clientMeta.set(res, { page });
      req.on('close', () => removeClient(clientId, res));
      return;
    }

    if (Object.hasOwn(BODY_LIMITS, path)) {
      if (req.method !== 'POST') {
        apiFailure(res, new RequestError(405, 'method_not_allowed', 'Mutation endpoints require POST'));
        return;
      }
      void handleMutation(req, res, path);
      return;
    }

    if (isDir && (path === '/' || path === '') && !existsSync(join(root, 'index.html')) && existsSync(join(root, 'brain', 'index.html'))) {
      res.writeHead(302, { Location: '/brain/index.html' });
      res.end();
      return;
    }

    if (path.startsWith('/__sandpaper/') && (path.endsWith('.js') || path.endsWith('.css'))) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }
      serveFile(join(PUBLIC, basename(path)), req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('method not allowed'); return; }
    const file = resolveUnder(path);
    if (!file) { res.writeHead(404); res.end('not found'); return; }
    if (extname(file) === '.html') {
      readFile(file, 'utf8', (error, html) => {
        if (error) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : injectToolbar(html));
      });
      return;
    }
    serveFile(file, req, res);
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const onWatchChange = (_event, filename) => {
    let name = filename;
    if (!name) { if (isDir) return; name = defaultDoc; }
    const rel = String(name).split(sep).join('/');
    if (rel.startsWith('.sandpaper') || !rel.endsWith('.html')) return;
    if (!isDir && basename(rel) !== defaultDoc) return;
    const page = !isDir || rel === defaultDoc ? '/' : `/${rel}`;
    clearTimeout(reloadTimers.get(page));
    const timer = setTimeout(() => {
      reloadTimers.delete(page);
      const expected = expectedWatcherEchoes.get(page);
      const pageFile = resolveUnder(page, { mutable: true });
      const hash = pageFile ? fileHash(pageFile) : null;
      if (expected && now() < expected.expiresAt && hash === expected.hash) {
        expectedWatcherEchoes.delete(page);
        return;
      }
      if (expected) expectedWatcherEchoes.delete(page);
      if (activeTurn && activeTurn.page === page && !activeTurn.terminal) {
        activeTurn.reloadPending = true;
        return;
      }
      broadcastReload(page);
    }, 120);
    reloadTimers.set(page, timer);
  };
  try {
    watcher = watch(root, { persistent: true, recursive: isDir }, onWatchChange);
  } catch (error) {
    if (!isDir || !recursiveWatchUnavailable(error)) throw error;
    watcher = createFallbackTreeWatcher(root, watch, onWatchChange);
  }

  let listeningPromise = null;
  let rejectPendingListen = null;
  let listenSettled = false;
  const closedListenError = () => Object.assign(new Error('Sandpaper server closed before listening'), { code: 'SERVER_CLOSED' });
  const listen = (port = 0) => {
    if (listeningPromise) return listeningPromise;
    if (closed) return Promise.reject(closedListenError());
    listeningPromise = new Promise((resolve, reject) => {
      rejectPendingListen = reject;
      let requestedPort = port;
      let attempts = 0;
      const settleResolve = (value) => {
        if (listenSettled) return;
        listenSettled = true;
        resolve(value);
      };
      const settleReject = (error) => {
        if (listenSettled) return;
        listenSettled = true;
        reject(error);
      };
      const onError = (error) => {
        if (closed) {
          settleReject(closedListenError());
          return;
        }
        if (error.code === 'EADDRINUSE' && requestedPort !== 0 && attempts++ < 50) {
          requestedPort += 1;
          let timer;
          timer = scheduleRetry(() => {
            listenRetryTimers.delete(timer);
            if (closed) {
              settleReject(closedListenError());
              return;
            }
            server.listen(requestedPort, '127.0.0.1');
          }, 0);
          listenRetryTimers.add(timer);
          return;
        }
        settleReject(error);
      };
      server.on('error', onError);
      server.on('listening', () => {
        if (closed) {
          server.close(() => {});
          settleReject(closedListenError());
          return;
        }
        const address = server.address();
        settleResolve(`http://127.0.0.1:${address.port}/`);
      });
      server.listen(requestedPort, '127.0.0.1');
    });
    return listeningPromise;
  };

  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    if (activeTurn?.runnerHandle && typeof activeTurn.runnerHandle.kill === 'function') {
      try { activeTurn.runnerHandle.kill(); } catch { /* best-effort */ }
    }
    for (const timer of listenRetryTimers) cancelRetry(timer);
    listenRetryTimers.clear();
    if (!listenSettled && rejectPendingListen) {
      listenSettled = true;
      rejectPendingListen(closedListenError());
    }
    try { watcher?.close(); } catch { /* best-effort */ }
    for (const timer of reloadTimers.values()) clearTimeout(timer);
    reloadTimers.clear();
    expectedWatcherEchoes.clear();
    for (const res of allResponses()) {
      try { res.end(); } catch { /* best-effort */ }
    }
    clients.clear();
    currentStatusByPage.clear();
    if (!server.listening) return Promise.resolve();
    const stopped = new Promise((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    return stopped;
  };

  return { server, listen, close };
}

export function startServer(target, port, opts = {}) {
  return createSandpaperServer(target, opts).listen(port);
}

function buildPrompt(payload, docName) {
  const { prompt = '', cid, selector, snippet } = payload;
  if (cid || selector) {
    const where = cid ? `the element with data-cid="${cid}"` : `the element matching CSS selector \`${selector}\``;
    const context = snippet ? `\nFor reference, its current content begins: "${snippet}"` : '';
    return `In ${docName}, edit ONLY ${where}.${context}\n\nRequested change: ${prompt}\n\n` +
      'Make the smallest edit that satisfies this and leave the rest of the document unchanged.';
  }
  return `In ${docName}: ${prompt}\n\nMake the smallest edit that satisfies this; do not regenerate unrelated parts of the document.`;
}
