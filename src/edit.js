// edit.js — direct (no-AI) in-place edits.
// The browser manipulates the rendered DOM of one element; these functions splice that change
// back into the SOURCE FILE around it, leaving the rest of the file byte-for-byte intact.
// Pure + dependency-free (Sandpaper ships zero runtime deps) so it can be unit-tested in isolation.
//
// All operations locate an element by its data-cid="…" attribute. The tricky parts, all handled in
// locate(): the literal string can appear in prose/comments (skip those), the element can contain
// NESTED same-name tags (count depth), and void/self-closing elements have no body (reject).

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Find the element carrying data-cid="<cid>" and return ALL its byte boundaries, or null:
//   { tag, openStart, innerStart, innerEnd, closeEnd }
//   openStart  — the '<' of the opening tag
//   innerStart — first byte after the opening tag's '>'
//   innerEnd   — the '<' of the matching close tag
//   closeEnd   — first byte after the matching '</tag>'
function locate(html, cid) {
  const marker = 'data-cid="' + cid + '"';
  let at = html.indexOf(marker);
  while (at >= 0) {
    const lt = html.lastIndexOf('<', at);
    // genuine attribute ⇒ still INSIDE an opening tag: no '>' sits between '<' and the marker.
    if (lt >= 0 && html.lastIndexOf('>', at) < lt) {
      const name = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(lt));
      if (name) {
        const tag = name[1];
        const openEnd = html.indexOf('>', at);
        if (openEnd >= 0 && html[openEnd - 1] !== '/' && !VOID.has(tag.toLowerCase())) {
          const tok = new RegExp('<' + tag + '(?=[\\s/>])|</' + tag + '\\s*>', 'gi');
          tok.lastIndex = openEnd + 1;
          let depth = 1, m;
          while ((m = tok.exec(html))) {
            if (m[0][1] === '/') {
              if (--depth === 0) {
                return { tag, openStart: lt, innerStart: openEnd + 1, innerEnd: m.index, closeEnd: tok.lastIndex };
              }
            } else depth++;
          }
        }
      }
    }
    at = html.indexOf(marker, at + marker.length); // this occurrence wasn't usable — try the next
  }
  return null;
}

// Range of the element's INNER content (between the tags).
export function innerRange(html, cid) {
  const r = locate(html, cid);
  return r ? { tag: r.tag, start: r.innerStart, end: r.innerEnd } : null;
}

// Range of the WHOLE element (tags included).
export function outerRange(html, cid) {
  const r = locate(html, cid);
  return r ? { tag: r.tag, start: r.openStart, end: r.closeEnd } : null;
}

// Replace the element's inner content. Returns the new file string, or null if not located.
export function replaceInner(html, cid, inner) {
  const r = locate(html, cid);
  return r ? html.slice(0, r.innerStart) + inner + html.slice(r.innerEnd) : null;
}

// True if the bytes from a line start up to `pos` are only spaces/tabs (i.e. `pos` begins a line).
function leadingIndent(html, pos) {
  const ls = html.lastIndexOf('\n', pos - 1) + 1; // 0 if no preceding newline
  const lead = html.slice(ls, pos);
  return /^[ \t]*$/.test(lead) ? { lineStart: ls, indent: lead } : null;
}

// Remove the element entirely. Returns { html, removed } (removed = the element's outer HTML) or null.
// If the element sits alone on its line, the line's leading whitespace + the preceding newline go too,
// so no blank gap is left behind.
export function removeElement(html, cid) {
  const r = outerRange(html, cid);
  if (!r) return null;
  const removed = html.slice(r.start, r.end);
  let from = r.start, to = r.end;
  const li = leadingIndent(html, r.start);
  if (li) {
    if (li.lineStart > 0) from = li.lineStart - 1;      // consume the newline that ended the previous line
    else if (html[to] === '\n') to++;                   // at file start: there is none — consume the trailing one
  }
  return { html: html.slice(0, from) + html.slice(to), removed };
}

// Move the element to sit `mode` ('before' | 'after') the element with cid=target. Returns { html } or null.
// The moved element's own bytes are preserved verbatim; only the indentation around the two seams changes.
export function moveElement(html, cid, target, mode) {
  if (!target || target === cid || (mode !== 'before' && mode !== 'after')) return null;
  const r = outerRange(html, cid);
  if (!r) return null;
  const element = html.slice(r.start, r.end);
  // lift the element out, taking its own line's leading whitespace + the preceding newline with it
  let from = r.start;
  const li = leadingIndent(html, r.start);
  if (li) from = li.lineStart === 0 ? 0 : li.lineStart - 1;
  const without = html.slice(0, from) + html.slice(r.end);
  // locate the target in the reduced document (target must still exist — not a descendant of the moved node)
  const t = outerRange(without, target);
  if (!t) return null;
  const tli = leadingIndent(without, t.start);
  const indent = tli ? tli.indent : '';
  // only break onto a new line when the target is block-indented; inline targets stay inline.
  if (mode === 'before') {
    const at = tli ? tli.lineStart : t.start;
    return { html: without.slice(0, at) + indent + element + (indent ? '\n' : '') + without.slice(at) };
  }
  return { html: without.slice(0, t.end) + (indent ? '\n' + indent : '') + element + without.slice(t.end) };
}
