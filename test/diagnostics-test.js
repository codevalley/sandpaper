import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  diagnoseClaude,
  diagnoseCodex,
  inspectInstallation,
  probeClaude,
  probeCodex,
} from '../src/diagnostics.js';
import { doctor, installSkill } from '../src/setup.js';
import { integrationContract } from '../src/integrations.js';

const PACKAGE = new URL('..', import.meta.url).pathname;
const commandResult = (status, stdout = '', stderr = '') => ({ status, stdout, stderr });

// Preserve the Task 1 runtime-diagnostic contract while Task 5 adds the probe aliases
// and installation-level inspection below.
test('runtime Claude diagnosis distinguishes missing and failed version probes', () => {
  const missing = diagnoseClaude(() => {
    const error = new Error('spawn ENOENT');
    error.code = 'ENOENT';
    throw error;
  });
  assert.deepEqual(missing, {
    available: false, compatible: false, authMethod: null, unavailableCode: 'binary_missing',
  });
  assert.deepEqual(diagnoseClaude(() => commandResult(2, '', 'secret failure')), {
    available: false, compatible: false, authMethod: null, unavailableCode: 'incompatible',
  });
});

test('runtime Codex diagnosis rejects misplaced and failed controlled capabilities', () => {
  const misplaced = diagnoseCodex((_command, args) => {
    const key = args.join(' ');
    if (key === '--version') return commandResult(0, 'codex-cli 1');
    if (key === '--help') return commandResult(0, '--ask-for-approval --sandbox');
    if (key === 'exec --help') return commandResult(0, '--config --disable resume --json --ignore-user-config --ignore-rules');
    if (key === 'exec resume --help') {
      return commandResult(0, 'Usage: codex exec resume [SESSION_ID] [PROMPT] --config --json --ignore-user-config --ignore-rules');
    }
    return commandResult(0, 'Logged in using ChatGPT');
  });
  assert.equal(misplaced.compatible, false);
  assert.equal(misplaced.unavailableCode, 'incompatible');

  const failedHelp = diagnoseCodex((_command, args) => {
    const key = args.join(' ');
    if (key === '--version') return commandResult(0, 'codex-cli 1');
    if (key === 'exec --help') return commandResult(2, 'resume --json --ignore-user-config --ignore-rules');
    if (key === 'login status') return commandResult(0, 'Logged in using ChatGPT');
    return commandResult(0, '--ask-for-approval --sandbox --config --disable Usage: codex exec resume --json --ignore-user-config --ignore-rules [SESSION_ID] [PROMPT]');
  });
  assert.equal(failedHelp.compatible, false);
  assert.equal(failedHelp.unavailableCode, 'incompatible');
});

function claudeRun({ authStatus = 0, auth = { loggedIn: true, authMethod: 'claude.ai' } } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (args.join(' ') === '--version') {
      return { status: 0, stdout: `claude 3.4.5\nSECRET_SECOND_LINE\u0007\n`, stderr: 'token=stderr-secret' };
    }
    return {
      status: authStatus,
      stdout: JSON.stringify({
        ...auth,
        email: 'private@example.test',
        organization: 'Secret Org',
        apiKey: 'sk-secret',
      }),
      stderr: 'Bearer stderr-secret',
    };
  };
  return { calls, run };
}

function codexRun({ loginStatus = 0, login = 'Logged in using ChatGPT' } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    const key = args.join(' ');
    if (key === '--version') return { status: 0, stdout: 'codex-cli 0.143.0\nSECRET\n', stderr: 'token=stderr-secret' };
    if (key === '--help') {
      return { status: 0, stdout: 'Options:\n  --ask-for-approval <POLICY>\n  --sandbox <MODE>\n  --config <key=value>\n  --disable <FEATURE>\n' };
    }
    if (key === 'exec --help') {
      return { status: 0, stdout: 'Commands:\n  resume  Resume a session\nOptions:\n  --json\n  --ignore-user-config\n  --ignore-rules\n' };
    }
    if (key === 'exec resume --help') {
      return { status: 0, stdout: 'Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\nOptions:\n  --config <key=value>\n  --json\n  --ignore-user-config\n  --ignore-rules\n' };
    }
    if (key === 'login status') return { status: loginStatus, stdout: login, stderr: 'sk-stderr-secret' };
    throw new Error(`unexpected command: ${command} ${key}`);
  };
  return { calls, run };
}

