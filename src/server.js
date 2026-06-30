// server.js — the local bridge server.
// Serves a document OR a whole folder (e.g. the project brain), injecting the on-page
// toolbar at response time only, relaying page → Claude turns, streaming status over SSE,
// and live-reloading the affected page when its file changes.
import { createServer } from 'node:http';
import { readFile, writeFile, readFileSync, writeFileSync, watch, copyFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, basename, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { runTurn } from './claude.js';
import { replaceInner, removeElement, moveElement } from './edit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json',
};

// `target` is a file (single-doc mode) or a directory (folder/brain mode, opts.brain=true).
export function startServer(target, port, opts = {}) {
  const isDir = !!opts.brain;
  const root = isDir ? target : dirname(target);        // the directory we serve from
  const defaultDoc = isDir ? 'index.html' : basename(target); // what "/" resolves to
  const clients = new Set();
  const turnSnapshots = new Map(); // turnId -> the page file it snapshotted (so undo restores the right file)
  let activeTurn = null;
  let activeTurnPage = null;  // the URL path the active turn is editing (for the reload frame)
  let reloadPending = false;  // a file change happened mid-turn; reload once it ends
  let suppressReloadUntil = 0; // a direct in-place edit we just wrote — the browser already shows it

  // One-level undo for direct (no-AI) edits: snapshot a page just before we mutate it.
  const directSnapDir = join(root, '.sandpaper', 'snapshots', 'direct');
  const directSnaps = new Map(); // pageFile -> its pre-edit snapshot file (recorded only after a successful write)
  const takeDirectSnap = (pageFile) => { // copy the current file aside; return the snapshot path, or null
    try {
      if (!existsSync(directSnapDir)) mkdirSync(directSnapDir, { recursive: true });
      const rel = pageFile.startsWith(root + sep) ? pageFile.slice(root.length + 1) : basename(pageFile);
      const snap = join(directSnapDir, createHash('sha1').update(rel).digest('hex').slice(0, 16) + '.html');
      copyFileSync(pageFile, snap);
      return snap;
    } catch { return null; } // best-effort; never block the edit
  };

  // Apply a direct (no-AI) edit ATOMICALLY: sync read → compute → write, with no await points in between
  // (so two rapid edits can't interleave). compute(src) -> new HTML string, or null if not located.
  // Refuses to write while an AI turn is editing the same page (it would clobber Claude's in-progress edit).
  const applyDirect = (pageFile, compute) => {
    if (activeTurn && (!isDir || resolveUnder(activeTurnPage) === pageFile)) return { code: 409, body: '{"error":"an AI turn is editing this page"}' };
    let src;
    try { src = readFileSync(pageFile, 'utf8'); } catch { return { code: 404, body: '{"error":"unreadable"}' }; }
    const out = compute(src);
    if (out == null) return { code: 409, body: '{"error":"element not found"}' };
    if (out === src) return { code: 200, body: '{"ok":true,"noop":true}' };
    const snap = takeDirectSnap(pageFile);            // snapshot the pre-edit file
    try { writeFileSync(pageFile, out); } catch { return { code: 500, body: '{"error":"write failed"}' }; }
    if (snap) directSnaps.set(pageFile, snap);        // record undo ONLY after the write succeeds
    suppressReloadUntil = Date.now() + 800;           // the browser already shows the change
    return { code: 200, body: '{"ok":true}' };
  };

  const broadcast = (obj) => {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  };

  const injectToolbar = (html) => {
    const tag =
      '\n<link rel="stylesheet" href="/__sandpaper/toolbar.css">' +
      '\n<script type="module" src="/__sandpaper/toolbar.js"></script>\n';
    return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag;
  };

  const serveFile = (file, res) => {
    readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  };

  // Resolve a URL path to an absolute file UNDER root, or null if it escapes (traversal guard).
  const resolveUnder = (reqPath) => {
    const rel = (reqPath === '/' || reqPath === '') ? defaultDoc : reqPath.replace(/^\/+/, '');
    if (rel === '.git' || rel.startsWith('.git/')) return null; // never serve VCS internals
    const file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return null; // lexical traversal guard
    // also resolve symlinks: a link inside root pointing outside must not escape.
    try { const real = realpathSync(file); if (real !== root && !real.startsWith(root + sep)) return null; }
    catch { /* path not yet on disk — the lexical guard already passed */ }
    return file;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path;
    try { path = decodeURIComponent(url.pathname); }
    catch { res.writeHead(400); return res.end('bad request'); }

    // Root convenience: serving a repo whose brain lives in brain/ — send "/" to the cover so
    // localhost:<port> just works, no need to know the /brain/index.html path.
    if (isDir && (path === '/' || path === '') && !existsSync(join(root, 'index.html')) && existsSync(join(root, 'brain', 'index.html'))) {
      res.writeHead(302, { Location: '/brain/index.html' });
      return res.end();
    }

    // --- SSE status/reload channel ---
    if (path === '/__sandpaper/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'status', state: 'idle', label: 'idle' })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    // --- a refinement turn (page-aware) ---
    if (path === '/__sandpaper/turn' && req.method === 'POST') {
      if (activeTurn) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end('{"error":"a turn is already in progress"}');
      }
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch {}
        // Never trust the client page: re-resolve it under root and require an existing .html.
        const turnPage = typeof payload.page === 'string' ? payload.page : '/';
        const pageFile = resolveUnder(turnPage);
        if (!pageFile || extname(pageFile) !== '.html' || !existsSync(pageFile)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end('{"error":"unknown page"}');
        }
        const turnId = randomUUID();
        snapshot(pageFile, root, turnId);
        turnSnapshots.set(turnId, pageFile);
        activeTurnPage = turnPage;
        activeTurn = runTurn(pageFile, buildPrompt(payload, basename(pageFile)), (frame) => {
          frame.turnId = turnId;
          frame.page = activeTurnPage; // page-scope every frame so other-page windows ignore this turn
          broadcast(frame);
          const ended = frame.type === 'status' && (frame.done || frame.state === 'idle' || frame.state === 'error');
          if (ended) {
            activeTurn = null;
            if (reloadPending) {
              reloadPending = false;
              broadcast(isDir ? { type: 'reload', page: activeTurnPage } : { type: 'reload' });
            }
            activeTurnPage = null;
          }
        });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, turnId }));
      });
      return;
    }

    // --- undo a turn's edits (restore its pre-turn snapshot to the page it edited) ---
    if (path === '/__sandpaper/undo' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
        const snap = snapshotPath(root, p.turnId);
        const pageFile = turnSnapshots.get(p.turnId); // the file THIS turn snapshotted — not the client's claim
        if (snap && existsSync(snap) && pageFile && extname(pageFile) === '.html') {
          try {
            copyFileSync(snap, pageFile); // → watcher → reload
            turnSnapshots.delete(p.turnId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end('{"ok":true}');
          } catch {}
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"no snapshot for that turn"}');
      });
      return;
    }

    // --- a direct (no-AI) in-place edit: the browser edited one element; persist it to the file ---
    // The browser owns the new content; we splice ONLY that element's inner HTML back into the
    // source by data-cid, leaving the rest of the file untouched. No Claude, no turn, no snapshot.
    if (path === '/__sandpaper/write' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
        const pageFile = resolveUnder(typeof p.page === 'string' ? p.page : '/');
        const cid = typeof p.cid === 'string' ? p.cid : '';
        if (!pageFile || extname(pageFile) !== '.html' || !existsSync(pageFile) ||
            !/^[\w:-]{1,64}$/.test(cid) || typeof p.html !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end('{"error":"bad write request"}');
        }
        const r = applyDirect(pageFile, (src) => replaceInner(src, cid, p.html));
        res.writeHead(r.code, { 'Content-Type': 'application/json' });
        res.end(r.body);
      });
      return;
    }

    // --- a direct (no-AI) STRUCTURAL edit: delete or move an element by data-cid (the "Hands") ---
    if (path === '/__sandpaper/dom' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
        const okCid = (c) => typeof c === 'string' && /^[\w:-]{1,64}$/.test(c);
        const pageFile = resolveUnder(typeof p.page === 'string' ? p.page : '/');
        if (!pageFile || extname(pageFile) !== '.html' || !existsSync(pageFile) || !okCid(p.cid) ||
            (p.op !== 'delete' && p.op !== 'move') || (p.op === 'move' && !okCid(p.target))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end('{"error":"bad dom request"}');
        }
        const mode = p.mode === 'after' ? 'after' : 'before';
        const r = applyDirect(pageFile, (src) => {
          const out = p.op === 'delete' ? removeElement(src, p.cid) : moveElement(src, p.cid, p.target, mode);
          return out ? out.html : null;
        });
        res.writeHead(r.code, { 'Content-Type': 'application/json' });
        res.end(r.body);
      });
      return;
    }

    // --- undo the LAST direct edit on a page (restore its pre-edit snapshot) ---
    if (path === '/__sandpaper/undo-direct' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
        const pageFile = resolveUnder(typeof p.page === 'string' ? p.page : '/');
        const snap = pageFile && directSnaps.get(pageFile);
        if (snap && existsSync(snap)) {
          try {
            suppressReloadUntil = 0;          // we WANT the restore to reload the page
            copyFileSync(snap, pageFile);     // → watcher → reload
            directSnaps.delete(pageFile);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end('{"ok":true}');
          } catch { /* fall through to 404 */ }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"nothing to undo"}');
      });
      return;
    }

    // --- toolbar assets (dev chrome, served from the package; never written to disk) ---
    if (path.startsWith('/__sandpaper/') && (path.endsWith('.js') || path.endsWith('.css'))) {
      return serveFile(join(PUBLIC, basename(path)), res); // toolbar.js / toolbar.css / sp-markdown.js
    }

    // --- any file under root: .html gets the toolbar injected, everything else served raw ---
    const file = resolveUnder(path);
    if (!file) { res.writeHead(404); return res.end('not found'); }
    if (extname(file) === '.html') {
      return readFile(file, 'utf8', (err, html) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(injectToolbar(html));
      });
    }
    return serveFile(file, res);
  });

  // Watch the served tree; reload the page whose .html changed.
  let debounce = null;
  watch(root, { persistent: true, recursive: isDir }, (_evt, fname) => {
    if (!fname) { if (isDir) return; fname = defaultDoc; } // null filename: only act in single-doc mode
    const rel = fname.split(sep).join('/');
    if (rel.startsWith('.sandpaper')) return;             // our own snapshots/session
    if (!rel.endsWith('.html')) return;                   // only reload on document changes
    if (!isDir && basename(rel) !== defaultDoc) return;   // single-doc mode: just the doc
    const page = (isDir && rel === defaultDoc) ? '/' : '/' + rel; // map the root doc back to '/' like the URL
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      // A direct in-place edit we just wrote: the editing browser already shows it — don't reload.
      if (Date.now() < suppressReloadUntil) return;
      // Defer ONLY the active turn's own edit (so its reply isn't cut mid-stream); reload any
      // other (external) change immediately.
      if (activeTurn && (!isDir || page === activeTurnPage)) { reloadPending = true; return; }
      broadcast(isDir ? { type: 'reload', page } : { type: 'reload' });
    }, 120);
  });

  // Listen on `port`, or the next free port if it's taken — so several repos' Sandpapers
  // can run at once without colliding on 4848. Resolves with the URL of the port we landed on.
  return new Promise((resolve, reject) => {
    let p = port, tries = 0;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries++ < 50) { p++; setTimeout(() => server.listen(p, '127.0.0.1'), 0); }
      else reject(e);
    });
    server.on('listening', () => resolve(`http://127.0.0.1:${p}/`));
    server.listen(p, '127.0.0.1');
  });
}

