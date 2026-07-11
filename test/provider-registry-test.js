import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createFirstPartyRegistry, createProviderRegistry } from '../src/provider-registry.js';

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

test('registry contains a throwing diagnostic behind a redacted unavailable result', () => {
  const registry = createProviderRegistry([{
    id: 'codex',
    label: 'Codex',
    diagnose() { throw new Error('secret diagnostic output'); },
    runTurn() {},
  }]);
  const diagnostics = registry.diagnostics();
  assert.deepEqual(diagnostics, [{
    id: 'codex',
    label: 'Codex',
    available: false,
    compatible: false,
    authMethod: null,
    unavailableCode: 'diagnostic_failed',
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret/);
});

test('first-party registry contains frozen Claude and Codex entries without fallback', () => {
  const claudeRuns = [];
  const codexRuns = [];
  const registry = createFirstPartyRegistry({
    diagnoseClaude: () => ({ available: true, authMethod: 'subscription' }),
    diagnoseCodex: () => ({ available: false, unavailableCode: 'binary_missing' }),
    claude: {
      onClaudePlan: () => false,
      spawn: (...args) => { claudeRuns.push(args); return fakeChild(); },
    },
    codex: { spawn: (...args) => { codexRuns.push(args); return fakeChild(); } },
  });

  assert.equal(registry.get('claude').label, 'Claude Code');
  assert.equal(registry.get('codex').label, 'Codex');
  assert.equal(registry.get('codex').diagnose().available, false);
  assert.equal(registry.get('unknown'), null);
  assert.equal(Object.isFrozen(registry.get('claude')), true);
  assert.equal(Object.isFrozen(registry.get('codex')), true);
  assert.deepEqual(registry.diagnostics(), [
    {
      id: 'claude', label: 'Claude Code', available: true, authMethod: 'subscription',
    },
    {
      id: 'codex', label: 'Codex', available: false, unavailableCode: 'binary_missing',
    },
  ]);

  const fakeChild = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    return child;
  };
  const input = {
    pageFile: '/tmp/index.html', prompt: 'refine', resumeId: null,
    onSession() {}, onFrame() {},
  };
  registry.get('claude').runTurn(input);
  registry.get('codex').runTurn(input);
  assert.equal(claudeRuns[0][0], 'claude');
  assert.equal(codexRuns[0][0], 'codex');
});
