// markdown-test.js — exercises the pure markdown parser on a real, table-heavy reply.
// Run: node test/markdown-test.js   (no DOM; pure parse/tokenize checks.)
import { parseMarkdown, tokenizeInline } from '../public/sp-markdown.js';

const sample = [
  'What changed and why each serves the *concept* rather than decoration:',
  '',
  '| Element | Before | After | Concept it clarifies |',
  '|---|---|---|---|',
  '| Arrows (×2) | `⇄` bidirectional | `→` directional | Establishes a readable **flow direction**. |',
  '| `foundation` | "the file on disk" | "the one file all three read & write" | Makes the file the **hub**. |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '- first item',
  '- second `code` item',
  'Final line with **bold** and `inline` and a [link](https://example.com).',
].join('\n');

const blocks = parseMarkdown(sample);
const fails = [];
const expect = (c, m) => { if (!c) fails.push(m); };

const table = blocks.find((b) => b.type === 'table');
expect(table, 'parses a GFM table');
expect(table && table.headers.length === 4 && table.headers[0] === 'Element', 'table has 4 headers incl. "Element"');
expect(table && table.rows.length === 2, `table has 2 data rows (got ${table && table.rows.length})`);
expect(blocks.find((b) => b.type === 'code'), 'parses a fenced code block');
expect(blocks.filter((b) => b.type === 'ul').length === 1, 'parses one bullet list');
expect(blocks.filter((b) => b.type === 'p').length >= 2, 'parses paragraphs');

const toks = tokenizeInline('Final line with **bold** and `inline` and a [link](https://example.com).');
expect(toks.some((t) => t.type === 'bold' && t.value === 'bold'), 'inline bold');
expect(toks.some((t) => t.type === 'code' && t.value === 'inline'), 'inline code');
expect(toks.some((t) => t.type === 'link' && t.href === 'https://example.com'), 'inline link with href');

console.log('blocks:', blocks.map((b) => b.type).join(', '));
console.log('inline:', toks.map((t) => t.type).join(', '));
if (fails.length) {
  console.error('\nFAILED:');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ markdown parser checks passed');
