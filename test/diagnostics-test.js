import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseClaude, diagnoseCodex } from '../src/diagnostics.js';

const result = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });

test('Claude diagnosis distinguishes a missing binary from a failed version probe', () => {
  const missing = diagnoseClaude(() => { const error = new Error('spawn ENOENT'); error.code = 'ENOENT'; throw error; });
  assert.deepEqual(missing, {
    available: false,
    compatible: false,
    authMethod: null,
    unavailableCode: 'binary_missing',
  });

  const incompatible = diagnoseClaude(() => result(2, '', 'bad invocation'));
  assert.deepEqual(incompatible, {
    available: false,
    compatible: false,
    authMethod: null,
    unavailableCode: 'incompatible',
  });

  const healthy = diagnoseClaude((command, args) => {
    assert.equal(command, 'claude');
    assert.deepEqual(args, ['--version']);
    return result(0, '2.1.0\n');
  });
  assert.deepEqual(healthy, {
    available: true,
    compatible: true,
    authMethod: 'unknown',
    version: '2.1.0',
    unavailableCode: null,
  });
});

test('Codex diagnosis checks controlled capabilities and saved login without exposing output', () => {
  const calls = [];
  const outputs = new Map([
    ['--version', result(0, 'codex-cli 0.143.0\n')],
    ['--help', result(0, '--ask-for-approval --sandbox --config --disable')],
    ['exec --help', result(0, 'Commands: resume --json --ignore-user-config --ignore-rules')],
    ['exec resume --help', result(0, 'Usage: codex exec resume --config --json --ignore-user-config --ignore-rules [SESSION_ID] [PROMPT]')],
    ['login status', result(0, 'Logged in using ChatGPT secret@example.test')],
  ]);
  const diagnosis = diagnoseCodex((command, args) => {
    calls.push([command, args]);
    return outputs.get(args.join(' '));
  });

  assert.deepEqual(calls, [
    ['codex', ['--version']],
    ['codex', ['--help']],
    ['codex', ['exec', '--help']],
    ['codex', ['exec', 'resume', '--help']],
    ['codex', ['login', 'status']],
  ]);
  assert.deepEqual(diagnosis, {
    available: true,
    compatible: true,
    authMethod: 'chatgpt',
    version: 'codex-cli 0.143.0',
    unavailableCode: null,
  });
  assert.doesNotMatch(JSON.stringify(diagnosis), /secret@example/);
});

test('Codex diagnosis distinguishes missing, incompatible, and unauthenticated states', () => {
  const missing = diagnoseCodex(() => ({ error: { code: 'ENOENT' }, status: null, stdout: '', stderr: '' }));
  assert.equal(missing.available, false);
  assert.equal(missing.unavailableCode, 'binary_missing');

  const incompatible = diagnoseCodex((_command, args) => {
    if (args[0] === '--version') return result(0, 'codex-cli 1');
    if (args[0] === 'login') return result(0, 'Logged in using an API key');
    return result(0, 'incomplete help');
  });
  assert.equal(incompatible.available, false);
  assert.equal(incompatible.compatible, false);
  assert.equal(incompatible.authMethod, 'api-key');
  assert.equal(incompatible.unavailableCode, 'incompatible');

  const misplacedCapabilities = diagnoseCodex((_command, args) => {
    const key = args.join(' ');
    if (key === '--version') return result(0, 'codex-cli 1');
    if (key === '--help') return result(0, '--ask-for-approval --sandbox');
    if (key === 'exec --help') {
      return result(0, '--config --disable resume --json --ignore-user-config --ignore-rules');
    }
    if (key === 'exec resume --help') {
      return result(0, 'Usage: codex exec resume [SESSION_ID] [PROMPT] --config --json --ignore-user-config --ignore-rules');
    }
    return result(0, 'Logged in using ChatGPT');
  });
  assert.equal(misplacedCapabilities.compatible, false);
  assert.equal(misplacedCapabilities.unavailableCode, 'incompatible');

  const failedHelp = diagnoseCodex((_command, args) => {
    const key = args.join(' ');
    if (key === '--version') return result(0, 'codex-cli 1');
    if (key === 'exec --help') {
      return result(2, 'Commands: resume --json --ignore-user-config --ignore-rules');
    }
    if (key === 'login status') return result(0, 'Logged in using ChatGPT');
    return result(0, '--ask-for-approval --sandbox --config --disable Usage: codex exec resume --json --ignore-user-config --ignore-rules [SESSION_ID] [PROMPT]');
  });
  assert.equal(failedHelp.compatible, false);
  assert.equal(failedHelp.unavailableCode, 'incompatible');

  const unauthenticated = diagnoseCodex((_command, args) => {
    const key = args.join(' ');
    if (key === '--version') return result(0, 'codex-cli 1');
    if (key === '--help') return result(0, '--ask-for-approval --sandbox --config --disable');
    if (key === 'exec --help') return result(0, 'resume --json --ignore-user-config --ignore-rules');
    if (key === 'exec resume --help') return result(0, 'Usage: codex exec resume --config --json --ignore-user-config --ignore-rules [SESSION_ID] [PROMPT]');
    return result(1, '', 'Not logged in token=do-not-leak');
  });
  assert.deepEqual(unauthenticated, {
    available: false,
    compatible: true,
    authMethod: null,
    version: 'codex-cli 1',
    unavailableCode: 'unauthenticated',
  });
  assert.doesNotMatch(JSON.stringify(unauthenticated), /do-not-leak/);

  const unknownAuth = diagnoseCodex((_command, args) => {
    const key = args.join(' ');
    if (key === '--version') return result(0, 'codex-cli 1');
    if (key === '--help') return result(0, '--ask-for-approval --sandbox --config --disable');
    if (key === 'exec --help') return result(0, 'resume --json --ignore-user-config --ignore-rules');
    if (key === 'exec resume --help') return result(0, 'Usage: codex exec resume --config --json --ignore-user-config --ignore-rules [SESSION_ID] [PROMPT]');
    return result(0, 'Logged in');
  });
  assert.equal(unknownAuth.available, true);
  assert.equal(unknownAuth.authMethod, 'unknown');
  assert.equal(unknownAuth.unavailableCode, null);
});
