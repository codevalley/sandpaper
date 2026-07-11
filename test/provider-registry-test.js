import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry } from '../src/provider-registry.js';

test('registry rejects duplicate or unknown providers and returns safe diagnostics', () => {
  const claude = {
    id: 'claude',
    label: 'Claude Code',
    diagnose: () => ({ available: true }),
    runTurn() {},
  };
  const registry = createProviderRegistry([claude]);
  assert.equal(registry.get('claude'), claude);
  assert.equal(registry.get('codex'), null);
  assert.deepEqual(registry.diagnostics(), [{ id: 'claude', label: 'Claude Code', available: true }]);
  assert.throws(() => createProviderRegistry([claude, claude]), /Duplicate provider/);
});
