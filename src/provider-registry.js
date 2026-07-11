import { runClaudeTurn } from './claude.js';
import { runCodexTurn } from './codex.js';
import { diagnoseClaude, diagnoseCodex } from './diagnostics.js';

const DIAGNOSTIC_FIELDS = [
  'available', 'compatible', 'authMethod', 'version', 'unavailableCode',
];

function safeDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const key of DIAGNOSTIC_FIELDS) {
    const field = value[key];
    const safe = field === null
      || typeof field === 'string'
      || typeof field === 'boolean'
      || (typeof field === 'number' && Number.isFinite(field));
    if (safe) result[key] = field;
  }
  return result;
}

function diagnoseSafely(entry) {
  try { return safeDiagnostics(entry.diagnose()); }
  catch {
    return {
      available: false,
      compatible: false,
      authMethod: null,
      unavailableCode: 'diagnostic_failed',
    };
  }
}

export function createProviderRegistry(entries) {
  const providers = new Map();
  for (const entry of entries) {
    if (!entry
        || typeof entry.id !== 'string' || !entry.id.trim()
        || typeof entry.label !== 'string' || !entry.label.trim()
        || typeof entry.diagnose !== 'function'
        || typeof entry.runTurn !== 'function') {
      throw new TypeError('Invalid provider entry');
    }
    if (providers.has(entry.id)) throw new Error(`Duplicate provider: ${entry.id}`);
    providers.set(entry.id, Object.freeze(entry));
  }
  return {
    get(id) { return providers.get(id) || null; },
    diagnostics() {
      return [...providers.values()].map((entry) => ({
        id: entry.id,
        label: entry.label,
        ...diagnoseSafely(entry),
      }));
    },
  };
}

export function createFirstPartyRegistry(deps = {}) {
  return createProviderRegistry([
    {
      id: 'claude',
      label: 'Claude Code',
      diagnose: deps.diagnoseClaude || diagnoseClaude,
      runTurn: (input) => runClaudeTurn(input, deps.claude),
    },
    {
      id: 'codex',
      label: 'Codex',
      diagnose: deps.diagnoseCodex || diagnoseCodex,
      runTurn: (input) => runCodexTurn(input, deps.codex),
    },
  ]);
}