function missingRun(command) {
  return { status: null, error: Object.assign(new Error(`${command} missing with sk-secret`), { code: 'ENOENT' }) };
}

test('Claude probe is the runtime diagnosis, sanitizes version, and emits no auth identity', () => {
  const fixture = claudeRun();
  const result = probeClaude(fixture.run);
  assert.deepEqual(result, {
    available: true,
    compatible: true,
    authMethod: 'subscription',
    version: 'claude 3.4.5',
    unavailableCode: null,
  });
  assert.deepEqual(result, diagnoseClaude(fixture.run));
  assert.deepEqual(fixture.calls.slice(0, 2), [
    ['claude', ['--version']],
    ['claude', ['auth', 'status', '--json']],
  ]);
  assert.doesNotMatch(JSON.stringify(result), /private|Secret Org|sk-secret|stderr-secret/i);
});

test('Claude probe classifies missing, incompatible, logged out, api-key, and unknown auth', () => {
  assert.deepEqual(probeClaude(missingRun), {
    available: false, compatible: false, authMethod: null, unavailableCode: 'binary_missing',
  });
  const incompatible = claudeRun({ auth: { nope: true } });
  assert.equal(probeClaude(incompatible.run).unavailableCode, 'incompatible');
  const loggedOut = claudeRun({ authStatus: 1, auth: { loggedIn: false } });
  assert.equal(probeClaude(loggedOut.run).unavailableCode, 'unauthenticated');
  assert.equal(probeClaude(claudeRun({ auth: { loggedIn: true, authMethod: 'api-key' } }).run).authMethod, 'api-key');
  assert.equal(probeClaude(claudeRun({ auth: { loggedIn: true, authMethod: 'other' } }).run).authMethod, 'unknown');
  assert.deepEqual(probeClaude(() => ({ status: 2, stdout: '', stderr: 'secret failure' })), {
    available: false, compatible: false, authMethod: null, unavailableCode: 'incompatible',
  });
});

test('Codex probe checks the controlled grammar in order and reports saved auth only', () => {
  const fixture = codexRun();
  const result = probeCodex(fixture.run);
  assert.deepEqual(result, {
    available: true,
    compatible: true,
    authMethod: 'chatgpt',
    version: 'codex-cli 0.143.0',
    unavailableCode: null,
  });
  assert.deepEqual(result, diagnoseCodex(fixture.run));
  assert.deepEqual(fixture.calls.slice(0, 5), [
    ['codex', ['--version']],
    ['codex', ['--help']],
    ['codex', ['exec', '--help']],
    ['codex', ['exec', 'resume', '--help']],
    ['codex', ['login', 'status']],
  ]);
  assert.ok(fixture.calls.every(([command]) => command === 'codex'));
  assert.doesNotMatch(JSON.stringify(result), /SECRET|stderr-secret/i);
});

test('Codex probe classifies missing, incompatible, logged out, api-key, and unknown auth', () => {
  assert.equal(probeCodex(missingRun).unavailableCode, 'binary_missing');
  const incompatible = codexRun();
  incompatible.run = (command, args) => args.join(' ') === '--version'
    ? { status: 0, stdout: 'codex 1' }
    : args.join(' ') === 'login status'
      ? { status: 0, stdout: 'Logged in using ChatGPT' }
      : { status: 0, stdout: '' };
  assert.equal(probeCodex(incompatible.run).unavailableCode, 'incompatible');
  assert.equal(probeCodex(codexRun({ loginStatus: 1, login: 'Not logged in' }).run).unavailableCode, 'unauthenticated');
  assert.equal(probeCodex(codexRun({ login: 'Logged in using an API key sk-secret' }).run).authMethod, 'api-key');
  assert.equal(probeCodex(codexRun({ login: 'Authenticated' }).run).authMethod, 'unknown');

  const misplaced = codexRun();
  assert.equal(probeCodex((command, args) => {
    const key = args.join(' ');
    if (key === '--version') return { status: 0, stdout: 'codex 1' };
    if (key === '--help') return { status: 0, stdout: '--ask-for-approval --sandbox' };
    if (key === 'exec --help') return { status: 0, stdout: '--config --disable resume --json --ignore-user-config --ignore-rules' };
    if (key === 'exec resume --help') return misplaced.run(command, args);
    return { status: 0, stdout: 'Logged in using ChatGPT' };
  }).unavailableCode, 'incompatible');
});

