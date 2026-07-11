// toolbar.js — Sandpaper conversation surface (injected into the served document).
// Holds the back-and-forth with Claude on the page: streams replies, shows what each
// turn changed (and undo), survives the live-reload, and keeps the document the star.
import { renderMarkdown } from '/__sandpaper/sp-markdown.js';
import { createSandpaperClient } from '/__sandpaper/sp-client.js';

(function () {
  'use strict';
  var API = '/__sandpaper';
  var COLORS = {
    init: '#8A8578', thinking: '#C75B39', editing: '#3F5247', tool_using: '#3F5247',
    waiting: '#C98A1E', error: '#B23A2E', done: '#4E7C59', idle: '#8A8578',
  };
  var BUSY = ['init', 'thinking', 'editing', 'tool_using', 'waiting'];
  var SKEY = 'sp-thread:' + location.pathname; // transcript persists per-document
  var bootstrap = document.querySelector('script[type="module"][src="/__sandpaper/toolbar.js"][data-sandpaper-token]');
  var token = bootstrap ? bootstrap.getAttribute('data-sandpaper-token') : '';
  var clientId = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : 'page-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  var client = createSandpaperClient({
    base: API,
    token: token,
    clientId: clientId,
    fetchImpl: window.fetch.bind(window),
  });

  // crisp stroke icons (centre perfectly via viewBox; inherit the button's currentColor) —
  // the ⌖/✎ glyphs sat off-centre and read muddy at 36px.
  var ICON_PICK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.25"/><line x1="12" y1="2.5" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="21.5"/>' +
    '<line x1="2.5" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="21.5" y2="12"/></svg>';
  var ICON_EDIT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  // ---------- build the panel (static template — no untrusted data) ----------
  var panel = document.createElement('div');
  panel.id = 'sp-panel';
  panel.className = 'sp-collapsed';
  panel.innerHTML =
    '<div id="sp-head">' +
      '<span id="sp-chip" role="status" aria-live="polite" aria-atomic="true"><span id="sp-led"></span><span id="sp-who">Claude&nbsp;Code</span><span id="sp-label">idle</span></span>' +
      '<span id="sp-cost"></span>' +
      '<button type="button" id="sp-undo" hidden aria-label="Undo the last direct edit" title="Undo the last direct edit">⟲ undo</button>' +
      '<button type="button" id="sp-min" aria-label="Minimize Sandpaper" title="Minimize">–</button>' +
      '<button type="button" id="sp-toggle" aria-label="Expand or collapse conversation" aria-controls="sp-thread" aria-expanded="false">▸</button>' +
    '</div>' +
    '<div id="sp-thread" role="log" aria-label="Sandpaper conversation" aria-live="off" hidden></div>' +
    '<div id="sp-target" hidden></div>' +
    '<form id="sp-form">' +
      '<input id="sp-input" aria-label="Message Claude Code" placeholder="Ask, discuss, or describe a change…" autocomplete="off" />' +
      '<div id="sp-actions">' +
        '<button type="button" id="sp-pick" aria-label="Pick a page element" aria-pressed="false" aria-disabled="false" title="Scope — point at an element to target your message">' + ICON_PICK + '</button>' +
        '<button type="button" id="sp-edit" aria-label="Edit page content directly" aria-pressed="false" aria-disabled="false" title="Edit text in place — your words, no AI">' + ICON_EDIT + '</button>' +
        '<span class="sp-spring"></span>' +
        '<button type="button" id="sp-sling" aria-label="Copy instruction for terminal" title="Send to terminal — copy a ready instruction to paste into your Claude session">&gt;_</button>' +
        '<button type="submit" id="sp-send">Sand</button>' +
      '</div>' +
    '</form>';
  document.body.appendChild(panel);

  var chip = panel.querySelector('#sp-chip'), led = panel.querySelector('#sp-led'),
      label = panel.querySelector('#sp-label'), cost = panel.querySelector('#sp-cost'),
      thread = panel.querySelector('#sp-thread'), input = panel.querySelector('#sp-input'),
      sendBtn = panel.querySelector('#sp-send'), pickBtn = panel.querySelector('#sp-pick'),
      editBtn = panel.querySelector('#sp-edit'), undoBtn = panel.querySelector('#sp-undo'),
      targetTag = panel.querySelector('#sp-target'), toggleBtn = panel.querySelector('#sp-toggle');

  // ---------- adopt the host's skin when it has one ----------
  // The toolbar ships a hardcoded --sp-* palette so it stands alone on ANY page. But when it is
  // injected into a themed Sandpaper surface (the brain), the host defines theme.css tokens on :root —
  // read them and override our defaults so a re-skin reaches the toolbar too. No host theme → no-op.
  // Re-runs on every live-reload, so a /sandpaper:theme change propagates here on the next reload.
  var SKIN_MAP = { '--sp-paper': '--paper', '--sp-paper-2': '--panel', '--sp-ink': '--ink',
    '--sp-clay': '--clay', '--sp-pine': '--pine', '--sp-moss': '--moss', '--sp-rust': '--rust',
    '--sp-mute': '--mute', '--sp-text-quote': '--text-quote', '--sp-plate': '--plate' };
  // The chrome pairs LIGHT text on --sp-ink/--sp-plate and DARK text on --sp-paper. Adopting a host
  // theme that breaks that polarity (e.g. a light --ink used only as body text, never as a fill) makes
  // the dark head wash out — so adopt the neutral SURFACES only when the host keeps the expected
  // light-paper / dark-ink contrast; the accent hues are always safe to take.
  var SKIN_NEUTRALS = ['--sp-paper', '--sp-paper-2', '--sp-ink', '--sp-plate', '--sp-text-quote'];
  function parseColor(c) {
    if (!c) return null; c = c.trim();
    if (c.charAt(0) === '#') { var h = c.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length < 6) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    var m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null;
    var p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2]];
  }
  function luminance(c) {                              // WCAG relative luminance, 0 (black) … 1 (white)
    var rgb = parseColor(c); if (!rgb) return null;
    var a = rgb.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function adoptHostSkin() {
    var cs = getComputedStyle(document.documentElement), read = {}, found = false;
    for (var k in SKIN_MAP) { var v = cs.getPropertyValue(SKIN_MAP[k]).trim(); if (v) { read[k] = v; found = true; } }
    if (!found) return null;                          // arbitrary host page, no Sandpaper theme — keep our shipped defaults
    var lp = luminance(read['--sp-paper']), li = luminance(read['--sp-ink']);
    var polarityOK = lp != null && li != null && lp > 0.55 && li < 0.4 && (lp - li) > 0.4;
    var vals = {};
    for (var k2 in read) {
      if (!polarityOK && SKIN_NEUTRALS.indexOf(k2) >= 0) continue; // skip risky surface swaps; keep our legible defaults
      vals[k2] = read[k2];
    }
    for (var k3 in vals) panel.style.setProperty(k3, vals[k3]);
    return Object.keys(vals).length ? vals : null;
  }
  var hostSkin = adoptHostSkin();

  var turns = Object.create(null);  // turnId -> live turn record
  var pendingTurn = null;           // optimistic user turn awaiting its server turnId
  var sel = null, mode = 'idle', picking = false;
  var lastChangedCids = [];
  var stickBottom = true;
  var directQueue = Promise.resolve();
  var directPending = 0, turnBusy = false, modeVersion = 0;
  var disclosureSeq = 0;

  // ---------- small helpers ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function expand() { panel.classList.remove('sp-collapsed'); thread.hidden = false; toggleBtn.textContent = '▾'; toggleBtn.setAttribute('aria-expanded', 'true'); }
  function collapse() { panel.classList.add('sp-collapsed'); thread.hidden = true; toggleBtn.textContent = '▸'; toggleBtn.setAttribute('aria-expanded', 'false'); }
  function expandIfContent() { if (panel.classList.contains('sp-collapsed')) expand(); }
  function atBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40; }
  function stick() { if (stickBottom) thread.scrollTop = thread.scrollHeight; }
  function syncUndoAvailability() {
    var disabled = turnBusy || directPending > 0;
    undoBtn.disabled = disabled;
    Array.prototype.forEach.call(thread.querySelectorAll('.sp-undo'), function (button) { button.disabled = disabled; });
  }
  function syncDirectLockState() {
    var locked = directPending > 0;
    pickBtn.disabled = locked; editBtn.disabled = locked;
    pickBtn.setAttribute('aria-disabled', String(locked));
    editBtn.setAttribute('aria-disabled', String(locked));
    if (delBtn) { delBtn.disabled = locked; delBtn.setAttribute('aria-disabled', String(locked)); }
    if (grip) {
      grip.setAttribute('draggable', String(!locked));
      grip.setAttribute('aria-disabled', String(locked));
    }
    if (locked && rowctl) rowctl.hidden = true;
  }
  function setBusy(busy) {
    turnBusy = busy;
    chip.classList.toggle('sp-busy', busy);
    input.disabled = busy; sendBtn.disabled = busy;
    syncUndoAvailability();
  }
  function renderScope(scope) {
    sel = scope || null;
    if (!sel) { targetTag.hidden = true; targetTag.textContent = ''; return; }
    var where = sel.cid ? '#' + sel.cid : sel.selector;
    targetTag.hidden = false;
    targetTag.textContent = '⌖ ' + where + (sel.snippet ? ' — ' + sel.snippet : '');
  }
  function errorMessage(error) {
    return error && error.message ? error.message : 'Sandpaper request failed';
  }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function announceRequestError(error) {
    var message = errorMessage(error);
    label.textContent = message;
    led.style.background = COLORS.error;
    chip.style.color = COLORS.error;
    persist(); stick();
  }
  function confirmedDirectRejection(error) {
    return !!(error && typeof error.status === 'number' && error.status >= 400 && error.status < 500);
  }
  function reconcileDirectOutcome(error) {
    announceRequestError(new Error(errorMessage(error) + ' · reloading to reconcile'));
    location.reload();
  }
  function rejectPendingTurn(record, error, draft, terminal) {
    var message = errorMessage(error);
    if (record && !record.errorShown) {
      record.box.appendChild(el('div', 'sp-err', message));
      record.errorShown = true;
    }
    if (pendingTurn === record) pendingTurn = null;
    if (draft != null) input.value = draft;
    renderScope(record && record.scope ? record.scope : null);
    setBusy(false);
    announceRequestError(error);
    if (record && terminal && terminal.changed) finalizeTurn(record, terminal);
    persist(); stick(); input.focus();
  }
  function queueDirect(path, payload, onSuccess, rollback) {
    directPending += 1;
    syncUndoAvailability();
    syncDirectLockState();
    var request = directQueue.then(function () { return client.post(path, payload); });
    var handled = request.then(function (result) {
      if (onSuccess) onSuccess(result);
      return result;
    }).catch(function (error) {
      if (!confirmedDirectRejection(error)) {
        reconcileDirectOutcome(error);
        return null;
      }
      try {
        if (rollback) rollback();
      } catch (rollbackError) {
        announceRequestError(new Error('Couldn’t restore the page after a rejected edit'));
        location.reload();
        return null;
      }
      announceRequestError(error);
      return null;
    });
    var settled = handled.then(function (result) {
      directPending -= 1;
      syncUndoAvailability();
      syncDirectLockState();
      return result;
    });
    directQueue = settled.then(function () {}, function () {});
    return settled;
  }
  thread.addEventListener('scroll', function () { stickBottom = atBottom(); });

  // ---------- a turn (one user message + Claude's reply/edits) ----------
  function createTurn(turnId, userText, attach) {
    var box = el('div', 'sp-turn'); if (turnId) box.setAttribute('data-turn', turnId);
    if (userText != null) {
      var u = el('div', 'sp-user');
      u.appendChild(el('div', 'sp-bubble', userText));
      if (attach) u.appendChild(el('div', 'sp-attach', '↳ ' + attach));
      box.appendChild(u);
    }
    var group = el('div', 'sp-asst');
    var think = el('div', 'sp-think'); think.hidden = true;
    var thinkToggle = el('button', 'sp-think-toggle', '▸ thinking'); thinkToggle.type = 'button'; thinkToggle.setAttribute('data-act', 'think');
    var thinkBody = el('div', 'sp-think-body');
    var thinkId = 'sp-think-body-' + (++disclosureSeq);
    thinkBody.id = thinkId; thinkBody.hidden = true;
    thinkToggle.setAttribute('aria-controls', thinkId); thinkToggle.setAttribute('aria-expanded', 'false');
    think.appendChild(thinkToggle); think.appendChild(thinkBody);
    var prose = el('div', 'sp-prose');
    var meta = el('div', 'sp-turnmeta'); meta.hidden = true;
    group.appendChild(think); group.appendChild(prose); group.appendChild(meta);
    box.appendChild(group);
    thread.appendChild(box);
    panel.classList.add('sp-has-thread'); // the input's top rule only shows once a conversation exists
    return { id: turnId, box: box, proseEl: prose, thinkEl: thinkBody, thinkWrap: think, metaEl: meta,
             editCount: 0, cardEl: null, cardBody: null, cardTitle: null, textBuf: '', thinkBuf: '', raf: 0,
             changedCids: [], draft: userText, scope: null, finalized: false, errorShown: false };
  }

  function getTurn(turnId) {
    if (turnId && turns[turnId]) return turns[turnId];
    if (pendingTurn && !pendingTurn.id) {
      pendingTurn.id = turnId; if (turnId) { turns[turnId] = pendingTurn; pendingTurn.box.setAttribute('data-turn', turnId); }
      var pt = pendingTurn; pendingTurn = null; return pt;
    }
    var t = createTurn(turnId, null, null); if (turnId) turns[turnId] = t; return t;
  }

  function knownTerminalTurn(turnId) {
    if (turnId && turns[turnId]) return turns[turnId];
    if (pendingTurn && (!pendingTurn.id || pendingTurn.id === turnId)) return getTurn(turnId);
    return null;
  }

  function scheduleFlush(rec) {
    if (rec.raf) return;
    rec.raf = requestAnimationFrame(function () {
      rec.raf = 0;
      rec.proseEl.textContent = '';                               // re-render the accumulated reply (streaming-safe)
      rec.proseEl.appendChild(renderMarkdown(rec.textBuf));
      if (rec.thinkBuf) { rec.thinkEl.textContent = rec.thinkBuf; rec.thinkWrap.hidden = false; }
      stick();
    });
  }

  // ---------- status chip ----------
  function setChip(f) {
    var c = COLORS[f.state] || '#8A8578';
    led.style.background = c; chip.style.color = c;
    if (f.label) label.textContent = f.label;
    var busy = BUSY.indexOf(f.state) >= 0;
    setBusy(busy);
    if (typeof f.cost === 'number') cost.textContent = '$' + f.cost.toFixed(4);
    if (f.state === 'error' && f.turnId) {
      var te = knownTerminalTurn(f.turnId);
      var terminalError = new Error(f.detail || f.label || 'Turn failed');
      if (te) rejectPendingTurn(te, terminalError, te.draft, f);
      else announceRequestError(terminalError);
      return;
    }
    if ((f.done || f.phase === 'done') && f.turnId) {
      var doneTurn = knownTerminalTurn(f.turnId);
      if (doneTurn) finalizeTurn(doneTurn, f);
    }
  }

  function finalizeTurn(rec, f) {
    if (rec.finalized) return;
    rec.finalized = true;
    rec.metaEl.hidden = false;
    var edited = !!f.changed;
    rec.box.classList.add(edited ? 'sp-edited' : 'sp-talked');
    rec.metaEl.textContent = '';
    var saveLabel = 'Saved';
    if (edited && rec.editCount) saveLabel += ' · ' + rec.editCount + (rec.editCount > 1 ? ' changes' : ' change');
    rec.metaEl.appendChild(el('span', 'sp-tag', edited ? saveLabel : 'Replied'));
    if (typeof f.cost === 'number') rec.metaEl.appendChild(el('span', 'sp-tagcost', ' · $' + f.cost.toFixed(4)));
    if (f.undoable) {
      var u = el('button', 'sp-undo', 'Undo'); u.setAttribute('data-act', 'undo'); if (rec.id) u.setAttribute('data-turn', rec.id);
      rec.metaEl.appendChild(u);
    }
    lastChangedCids = rec.changedCids.slice();
    persist(); stick();
  }

  // ---------- the "what changed" card ----------
  function addEdit(rec, f) {
    rec.editCount += 1;
    (f.cids || []).forEach(function (c) { if (rec.changedCids.indexOf(c) < 0) rec.changedCids.push(c); });
    if (!rec.cardEl) {
      rec.cardEl = el('div', 'sp-card');
      var head = el('button', 'sp-card-head'); head.type = 'button'; head.setAttribute('data-act', 'card');
      rec.cardTitle = el('span', 'sp-card-title', '');
      head.appendChild(rec.cardTitle); head.appendChild(el('span', 'sp-card-chev', '▸'));
      rec.cardBody = el('div', 'sp-card-body'); rec.cardBody.hidden = true;
      var cardId = 'sp-card-body-' + (++disclosureSeq);
      rec.cardBody.id = cardId; head.setAttribute('aria-controls', cardId); head.setAttribute('aria-expanded', 'false');
      rec.cardEl.appendChild(head); rec.cardEl.appendChild(rec.cardBody);
      rec.box.querySelector('.sp-asst').appendChild(rec.cardEl);
    }
    rec.cardTitle.textContent = '✦ changed ' + rec.editCount + (rec.editCount > 1 ? ' things' : ' thing');
    rec.cardBody.appendChild(el('div', 'sp-hunkfile', f.file + '  (+' + f.added + ' / -' + f.removed + ')'));
    (f.hunks || []).forEach(function (h) {
      if (h.oldText) rec.cardBody.appendChild(diffRow('-', h.oldText));
      if (h.newText) rec.cardBody.appendChild(diffRow('+', h.newText));
    });
    stick();
  }
  function diffRow(sign, text) {
    var t = text.length > 400 ? text.slice(0, 400) + '…' : text;
    return el('div', sign === '+' ? 'sp-add' : 'sp-diff-del', sign + ' ' + t);
  }

  function rehydrateTranscript() {
    var saved = null;
    try { saved = sessionStorage.getItem(SKEY); } catch (e) {}
    if (!saved) return;
    thread.innerHTML = saved;
    panel.classList.add('sp-has-thread');
    for (var key in turns) delete turns[key];
    Array.prototype.forEach.call(thread.querySelectorAll('[id^="sp-think-body-"], [id^="sp-card-body-"]'), function (node) {
      var match = node.id.match(/-(\d+)$/);
      if (match) disclosureSeq = Math.max(disclosureSeq, parseInt(match[1], 10));
    });
    Array.prototype.forEach.call(thread.querySelectorAll('.sp-turn[data-turn]'), function (box) {
      var id = box.getAttribute('data-turn');
      var meta = box.querySelector('.sp-turnmeta');
      var card = box.querySelector('.sp-card');
      turns[id] = {
        id: id, box: box,
        proseEl: box.querySelector('.sp-prose'),
        thinkEl: box.querySelector('.sp-think-body'),
        thinkWrap: box.querySelector('.sp-think'),
        metaEl: meta,
        editCount: box.querySelectorAll('.sp-hunkfile').length,
        cardEl: card,
        cardBody: card ? card.querySelector('.sp-card-body') : null,
        cardTitle: card ? card.querySelector('.sp-card-title') : null,
        textBuf: '', thinkBuf: '', raf: 0, changedCids: [], draft: null, scope: null,
        finalized: !!(meta && !meta.hidden && meta.querySelector('.sp-tag')),
        errorShown: !!box.querySelector('.sp-err'),
      };
    });
    expand(); thread.scrollTop = thread.scrollHeight;
  }

  rehydrateTranscript();

  // ---------- SSE: the live conversation ----------
  var es = new EventSource(client.eventUrl() + '&page=' + encodeURIComponent(location.pathname));
  es.onmessage = function (m) {
    var f; try { f = JSON.parse(m.data); } catch (e) { return; }
    if (f.page && f.page !== location.pathname) return; // frames are page-scoped; ignore other pages' turns
    if (f.type === 'reload') {
      try { sessionStorage.setItem('sp-scroll', String(window.scrollY)); } catch (e) {}
      try { sessionStorage.setItem('sp-flash', JSON.stringify(lastChangedCids)); } catch (e) {}
      persist();
      location.reload();
      return;
    }
    if (f.type === 'assistant_delta') {
      var t = getTurn(f.turnId); expandIfContent();
      if (f.kind === 'thinking') t.thinkBuf += f.text; else t.textBuf += f.text;
      scheduleFlush(t);
      return;
    }
    if (f.type === 'edit') { expandIfContent(); addEdit(getTurn(f.turnId), f); return; }
    setChip(f); // default: a status frame
  };

  // ---------- submit a turn ----------
  panel.querySelector('#sp-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (chip.classList.contains('sp-busy')) return; // a turn is already running
    var prompt = input.value.trim(); if (!prompt) return;
    var attach = sel ? ((sel.cid ? '#' + sel.cid : sel.selector) + (sel.snippet ? ' — ' + sel.snippet : '')) : null;
    pendingTurn = createTurn(null, prompt, attach);
    pendingTurn.scope = sel ? { cid: sel.cid, selector: sel.selector, snippet: sel.snippet } : null;
    var submitted = pendingTurn;
    expand();
    var payload = { prompt: prompt, page: location.pathname };
    if (sel) { payload.cid = sel.cid; payload.selector = sel.selector; payload.snippet = sel.snippet; }
    setChip({ state: 'thinking', label: 'Sending…' });
    client.post('/turn', payload)
      .then(function (j) {
        if (j && j.turnId && submitted && !submitted.id) {
          submitted.id = j.turnId; turns[j.turnId] = submitted; submitted.box.setAttribute('data-turn', j.turnId);
          if (pendingTurn === submitted) pendingTurn = null;
        }
      })
      .catch(function (error) { rejectPendingTurn(submitted, error, prompt); });
    input.value = ''; clearScope();
  });

  // ---------- sling: hand a terminal-ready instruction to the clipboard ----------
  panel.querySelector('#sp-sling').addEventListener('click', function () {
    var instr = input.value.trim();
    var where = location.pathname.replace(/^\//, '') || 'index.html';
    var scope = sel ? (' ' + (sel.cid ? '#' + sel.cid : sel.selector) + (sel.snippet ? ' — "' + sel.snippet + '"' : '')) : '';
    var msg = 'In ' + where + scope + (instr ? '\n\n' + instr : '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(msg).then(
        function () { setChip({ state: 'done', label: 'Slung → paste in your terminal' }); },
        function () { setChip({ state: 'error', label: 'Clipboard blocked' }); }
      );
    } else {
      setChip({ state: 'error', label: 'Clipboard unavailable' });
    }
  });

  // ---------- delegated interactions (survive transcript rehydrate) ----------
  thread.addEventListener('click', function (e) {
    var node = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!node) return;
    var act = node.getAttribute('data-act');
    if (act === 'think') {
      var body = node.parentNode.querySelector('.sp-think-body');
      var open = node.classList.toggle('sp-open');
      node.textContent = (open ? '▾' : '▸') + ' thinking';
      node.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
    } else if (act === 'card') {
      var cardBody = node.parentNode.querySelector('.sp-card-body');
      var chev = node.querySelector('.sp-card-chev');
      cardBody.hidden = !cardBody.hidden;
      node.setAttribute('aria-expanded', String(!cardBody.hidden));
      if (chev) chev.textContent = cardBody.hidden ? '▸' : '▾';
    } else if (act === 'undo') {
      var id = node.getAttribute('data-turn');
      node.disabled = true; node.textContent = 'Undoing…';
      client.post('/undo', { turnId: id, page: location.pathname })
        .then(function () { node.hidden = true; })
        .catch(function (error) {
          node.disabled = false; node.textContent = 'Undo'; node.hidden = false;
          syncUndoAvailability();
          announceRequestError(error);
        });
    }
  });
  toggleBtn.addEventListener('click', function () { panel.classList.contains('sp-collapsed') ? expand() : collapse(); });

  // minimize to a small status pill (gets the toolbar out of the way); click the pill to restore
  var minBtn = panel.querySelector('#sp-min');
  minBtn.addEventListener('click', function (e) { e.stopPropagation(); panel.classList.add('sp-min'); });
  panel.querySelector('#sp-head').addEventListener('click', function () { if (panel.classList.contains('sp-min')) panel.classList.remove('sp-min'); });

  // ---------- click-to-scope ----------
  function cssPath(t) {
    if (t.id) return '#' + CSS.escape(t.id);
    var parts = [];
    while (t && t.nodeType === 1 && t !== document.body && parts.length < 6) {
      var p = t.tagName.toLowerCase(), par = t.parentNode;
      if (par) { var sib = Array.prototype.filter.call(par.children, function (c) { return c.tagName === t.tagName; }); if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(t) + 1) + ')'; }
      parts.unshift(p); t = t.parentNode;
    }
    return parts.join(' > ');
  }
  function clearScope() { renderScope(null); }
  function onOver(e) { if (picking && !panel.contains(e.target)) e.target.classList.add('sp-hl'); }
  function onOut(e) { if (e.target.classList) e.target.classList.remove('sp-hl'); }
  function onClick(e) {
    if (!picking || panel.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    var t = e.target; t.classList.remove('sp-hl');
    var anc = t.closest('[data-cid]'), cid = anc ? anc.getAttribute('data-cid') : null;
    var snip = (t.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    sel = { cid: cid, selector: cid ? null : cssPath(t), snippet: snip };
    targetTag.hidden = false; targetTag.textContent = '⌖ ' + (cid ? '#' + cid : sel.selector) + (snip ? ' — ' + snip : '');
    setMode('idle'); input.focus();
  }
  function applyMode(next) {
    mode = next;
    picking = next === 'pick';
    editing = next === 'hands';
    pickBtn.classList.toggle('sp-on', picking);
    editBtn.classList.toggle('sp-on', editing);
    pickBtn.setAttribute('aria-pressed', String(picking));
    editBtn.setAttribute('aria-pressed', String(editing));
    document.body.classList.toggle('sp-picking', picking);
    document.body.classList.toggle('sp-editing', editing);
    markEditables(editing);
    if (!editing && rowctl) { rowctl.hidden = true; clearDrag(); }
  }
  function setMode(next) {
    if (directPending > 0) return Promise.resolve();
    var version = ++modeVersion;
    if (next !== 'idle' && next !== 'pick' && next !== 'hands') next = 'idle';
    if (next === mode) next = 'idle';
    if (mode === 'hands' && current) {
      applyMode('idle');
      return Promise.resolve(commitEdit()).then(function () { if (version === modeVersion) applyMode(next); });
    }
    applyMode(next);
    return Promise.resolve();
  }
  pickBtn.addEventListener('click', function () { void setMode(mode === 'pick' ? 'idle' : 'pick'); });
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && mode === 'pick') { void setMode('idle'); clearScope(); } });

  // ---------- ✎ edit-in-place — change text directly, no AI (the "Hands") ----------
  // Clicking a LEAF record (a data-cid element with no data-cid descendants) makes it editable;
  // committing splices its new inner HTML straight into the file via /write. No turn, no Claude.
  var editing = false, current = null; // current = { el, cid, original, onKey, onBlur }

  function markEditables(on) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-cid]'), function (n) {
      if (panel.contains(n)) return;
      var leaf = !n.querySelector('[data-cid]'); // never make a big container editable, only leaf records
      if (on && leaf) n.classList.add('sp-editable'); else n.classList.remove('sp-editable');
    });
  }
  editBtn.addEventListener('click', function () { void setMode(mode === 'hands' ? 'idle' : 'hands'); });

  function detach(rec) {
    rec.el.removeEventListener('keydown', rec.onKey);
    rec.el.removeEventListener('blur', rec.onBlur);
    rec.el.removeAttribute('contenteditable');
  }
  function beginEdit(elm) {
    if (directPending > 0) return;
    if (current) {
      commitEdit();
      if (directPending > 0) return;
    }
    var rec = { el: elm, cid: elm.getAttribute('data-cid'), original: elm.innerHTML };
    rec.onKey = function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); elm.blur(); }        // Enter commits
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelEdit(); } // Esc reverts
    };
    rec.onBlur = function () { commitEdit(); };
    elm.setAttribute('contenteditable', 'true');
    elm.addEventListener('keydown', rec.onKey);
    elm.addEventListener('blur', rec.onBlur);
    current = rec; elm.focus();
  }
  function cancelEdit() { if (!current) return; var rec = current; current = null; rec.el.innerHTML = rec.original; detach(rec); }
  function commitEdit() {
    if (!current) return Promise.resolve();
    var rec = current; current = null; detach(rec);
    var next = rec.el.innerHTML;
    if (next === rec.original) return Promise.resolve(); // nothing changed
    return queueDirect('/write', { page: location.pathname, cid: rec.cid, html: next }, function (result) {
        directDone('Saved', result.undoable);
        rec.el.classList.add('sp-saved'); setTimeout(function () { rec.el.classList.remove('sp-saved'); }, 1300);
      }, function () {
        rec.el.innerHTML = rec.original;
      }); // keep file & page in sync on failure
  }

  // capture-phase so a click on a leaf record edits it instead of following links / scoping
  document.addEventListener('click', function (e) {
    if (!editing || directPending > 0 || panel.contains(e.target)) return;
    var elm = e.target.closest ? e.target.closest('[data-cid]') : null;
    if (!elm || elm.querySelector('[data-cid]')) return; // only leaf records are editable
    if (current && current.el === elm) return;           // already editing this one — let the caret move
    e.preventDefault(); e.stopPropagation();
    beginEdit(elm);
  }, true);

  // ---------- ✎ Hands: drag-to-reorder + delete (direct file ops, no AI) ----------
  // A small handle cluster floats over the hovered record; the grip drags, the × deletes.
  var rowctl = el('div'); rowctl.id = 'sp-rowctl'; rowctl.hidden = true;
  var grip = el('span', 'sp-grip', '⠿'); grip.setAttribute('draggable', 'true'); grip.title = 'Drag to reorder';
  var delBtn = el('button', 'sp-row-delete', '×'); delBtn.type = 'button'; delBtn.title = 'Delete this block';
  rowctl.appendChild(grip); rowctl.appendChild(delBtn);
  document.body.appendChild(rowctl);

  var hoverRow = null, hideT = 0;
  var dragEl = null, dragCid = null, dropTarget = null, dropMode = 'before';

  function showCtl(elm) {
    hoverRow = elm;
    var r = elm.getBoundingClientRect();
    rowctl.style.top = (r.top + window.scrollY) + 'px';
    rowctl.style.left = (r.left + window.scrollX) + 'px';
    rowctl.classList.toggle('sp-ctl-below', r.top < 40); // near the (sticky) top → sit just inside, not above
    rowctl.hidden = false;
  }
  function hideCtlSoon() { clearTimeout(hideT); hideT = setTimeout(function () { if (!dragEl) { rowctl.hidden = true; hoverRow = null; } }, 220); }
  function clearDrag() {
    document.body.classList.remove('sp-dragging');
    if (dropTarget) dropTarget.classList.remove('sp-drop-before', 'sp-drop-after');
    dragEl = null; dragCid = null; dropTarget = null;
  }

  document.addEventListener('mouseover', function (e) {
    if (!editing || directPending > 0 || dragEl || current) return; // no handle while a text edit is in progress
    if (rowctl.contains(e.target)) { clearTimeout(hideT); return; }
    var elm = e.target.closest ? e.target.closest('.sp-editable') : null;
    if (elm && !panel.contains(elm)) { clearTimeout(hideT); showCtl(elm); }
  }, true);
  document.addEventListener('mouseout', function (e) {
    if (!editing) return;
    var to = e.relatedTarget;
    if (to && (rowctl.contains(to) || (hoverRow && hoverRow.contains(to)))) return;
    hideCtlSoon();
  }, true);

  delBtn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (directPending > 0 || !hoverRow) return;
    var removed = hoverRow, cid = removed.getAttribute('data-cid');
    var anchor = document.createComment('sandpaper-delete-rollback');
    removed.parentNode.insertBefore(anchor, removed);
    removed.remove(); rowctl.hidden = true; hoverRow = null;
    queueDirect('/dom', { op: 'delete', cid: cid, page: location.pathname }, function (result) {
      anchor.remove(); directDone('Deleted', result.undoable);
    }, function () {
      if (!anchor.parentNode) throw new Error('delete rollback anchor is gone');
      anchor.parentNode.insertBefore(removed, anchor); anchor.remove();
    });
  });

  grip.addEventListener('dragstart', function (e) {
    if (directPending > 0 || !hoverRow || current) { e.preventDefault(); return; }
    dragEl = hoverRow; dragCid = dragEl.getAttribute('data-cid');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragCid); } catch (x) {}
    try { e.dataTransfer.setDragImage(dragEl, 14, 14); } catch (x) {} // the BLOCK follows the cursor, not the 8px grip
    document.body.classList.add('sp-dragging');
    setTimeout(function () { rowctl.hidden = true; }, 0);             // hide the handle AFTER the drag latches (don't kill the source)
  });
  grip.addEventListener('dragend', clearDrag);
  document.addEventListener('dragover', function (e) {
    if (directPending > 0 || !dragEl) return;
    var elm = e.target.closest ? e.target.closest('.sp-editable') : null;
    if (!elm || panel.contains(elm) || elm === dragEl || dragEl.contains(elm) || elm.parentNode !== dragEl.parentNode) return; // reorder among siblings only
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (dropTarget && dropTarget !== elm) dropTarget.classList.remove('sp-drop-before', 'sp-drop-after');
    dropTarget = elm;
    var r = elm.getBoundingClientRect();
    dropMode = (e.clientY < r.top + r.height / 2) ? 'before' : 'after';
    elm.classList.toggle('sp-drop-before', dropMode === 'before');
    elm.classList.toggle('sp-drop-after', dropMode === 'after');
  }, true);
  document.addEventListener('drop', function (e) {
    if (directPending > 0) { clearDrag(); return; }
    if (!dragEl || !dropTarget) { clearDrag(); return; }
    e.preventDefault();
    var moved = dragEl, cid = dragCid, tgt = dropTarget, mode = dropMode, tcid = tgt.getAttribute('data-cid');
    tgt.classList.remove('sp-drop-before', 'sp-drop-after');
    var anchor = document.createComment('sandpaper-move-rollback');
    moved.parentNode.insertBefore(anchor, moved);
    if (mode === 'before') tgt.parentNode.insertBefore(moved, tgt);            // optimistic DOM move
    else tgt.parentNode.insertBefore(moved, tgt.nextSibling);
    clearDrag();
    queueDirect('/dom', { op: 'move', cid: cid, target: tcid, mode: mode, page: location.pathname }, function (result) {
      anchor.remove(); directDone('Moved', result.undoable);
    }, function () {
      if (!anchor.parentNode) throw new Error('move rollback anchor is gone');
      anchor.parentNode.insertBefore(moved, anchor); anchor.remove();
    });
  }, true);

  // undo affordance after ANY direct edit (text · delete · move) — one level, server-snapshotted
  function directDone(label, undoable) { setChip({ state: 'done', label: label + ' · no AI' }); undoBtn.hidden = !undoable; }
  undoBtn.addEventListener('click', function () {
    if (directPending > 0) return;
    undoBtn.disabled = true; undoBtn.textContent = 'Undoing…';
    client.post('/undo-direct', { page: location.pathname })
      .then(function () { undoBtn.hidden = true; undoBtn.disabled = false; undoBtn.textContent = '⟲ undo'; })
      .catch(function (error) {
        undoBtn.hidden = false; undoBtn.disabled = false; undoBtn.textContent = '⟲ undo';
        syncUndoAvailability();
        announceRequestError(error);
      });
  });

  // ---------- first-run welcome — a one-time, on-page tour of the three tools ----------
  // Shows once per browser. Gated on BOTH localStorage (across sessions) and sessionStorage
  // (survives the live-reload even when localStorage is blocked, e.g. private mode).
  var WELCOMED = 'sp-welcomed:v1';
  function welcomed() {
    try { if (localStorage.getItem(WELCOMED) === '1') return true; } catch (e) {}
    try { if (sessionStorage.getItem(WELCOMED) === '1') return true; } catch (e) {}
    return false;
  }
  function setWelcomed() {
    try { localStorage.setItem(WELCOMED, '1'); } catch (e) {}
    try { sessionStorage.setItem(WELCOMED, '1'); } catch (e) {}
  }
  function pulsePanel() { panel.classList.add('sp-attn'); setTimeout(function () { panel.classList.remove('sp-attn'); }, 1600); }

  function maybeWelcome() {
    if (welcomed()) return;
    var previousFocus = document.activeElement;
    var w = el('div'); w.id = 'sp-welcome'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-modal', 'true'); w.setAttribute('aria-labelledby', 'sp-welcome-title');
    if (hostSkin) for (var sk in hostSkin) w.style.setProperty(sk, hostSkin[sk]); // the tour wears the host skin too
    w.innerHTML =                                                        // static template — no untrusted data
      '<div class="sp-w-card">' +
        '<div class="sp-w-head"><span class="sp-w-mark">Sand<span>paper</span></span>' +
          '<button type="button" class="sp-w-x" aria-label="Close">×</button></div>' +
        '<div class="sp-w-body">' +
          '<h2 class="sp-w-title" id="sp-welcome-title">This page is your project&rsquo;s brain.</h2>' +
          '<p class="sp-w-lede">It mirrors where the project stands — and you refine it right here, in the page. Three ways:</p>' +
          '<ul class="sp-w-tools">' +
            '<li><span class="sp-w-g sp-w-sand">Sand</span><div><b>Say a change</b><span class="d">Describe it in plain words — Claude edits the page, scoped to whatever you point at.</span></div></li>' +
            '<li><span class="sp-w-g sp-w-hands">✎</span><div><b>Use your hands</b><span class="d">Edit text, drag to reorder, or delete — directly, no AI.</span></div></li>' +
            '<li><span class="sp-w-g sp-w-sling">&gt;_</span><div><b>Sling to terminal</b><span class="d">Copy a ready-made instruction for bigger, cross-page work.</span></div></li>' +
          '</ul>' +
          '<p class="sp-w-tip">Try first: re-skin it to your brand with <code>/sandpaper:theme #yourhex</code>, or hit <b>✎</b> and rewrite the line up top.</p>' +
        '</div>' +
        '<div class="sp-w-foot"><span class="sp-w-point">your tools live down here ↘</span>' +
          '<button type="button" class="sp-w-go">Start refining →</button></div>' +
      '</div>';
    document.body.appendChild(w);
    requestAnimationFrame(function () { w.classList.add('sp-w-in'); });
    function close() {
      setWelcomed();
      w.classList.remove('sp-w-in');
      document.removeEventListener('keydown', onKey, true);
      setTimeout(function () {
        w.remove();
        if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
        pulsePanel();
      }, reducedMotion() ? 0 : 240);       // then nudge the eye to the real toolbar
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      var focusable = Array.prototype.slice.call(w.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) { e.preventDefault(); w.focus(); return; }
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    w.querySelector('.sp-w-go').addEventListener('click', close);
    w.querySelector('.sp-w-x').addEventListener('click', close);
    w.addEventListener('click', function (e) { if (e.target === w) close(); }); // click the backdrop to dismiss
    document.addEventListener('keydown', onKey, true);
    w.querySelector('.sp-w-go').focus();
  }
  window.addEventListener('load', maybeWelcome);

  // ---------- persistence + rehydrate (survive the live-reload) ----------
  function persist() { try { sessionStorage.setItem(SKEY, thread.innerHTML); } catch (e) {} }

  window.addEventListener('load', function () {
    try { var y = sessionStorage.getItem('sp-scroll'); if (y !== null) { window.scrollTo(0, parseInt(y, 10)); sessionStorage.removeItem('sp-scroll'); } } catch (e) {}
    // flash the changed elements so the eye lands on what moved
    try {
      var cids = JSON.parse(sessionStorage.getItem('sp-flash') || '[]'); sessionStorage.removeItem('sp-flash');
      var first = null;
      cids.forEach(function (c) {
        var q = '[data-cid="' + (window.CSS && CSS.escape ? CSS.escape(c) : c) + '"]';
        Array.prototype.forEach.call(document.querySelectorAll(q), function (n) {
          if (panel.contains(n)) return;
          n.classList.add('sp-flash'); if (!first) first = n;
          setTimeout(function () { n.classList.remove('sp-flash'); }, 2200);
        });
      });
      if (first) first.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    } catch (e) {}
  });
})();
