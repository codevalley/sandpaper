// brain.js — zero-dependency, file://-safe enhancements for the project brain.
// (1) Live-DOM search/filter over .entry blocks.  (2) "Since you last looked" on the log.
// (3) Plan progress derived from task status.  (4) Out-link resolver — keeps brain/
//     publishable anywhere (one same-origin probe; the only network call in this file).
// (5) Whiteboard fold-fit — the canvas caps at the first fold, content scrolls inside.
(function () {
  'use strict';

  // ---- (1) search / filter ----
  var q = document.getElementById('brain-q');
  if (q) {
    var entries = Array.prototype.slice.call(document.querySelectorAll('.entry[data-kind], .timeline li[data-kind]'));
    var facetEls = Array.prototype.slice.call(document.querySelectorAll('.facet'));
    var note = document.getElementById('brain-searchnote');
    var activeFacet = '';

    function apply() {
      var term = q.value.trim().toLowerCase();
      var shown = 0;
      entries.forEach(function (e) {
        var hay = (e.textContent + ' ' + (e.getAttribute('data-tags') || '') + ' ' + (e.getAttribute('data-kind') || '') + ' ' + (e.getAttribute('data-status') || '') + ' ' + (e.getAttribute('data-lens') || '')).toLowerCase();
        var okTerm = !term || hay.indexOf(term) >= 0;
        var okFacet = !activeFacet || e.getAttribute('data-kind') === activeFacet || e.getAttribute('data-status') === activeFacet || e.getAttribute('data-lens') === activeFacet;
        var show = okTerm && okFacet;
        e.hidden = !show;
        if (show) shown++;
      });
      if (note) note.textContent = (term || activeFacet) ? (shown + ' shown') : '';
    }
    q.addEventListener('input', apply);
    facetEls.forEach(function (f) {
      f.addEventListener('click', function () {
        var val = f.getAttribute('data-facet') || '';
        activeFacet = (activeFacet === val) ? '' : val;
        facetEls.forEach(function (x) {
          var pressed = x === f && !!activeFacet;
          x.classList.toggle('on', pressed);
          x.setAttribute('aria-pressed', String(pressed));
        });
        apply();
      });
    });
    // press "/" to focus search
    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.key !== '/') return;
      var target = e.target;
      if (target && target.nodeType === 1 && target.closest('input, textarea, select, button, [contenteditable]')) return;
      if (document.activeElement !== q) { e.preventDefault(); q.focus(); }
    });
  }

  // ---- (2) "since you last looked" on the log ----
  var logRows = Array.prototype.slice.call(document.querySelectorAll('.timeline li[data-cid], .entry--worklog[data-cid]'));
  if (logRows.length) {
    // freshness is the product: derive the day divider from the newest row instead of trusting stale hand-typed text
    var day = document.querySelector('.tl-day');
    var newestDate = logRows[0].getAttribute('data-date');
    if (day && newestDate) {
      var d = new Date(newestDate + 'T00:00:00');
      if (!isNaN(d)) day.textContent = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) + ' · latest';
    }
    var KEY = 'brain:lastSeen';
    var last = null;
    try { last = localStorage.getItem(KEY); } catch (e) {}
    var newest = logRows[0].getAttribute('data-cid'); // rows are newest-first
    if (last && last !== newest) {
      var unseen = 0;
      for (var i = 0; i < logRows.length; i++) {
        if (logRows[i].getAttribute('data-cid') === last) break;
        logRows[i].classList.add('unseen'); unseen++;
      }
      var badge = document.getElementById('brain-unseen');
      if (badge && unseen) { badge.textContent = unseen + ' new'; badge.hidden = false; }
    }
    var mark = document.getElementById('brain-markseen');
    if (mark) mark.addEventListener('click', function () {
      try { localStorage.setItem(KEY, newest); } catch (e) {}
      logRows.forEach(function (r) { r.classList.remove('unseen'); });
      var b = document.getElementById('brain-unseen'); if (b) b.hidden = true;
    });
    // record this visit as seen on unload
    window.addEventListener('pagehide', function () { try { localStorage.setItem(KEY, newest); } catch (e) {} });
  }

  // ---- (3) plan progress: derive each initiative's bar + the overall % from child task status ----
  var inits = Array.prototype.slice.call(document.querySelectorAll('.entry--initiative'));
  if (inits.length) {
    var allDone = 0, allTotal = 0;
    inits.forEach(function (ini) {
      var tasks = Array.prototype.slice.call(ini.querySelectorAll('.task[data-status]'));
      var done = 0, doing = 0, blocked = 0;
      tasks.forEach(function (t) {
        var s = t.getAttribute('data-status');
        if (s === 'done') done++; else if (s === 'doing') doing++; else if (s === 'blocked') blocked++;
      });
      var total = tasks.length; allDone += done; allTotal += total;
      var pct = total ? Math.round(done / total * 100) : 0;
      var bar = ini.querySelector('[data-progress] i'); if (bar) bar.style.width = pct + '%';
      var lab = ini.querySelector('[data-progress-label]'); if (lab) lab.textContent = done + '/' + total + ' · ' + pct + '%';
      var st = (total && done === total) ? 'done' : (blocked && !doing) ? 'blocked' : (doing || done) ? 'active' : 'planned';
      var roll = ini.querySelector('[data-rollup]');
      if (roll) { roll.textContent = st; roll.className = 'badge ' + (st === 'done' ? 'done' : st === 'active' ? 'wip' : st === 'blocked' ? 'open' : 'stub'); }
      ini.setAttribute('data-derived', st);
    });
    var op = allTotal ? Math.round(allDone / allTotal * 100) : 0;
    var ov = document.getElementById('plan-overall'); if (ov) ov.textContent = allDone + '/' + allTotal + ' · ' + op + '%';
    var ob = document.getElementById('plan-overall-bar'); if (ob) ob.style.width = op + '%';
    // per-PHASE rollup — sum tasks across each phase's initiatives (by data-phase, not position)
    ['0', '1'].forEach(function (ph) {
      var pt = Array.prototype.slice.call(document.querySelectorAll('.entry--initiative[data-phase="' + ph + '"] .task[data-status]'));
      var pd = pt.filter(function (t) { return t.getAttribute('data-status') === 'done'; }).length;
      var pp = pt.length ? Math.round(pd / pt.length * 100) : 0;
      var pbar = document.querySelector('[data-phase-progress="' + ph + '"] i'); if (pbar) pbar.style.width = pp + '%';
      var plab = document.querySelector('[data-phase-label="' + ph + '"]'); if (plab) plab.textContent = pd + '/' + pt.length + ' · ' + pp + '%';
    });
  }

  // ---- (4) out-link resolver: brain/ stays publishable anywhere ----
  // Refs to canonical truth (spec · source · meta) are written RELATIVE — link, never copy —
  // so they resolve on disk and whenever the whole repo is served. Deployed DETACHED (a
  // brain/-only static host), they would 404; so: probe once per load for the repo above us
  // (../package.json, name-checked, NO caching — the same origin can serve both modes), and
  // when detached, resolve out-links AT CLICK TIME to the source base named in
  // <meta name="sandpaper:source" content=".../blob/HEAD/" data-pkg="name">.
  // No meta → dim them with a tooltip instead of 404ing. file:// counts as attached (it IS
  // the disk). NOTE: out-of-brain detection must read the RAW href prefix — at a root deploy
  // the URL resolver silently eats "../" at the boundary, so resolved URLs can't tell.
  var me = document.querySelector('script[src*="assets/brain.js"]');
  var ups = me ? ((me.getAttribute('src') || '').match(/\.\.\//g) || []).length : 0; // page depth below the brain root
  var OUT = new Array(ups + 2).join('../'); // (ups+1) ×  "../"  — the prefix that leaves brain/
  var srcMeta = document.querySelector('meta[name="sandpaper:source"]');
  var srcBase = srcMeta ? (srcMeta.getAttribute('content') || '') : '';
  var srcPkg = srcMeta ? (srcMeta.getAttribute('data-pkg') || '') : '';

  function outPath(a) { // the repo-relative path if this anchor leaves brain/, else null
    var h = a.getAttribute('href') || '';
    if (h.slice(0, OUT.length) !== OUT) return null;
    var rest = h.slice(OUT.length);
    return rest.slice(0, 3) === '../' ? null : rest; // above the repo root — unmappable
  }

  var outLinks = Array.prototype.slice.call(document.querySelectorAll('a[href]')).filter(outPath);
  if (outLinks.length && location.protocol !== 'file:') {
    fetch(OUT + 'package.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (j) { if (!j || typeof j.name !== 'string' || (srcPkg && j.name !== srcPkg)) detached(); })
      .catch(detached);
  }

  function detached() {
    document.documentElement.classList.add('brain-detached');
    if (srcBase) {
      outLinks.forEach(function (a) { a.title = 'repo file — opens the copy on the source host'; });
      document.addEventListener('click', rewrite, true);
      document.addEventListener('auxclick', rewrite, true); // middle-click
    } else {
      var block = function (e) { e.preventDefault(); };
      outLinks.forEach(function (a) {
        a.classList.add('ref-detached');
        a.title = 'lives in the repo — open the brain locally (or set the sandpaper:source meta) to follow';
        a.addEventListener('click', block);
        a.addEventListener('auxclick', block);
      });
    }
  }
  // Resolve just-in-time, then RESTORE the raw href: the mutation must live only long enough
  // for the browser's default navigation to read it. A rewrite left in the DOM gets captured
  // by the refine toolbar's edit-in-place and committed to disk — an absolute URL baked into
  // the brain file. Inert when something upstream (the toolbar) already claimed the click.
  function rewrite(e) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var p = outPath(a);
    if (!p) return;
    var raw = a.getAttribute('href');
    a.setAttribute('href', srcBase + p);
    setTimeout(function () { a.setAttribute('href', raw); }, 0);
  }

  // ---- (5) whiteboard fold-fit ----
  // CSS alone can't cap the canvas at the fold — how far down the whiteboard starts depends
  // on the shell + NOW plate above it — so measure: cap = viewport − document offset − a
  // breath. Re-fit on resize and once fonts settle (they shift the offset after first paint).
  var wb = document.querySelector('.whiteboard');
  if (wb) {
    var fit = function () {
      var top = wb.getBoundingClientRect().top + window.pageYOffset;
      wb.style.maxHeight = Math.max(260, window.innerHeight - top - 26) + 'px';
    };
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('load', fit);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) document.fonts.ready.then(fit);
  }
})();
