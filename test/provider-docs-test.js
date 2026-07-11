import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

const PUBLIC_FILES = [
  'README.md',
  'bin/cli.js',
  'site/index.html',
  'sandpaper.html',
  'engg-spec.html',
];

const CURRENT_BRAIN_FILES = [
  'brain/index.html',
  'brain/map.html',
  'brain/product/index.html',
  'brain/engineering/index.html',
  'brain/project/index.html',
  'brain/wiki/architecture.html',
  'brain/wiki/index.html',
  'brain/wiki/overview.html',
  'brain/wiki/product.html',
  'brain/wiki/rationale.html',
  'brain/learnings.html',
];

function assertContains(file, patterns) {
  const source = read(file);
  for (const pattern of patterns) assert.match(source, pattern, `${file} is missing ${pattern}`);
}

function elementById(file, tag, id) {
  const source = read(file);
  const idAt = source.indexOf(`id="${id}"`);
  assert.notEqual(idAt, -1, `${file} is missing #${id}`);
  const start = source.lastIndexOf(`<${tag}`, idAt);
  const end = source.indexOf(`</${tag}>`, idAt);
  assert.ok(start >= 0 && end >= idAt, `${file} has malformed #${id}`);
  return source.slice(start, end + tag.length + 3);
}

test('all current public surfaces name both providers and both workflow syntaxes', () => {
  for (const file of PUBLIC_FILES) {
    assertContains(file, [
      /Claude Code/,
      /Codex/,
      /\/sandpaper:&lt;action&gt;|\/sandpaper:<action>|\/sandpaper:<code>&lt;action&gt;<\/code>/,
      /\$sandpaper(?: |&nbsp;|<code>).*action|\$sandpaper &lt;action&gt;|\$sandpaper <action>/,
    ]);
  }
});

test('public product truth covers installation, selection, sessions, auth, usage, and safety', () => {
  assertContains('README.md', [
    /both (?:Claude Code and Codex )?integrations[^.\n]{0,40}by default/i,
    /--integration claude/,
    /--integration codex/,
    /launch-only override/i,
    /tab-local selection/i,
    /Make default/,
    /codex login/,
    /saved authentication/i,
    /does not prompt for an API key/i,
    /Claude[^\n]{0,180}cost[^\n]{0,180}supplied/i,
    /Codex[^\n]{0,180}total tokens[^\n]{0,180}supplied/i,
    /neither[^\n]{0,120}(?:estimate|convert)/i,
    /directory-level write (?:access|ability)/i,
    /best-effort[^\n]{0,180}external/i,
    /cannot (?:verify|be verified)[^\n]{0,120}(?:undo|undone)/i,
    /no silent fallback/i,
    /no hidden context handoff/i,
    /page\/provider-scoped resumable sessions/i,
    /project\/page\/provider-scoped browser transcripts/i,
    /server success/i,
    /actual selected-document\s+bytes/i,
  ]);

  for (const file of ['site/index.html', 'sandpaper.html']) {
    assertContains(file, [
      /both (?:first-class )?providers|Claude Code and Codex/i,
      /Make default/i,
      /no silent fallback/i,
      /no hidden\s+context handoff/i,
      /directory-level write (?:access|ability)/i,
      /best-effort/i,
      /server[^<\n]{0,100}(?:bytes|hash)/i,
    ]);
  }
});

