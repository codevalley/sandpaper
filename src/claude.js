// claude.js — the bridge to Claude Code.
// Spawns `claude -p` in stream-json mode against the document's folder, maps the
// event stream to a small set of UI status states, and reports native session ids
// to the server so it can persist provider-scoped resume state.
import { spawn } from 'node:child_process';
import { dirname, basename, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// Appended per turn instead of a repo-wide CLAUDE.md, so the contract is scoped to
// the editing job and doesn't pollute the project's own Claude guidance.
const CONTRACT = [
  'You are the editing engine behind Sandpaper. A human is refining a single,',
  'self-contained HTML document live in their browser.',
  '- Edit the target HTML file in place with the Edit tool. Keep it valid and self-contained.',
  '- Make the SMALLEST change that satisfies the request. Never regenerate unrelated parts.',
  '- Preserve every existing data-cid attribute exactly; give new block elements unique ones.',
  '- When told a specific element (by data-cid or CSS selector), change ONLY that element.',
  "- Preserve the document's structure, style, and voice unless asked to change them.",
].join('\n');

const SESSION_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit'];

// ---- pure helpers (unit-tested in test/parse-test.js) ----

// Returns a session id if this event carries one (the init system event), else null.
export function getSessionId(ev) {
  return ev && ev.type === 'system' && ev.subtype === 'init' && ev.session_id
    ? ev.session_id
    : null;
}

// Summarize an Edit/Write/MultiEdit tool_use block (taken from a COMPLETE assistant
// message, where `input` is fully formed — never from partial input_json_delta) into a
// typed `edit` frame for the conversation surface's "what changed" card.
function summarizeEdit(block, docName) {
  const input = block.input || {};
  const name = block.name;
  let hunks;
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    hunks = input.edits.map((e) => ({ oldText: e.old_string || '', newText: e.new_string || '' }));
  } else if (name === 'Write') {
    hunks = [{ oldText: '', newText: input.content || '' }];
  } else {
    hunks = [{ oldText: input.old_string || '', newText: input.new_string || '' }];
  }
  let added = 0, removed = 0;
  const cids = new Set();
  for (const h of hunks) {
    if (h.oldText) removed += h.oldText.split('\n').length;
    if (h.newText) added += h.newText.split('\n').length;
    for (const t of [h.oldText, h.newText]) {
      for (const m of String(t).matchAll(/data-cid="([^"]+)"/g)) cids.add(m[1]);
    }
  }
  const file = input.file_path ? basename(input.file_path) : docName;
  return { type: 'edit', tool: name, file, hunks, added, removed, cids: [...cids] };
}

// Map one stream-json event to an ARRAY of typed frames for the conversation surface:
//   {type:'status', …}          → drives the 7-state chip (unchanged behaviour)
//   {type:'assistant_delta', …} → streamed reply text / thinking (previously DROPPED — the bug)
//   {type:'edit', …}            → a per-edit change summary
// Returns [] for events that carry nothing renderable.
export function mapEvents(ev, docName) {
  if (!ev || !ev.type) return [];

  if (ev.type === 'system' && ev.subtype === 'init') {
    return [{ type: 'status', state: 'init', label: 'starting…' }];
  }

  if (ev.type === 'stream_event' && ev.event) {
    const e = ev.event;
    if (e.type === 'message_start') {
      return [{ type: 'status', state: 'thinking', label: 'thinking…' }];
    }
    if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
      const tool = e.content_block.name || 'tool';
      const editing = tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit';
      return [editing
        ? { type: 'status', state: 'editing', label: `editing ${docName}` }
        : { type: 'status', state: 'tool_using', label: `${tool.toLowerCase()}…` }];
    }
    if (e.type === 'content_block_delta' && e.delta) {
      if (e.delta.type === 'text_delta' && e.delta.text) {
        return [{ type: 'assistant_delta', kind: 'text', text: e.delta.text }];
      }
      if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
        return [{ type: 'assistant_delta', kind: 'thinking', text: e.delta.thinking }];
      }
    }
    return [];
  }

  // A COMPLETE assistant message: pull edit summaries from it (text was already streamed
  // via deltas, so we do NOT re-emit it here — that would double-render).
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const edits = [];
    for (const block of ev.message.content) {
      if (block.type === 'tool_use' && (block.name === 'Edit' || block.name === 'Write' || block.name === 'MultiEdit')) {
        edits.push(summarizeEdit(block, docName));
      }
    }
    return edits;
  }

  if (ev.type === 'result') {
    if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
      return [{ type: 'status', state: 'error', label: 'turn failed', detail: String(ev.result || '').slice(0, 200) }];
    }
    // The toolbar derives "Replied" vs "Saved" from whether any edit frame arrived this turn,
    // so the chip stays neutral here — no more hardcoded "Saved" on pure-discussion turns.
    const cost = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
    return [{ type: 'status', state: 'done', label: 'done', cost, done: true }];
  }

  return [];
}

