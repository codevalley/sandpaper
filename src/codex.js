// codex.js — controlled Codex JSONL adapter for Sandpaper provider turns.
import { spawn } from 'node:child_process';
import { basename, dirname } from 'node:path';

export function codexArgs({ prompt, resumeId }) {
  const args = [
    '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
    '--config', 'web_search="disabled"',
    '--config', 'sandbox_workspace_write.network_access=false',
    '--config', 'project_doc_max_bytes=0',
    '--disable', 'multi_agent', '--disable', 'apps',
    'exec', '--ignore-user-config', '--ignore-rules', '--json',
  ];
  if (resumeId) args.push('resume', resumeId);
  args.push(prompt);
  return args;
}

export function getCodexThreadId(event) {
  return event?.type === 'thread.started' && typeof event.thread_id === 'string'
    ? event.thread_id : null;
}

export function codexChildEnv(source = process.env) {
  const env = { ...source };
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

function warningDetail(event) {
  const value = event?.message ?? event?.error?.message
    ?? event?.item?.message ?? event?.item?.error?.message ?? '';
  return String(value).slice(0, 300);
}

function usageFrame(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const frame = { type: 'usage', provider: 'codex' };
  if (Number.isFinite(usage.input_tokens)) frame.inputTokens = usage.input_tokens;
  if (Number.isFinite(usage.cached_input_tokens)) frame.cachedInputTokens = usage.cached_input_tokens;
  if (Number.isFinite(usage.output_tokens)) frame.outputTokens = usage.output_tokens;
  if (Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)) {
    frame.totalTokens = usage.input_tokens + usage.output_tokens;
  }
  return Object.keys(frame).length > 2 ? frame : null;
}

export function mapCodexEvent(event, documentName) {
  if (!event || typeof event !== 'object') return [];

  if (event.type === 'thread.started') {
    return [{ type: 'status', state: 'init', label: 'starting…' }];
  }
  if (event.type === 'turn.started') {
    return [{ type: 'status', state: 'thinking', label: 'thinking…' }];
  }
  if (event.type === 'error') {
    return [{ type: 'warning', label: 'Codex warning', detail: warningDetail(event) }];
  }
  if (event.type === 'turn.failed') {
    return [{ type: 'status', state: 'error', label: 'turn failed', detail: warningDetail(event) }];
  }
  if (event.type === 'turn.completed') {
    const frames = [];
    const usage = usageFrame(event.usage);
    if (usage) frames.push(usage);
    frames.push({
      type: 'status', state: 'done', label: 'done',
      usage: event.usage || null, done: true,
    });
    return frames;
  }

  const item = event.item;
  if (!item || typeof item !== 'object') return [];
  if (event.type === 'item.started' && item.type === 'command_execution') {
    return [{ type: 'status', state: 'tool_using', label: 'running command…' }];
  }
  if (event.type !== 'item.completed') return [];
  if (item.type === 'reasoning' && typeof item.text === 'string' && item.text) {
    return [{ type: 'assistant_delta', kind: 'thinking', text: item.text }];
  }
  if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
    return [{ type: 'assistant_delta', kind: 'text', text: item.text }];
  }
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    const paths = item.changes
      .filter((change) => change && typeof change === 'object' && !Array.isArray(change)
        && typeof change.path === 'string' && change.path
        && typeof change.kind === 'string' && change.kind)
      .map((change) => ({ path: change.path, kind: change.kind }));
    if (!paths.length) return [];
    return [{
      type: 'edit', tool: 'Codex', file: documentName,
      paths,
    }];
  }
  if (item.type === 'error') {
    return [{ type: 'warning', label: 'Codex warning', detail: warningDetail(event) }];
  }
  return [];
}

export function runCodexTurn({ pageFile, prompt, resumeId, onSession, onFrame }, deps = {}) {
  const spawnProcess = deps.spawn || spawn;
  let child;
  try {
    child = spawnProcess('codex', codexArgs({ prompt, resumeId }), {
      cwd: dirname(pageFile),
      env: codexChildEnv(deps.env || process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    onFrame({
      type: 'status', state: 'error', label: 'Could not start codex', detail: error.message,
    });
    return null;
  }

  let terminalEmitted = false;
  const emit = (frame) => {
    if (terminalEmitted) return;
    const terminal = frame.type === 'status'
      && (frame.done || frame.state === 'done' || frame.state === 'error');
    try { onFrame(frame); }
    catch { return; }
    if (terminal) terminalEmitted = true;
  };

  emit({ type: 'status', state: 'init', label: 'starting…' });

  let stdout = '';
  const processLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const threadId = getCodexThreadId(event);
    if (threadId) {
      try { onSession(threadId); }
      catch { emit({ type: 'warning', label: 'Codex session could not be saved' }); }
    }
    let frames;
    try { frames = mapCodexEvent(event, basename(pageFile)); }
    catch { emit({ type: 'warning', label: 'Codex returned an invalid event' }); return; }
    for (const frame of frames) emit(frame);
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      processLine(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
    }
  });
  child.stdout.on('end', () => {
    processLine(stdout);
    stdout = '';
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    emit({
      type: 'status', state: 'error',
      label: 'codex not found — is it installed?', detail: error.message,
    });
  });
  child.on('close', (code, signal) => {
    if (terminalEmitted) return;
    const detail = stderr.slice(0, 300);
    if (signal) {
      emit({
        type: 'status', state: 'error', label: `codex interrupted (${signal})`, detail,
      });
    } else if (code !== 0 && code !== null) {
      emit({ type: 'status', state: 'error', label: `codex exited (${code})`, detail });
    } else {
      emit({
        type: 'status', state: 'error',
        label: 'codex exited without a terminal event', detail,
      });
    }
  });

  return child;
}