test('engineering spec records the exact provider protocol and ownership model', () => {
  assertContains('engg-spec.html', [
    /\{projectId, initialProvider, defaultProvider, providers\[\]\}/,
    /\{prompt, page, provider\}/,
    /202[^<\n]{0,100}\{ok:true, turnId, provider\}/,
    /provider-tagged[^<\n]{0,160}status[^<\n]{0,80}assistant_delta[^<\n]{0,80}edit[^<\n]{0,80}usage[^<\n]{0,80}lifecycle/i,
    /POST <code>\/__sandpaper\/provider-default<\/code>/,
    /POST <code>\/__sandpaper\/session\/reset<\/code>/,
    /X-Sandpaper-Token/,
    /X-Sandpaper-Client/,
    /global[^<\n]{0,80}409[^<\n]{0,80}turn_in_progress/i,
    /\{id, label, diagnose, runTurn\}/,
    /internal static registry/i,
    /validation before reservation/i,
    /one server-owned global turn lifecycle/i,
    /no silent fallback/i,
    /not shipped in <code>v0\.3\.0<\/code>/i,
    /versioned, trusted provider-plugin/i,
  ]);

  const schemas = elementById('engg-spec.html', 'div', 'frame-schemas');
  for (const exact of [
    "{type:'lifecycle',busy,turnId,provider,page}",
    "{type:'status',state,label,turnId,provider,page,phase,changed?,undoable?,cost?}",
    "{type:'assistant_delta',kind,text,turnId,provider,page,phase}",
    "{type:'edit',provider:'claude',turnId,page,phase,file?,added?,removed?,hunks?:[{oldText,newText}],cids?:[]}",
    "{type:'edit',provider:'codex',turnId,page,phase,file,paths:[{path,kind}]}",
    "{type:'usage',provider:'codex',turnId,page,phase,inputTokens?,cachedInputTokens?,outputTokens?,totalTokens?}",
    "{type:'status',state:'idle',label:'idle'}",
  ]) assert.match(schemas, new RegExp(exact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(schemas, /lifecycle frames never carry <code>phase<\/code>/i);
  assert.doesNotMatch(schemas, /type:'lifecycle'[^\n]*phase/);
  assert.match(schemas, /Claude[^<\n]{0,100}cost[^<\n]{0,100}supplied terminal/i);
  assert.match(schemas, /Codex[^<\n]{0,100}no fabricated hunks/i);
});

test('cover has one truthful current board while preserving board 0011 as dated evidence', () => {
  const source = read('brain/index.html');
  const current = source.match(/<(?:article|details)[^>]*class="[^"]*\bboard--live\b[^"]*"[^>]*data-status="current"/g) || [];
  assert.equal(current.length, 1);

  const latest = elementById('brain/index.html', 'article', 'board-0012');
  assert.match(latest, /class="board board--live"/);
  assert.match(latest, /data-status="current"/);
  for (const anchor of [
    /Claude Code/, /Codex/, /explicit provider selection/i, /no silent fallback/i,
    /page\/provider-scoped resume/i, /project\/page\/provider transcript/i, /New session/,
    /one global lifecycle/i, /selected-document bytes/i, /best-effort external-path warning/i,
    /58-file/, /334 unit/, /101 Chromium/,
  ]) assert.match(latest, anchor);

  const historical = elementById('brain/index.html', 'article', 'board-0011');
  assert.match(historical, /class="board board--past"/);
  assert.match(historical, /data-status="past"/);
  assert.match(historical, /Historical snapshot/);
  const bodyStart = historical.indexOf('<div class="board-body">');
  const bodyEnd = historical.indexOf('\n        <footer class="board-foot">', bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart);
  const bodyHash = createHash('sha256').update(historical.slice(bodyStart, bodyEnd)).digest('hex');
  assert.equal(bodyHash, '2bf016d56ac350c4ffec64e473e84e7a626e2e13ee62a3a8c8239c7fb4954f80');
  assert.match(source, /data-cid="canvas-count">6 boards<\/span>/);
});

test('current status demo never invents provider model, context, permission, retry, or usage', () => {
  const status = elementById('sandpaper.html', 'section', 's-status')
    + elementById('sandpaper.html', 'script', 'status-demo-script');
  assert.match(status, /Claude Code[^\n]{0,160}supplied cost[^\n]{0,80}\$0\.0400/i);
  assert.match(status, /Codex[^\n]{0,160}supplied total[^\n]{0,80}1,842 tokens/i);
  assert.match(status, /tool_using/);
  assert.doesNotMatch(status, /Opus|context\s*(?:<[^>]+>)*\d+%|auto-retry|retrying|rate limit|permission|data-st="waiting"|\$<b>|\$0\.07/i);
});

test('CLI help describes the completed dual-provider toolbar without stale wave copy', () => {
  const source = read('bin/cli.js');
  assert.match(source, /tab-local provider selection/i);
  assert.match(source, /Make default/);
  assert.match(source, /New session/);
  assert.doesNotMatch(source, /toolbar still dispatches Claude|remaining v0\.3\.0 wave/i);
});

test('stale Claude-only roadmap claims are absent from current truth surfaces', () => {
  const stale = /current UI is Claude-only|current Claude-only toolbar|Codex planned|Codex is planned|first-class Codex (?:execution|support)[^.<]{0,100}(?:planned|remain)|remaining (?:the )?(?:v0\.3\.0 )?Toolbar Wave|toolbar still dispatches (?:turns through )?Claude/i;
  for (const file of [...PUBLIC_FILES, ...CURRENT_BRAIN_FILES]) {
    assert.doesNotMatch(read(file), stale, `${file} retains stale current-state provider copy`);
  }
});

test('selected historical Claude-specific evidence remains byte-for-byte present', () => {
  assert.match(read('brain/log.html'), /id="w-0173"[\s\S]*?Toolbar nits — the head reads <code>● Claude&nbsp;Code · idle<\/code> \(reads as a tool, not a person\), and the <code>⌖\/✎<\/code> glyphs became crisp centred stroke SVGs \(the crosshair was off-centre and muddy\)\./);
  assert.match(read('brain/decisions.html'), /id="d-stabilize-before-codex"[\s\S]*?Ship a risk-based <code>v0\.2\.1<\/code> sweep before first-class provider support in <code>v0\.3\.0<\/code>\./);
  assert.match(read('brain/index.html'), /data-cid="w-0176"[\s\S]*?wired the SessionStart <strong>handoff<\/strong> so Claude Code uses it\. Dogfood board 002\./);
});

test('brain stamp completes implementation once while leaving release open', () => {
  const project = read('brain/project/index.html');
  assert.match(project, /<li[^>]*data-status="done"[^>]*id="t-0049"/);
  assert.match(project, /<li[^>]*data-status="todo"[^>]*id="t-0050"/);

  const worklog = /id="w-0232"[^>]*[\s\S]*?Completed and reviewed the first-class Claude and Codex toolbar and documentation\./g;
  assert.equal((read('brain/log.html').match(worklog) || []).length, 1);
  assert.equal((read('brain/index.html').match(worklog) || []).length, 1);
  assert.match(read('brain/index.html'), /"focus":\{ "one":"Release qualification for v0\.3\.0 is next\."/);
  assert.match(read('brain/index.html'), /id="now"[^>]*>Release qualification for <code>v0\.3\.0<\/code> is next\./);
});

test('the provider docs contract is part of the default unit inventory', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.match(manifest.scripts['test:unit'], /(?:^|\s)test\/provider-docs-test\.js(?:\s|$)/);
});
