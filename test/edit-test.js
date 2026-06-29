// edit-test.js — the direct-edit HTML slicer. Run via `npm test`.
import { strict as assert } from 'node:assert';
import { innerRange, replaceInner } from '../src/edit.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓', name); };

ok('replaces a simple element by data-cid', () => {
  const html = '<p data-cid="x">old text</p>';
  assert.equal(replaceInner(html, 'x', 'new text'), '<p data-cid="x">new text</p>');
});

ok('leaves the rest of the file byte-for-byte', () => {
  const html = '<header>\n  <h1 data-cid="t">Title</h1>\n  <p>kept</p>\n</header>';
  assert.equal(replaceInner(html, 't', 'Edited'),
    '<header>\n  <h1 data-cid="t">Edited</h1>\n  <p>kept</p>\n</header>');
});

ok('handles attributes after data-cid', () => {
  const html = '<li data-cid="w-01" class="row" data-kind="worklog">stuff</li>';
  assert.equal(replaceInner(html, 'w-01', 'X'),
    '<li data-cid="w-01" class="row" data-kind="worklog">X</li>');
});

ok('counts NESTED same-name tags to find the right close', () => {
  const html = '<div data-cid="x"><div class="inner">a</div>tail</div><div>sibling</div>';
  // must replace the OUTER div's content, not stop at the inner </div>
  assert.equal(replaceInner(html, 'x', 'Z'),
    '<div data-cid="x">Z</div><div>sibling</div>');
});

ok('preserves inner markup when the new content carries it', () => {
  const html = '<li data-cid="r"><span class="when">06-29</span><span class="what">old</span></li>';
  const next = '<span class="when">06-29</span><span class="what">new wording</span>';
  assert.equal(replaceInner(html, 'r', next),
    '<li data-cid="r">' + next + '</li>');
});

ok('skips a data-cid mention in PROSE and hits the real element', () => {
  // a doc that documents the grammar in text, then uses it for real
  const html = '<p>the data-cid="r" attribute is the anchor</p><span data-cid="r">real</span>';
  assert.equal(replaceInner(html, 'r', 'EDITED'),
    '<p>the data-cid="r" attribute is the anchor</p><span data-cid="r">EDITED</span>');
});

ok('skips a data-cid mention inside an HTML comment', () => {
  const html = '<!-- stamp the now-line: data-cid="n" --><p data-cid="n">live</p>';
  assert.equal(replaceInner(html, 'n', 'fresh'),
    '<!-- stamp the now-line: data-cid="n" --><p data-cid="n">fresh</p>');
});

ok('returns null for an unknown cid', () => {
  assert.equal(replaceInner('<p data-cid="a">x</p>', 'b', 'y'), null);
});

ok('returns null for a void / self-closing element (no inner content)', () => {
  assert.equal(replaceInner('<img data-cid="i" src="a.png">', 'i', 'x'), null);
  assert.equal(replaceInner('<hr data-cid="h"/>', 'h', 'x'), null);
});

ok('innerRange reports correct offsets', () => {
  const html = 'AB<p data-cid="x">CD</p>EF';
  const r = innerRange(html, 'x');
  assert.equal(html.slice(r.start, r.end), 'CD');
  assert.equal(r.tag, 'p');
});

console.log('\nedit-test: ' + n + ' assertions passed.');
