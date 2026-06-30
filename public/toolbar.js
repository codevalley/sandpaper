// toolbar.js — Sandpaper conversation surface (injected into the served document).
// Holds the back-and-forth with Claude on the page: streams replies, shows what each
// turn changed (and undo), survives the live-reload, and keeps the document the star.
import { renderMarkdown } from '/__sandpaper/sp-markdown.js';

(function () {
  'use strict';
  var API = '/__sandpaper';
  var COLORS = {
    init: '#8A8578', thinking: '#C75B39', editing: '#3F5247', tool_using: '#3F5247',
    waiting: '#C98A1E', error: '#B23A2E', done: '#4E7C59', idle: '#8A8578',
  };
  var BUSY = ['init', 'thinking', 'editing', 'tool_using', 'waiting'];
  var SKEY = 'sp-thread:' + location.pathname; // transcript persists per-document

  // ---------- build the panel (static template — no untrusted data) ----------
  var panel = document.createElement('div');
  panel.id = 'sp-panel';
  panel.className = 'sp-collapsed';
  panel.innerHTML =
    '<div id="sp-head">' +
      '<span id="sp-chip"><span id="sp-led"></span><span id="sp-label">Idle — ready when you are</span></span>' +
      '<span id="sp-cost"></span>' +
      '<button type="button" id="sp-undo" hidden title="Undo the last direct edit">⟲ undo</button>' +
      '<button type="button" id="sp-min" title="Minimize">–</button>' +
      '<button type="button" id="sp-toggle" aria-label="Expand or collapse">▴</button>' +
    '</div>' +
    '<div id="sp-thread" hidden></div>' +
    '<div id="sp-target" hidden></div>' +
    '<form id="sp-form">' +
      '<input id="sp-input" placeholder="Ask, discuss, or describe a change…" autocomplete="off" />' +
      '<div id="sp-actions">' +
        '<button type="button" id="sp-pick" title="Scope — point at an element to target your message">⌖</button>' +
        '<button type="button" id="sp-edit" title="Edit text in place — your words, no AI">✎</button>' +
        '<span class="sp-spring"></span>' +
        '<button type="button" id="sp-sling" title="Send to terminal — copy a ready instruction to paste into your Claude session">&gt;_</button>' +
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

  var turns = Object.create(null);  // turnId -> live turn record
  var pendingTurn = null;           // optimistic user turn awaiting its server turnId
  var sel = null, picking = false;
  var lastChangedCids = [];
  var stickBottom = true;

  // ---------- small helpers ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function expand() { panel.classList.remove('sp-collapsed'); thread.hidden = false; toggleBtn.textContent = '▾'; }
  function collapse() { panel.classList.add('sp-collapsed'); thread.hidden = true; toggleBtn.textContent = '▴'; }
  function expandIfContent() { if (panel.classList.contains('sp-collapsed')) expand(); }
  function atBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40; }
  function stick() { if (stickBottom) thread.scrollTop = thread.scrollHeight; }
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
    var thinkToggle = el('div', 'sp-think-toggle', '▸ thinking'); thinkToggle.setAttribute('data-act', 'think');
    var thinkBody = el('div', 'sp-think-body');
    think.appendChild(thinkToggle); think.appendChild(thinkBody);
    var prose = el('div', 'sp-prose');
    var meta = el('div', 'sp-turnmeta'); meta.hidden = true;
    group.appendChild(think); group.appendChild(prose); group.appendChild(meta);
    box.appendChild(group);
    thread.appendChild(box);
    return { id: turnId, box: box, proseEl: prose, thinkEl: thinkBody, thinkWrap: think, metaEl: meta,
             editCount: 0, cardEl: null, cardBody: null, cardTitle: null, textBuf: '', thinkBuf: '', raf: 0, changedCids: [] };
  }

  function getTurn(turnId) {
    if (turnId && turns[turnId]) return turns[turnId];
    if (pendingTurn && !pendingTurn.id) {
      pendingTurn.id = turnId; if (turnId) { turns[turnId] = pendingTurn; pendingTurn.box.setAttribute('data-turn', turnId); }
      var pt = pendingTurn; pendingTurn = null; return pt;
    }
    var t = createTurn(turnId, null, null); if (turnId) turns[turnId] = t; return t;
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
    chip.classList.toggle('sp-busy', busy);
    input.disabled = busy; sendBtn.disabled = busy;
    if (typeof f.cost === 'number') cost.textContent = '$' + f.cost.toFixed(4);
    if (f.state === 'error' && f.turnId) { var te = getTurn(f.turnId); te.box.appendChild(el('div', 'sp-err', (f.label || 'Error') + (f.detail ? ' — ' + f.detail : ''))); stick(); }
    if (f.done && f.turnId) finalizeTurn(getTurn(f.turnId), f);
  }

  function finalizeTurn(rec, f) {
    rec.metaEl.hidden = false;
    var edited = rec.editCount > 0;
    rec.box.classList.add(edited ? 'sp-edited' : 'sp-talked');
    rec.metaEl.textContent = '';
    rec.metaEl.appendChild(el('span', 'sp-tag', edited ? ('Saved · ' + rec.editCount + (rec.editCount > 1 ? ' changes' : ' change')) : 'Replied'));
    if (typeof f.cost === 'number') rec.metaEl.appendChild(el('span', 'sp-tagcost', ' · $' + f.cost.toFixed(4)));
    if (edited) {
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
      var head = el('div', 'sp-card-head'); head.setAttribute('data-act', 'card');
      rec.cardTitle = el('span', 'sp-card-title', '');
      head.appendChild(rec.cardTitle); head.appendChild(el('span', 'sp-card-chev', '▸'));
      rec.cardBody = el('div', 'sp-card-body'); rec.cardBody.hidden = true;
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
    return el('div', sign === '+' ? 'sp-add' : 'sp-del', sign + ' ' + t);
  }

  // ---------- SSE: the live conversation ----------
  var es = new EventSource(API + '/events');
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
    expand();
    var payload = { prompt: prompt, page: location.pathname };
    if (sel) { payload.cid = sel.cid; payload.selector = sel.selector; payload.snippet = sel.snippet; }
    setChip({ state: 'thinking', label: 'Sending…' });
    fetch(API + '/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.turnId && pendingTurn && !pendingTurn.id) {
          pendingTurn.id = j.turnId; turns[j.turnId] = pendingTurn; pendingTurn.box.setAttribute('data-turn', j.turnId); pendingTurn = null;
        }
      })
      .catch(function () { setChip({ state: 'error', label: 'Bridge unreachable' }); });
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
      body.style.display = open ? 'block' : 'none';
    } else if (act === 'card') {
      var cardBody = node.parentNode.querySelector('.sp-card-body');
      var chev = node.querySelector('.sp-card-chev');
      cardBody.hidden = !cardBody.hidden;
      if (chev) chev.textContent = cardBody.hidden ? '▸' : '▾';
    } else if (act === 'undo') {
      var id = node.getAttribute('data-turn');
      node.disabled = true; node.textContent = 'Undoing…';
      fetch(API + '/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId: id, page: location.pathname }) })
        .catch(function () { node.textContent = 'Undo failed'; });
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
  function clearScope() { sel = null; targetTag.hidden = true; }
  function onOver(e) { if (picking && !panel.contains(e.target)) e.target.classList.add('sp-hl'); }
  function onOut(e) { if (e.target.classList) e.target.classList.remove('sp-hl'); }
  function onClick(e) {
    if (!picking || panel.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    var t = e.target; t.classList.remove('sp-hl');
    var anc = t.closest('[data-cid]'), cid = anc ? anc.getAttribute('data-cid') : null;
    var snip = (t.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    sel = { cid: cid, selector: cid ? null : cssPath(t), snippet: snip };
    targetTag.hidden = false; targetTag.textContent = '✎ ' + (cid ? '#' + cid : sel.selector) + (snip ? ' — ' + snip : '');
    stopPick(); input.focus();
  }
  function startPick() { picking = true; pickBtn.classList.add('sp-on'); document.body.classList.add('sp-picking'); }
  function stopPick() { picking = false; pickBtn.classList.remove('sp-on'); document.body.classList.remove('sp-picking'); }
  pickBtn.addEventListener('click', function () { picking ? stopPick() : startPick(); });
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('mouseout', onOut, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { stopPick(); clearScope(); } });

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
  function startEditMode() { editing = true; editBtn.classList.add('sp-on'); document.body.classList.add('sp-editing'); markEditables(true); if (picking) stopPick(); }
  function stopEditMode() { if (current) commitEdit(); editing = false; editBtn.classList.remove('sp-on'); document.body.classList.remove('sp-editing'); markEditables(false); rowctl.hidden = true; clearDrag(); }
  editBtn.addEventListener('click', function () { editing ? stopEditMode() : startEditMode(); });

  function detach(rec) {
    rec.el.removeEventListener('keydown', rec.onKey);
    rec.el.removeEventListener('blur', rec.onBlur);
    rec.el.removeAttribute('contenteditable');
  }
  function beginEdit(elm) {
    if (current) commitEdit();
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
    if (!current) return;
    var rec = current; current = null; detach(rec);
    var next = rec.el.innerHTML;
    if (next === rec.original) return; // nothing changed
    fetch(API + '/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: location.pathname, cid: rec.cid, html: next }) })
      .then(function (r) { if (!r.ok) throw new Error('write rejected'); return r.json(); })
      .then(function () { directDone('Saved'); rec.el.classList.add('sp-saved'); setTimeout(function () { rec.el.classList.remove('sp-saved'); }, 1300); })
      .catch(function () { rec.el.innerHTML = rec.original; setChip({ state: 'error', label: 'Couldn’t save that edit' }); }); // keep file & page in sync on failure
  }

  // capture-phase so a click on a leaf record edits it instead of following links / scoping
  document.addEventListener('click', function (e) {
    if (!editing || panel.contains(e.target)) return;
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
  var delBtn = el('button', 'sp-del', '×'); delBtn.type = 'button'; delBtn.title = 'Delete this block';
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
    if (!editing || dragEl || current) return; // no handle while a text edit is in progress
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
    if (!hoverRow) return;
    var cid = hoverRow.getAttribute('data-cid');
    hoverRow.remove(); rowctl.hidden = true; hoverRow = null;   // optimistic; resync on failure
    domOp({ op: 'delete', cid: cid }, 'Deleted');
  });

  grip.addEventListener('dragstart', function (e) {
    if (!hoverRow || current) { e.preventDefault(); return; }
    dragEl = hoverRow; dragCid = dragEl.getAttribute('data-cid');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragCid); } catch (x) {}
    try { e.dataTransfer.setDragImage(dragEl, 14, 14); } catch (x) {} // the BLOCK follows the cursor, not the 8px grip
    document.body.classList.add('sp-dragging');
    setTimeout(function () { rowctl.hidden = true; }, 0);             // hide the handle AFTER the drag latches (don't kill the source)
  });
  grip.addEventListener('dragend', clearDrag);
  document.addEventListener('dragover', function (e) {
    if (!dragEl) return;
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
    if (!dragEl || !dropTarget) { clearDrag(); return; }
    e.preventDefault();
    var moved = dragEl, cid = dragCid, tgt = dropTarget, mode = dropMode, tcid = tgt.getAttribute('data-cid');
    tgt.classList.remove('sp-drop-before', 'sp-drop-after');
    if (mode === 'before') tgt.parentNode.insertBefore(moved, tgt);            // optimistic DOM move
    else tgt.parentNode.insertBefore(moved, tgt.nextSibling);
    clearDrag();
    domOp({ op: 'move', cid: cid, target: tcid, mode: mode }, 'Moved');
  }, true);

  // shared POST for structural ops; on failure resync the page from disk
  function domOp(payload, okLabel) {
    payload.page = location.pathname;
    fetch(API + '/dom', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function () { directDone(okLabel); })
      .catch(function () { setChip({ state: 'error', label: 'Couldn’t save — reloading' }); setTimeout(function () { location.reload(); }, 600); });
  }

  // undo affordance after ANY direct edit (text · delete · move) — one level, server-snapshotted
  function directDone(label) { setChip({ state: 'done', label: label + ' · no AI' }); undoBtn.hidden = false; }
  undoBtn.addEventListener('click', function () {
    undoBtn.hidden = true;
    fetch(API + '/undo-direct', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: location.pathname }) })
      .then(function (r) { if (!r.ok) throw new Error(); /* server restores → watcher → reload */ })
      .catch(function () { setChip({ state: 'error', label: 'Nothing to undo' }); });
  });

  // ---------- persistence + rehydrate (survive the live-reload) ----------
  function persist() { try { sessionStorage.setItem(SKEY, thread.innerHTML); } catch (e) {} }

  window.addEventListener('load', function () {
    try { var y = sessionStorage.getItem('sp-scroll'); if (y !== null) { window.scrollTo(0, parseInt(y, 10)); sessionStorage.removeItem('sp-scroll'); } } catch (e) {}
    // rehydrate the conversation (our own serialized, escaped DOM)
    try { var saved = sessionStorage.getItem(SKEY); if (saved) { thread.innerHTML = saved; expand(); thread.scrollTop = thread.scrollHeight; } } catch (e) {}
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
      if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {}
  });
})();
