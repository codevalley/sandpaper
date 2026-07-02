// sandpaper.sh — the self-stamping demo + small page behaviors. Zero dependencies.
(function () {
  'use strict';
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js'); // gates demo-line hiding; without JS everything is visible

  // ---- copy-to-clipboard on the install chips (announced, and honest about failure) ----
  var status = document.createElement('span');
  status.setAttribute('role', 'status');
  status.className = 'sr-only';
  document.body.appendChild(status);
  document.querySelectorAll('.install').forEach(function (btn) {
    var chip = btn.querySelector('.install-copy');
    btn.addEventListener('click', function () {
      var cmd = btn.getAttribute('data-copy');
      var done = function () {
        btn.classList.add('copied');
        chip.textContent = 'copied';
        status.textContent = 'Install command copied to clipboard';
        setTimeout(function () { btn.classList.remove('copied'); chip.textContent = 'copy'; }, 1600);
      };
      var failed = function () { // no false "copied": select the text so a manual copy works
        var r = document.createRange();
        r.selectNodeContents(btn.querySelector('.install-cmd'));
        var s = getSelection(); s.removeAllRanges(); s.addRange(r);
        chip.textContent = 'press ⌘C';
        status.textContent = 'Command selected — press Control or Command C to copy';
        setTimeout(function () { chip.textContent = 'copy'; }, 2600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(cmd).then(done, failed);
      else failed();
    });
  });

  // ---- reveal-on-scroll (one gentle pass per band) ----
  // the hidden initial state is scoped to html.js-reveal — set only when we will actually reveal
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0, rootMargin: '0px 0px -8% 0px' }) : null;
  if (io && !reduced) {
    document.documentElement.classList.add('js-reveal');
    document.querySelectorAll('.band .wrap').forEach(function (w) { io.observe(w); });
  }

  // ---- the demo: a working turn becomes a stamped brain (re-enacts entry w-0193) ----
  var demo = document.getElementById('demo');
  if (!demo) return;
  var ttype = document.getElementById('ttype');
  var steps = demo.querySelectorAll('.tline[data-step]');
  var bnow = document.getElementById('bnow');
  var blog = document.getElementById('blog');
  var bbar = document.getElementById('bbar');
  var bcount = document.getElementById('bcount');
  var chip = document.getElementById('stampchip');
  var USER_LINE = 'ship it — create the public repo and push';
  var NOW_BEFORE = 'Install flow bullet-proofed — ready for the GitHub-push go.';
  var NOW_AFTER = 'Sandpaper is public — install verified; dogfooding starts.';
  var NEW_ROW = { when: '07-02', what: 'Sandpaper is PUBLIC — repo live, install verified' };
  var timers = [];
  var running = false;

  function after(ms, fn) { timers.push(setTimeout(fn, ms)); }

  function finalState() {
    ttype.textContent = USER_LINE;
    steps.forEach(function (s) { s.classList.add('on'); });
    bnow.textContent = NOW_AFTER;
    prependRow(false);
    bbar.style.width = '77%'; bcount.textContent = '27/35';
    chip.classList.add('on');
  }

  function makeRow(when, what, cls) {
    var li = document.createElement('li');
    li.className = cls || 'brow';
    var w = document.createElement('span'); w.className = 'bwhen'; w.textContent = when;
    var t = document.createElement('span'); t.className = 'bwhat'; t.textContent = what;
    li.appendChild(w); li.appendChild(t);
    return li;
  }

  function prependRow(animated) {
    if (blog.querySelector('.brow--new, .brow--new-still')) return;
    blog.insertBefore(makeRow(NEW_ROW.when, NEW_ROW.what, 'brow ' + (animated ? 'brow--new' : 'brow--new-still')), blog.firstChild);
    if (blog.children.length > 3) blog.removeChild(blog.lastElementChild); // hold 3 rows — the stamp is an in-place swap, zero layout shift
  }

  function reset() {
    ttype.textContent = '';
    steps.forEach(function (s) { s.classList.remove('on'); });
    demo.classList.remove('stamping');
    chip.classList.remove('on');
    var fresh = blog.querySelector('.brow--new, .brow--new-still');
    if (fresh) blog.removeChild(fresh);
    if (blog.children.length < 3) blog.appendChild(makeRow('07-01', 'Decided: entries link to source, never copy it'));
    bnow.textContent = NOW_BEFORE; bnow.classList.remove('swap');
    bbar.style.width = '74%'; bcount.textContent = '26/35';
  }

  function play() {
    if (running) return;
    running = true;
    reset();
    // 1 · the human types
    var i = 0;
    var typer = setInterval(function () {
      ttype.textContent = USER_LINE.slice(0, ++i);
      if (i >= USER_LINE.length) clearInterval(typer);
    }, 42);
    timers.push(typer);
    // 2 · the agent works
    after(2600, function () { steps[0].classList.add('on'); });
    after(3800, function () { steps[1].classList.add('on'); });
    after(4900, function () { steps[2].classList.add('on'); });
    // 3 · the stamp lands
    after(5700, function () { demo.classList.add('stamping'); });
    after(6400, function () {
      bnow.classList.add('swap');
      after(360, function () { bnow.textContent = NOW_AFTER; bnow.classList.remove('swap'); });
      prependRow(true);
      bbar.style.width = '77%'; bcount.textContent = '27/35';
      chip.classList.add('on');
    });
    // 4 · hold, then loop
    after(13500, function () { running = false; play(); });
  }

  function stop() {
    timers.forEach(clearTimeout); timers = [];
    running = false;
  }

  if (reduced) { finalState(); return; }

  // run only while the hero is on screen
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) play(); else { stop(); } });
    }, { threshold: 0.25 }).observe(demo);
  } else play();
})();
