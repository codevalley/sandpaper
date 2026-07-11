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

test('registry requires complete non-empty provider entries', () => {
  const runTurn = () => {};
  const diagnose = () => ({ available: true });
  for (const entry of [
    { id: '', label: 'Claude Code', diagnose, runTurn },
    { id: 'claude', label: '', diagnose, runTurn },
    { id: 'claude', diagnose, runTurn },
    { id: 'claude', label: 'Claude Code', runTurn },
    { id: 'claude', label: 'Claude Code', diagnose: true, runTurn },
  ]) {
    assert.throws(() => createProviderRegistry([entry]), /Invalid provider entry/);
  }
});

test('registry diagnostics keep identity authoritative and expose only safe scalar fields', () => {
  const registry = createProviderRegistry([{
    id: 'claude',
    label: 'Claude Code',
    diagnose: () => ({
      id: 'spoofed',
      label: 'Spoofed Provider',
      available: true,
      compatible: false,
      authMethod: 'subscription',
      version: () => 'secret',
      unavailableCode: null,
      runTurn: 'leaked runner',
      diagnose() {},
    }),
    runTurn() {},
  }]);
  const diagnostics = registry.diagnostics();
  assert.deepEqual(diagnostics, [{
    id: 'claude',
    label: 'Claude Code',
    available: true,
    compatible: false,
    authMethod: 'subscription',
    unavailableCode: null,
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /spoofed|leaked|secret/);
  assert.equal(Object.values(diagnostics[0]).some((value) => typeof value === 'function'), false);
});
