// brain.js — zero-dependency, no-fetch, file://-safe enhancements for the project brain.
// (1) Live-DOM search/filter over .entry blocks.  (2) "Since you last looked" on the log.
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
        e.classList.toggle('hidden', !show);
        if (show) shown++;
      });
      if (note) note.textContent = (term || activeFacet) ? (shown + ' shown') : '';
    }
    q.addEventListener('input', apply);
    facetEls.forEach(function (f) {
      f.addEventListener('click', function () {
        var val = f.getAttribute('data-facet') || '';
        activeFacet = (activeFacet === val) ? '' : val;
        facetEls.forEach(function (x) { x.classList.toggle('on', x === f && activeFacet); });
        apply();
      });
    });
    // press "/" to focus search
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    });
  }

  // ---- (2) "since you last looked" on the log ----
  var logRows = Array.prototype.slice.call(document.querySelectorAll('.timeline li[data-cid], .entry--worklog[data-cid]'));
  if (logRows.length) {
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
})();
