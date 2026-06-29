// edit.js — direct (no-AI) in-place edits.
// The browser edits the rendered DOM of one element; this splices that element's new inner
// HTML back into the SOURCE FILE around it, leaving the rest of the file byte-for-byte intact.
// Pure + dependency-free (Sandpaper ships zero runtime deps) so it can be unit-tested in isolation.
//
// We locate the element by its data-cid="…" attribute. The tricky parts, all handled below:
//   • the literal string data-cid="…" can also appear in prose or comments — skip those,
//   • the element can contain NESTED same-name tags (<div> in <div>) — count depth,
//   • void / self-closing elements have no inner content — reject.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Return { tag, start, end } byte offsets of the INNER content of the element carrying
// data-cid="<cid>" (between the end of its opening tag and the start of its matching close),
// or null if not found / not a real element / has no inner content / is unbalanced.
export function innerRange(html, cid) {
  const marker = 'data-cid="' + cid + '"';
  let at = html.indexOf(marker);
  while (at >= 0) {
    const lt = html.lastIndexOf('<', at);
    // genuine attribute ⇒ we are still INSIDE an opening tag: no '>' sits between '<' and the marker.
    if (lt >= 0 && html.lastIndexOf('>', at) < lt) {
      const name = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(lt));
      if (name) {
        const tag = name[1];
        const openEnd = html.indexOf('>', at);
        if (openEnd >= 0 && html[openEnd - 1] !== '/' && !VOID.has(tag.toLowerCase())) {
          // walk forward to the matching close, counting nested opens of the SAME tag name.
          const tok = new RegExp('<' + tag + '(?=[\\s/>])|</' + tag + '\\s*>', 'gi');
          tok.lastIndex = openEnd + 1;
          let depth = 1, m;
          while ((m = tok.exec(html))) {
            if (m[0][1] === '/') { if (--depth === 0) return { tag, start: openEnd + 1, end: m.index }; }
            else depth++;
          }
        }
      }
    }
    at = html.indexOf(marker, at + marker.length); // this occurrence wasn't usable — try the next
  }
  return null;
}

// Replace the inner content of the data-cid element with `inner`. Returns the new file string,
// or null if the element couldn't be located (caller should treat null as "refuse the write").
export function replaceInner(html, cid, inner) {
  const r = innerRange(html, cid);
  if (!r) return null;
  return html.slice(0, r.start) + inner + html.slice(r.end);
}
