// sp-markdown.js — a tiny, dependency-free, XSS-safe markdown renderer for the Sandpaper toolbar.
// parseMarkdown / tokenizeInline are PURE (no DOM) and unit-tested in node.
// renderMarkdown builds DOM via createElement + textContent only — never innerHTML on model output.

// ---- block parser (pure) ----
export function parseMarkdown(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isSep = (s) => s != null && /-/.test(s) && /^\s*\|?[\s:|-]+\|?\s*$/.test(s);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }                       // blank

    const fence = line.match(/^```(\w*)\s*$/);                        // fenced code
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence (tolerant of EOF — streaming-safe)
      blocks.push({ type: 'code', lang: fence[1] || '', text: buf.join('\n') });
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);                        // heading
    if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2].trim() }); i++; continue; }

    if (/^\s*([-*_])\1\1[-*_\s]*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; } // hr

    if (/^\s*>\s?/.test(line)) {                                      // blockquote
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ type: 'quote', text: q.join('\n') });
      continue;
    }

    if (line.indexOf('|') >= 0 && isSep(lines[i + 1])) {             // GFM table
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    const lu = line.match(/^\s*[-*+]\s+(.*)$/);                       // list
    const lo = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (lu || lo) {
      const ordered = !!lo; const items = [];
      while (i < lines.length) {
        const mu = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const mo = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        if (ordered && mo) { items.push(mo[1]); i++; }
        else if (!ordered && mu) { items.push(mu[1]); i++; }
        else break;
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }

    const p = [];                                                    // paragraph
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) &&
           !/^#{1,6}\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
           !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
           !(lines[i].indexOf('|') >= 0 && isSep(lines[i + 1]))) {
      p.push(lines[i]); i++;
    }
    blocks.push({ type: 'p', text: p.join('\n') });
  }
  return blocks;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// ---- inline tokenizer (pure) ----
const SAFE_HREF = /^(https?:|mailto:|\/|\.|#)/i;
export function tokenizeInline(text) {
  const out = [];
  let s = String(text == null ? '' : text);
  const rules = [
    { type: 'code', re: /`([^`]+)`/ },
    { type: 'bold', re: /\*\*([^*]+)\*\*/ },
    { type: 'strike', re: /~~([^~]+)~~/ },
    { type: 'link', re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
    { type: 'em', re: /\*([^*\n]+)\*|_([^_\n]+)_/ },
  ];
  while (s.length) {
    let best = null;
    for (const r of rules) {
      const m = r.re.exec(s);
      if (m && (best === null || m.index < best.m.index)) best = { r, m };
    }
    if (!best) { out.push({ type: 'text', value: s }); break; }
    if (best.m.index > 0) out.push({ type: 'text', value: s.slice(0, best.m.index) });
    const m = best.m;
    if (best.r.type === 'link') out.push({ type: 'link', value: m[1], href: m[2] });
    else if (best.r.type === 'em') out.push({ type: 'em', value: m[1] || m[2] });
    else out.push({ type: best.r.type, value: m[1] });
    s = s.slice(m.index + m[0].length);
  }
  return out;
}

// ---- DOM renderer (browser only) ----
export function renderMarkdown(md) {
  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(md)) {
    if (b.type === 'h') frag.appendChild(inlineInto(document.createElement('h' + Math.min(b.level, 6)), b.text, 'sp-md-h'));
    else if (b.type === 'p') frag.appendChild(inlineInto(document.createElement('p'), b.text, 'sp-md-p'));
    else if (b.type === 'ul' || b.type === 'ol') frag.appendChild(listEl(b));
    else if (b.type === 'code') frag.appendChild(codeBlock(b.text));
    else if (b.type === 'table') frag.appendChild(tableEl(b));
    else if (b.type === 'quote') frag.appendChild(inlineInto(document.createElement('blockquote'), b.text, 'sp-md-quote'));
    else if (b.type === 'hr') { const hr = document.createElement('hr'); hr.className = 'sp-md-hr'; frag.appendChild(hr); }
  }
  return frag;
}

function inlineInto(el, text, cls) {
  if (cls) el.className = cls;
  for (const t of tokenizeInline(text)) {
    if (t.type === 'text') el.appendChild(document.createTextNode(t.value));
    else if (t.type === 'link') {
      const a = document.createElement('a');
      a.textContent = t.value;
      a.href = SAFE_HREF.test(t.href) ? t.href : '#';   // reject javascript: etc.
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      el.appendChild(a);
    } else {
      const tag = t.type === 'bold' ? 'strong' : t.type === 'em' ? 'em' : t.type === 'strike' ? 'del' : 'code';
      const e = document.createElement(tag);
      if (t.type === 'code') e.className = 'sp-md-code';
      e.textContent = t.value;
      el.appendChild(e);
    }
  }
  return el;
}

function listEl(b) {
  const l = document.createElement(b.type); l.className = 'sp-md-list';
  b.items.forEach((it) => l.appendChild(inlineInto(document.createElement('li'), it)));
  return l;
}

function codeBlock(text) {
  const wrap = document.createElement('div'); wrap.className = 'sp-md-pre';
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'sp-md-copy'; copy.textContent = 'Copy';
  copy.addEventListener('click', function () {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1200); });
  });
  const pre = document.createElement('pre'); const code = document.createElement('code');
  code.textContent = text; pre.appendChild(code);
  wrap.appendChild(copy); wrap.appendChild(pre);
  return wrap;
}

function tableEl(b) {
  const t = document.createElement('table'); t.className = 'sp-md-table';
  const thead = document.createElement('thead'); const htr = document.createElement('tr');
  b.headers.forEach((c) => htr.appendChild(inlineInto(document.createElement('th'), c)));
  thead.appendChild(htr); t.appendChild(thead);
  const tb = document.createElement('tbody');
  b.rows.forEach((row) => {
    const tr = document.createElement('tr');
    row.forEach((c) => tr.appendChild(inlineInto(document.createElement('td'), c)));
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  return t;
}