test('Codex probe rejects lookalike capability tokens, subcommands, usage, and operands', () => {
  const valid = {
    root: 'Options:\n  --ask-for-approval <POLICY>\n  --sandbox <MODE>\n  --config <key=value>\n  --disable <FEATURE>\n',
    exec: 'Commands:\n  resume  Resume a session\nOptions:\n  --json\n  --ignore-user-config\n  --ignore-rules\n',
    resume: 'Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\nArguments:\n  [SESSION_ID]\n  [PROMPT]\nOptions:\n  --config <key=value>\n  --json\n  --ignore-user-config\n  --ignore-rules\n',
  };
  const mutations = [
    ['root sandbox suffix', { root: valid.root.replace('--sandbox ', '--sandboxed ') }],
    ['root disable prefix', { root: valid.root.replace('--disable ', '--disablement ') }],
    ['root option in wrong section', {
      root: `Arguments:\n  --sandbox <FAKE>\n${valid.root.replace('  --sandbox <MODE>\n', '')}`,
    }],
    ['exec presume command', { exec: valid.exec.replace('  resume  ', '  presume  ') }],
    ['exec command in wrong section', {
      exec: `Arguments:\n  resume  not a command\n${valid.exec.replace('  resume  Resume a session\n', '')}`,
    }],
    ['exec json suffix', { exec: valid.exec.replace('  --json\n', '  --jsonish\n') }],
    ['exec rules suffix', { exec: valid.exec.replace('  --ignore-rules\n', '  --ignore-rules-extra\n') }],
    ['resume subcommand suffix', { resume: valid.resume.replace('codex exec resume ', 'codex exec resumeLater ') }],
    ['resume session operand suffix', { resume: valid.resume.replaceAll('[SESSION_ID]', '[SESSION_ID]junk') }],
    ['resume prompt operand suffix', { resume: valid.resume.replaceAll('[PROMPT]', '[PROMPT]ly') }],
    ['resume config suffix', { resume: valid.resume.replace('  --config ', '  --configuration ') }],
  ];
  for (const [name, change] of mutations) {
    const help = { ...valid, ...change };
    const diagnosis = probeCodex((_command, args) => {
      const key = args.join(' ');
      if (key === '--version') return { status: 0, stdout: 'codex-cli 0.143.0' };
      if (key === '--help') return { status: 0, stdout: help.root };
      if (key === 'exec --help') return { status: 0, stdout: help.exec };
      if (key === 'exec resume --help') return { status: 0, stdout: help.resume };
      return { status: 0, stdout: 'Logged in using ChatGPT' };
    });
    assert.equal(diagnosis.compatible, false, name);
    assert.equal(diagnosis.unavailableCode, 'incompatible', name);
  }
});

