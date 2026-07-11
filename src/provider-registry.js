export function createProviderRegistry(entries) {
  const providers = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.runTurn !== 'function') {
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
        ...entry.diagnose(),
      }));
    },
  };
}
