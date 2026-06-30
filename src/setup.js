// setup.js — the `npx sandpaper` packaging commands: install-skill · init (scaffold) · doctor.
// The plumbing half of Sandpaper (no AI): copy the skill + hooks + design-system templates from
// THIS package into a target repo, write the manifest, and health-check a setup. Zero deps.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, basename, normalize, extname } from 'node:path';

const ok = (m) => console.log('  ✓ ' + m);
const warn = (m) => console.log('  · ' + m);
const bad = (m) => console.log('  ✗ ' + m);

const ensureDir = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); };
const copyDirFiles = (srcDir, dstDir, skipExisting = false) => {
  ensureDir(dstDir);
  let n = 0;
  for (const f of readdirSync(srcDir)) {
    const s = join(srcDir, f);
    if (!statSync(s).isFile()) continue;
    const d = join(dstDir, f);
    if (skipExisting && existsSync(d)) continue; // never clobber a user's customised file
    copyFileSync(s, d); n++;
  }
  return n;
};
const projectName = (target) => {
  try { return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name || basename(target); }
  catch { return basename(target); }
};
const today = () => new Date().toISOString().slice(0, 10);

// ---- install-skill: make /sandpaper:* available + wire the auto-update hooks (use --no-hooks to skip) ----
const HOOKS = [
  ['SessionStart', 'node .sandpaper/hooks/brain-inject.js', 10],
  ['Stop', 'node .sandpaper/hooks/brain-stamp-check.js', 20],
];
const hooksSnippet = () => JSON.stringify({ hooks: Object.fromEntries(HOOKS.map(([e, c, t]) =>
  [e, [{ matcher: '*', hooks: [{ type: 'command', command: c, timeout: t }] }]])) }, null, 2)
  .split('\n').map((l) => '    ' + l).join('\n');

// merge our hooks into the target's .claude/settings.json — preserve existing settings, dedupe by command
function wireHooks(target) {
  const sp = join(target, '.claude', 'settings.json');
  let s = {};
  if (existsSync(sp)) { try { s = JSON.parse(readFileSync(sp, 'utf8')); } catch { return { ok: false, reason: '.claude/settings.json exists but is not valid JSON — left it untouched' }; } }
  s.hooks = s.hooks || {};
  let added = 0;
  for (const [evt, cmd, to] of HOOKS) {
    s.hooks[evt] = s.hooks[evt] || [];
    const present = s.hooks[evt].some((g) => (g.hooks || []).some((h) => h.command === cmd));
    if (!present) { s.hooks[evt].push({ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: to }] }); added++; }
  }
  try { ensureDir(dirname(sp)); writeFileSync(sp, JSON.stringify(s, null, 2) + '\n'); return { ok: true, added }; }
  catch (e) { return { ok: false, reason: 'could not write .claude/settings.json (' + e.message + ')' }; }
}

export function installSkill(target, pkg, opts = {}) {
  console.log(`\n  🪵  Installing the Sandpaper skill into ${target}\n`);
  const nCmds = copyDirFiles(join(pkg, 'skill', 'sandpaper', 'commands'), join(target, '.claude', 'commands', 'sandpaper'));
  ok(`${nCmds} commands → .claude/commands/sandpaper/  (use them as /sandpaper:<name>)`);
  const hookDir = join(target, '.sandpaper', 'hooks');
  ensureDir(hookDir);
  for (const h of ['brain-inject.js', 'brain-stamp-check.js']) copyFileSync(join(pkg, 'bin', h), join(hookDir, h));
  ok('2 hooks → .sandpaper/hooks/');
  if (opts.noHooks) {
    warn('--no-hooks: skipped wiring the auto-update hooks. To enable later, add to .claude/settings.json:');
    console.log('\n' + hooksSnippet());
  } else {
    const r = wireHooks(target);
    if (r.ok) ok(r.added ? 'auto-update hooks wired into .claude/settings.json  (delete them there, or re-run with --no-hooks, to disable)' : 'auto-update hooks already wired');
    else { warn(r.reason + ' — add this by hand:'); console.log('\n' + hooksSnippet()); }
  }
  // Scaffold the brain from THIS package now, so /sandpaper:init has the design-system assets
  // LOCALLY and never has to hunt the filesystem for a reference brain. scaffold prints its own
  // "Next: …" closing.
  scaffold(target, pkg);
}