// ---- environment hygiene (mirrors amux _on_claude_plan / _claude_oneshot env scrub) ----

// True if the user is signed into a Claude subscription (Pro/Max) rather than API billing.
function onClaudePlan() {
  try { return !!JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).oauthAccount; }
  catch { return false; }
}

// The child is a fresh, top-level `claude` run — not nested inside whatever process spawned
// us. Strip the markers that would make it think it's running inside Claude Code, and on a
// subscription drop any exported ANTHROPIC_API_KEY so turns bill the plan, not the API.
function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (onClaudePlan()) delete env.ANTHROPIC_API_KEY;
  return env;
}

// ---- the turn ----

// Run one refinement turn. Returns the child process (or null if spawn failed
// synchronously); session persistence and lifecycle enrichment stay with the server.
export function runClaudeTurn({ pageFile, prompt, resumeId, onSession, onFrame }, deps = {}) {
  const docDir = dirname(pageFile);
  const docName = basename(pageFile);
  const spawnProcess = deps.spawn || spawn;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', SESSION_TOOLS.join(','),
    '--append-system-prompt', CONTRACT,
  ];
  if (resumeId) args.push('--resume', resumeId);

  let child;
  try {
    // cwd = the document's folder: this is what makes --resume's directory-scoped
    // session lookup reliable, and keeps Claude's relative paths anchored to the doc.
    // stdin 'ignore' so a non-interactive `-p` run can never block waiting on input.
    child = spawnProcess('claude', args, { cwd: docDir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    onFrame({ type: 'status', state: 'error', label: 'Could not start claude', detail: err.message });
    return null;
  }

  let terminalEmitted = false;
  const emit = (frame) => {
    if (terminalEmitted) return;
    if (frame.type === 'status' && (frame.done || frame.state === 'done' || frame.state === 'error')) {
      terminalEmitted = true;
    }
    onFrame(frame);
  };

  emit({ type: 'status', state: 'init', label: 'starting…' });

  let buf = '';
  let errored = false;

  const processLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; } // ignore non-JSON noise
    const id = getSessionId(ev);
    if (id) onSession(id);
    for (const frame of mapEvents(ev, docName)) emit(frame);
  };

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      processLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  // Flush a final line that arrives without a trailing newline (else the `result`
  // event — cost + "Saved" confirmation — can be silently dropped on abrupt exit).
  child.stdout.on('end', () => { processLine(buf); buf = ''; });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (err) => {
    errored = true;
    emit({ type: 'status', state: 'error', label: 'claude not found — is it installed?', detail: err.message });
  });
  child.on('close', (code) => {
    if (terminalEmitted || errored) return;
    if (code && code !== 0) {
      emit({ type: 'status', state: 'error', label: `claude exited (${code})`, detail: stderr.slice(0, 300) });
    } else {
      emit({ type: 'status', state: 'error', label: 'claude exited without a result', detail: stderr.slice(0, 300) });
    }
  });

  return child;
}

// Compatibility for the Claude-only server path until provider composition is wired.
export function runTurn(pageFile, prompt, onFrame, deps) {
  return runClaudeTurn({ pageFile, prompt, resumeId: null, onSession() {}, onFrame }, deps);
}