function fixture(t, options = {}) {
  const target = mkdtempSync(join(tmpdir(), 'sandpaper-diagnostics-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  writeFileSync(join(target, 'package.json'), '{"name":"fixture"}\n');
  const log = console.log;
  console.log = () => {};
  try { installSkill(target, PACKAGE, options); } finally { console.log = log; }
  return target;
}

function readyRun(command, args) {
  return command === 'claude'
    ? claudeRun().run(command, args)
    : codexRun().run(command, args);
}

test('installation inspection verifies selected bytes and reports Codex trust separately', (t) => {
  const target = fixture(t);
  const result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  assert.deepEqual(result.problems, []);
  assert.equal(result.defaultProvider, 'claude');
  assert.deepEqual(result.integrations, ['claude', 'codex']);
  assert.equal(result.hooksEnabled, true);
  assert.equal(result.providers.claude.authMethod, 'subscription');
  assert.equal(result.providers.codex.authMethod, 'chatgpt');
  assert.ok(result.warnings.some(({ code, repair }) => code === 'codex-hook-trust' && /\/hooks/.test(repair)));
  assert.doesNotMatch(JSON.stringify(result), /private@example|Secret Org|sk-secret|SESSION_SECRET/);
});

test('inspection makes selected provider drift a problem and unselected readiness a warning', (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  rmSync(join(target, '.claude', 'commands', 'sandpaper', 'help.md'));
  const result = inspectInstallation(target, PACKAGE, {
    runCommand(command, args) {
      if (command === 'codex') return missingRun(command, args);
      return claudeRun().run(command, args);
    },
  });
  assert.ok(result.problems.some(({ code, repair }) => code === 'claude-tree-drift'
    && repair === 'npx @nynb/sandpaper upgrade'));
  assert.ok(result.warnings.some(({ code }) => code === 'codex-binary-missing'));
  assert.equal(result.problems.some(({ code }) => code.startsWith('codex-')), false);
});

test('managed block inspection accepts LF or CRLF user files without a final newline', (t) => {
  for (const provider of ['claude', 'codex']) {
    for (const newline of ['\n', '\r\n']) {
      const target = fixture(t, { integrations: [provider], defaultProvider: provider, hooksEnabled: false });
      const contract = integrationContract(provider);
      const content = contract.managedContent.replaceAll('\n', newline);
      writeFileSync(join(target, contract.managedFile), [
        '# User prose',
        'Keep this.',
        contract.markers.begin,
        content,
        contract.markers.end,
      ].join(newline));

      const result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
      assert.equal(result.problems.some(({ code }) => code === `${provider}-managed-block-drift`), false, `${provider}:${JSON.stringify(newline)}`);
    }
  }
});

test('unsafe selected managed paths are classified before drift with reversible repair', {
  skip: process.platform === 'win32',
}, (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const managed = join(target, 'CLAUDE.md');
  const outside = join(target, 'outside-user-rules.md');
  writeFileSync(outside, 'private outside rules\n');
  rmSync(managed);
  symlinkSync(outside, managed);

  const result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  const unsafe = result.problems.find(({ code }) => code === 'claude-managed-block-unsafe');
  assert.ok(unsafe);
  assert.match(unsafe.repair, /unoccupied.*timestamp|timestamp.*suffix/i);
  assert.doesNotMatch(unsafe.repair, /upgrade/);
  assert.doesNotMatch(unsafe.repair, /\brun\b/i);
  assert.equal(result.problems.some(({ code }) => code === 'claude-managed-block-drift'), false);
  assert.equal(readFileSync(outside, 'utf8'), 'private outside rules\n');
});

test('unsafe generated trees and shared scripts require reversible path repair before upgrade', {
  skip: process.platform === 'win32',
}, (t) => {
  const treeTarget = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const tree = join(treeTarget, '.claude', 'commands', 'sandpaper');
  const outsideTree = join(treeTarget, 'outside-tree');
  mkdirSync(outsideTree);
  rmSync(tree, { recursive: true });
  symlinkSync(outsideTree, tree);
  let result = inspectInstallation(treeTarget, PACKAGE, { runCommand: readyRun });
  const treeUnsafe = result.problems.find(({ code }) => code === 'claude-tree-unsafe');
  assert.ok(treeUnsafe);
  assert.match(treeUnsafe.repair, /unoccupied.*timestamp|timestamp.*suffix/i);
  assert.match(treeUnsafe.repair, /npx @nynb\/sandpaper upgrade/);
  assert.doesNotMatch(treeUnsafe.repair, /\brun\b/i);
  assert.equal(result.problems.some(({ code }) => code === 'claude-tree-drift'), false);

  const scriptTarget = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const script = join(scriptTarget, '.sandpaper', 'hooks', 'brain-inject.js');
  const outsideScript = join(scriptTarget, 'outside-script.js');
  writeFileSync(outsideScript, 'outside script bytes\n');
  rmSync(script);
  symlinkSync(outsideScript, script);
  result = inspectInstallation(scriptTarget, PACKAGE, { runCommand: readyRun });
  const scriptUnsafe = result.problems.find(({ code }) => code === 'shared-hook-script-unsafe');
  assert.ok(scriptUnsafe);
  assert.match(scriptUnsafe.repair, /unoccupied.*timestamp|timestamp.*suffix/i);
  assert.match(scriptUnsafe.repair, /npx @nynb\/sandpaper upgrade/);
  assert.doesNotMatch(scriptUnsafe.repair, /\brun\b/i);
  assert.equal(readFileSync(outsideScript, 'utf8'), 'outside script bytes\n');
});

test('irrelevant invalid hook configs do not block unselected or hooks-disabled installs', (t) => {
  const target = fixture(t, { integrations: ['codex'], defaultProvider: 'codex', hooksEnabled: false });
  mkdirSync(join(target, '.codex'), { recursive: true });
  writeFileSync(join(target, '.codex', 'hooks.json'), '{ invalid selected-but-disabled');
  mkdirSync(join(target, '.claude'), { recursive: true });
  writeFileSync(join(target, '.claude', 'settings.json'), '{ invalid unselected');

  let result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  assert.equal(result.problems.some(({ code }) => code.includes('hook-config')), false);

  const manifest = join(target, '.sandpaper', 'manifest.json');
  const value = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, `${JSON.stringify({ ...value, hooksEnabled: true }, null, 2)}\n`);
  result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  const invalid = result.problems.find(({ code }) => code === 'codex-hook-config-invalid');
  assert.ok(invalid);
  assert.match(invalid.repair, /unoccupied.*timestamp|timestamp.*suffix/i);
  assert.doesNotMatch(invalid.repair, /upgrade/);
});

test('corrupt manifest and session repairs preserve bytes in explicit backup commands', (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  writeFileSync(join(target, '.sandpaper', 'session.json'), '{ corrupt session secret');
  writeFileSync(join(target, '.sandpaper', 'manifest.json'), '{ corrupt manifest secret');

  const result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  const manifest = result.problems.find(({ code }) => code === 'manifest-corrupt');
  const session = result.warnings.find(({ code }) => code === 'session-corrupt');
  assert.match(manifest.repair, /unoccupied.*timestamp|timestamp.*suffix/i);
  assert.doesNotMatch(manifest.repair, /upgrade/);
  assert.match(session.repair, /unoccupied.*timestamp|timestamp.*suffix/i);
  assert.doesNotMatch(JSON.stringify(result), /\brun\b/i);
});

test('unsafe unselected trees are distinct from ordinary stale drift and preserve manifest intent', {
  skip: process.platform === 'win32',
}, (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const manifest = join(target, '.sandpaper', 'manifest.json');
  const manifestBytes = readFileSync(manifest);
  const namespace = join(target, '.agents', 'skills', 'sandpaper');
  const outside = join(target, 'outside-unselected-tree');
  mkdirSync(join(target, '.agents', 'skills'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, namespace);

  const result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  const unsafe = result.warnings.find(({ code }) => code === 'codex-tree-unsafe-unselected');
  assert.ok(unsafe);
  assert.equal(result.warnings.some(({ code }) => code === 'codex-stale-tree'), false);
  assert.match(unsafe.repair, /unoccupied.*timestamp|timestamp.*suffix/i);
  assert.doesNotMatch(unsafe.repair, /upgrade only|^npx @nynb\/sandpaper upgrade$/i);
  assert.deepEqual(readFileSync(manifest), manifestBytes);
});

test('unsafe package integration source is a package problem, not target upgrade drift', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sandpaper-diagnostics-package-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'package');
  const outside = join(root, 'outside-help.md');
  cpSync(join(PACKAGE, 'skill'), join(packageRoot, 'skill'), { recursive: true });
  cpSync(join(PACKAGE, 'bin'), join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(outside, 'unsafe package source\n');
  const source = join(packageRoot, 'skill', 'sandpaper', 'commands', 'help.md');
  rmSync(source);
  symlinkSync(outside, source);
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const manifest = join(target, '.sandpaper', 'manifest.json');
  const before = readFileSync(manifest);

  const result = inspectInstallation(target, packageRoot, { runCommand: readyRun });
  const unsafe = result.problems.find(({ code }) => code === 'package-claude-source-unsafe');
  assert.ok(unsafe);
  assert.doesNotMatch(unsafe.repair, /^npx @nynb\/sandpaper upgrade$/);
  assert.match(unsafe.repair, /package|reinstall/i);
  assert.equal(result.problems.some(({ code }) => code === 'claude-tree-drift'), false);
  assert.deepEqual(readFileSync(manifest), before);
});

test('installation inspection makes missing selected readiness a problem without fallback', (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const result = inspectInstallation(target, PACKAGE, { runCommand: missingRun });
  assert.ok(result.problems.some(({ code, repair }) => code === 'claude-binary-missing' && /Claude Code/.test(repair)));
  assert.ok(result.warnings.some(({ code }) => code === 'codex-binary-missing'));
  assert.equal(result.defaultProvider, 'claude');
});

test('session inspection is read-only, redacted, and rejects symlinks', (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const session = join(target, '.sandpaper', 'session.json');
  writeFileSync(session, '{"version":2,"pages":{"/":{"claude":{"resumeId":"SESSION_SECRET"}}}}\n');
  let result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  assert.equal(result.warnings.some(({ code }) => code === 'session-corrupt'), false);
  assert.doesNotMatch(JSON.stringify(result), /SESSION_SECRET/);

  writeFileSync(session, '{"version":99,"resumeId":"SESSION_SECRET"}\n');
  result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  assert.ok(result.warnings.some(({ code }) => code === 'session-unsupported'));
  assert.doesNotMatch(JSON.stringify(result), /SESSION_SECRET/);

  rmSync(session);
  symlinkSync(join(target, 'private-session.json'), session);
  writeFileSync(join(target, 'private-session.json'), '{"sessionId":"SESSION_SECRET"}\n');
  result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  assert.ok(result.problems.some(({ code }) => code === 'session-unsafe'));
  assert.equal(readFileSync(join(target, 'private-session.json'), 'utf8'), '{"sessionId":"SESSION_SECRET"}\n');
  assert.doesNotMatch(JSON.stringify(result), /SESSION_SECRET/);
});

test('installation inspection rejects FIFO state without blocking or changing bytes', {
  skip: process.platform === 'win32',
}, (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const session = join(target, '.sandpaper', 'session.json');
  execFileSync('mkfifo', [session]);
  const started = Date.now();
  const result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  assert.ok(result.problems.some(({ code }) => code === 'session-unsafe'));
  assert.ok(Date.now() - started < 2_000);
});

test('inspection reports v1 migration residue without rewriting the manifest', (t) => {
  const target = fixture(t);
  const manifest = join(target, '.sandpaper', 'manifest.json');
  const value = JSON.parse(readFileSync(manifest, 'utf8'));
  const legacy = `${JSON.stringify({ ...value, version: 1, defaultProvider: undefined, integrations: undefined, hooksEnabled: undefined }, null, 2)}\n`;
  writeFileSync(manifest, legacy);
  const result = inspectInstallation(target, PACKAGE, { runCommand: readyRun });
  assert.ok(result.warnings.some(({ code }) => code === 'manifest-v1-residue'));
  assert.equal(readFileSync(manifest, 'utf8'), legacy);
});

test('doctor merges brain and installation health, prints bounded selections, and exits only for problems', (t) => {
  const target = fixture(t, { integrations: ['claude'], defaultProvider: 'claude', hooksEnabled: false });
  const lines = [];
  const log = console.log;
  const previousExitCode = process.exitCode;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const healthy = doctor(target, PACKAGE, {
      runCommand(command, args) {
        if (command === 'codex') return missingRun(command, args);
        return claudeRun().run(command, args);
      },
    });
    assert.equal(process.exitCode, 0);
    assert.deepEqual(healthy.installation.integrations, ['claude']);
    assert.equal(healthy.installation.defaultProvider, 'claude');
    assert.equal(healthy.installation.providers.claude.authMethod, 'subscription');
    const output = lines.join('\n');
    assert.match(output, /integrations.*claude/i);
    assert.match(output, /default provider.*claude/i);
    assert.match(output, /Claude Code.*subscription/i);
    assert.match(output, /warning.*Codex|Codex.*warning/i);
    assert.doesNotMatch(output, /private@example|Secret Org|sk-secret|stderr-secret/i);

    rmSync(join(target, '.claude', 'commands', 'sandpaper', 'help.md'));
    doctor(target, PACKAGE, { runCommand: readyRun });
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = log;
    process.exitCode = previousExitCode;
  }
});