// ---- init: scaffold brain/ (assets + manifest + a starter cover) — the mechanical part ----
export function scaffold(target, pkg) {
  console.log(`\n  🪵  Scaffolding brain/ in ${target}\n`);
  const brain = join(target, 'brain');
  const nA = copyDirFiles(join(pkg, 'brain', 'assets'), join(brain, 'assets'), true); // never clobber a user's skin
  ok(nA ? `brain/assets/ ← ${nA} design-system file(s)` : 'brain/assets/ already present — kept your customised skin');
  const project = projectName(target), date = today();
  ensureDir(join(target, '.sandpaper'));
  const manPath = join(target, '.sandpaper', 'manifest.json');
  if (existsSync(manPath)) warn('.sandpaper/manifest.json exists — kept (preserves the id counters)');
  else {
    writeFileSync(manPath, JSON.stringify({
      version: 1, project, created: date, theme: 'brain/assets/theme.css',
      port: 4848, // `npx sandpaper open` starts here (auto-bumps if taken); pin a distinct one per repo
      lenses: ['product', 'engineering', 'project'], books: ['log', 'decisions', 'learnings'],
      cidPrefixes: { worklog: 'w', task: 't', decision: 'd', learning: 'l', initiative: 'i' },
      counters: { w: 1, t: 0, d: 0, l: 0, i: 0 },
    }, null, 2) + '\n');
    ok('.sandpaper/manifest.json (id counters · cid prefixes · theme path)');
  }
  const cover = join(brain, 'index.html');
  if (existsSync(cover)) warn('brain/index.html exists — leaving it (delete to re-scaffold)');
  else { writeFileSync(cover, starterCover(project, date)); ok('brain/index.html (a starter cover)'); }
  console.log('\n  Next: run /sandpaper:init in Claude Code to harvest this repo and fill the brain.\n');
}

