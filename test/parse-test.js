// parse-test.js — exercises the stream-json → typed-frame mapping on a recorded sample.
// Run: node test/parse-test.js   (no live model call; pure parser verification.)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapEvents, getSessionId } from '../src/claude.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(HERE, 'stream-sample.jsonl'), 'utf8').split('\n').filter(Boolean);

const frames = [];
let sessionId = null;
for (const line of lines) {
  const ev = JSON.parse(line);
  const id = getSessionId(ev);
  if (id) sessionId = id;
  for (const f of mapEvents(ev, 'spec.html')) frames.push(f);
}

const states = frames.filter((f) => f.type === 'status').map((f) => f.state);
const deltas = frames.filter((f) => f.type === 'assistant_delta');
const edits = frames.filter((f) => f.type === 'edit');
const done = frames.find((f) => f.type === 'status' && f.state === 'done');

const fails = [];
const expect = (cond, msg) => { if (!cond) fails.push(msg); };

expect(sessionId === 'sess-test-001', `session id captured (got ${sessionId})`);
expect(states[0] === 'init', `first status is init (got ${states[0]})`);
expect(states.includes('thinking'), 'has a thinking status');
expect(states.includes('editing'), 'has an editing status (Edit tool_use)');
expect(states[states.length - 1] === 'done', `last status is done (got ${states[states.length - 1]})`);

// the core fix: assistant text + thinking are no longer dropped
expect(deltas.some((d) => d.kind === 'text' && /Tightening/.test(d.text)), 'streams assistant TEXT (was the bug)');
expect(deltas.some((d) => d.kind === 'thinking'), 'streams a THINKING delta');

// edit summary is extracted from the complete assistant message
expect(edits.length === 1, `exactly one edit frame (got ${edits.length})`);
expect(edits[0] && edits[0].file === 'spec.html', 'edit names the file');
expect(edits[0] && edits[0].hunks.length === 1 && /Welcome/.test(edits[0].hunks[0].newText), 'edit carries the new text');
expect(edits[0] && edits[0].cids.includes('h7'), 'edit extracts data-cid "h7"');
expect(edits[0] && edits[0].added > 0 && edits[0].removed > 0, 'edit has +/- line counts');

// turn-end status carries cost (toolbar derives Replied vs Saved from edit count)
expect(done && done.cost === 0.0123, `done status carries cost (got ${done && done.cost})`);

console.log('states:', states.join(' → '));
console.log(`deltas: ${deltas.length} | edits: ${edits.length} | edit.cids: ${edits[0] && edits[0].cids.join(',')}`);
if (fails.length) {
  console.error('\nFAILED:');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ all parser checks passed');