// Pre-turn snapshot of the edited page, so a turn's edits can be undone and recovered.
function snapshotPath(root, turnId) {
  const safe = String(turnId || '').replace(/[^a-fA-F0-9-]/g, ''); // turnId is a uuid; reject anything else
  return safe ? join(root, '.sandpaper', 'snapshots', safe + '.html') : null;
}
function snapshot(pageFile, root, turnId) {
  try {
    const dir = join(root, '.sandpaper', 'snapshots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    copyFileSync(pageFile, snapshotPath(root, turnId));
  } catch { /* best-effort; never block a turn */ }
}

// Turn a toolbar payload into a scoped prompt for Claude.
function buildPrompt(payload, docName) {
  const { prompt = '', cid, selector, snippet } = payload;
  if (cid || selector) {
    const where = cid ? `the element with data-cid="${cid}"` : `the element matching CSS selector \`${selector}\``;
    const ctx = snippet ? `\nFor reference, its current content begins: "${snippet}"` : '';
    return `In ${docName}, edit ONLY ${where}.${ctx}\n\nRequested change: ${prompt}\n\n` +
      'Make the smallest edit that satisfies this and leave the rest of the document unchanged.';
  }
  return `In ${docName}: ${prompt}\n\nMake the smallest edit that satisfies this; do not regenerate unrelated parts of the document.`;
}