// ---- doctor: health-check a Sandpaper setup ----
export function doctor(target) {
  console.log(`\n  🪵  Sandpaper doctor — ${target}\n`);
  let problems = 0;
  const brain = join(target, 'brain');
  if (!existsSync(brain)) { bad('no brain/ — run `npx sandpaper init` (then /sandpaper:init)'); return finish(1); }
  ok('brain/ exists');
  for (const a of ['theme.css', 'brain.css', 'brain.js']) {
    if (existsSync(join(brain, 'assets', a))) ok(`assets/${a}`); else { bad(`missing assets/${a}`); problems++; }
  }
  try {
    const css = readFileSync(join(brain, 'assets', 'brain.css'), 'utf8');
    if (/@import\s+["']theme\.css/.test(css)) ok('brain.css @imports theme.css'); else warn('brain.css does not @import theme.css — re-skins may not propagate');
  } catch {}
  try {
    const h = readFileSync(join(brain, 'index.html'), 'utf8');
    const m = h.match(/id="brain-state">([\s\S]*?)<\/script>/);
    if (m) { JSON.parse(m[1]); ok('#brain-state digest parses'); } else { warn('cover has no #brain-state digest'); }
  } catch { bad('brain/index.html unreadable'); problems++; }
  const broken = checkLinks(brain);
  if (broken === 0) ok('internal links resolve'); else { bad(`${broken} broken internal link(s)`); problems++; }
  const man = join(target, '.sandpaper', 'manifest.json');
  if (existsSync(man)) { try { JSON.parse(readFileSync(man, 'utf8')); ok('.sandpaper/manifest.json valid'); } catch { bad('manifest.json invalid JSON'); problems++; } }
  else warn('no .sandpaper/manifest.json — run `npx sandpaper init`');
  if (existsSync(join(target, '.sandpaper', 'hooks', 'brain-stamp-check.js'))) ok('hooks present (.sandpaper/hooks/)'); else warn('hooks not installed — run `npx sandpaper install-skill`');
  finish(problems);
  function finish(p) { console.log(`\n  ${p ? '✗ ' + p + ' problem(s).' : '✓ healthy.'}\n`); process.exitCode = p ? 1 : 0; }
}

// ---- upgrade: bring an EXISTING brain up to the current package (assets · hooks · commands · the canvas) ----
export function upgrade(target, pkg) {
  console.log(`\n  🪵  Upgrading Sandpaper in ${target}\n`);
  const brain = join(target, 'brain');
  if (!existsSync(brain)) { bad('no brain/ here — this upgrades an existing brain. Run `npx sandpaper init` first.'); process.exitCode = 1; return; }

  // 1. commands + hooks → latest (idempotent; this is how board-first reaches an old install)
  const nCmds = copyDirFiles(join(pkg, 'skill', 'sandpaper', 'commands'), join(target, '.claude', 'commands', 'sandpaper'));
  ok(`${nCmds} commands refreshed → .claude/commands/sandpaper/`);
  const hookDir = join(target, '.sandpaper', 'hooks');
  ensureDir(hookDir);
  for (const h of ['brain-inject.js', 'brain-stamp-check.js']) copyFileSync(join(pkg, 'bin', h), join(hookDir, h));
  ok('2 hooks refreshed → .sandpaper/hooks/');
  const wr = wireHooks(target);
  if (wr.ok) ok(wr.added ? 'auto-update hooks wired into .claude/settings.json' : 'auto-update hooks already wired');
  else warn(wr.reason);

  // 2. engine assets → latest brain.css + brain.js (these carry the canvas styles); PRESERVE theme.css (the skin)
  const aSrc = join(pkg, 'brain', 'assets'), aDst = join(brain, 'assets');
  ensureDir(aDst);
  for (const a of ['brain.css', 'brain.js']) {
    if (existsSync(join(aSrc, a))) { copyFileSync(join(aSrc, a), join(aDst, a)); ok(`assets/${a} → latest`); }
  }
  if (existsSync(join(aDst, 'theme.css'))) warn('assets/theme.css kept — it is your skin (delete it + re-run to take the shipped one)');
  else if (existsSync(join(aSrc, 'theme.css'))) { copyFileSync(join(aSrc, 'theme.css'), join(aDst, 'theme.css')); ok('assets/theme.css added'); }

  // 3. inject the canvas region into the cover if it predates the canvas
  const r = ensureCanvas(join(brain, 'index.html'));
  if (r.had) ok('cover already hosts the canvas');
  else if (r.injected) ok(`canvas added to the cover (${r.anchor})`);
  else { warn('couldn\'t find a safe spot to add the canvas — paste this into brain/index.html just below the NOW plate:'); console.log('\n' + canvasSection() + '\n'); }

  console.log('\n  Upgraded. `npx sandpaper open` to view; start a FRESH Claude Code session for the board-first canvas.\n');
}

// The canvas section (empty state) — shared by the scaffold's starter cover and `upgrade`.
function canvasSection() {
  return `  <section class="canvas" id="s-canvas" data-cid="s-canvas" aria-label="Canvas">
    <div class="canvas-rail"><div class="eyebrow">Canvas <span class="canvas-sub">— the current summary, elevated</span></div></div>
    <!-- BRAIN:CANVAS — the current board lives in .whiteboard; older ones fold into .canvas-earlier below -->
    <div class="whiteboard" data-cid="whiteboard">
      <p class="canvas-empty" data-cid="canvas-empty">The canvas is clear. When Claude works through something
        substantial — an architecture, a comparison, a walkthrough, the summary of a turn — the elevated
        version lands here, live.</p>
    </div>
    <!-- /BRAIN:CANVAS -->
  </section>`;
}

// Add the canvas section to an existing cover that lacks it. Best-effort: try a few stable anchors.
function ensureCanvas(coverPath) {
  let html;
  try { html = readFileSync(coverPath, 'utf8'); } catch { return { injected: false }; }
  if (html.includes('BRAIN:CANVAS') || html.includes('class="whiteboard"')) return { had: true };
  const section = canvasSection();
  // ordered anchors: just after the NOW plate, else above the doors / first section
  const anchors = [
    { find: '<!-- /BRAIN:EDITION -->', after: true, name: 'below the NOW plate' },
    { find: '<nav class="doors"', after: false, name: 'above the lens doors' },
    { find: '<section class="zone"', after: false, name: 'above the first section' },
    { find: '</header>', after: true, name: 'below the header' },
  ];
  for (const a of anchors) {
    const i = html.indexOf(a.find);
    if (i < 0) continue;
    const pos = a.after ? i + a.find.length : i;
    const out = html.slice(0, pos) + (a.after ? '\n' + section : section + '\n  ') + html.slice(pos);
    try { writeFileSync(coverPath, out); return { injected: true, anchor: a.name }; } catch { return { injected: false }; }
  }
  return { injected: false };
}

// walk brain/*.html, return count of broken internal href/src (file missing or #anchor absent)
function checkLinks(brain) {
  const pages = [];
  (function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (extname(p) === '.html') pages.push(p); } })(brain);
  let bad = 0;
  for (const p of pages) {
    const html = readFileSync(p, 'utf8'), dir = dirname(p);
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const hr = m[1];
      if (/^(https?:|#|mailto:|data:)/.test(hr)) continue;
      const [path, anchor] = hr.split('#');
      const t = normalize(join(dir, path.endsWith('/') ? path + 'index.html' : path));
      if (!existsSync(t)) { bad++; continue; }
      if (anchor) { const x = readFileSync(t, 'utf8'); if (!x.includes(`id="${anchor}"`) && !x.includes(`name="${anchor}"`)) bad++; }
    }
  }
  return bad;
}

function starterCover(project, date) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${project} — brain</title>
<link rel="stylesheet" href="./assets/brain.css" />
<script type="application/json" id="brain-state">
{ "v":1, "project":"${project}", "phase":"fresh", "updated":"${date}", "session":"S01",
  "focus":{ "one":"Brain scaffolded — run /sandpaper:init in Claude to harvest this repo and fill it", "ref":"#" },
  "worklog":[ {"date":"${date}","one":"Brain scaffolded by npx sandpaper init","cid":"w-0001"} ],
  "open":[], "docs":[] }
</script>
</head>
<body>
<div class="wrap">
  <header class="plate" data-cid="cover" style="margin-top:32px">
    <div class="pl-meta">Fresh brain · stamped ${date}</div>
    <p class="now-line" data-cid="now" data-kind="now">Run <code>/sandpaper:init</code> in Claude Code to harvest this
      repository and fill the brain — it will discover your code, specs, and docs, ask a few questions, then
      generate the cover, the plan board, and the books.</p>
  </header>
${canvasSection()}
  <section class="zone"><div class="eyebrow">Next</div>
    <p class="muted">Once filled, <code>npx sandpaper open</code> serves this with the on-page refine toolbar.</p>
  </section>
</div>
<script src="./assets/brain.js" defer></script>
</body>
</html>
`;
}
