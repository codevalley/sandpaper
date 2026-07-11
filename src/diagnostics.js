// Safe, synchronous provider capability probes. These commands never perform a model turn,
// inspect credential files, or return command output other than the provider version string.
import { spawnSync } from 'node:child_process';

function defaultRunCommand(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function runProbe(runCommand, command, args) {
  try {
    const value = runCommand(command, args) || {};
    const errorCode = value.error?.code || null;
    return {
      status: Number.isInteger(value.status) ? value.status : null,
      stdout: typeof value.stdout === 'string' ? value.stdout : '',
      stderr: typeof value.stderr === 'string' ? value.stderr : '',
      errorCode,
    };
  } catch (error) {
    return { status: null, stdout: '', stderr: '', errorCode: error?.code || 'COMMAND_FAILED' };
  }
}

function missing(result) {
  return result.errorCode === 'ENOENT';
}

function missingDiagnosis() {
  return {
    available: false,
    compatible: false,
    authMethod: null,
    unavailableCode: 'binary_missing',
  };
}

export function diagnoseClaude(runCommand = defaultRunCommand) {
  const version = runProbe(runCommand, 'claude', ['--version']);
  if (missing(version)) return missingDiagnosis();
  if (version.status !== 0) {
    return {
      available: true,
      compatible: false,
      authMethod: null,
      unavailableCode: 'incompatible',
    };
  }
  return {
    available: true,
    compatible: true,
    authMethod: 'unknown',
    version: version.stdout.trim(),
    unavailableCode: null,
  };
}

export function diagnoseCodex(runCommand = defaultRunCommand) {
  const version = runProbe(runCommand, 'codex', ['--version']);
  if (missing(version)) return missingDiagnosis();
  if (version.status !== 0) {
    return {
      available: true,
      compatible: false,
      authMethod: null,
      unavailableCode: 'incompatible',
    };
  }

  const rootHelp = runProbe(runCommand, 'codex', ['--help']);
  const execHelp = runProbe(runCommand, 'codex', ['exec', '--help']);
  const resumeHelp = runProbe(runCommand, 'codex', ['exec', 'resume', '--help']);
  const login = runProbe(runCommand, 'codex', ['login', 'status']);

  const rootCompatible = rootHelp.status === 0
    && ['--ask-for-approval', '--sandbox', '--config', '--disable']
      .every((flag) => rootHelp.stdout.includes(flag));
  const execCompatible = execHelp.status === 0
    && ['resume', '--json', '--ignore-user-config', '--ignore-rules']
      .every((flag) => execHelp.stdout.includes(flag));
  const resumeCompatible = resumeHelp.status === 0
    && /Usage:\s*codex\s+exec\s+resume/i.test(resumeHelp.stdout)
    && ['--config', '--json', '--ignore-user-config', '--ignore-rules', '[SESSION_ID]', '[PROMPT]']
      .every((value) => resumeHelp.stdout.includes(value));
  const compatible = rootCompatible && execCompatible && resumeCompatible;

  const loginOutput = `${login.stdout}\n${login.stderr}`;
  let authMethod = null;
  if (login.status === 0 && !/not\s+logged\s+in/i.test(loginOutput)) {
    if (/ChatGPT/i.test(loginOutput)) authMethod = 'chatgpt';
    else if (/API[ -]?key/i.test(loginOutput)) authMethod = 'api-key';
    else authMethod = 'unknown';
  }

  return {
    available: true,
    compatible,
    authMethod,
    version: version.stdout.trim(),
    unavailableCode: !compatible ? 'incompatible' : authMethod ? null : 'unauthenticated',
  };
}
