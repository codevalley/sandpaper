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
        var hay = (e.textContent + ' ' + (e.getAttribute('data-tags') || '') + ' ' + (e.getAttribute('data-kind') || '') + ' ' + (e.getAttribute('data-status') || '')).toLowerCase();
        var okTerm = !term || hay.indexOf(term) >= 0;
        var okFacet = !activeFacet || e.getAttribute('data-kind') === activeFacet || e.getAttribute('data-status') === activeFacet;
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
})();
