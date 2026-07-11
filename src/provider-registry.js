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
        ...safeDiagnostics(entry.diagnose()),
      }));
    },
  };
}
