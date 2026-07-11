// Safe, synchronous provider capability probes. These commands never perform a model turn,
// inspect credential files, or return command output other than the provider version string.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { inspectTrustedPath, planManagedBlock } from './managed-files.js';
import { inspectManifest } from './manifest.js';
import { inspectSessionState } from './session-store.js';
import { integrationContract } from './integrations.js';
import { inspectHookConfigSource } from './hooks.js';

const MAX_VERSION_LENGTH = 120;
const PROVIDERS = ['claude', 'codex'];

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

function safeVersion(value) {
  const line = String(value || '').split(/\r?\n/, 1)[0].trim();
  if (!line || /[\x00-\x1f\x7f]/.test(line)) return null;
  return line.slice(0, MAX_VERSION_LENGTH);
}

function withVersion(result, value) {
  const version = safeVersion(value);
  return version ? { ...result, version } : result;
}

export function diagnoseClaude(runCommand = defaultRunCommand) {
  const version = runProbe(runCommand, 'claude', ['--version']);
  if (missing(version)) return missingDiagnosis();
  if (version.status !== 0) {
    return {
      available: false,
      compatible: false,
      authMethod: null,
      unavailableCode: 'incompatible',
    };
  }
  const auth = runProbe(runCommand, 'claude', ['auth', 'status', '--json']);
  let status;
  try { status = JSON.parse(auth.stdout); }
  catch { status = null; }
  const structured = status && typeof status === 'object' && !Array.isArray(status)
    && typeof status.loggedIn === 'boolean';
  if (!structured) {
    return {
      available: false,
      compatible: false,
      authMethod: null,
      ...withVersion({}, version.stdout),
      unavailableCode: 'incompatible',
    };
  }
  if (auth.status !== 0 || !status.loggedIn) {
    return {
      available: false,
      compatible: true,
      authMethod: null,
      ...withVersion({}, version.stdout),
      unavailableCode: 'unauthenticated',
    };
  }
  const method = String(status.authMethod || '');
  const authMethod = /claude\.ai|subscription/i.test(method) || status.subscriptionType
    ? 'subscription'
    : /api/i.test(method) ? 'api-key' : 'unknown';
  return {
    available: true,
    compatible: true,
    authMethod,
    ...withVersion({}, version.stdout),
    unavailableCode: null,
  };
}

export function diagnoseCodex(runCommand = defaultRunCommand) {
  const version = runProbe(runCommand, 'codex', ['--version']);
  if (missing(version)) return missingDiagnosis();
  if (version.status !== 0) {
    return {
      available: false,
      compatible: false,
      authMethod: null,
      unavailableCode: 'incompatible',
    };
  }

  const rootHelp = runProbe(runCommand, 'codex', ['--help']);
  const execHelp = runProbe(runCommand, 'codex', ['exec', '--help']);
  const resumeHelp = runProbe(runCommand, 'codex', ['exec', 'resume', '--help']);
  const login = runProbe(runCommand, 'codex', ['login', 'status']);

  const sectionLines = (output, heading) => {
    const lines = String(output).split(/\r?\n/);
    const start = lines.findIndex((line) => line === `${heading}:`);
    if (start === -1) return [];
    const section = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^[A-Za-z][A-Za-z ]*:\s*$/.test(lines[index])) break;
      section.push(lines[index]);
    }
    return section;
  };
  const options = (output) => new Set(sectionLines(output, 'Options').flatMap((line) => {
    const match = line.match(/^\s*(?:-[A-Za-z],\s*)?(--[A-Za-z0-9][A-Za-z0-9-]*)(?:\s|$)/);
    return match ? [match[1]] : [];
  }));
  const exactCommand = (output, command) => sectionLines(output, 'Commands')
    .some((line) => new RegExp(`^\\s{2,}${command}(?:\\s{2,}|\\s*$)`).test(line));
  const rootOptions = options(rootHelp.stdout);
  const execOptions = options(execHelp.stdout);
  const resumeOptions = options(resumeHelp.stdout);
  const rootCompatible = rootHelp.status === 0
    && ['--ask-for-approval', '--sandbox', '--config', '--disable'].every((flag) => rootOptions.has(flag));
  const execCompatible = execHelp.status === 0
    && exactCommand(execHelp.stdout, 'resume')
    && ['--json', '--ignore-user-config', '--ignore-rules'].every((flag) => execOptions.has(flag));
  const resumeCompatible = resumeHelp.status === 0
    && /^Usage:\s+codex exec resume \[OPTIONS\] \[SESSION_ID\] \[PROMPT\]\s*$/m.test(resumeHelp.stdout)
    && ['--config', '--json', '--ignore-user-config', '--ignore-rules'].every((flag) => resumeOptions.has(flag));
  const compatible = rootCompatible && execCompatible && resumeCompatible;

  const loginOutput = `${login.stdout}\n${login.stderr}`;
  let authMethod = null;
  if (login.status === 0 && !/not\s+logged\s+in/i.test(loginOutput)) {
    if (/ChatGPT/i.test(loginOutput)) authMethod = 'chatgpt';
    else if (/API[ -]?key/i.test(loginOutput)) authMethod = 'api-key';
    else authMethod = 'unknown';
  }

  return {
    available: compatible && authMethod !== null,
    compatible,
    authMethod,
    ...withVersion({}, version.stdout),
    unavailableCode: !compatible ? 'incompatible' : authMethod ? null : 'unauthenticated',
  };
}

// Task 5 plan names; runtime callers keep diagnose* and therefore share exactly
// one contract rather than drifting into a second distribution-only probe.
export const probeClaude = diagnoseClaude;
export const probeCodex = diagnoseCodex;

function safeRead(root, file, pathClass) {
  let inspected;
  try {
    inspected = inspectTrustedPath(root, file, { pathClass });
  } catch {
    return { status: 'unsafe', bytes: null };
  }
  if (!inspected.exists) return { status: 'absent', bytes: null };
  if (!inspected.stats.isFile()) return { status: 'unsafe', bytes: null };
  const flags = constants.O_RDONLY
    | (constants.O_NOFOLLOW || 0)
    | (constants.O_NONBLOCK || 0);
  let descriptor;
  try {
    descriptor = openSync(file, flags);
    if (!fstatSync(descriptor).isFile()) return { status: 'unsafe', bytes: null };
    return { status: 'file', bytes: Buffer.from(readFileSync(descriptor)) };
  } catch {
    return { status: 'unsafe', bytes: null };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function collectTree(root, directory, pathClass) {
  let inspected;
  try {
    inspected = inspectTrustedPath(root, directory, { pathClass });
  } catch {
    return { status: 'unsafe', files: new Map() };
  }
  if (!inspected.exists) return { status: 'absent', files: new Map() };
  if (!inspected.stats.isDirectory()) return { status: 'unsafe', files: new Map() };
  const files = new Map();
  const walk = (current) => {
    let names;
    try { names = readdirSync(current).sort(); }
    catch { return false; }
    for (const name of names) {
      const child = join(current, name);
      let childInspection;
      try { childInspection = inspectTrustedPath(root, child, { pathClass }); }
      catch { return false; }
      if (!childInspection.exists || childInspection.stats.isSymbolicLink()) return false;
      if (childInspection.stats.isDirectory()) {
        if (!walk(child)) return false;
      } else if (childInspection.stats.isFile()) {
        const read = safeRead(root, child, pathClass);
        if (read.status !== 'file') return false;
        files.set(relative(directory, child).split(sep).join('/'), read.bytes);
      } else return false;
    }
    return true;
  };
  return walk(directory) ? { status: 'directory', files } : { status: 'unsafe', files: new Map() };
}

function expectedTree(packageRoot, provider) {
  const files = new Map();
  const add = (sourceDirectory, prefix = '') => {
    const tree = collectTree(packageRoot, sourceDirectory, 'package source tree');
    if (tree.status !== 'directory') return false;
    for (const [path, bytes] of tree.files) files.set(prefix ? `${prefix}/${path}` : path, bytes);
    return true;
  };
  const base = join(packageRoot, 'skill', 'sandpaper');
  if (provider === 'claude') {
    if (!add(join(base, 'commands'))) return { status: 'unsafe', files };
  } else {
    const skill = safeRead(packageRoot, join(base, 'SKILL.md'), 'package skill source');
    if (skill.status !== 'file') return { status: 'unsafe', files };
    files.set('SKILL.md', skill.bytes);
  }
  if (!add(join(base, 'references', 'workflows'), 'references/workflows')) {
    return { status: 'unsafe', files };
  }
  return { status: 'directory', files };
}

function equalTrees(left, right) {
  if (left.status !== 'directory' || right.status !== 'directory' || left.files.size !== right.files.size) return false;
  for (const [path, bytes] of left.files) {
    if (!right.files.get(path)?.equals(bytes)) return false;
  }
  return true;
}

function repairForProvider(provider, code) {
  if (code === 'unauthenticated') return provider === 'codex' ? 'codex login' : 'claude auth login';
  return provider === 'codex'
    ? 'Install or upgrade Codex CLI. Then execute: codex login'
    : 'Install or upgrade Claude Code. Then execute: claude auth login';
}

function driftRepair() {
  return 'npx @nynb/sandpaper upgrade';
}

function uniqueBackupRepair(path, next) {
  return `Move ${path} to a new unoccupied backup path using a unique timestamp/suffix. ${next}`;
}

function uniqueCopyRepair(path, next) {
  return `Copy ${path} to a new unoccupied backup path using a unique timestamp/suffix. ${next}`;
}

function entry(code, message, repair) {
  return { code, message: String(message).slice(0, 240), repair: String(repair).slice(0, 240) };
}

export function inspectInstallation(target, packageRoot, { runCommand = defaultRunCommand } = {}) {
  const problems = [];
  const warnings = [];
  const addProblem = (code, message, repair) => problems.push(entry(code, message, repair));
  const addWarning = (code, message, repair) => warnings.push(entry(code, message, repair));
  const manifestResult = inspectManifest(join(target, '.sandpaper', 'manifest.json'), { trustedRoot: target });

  if (manifestResult.status === 'absent') {
    addWarning('missing-manifest', 'No local Sandpaper manifest is installed.', 'npx @nynb/sandpaper init');
  } else if (manifestResult.status === 'legacy') {
    addWarning('manifest-v1-residue', 'Manifest schema v1 is supported migration residue.', 'npx @nynb/sandpaper upgrade');
  } else if (manifestResult.status === 'unsupported') {
    addProblem('manifest-unsupported', 'Manifest schema version is unsupported.', uniqueCopyRepair('.sandpaper/manifest.json', 'Manually repair it, preserving provider choices.'));
  } else if (manifestResult.status === 'unsafe') {
    addProblem('manifest-unsafe', 'Manifest path is a symlink or special/unsafe file.', uniqueBackupRepair('.sandpaper/manifest.json', 'Restore a regular manifest preserving provider choices.'));
  } else if (manifestResult.status === 'corrupt') {
    addProblem('manifest-corrupt', 'Manifest JSON or schema is invalid.', uniqueCopyRepair('.sandpaper/manifest.json', 'Manually repair JSON preserving provider choices.'));
  }

  const manifest = manifestResult.manifest;
  const integrations = manifest?.integrations || [];
  const defaultProvider = manifest?.defaultProvider || null;
  const hooksEnabled = manifest?.hooksEnabled ?? null;
  const providers = {
    claude: probeClaude(runCommand),
    codex: probeCodex(runCommand),
  };

  for (const provider of PROVIDERS) {
    const diagnosis = providers[provider];
    const selected = integrations.includes(provider);
    if (!diagnosis.available) {
      const suffix = String(diagnosis.unavailableCode || 'unavailable').replaceAll('_', '-');
      const add = selected || provider === defaultProvider ? addProblem : addWarning;
      add(`${provider}-${suffix}`, `${provider === 'claude' ? 'Claude Code' : 'Codex'} is not ready (${suffix}).`, repairForProvider(provider, diagnosis.unavailableCode));
    }

    if (!manifest) continue;
    const contract = integrationContract(provider);
    const destination = join(target, contract.namespace);
    const actual = collectTree(target, destination, `${provider} integration tree`);
    const expected = expectedTree(packageRoot, provider);
    const current = equalTrees(actual, expected);
    if (expected.status === 'unsafe') {
      addProblem(
        `package-${provider}-source-unsafe`,
        `Executing package ${provider} integration source is missing or unsafe.`,
        'Repair or reinstall the executing Sandpaper package; target upgrade cannot repair package source.',
      );
    }
    if (actual.status === 'unsafe') {
      const add = selected ? addProblem : addWarning;
      add(
        selected ? `${provider}-tree-unsafe` : `${provider}-tree-unsafe-unselected`,
        `${provider === 'claude' ? 'Claude' : 'Codex'} generated integration tree is an unsafe path.`,
        uniqueBackupRepair(contract.namespace, 'Then execute: npx @nynb/sandpaper upgrade'),
      );
    } else if (expected.status === 'directory' && selected && !current) {
      addProblem(`${provider}-tree-drift`, `${provider === 'claude' ? 'Claude' : 'Codex'} generated integration tree is missing, stale, or unsafe.`, driftRepair());
    } else if (expected.status === 'directory' && !selected && actual.status !== 'absent') {
      addWarning(`${provider}-stale-tree`, `An unselected ${provider} generated integration tree remains.`, 'npx @nynb/sandpaper upgrade');
    }

    const managed = safeRead(target, join(target, contract.managedFile), `${provider} managed instructions`);
    let managedCurrent = false;
    let managedPresent = false;
    if (managed.status === 'unsafe') {
      addProblem(
        `${provider}-managed-block-unsafe`,
        `${contract.managedFile} is an unsafe path.`,
        uniqueBackupRepair(contract.managedFile, 'Restore a regular file preserving user rules. Then execute: npx @nynb/sandpaper doctor'),
      );
    } else if (managed.status === 'file') {
      const source = managed.bytes.toString('utf8');
      const { begin, end } = contract.markers;
      const starts = source.split(begin).length - 1;
      const ends = source.split(end).length - 1;
      managedPresent = starts > 0 || ends > 0;
      const plan = planManagedBlock(join(target, contract.managedFile), {
        begin,
        end,
        content: contract.managedContent,
        trustedRoot: target,
      });
      managedCurrent = plan.ok && !plan.changed;
    }
    if (managed.status !== 'unsafe' && selected && !managedCurrent) {
      addProblem(`${provider}-managed-block-drift`, `${contract.managedFile} is missing the exact Sandpaper managed block or has unsafe markers.`, driftRepair());
    } else if (!selected && managedPresent) {
      addWarning(`${provider}-stale-managed-block`, `${contract.managedFile} retains an unselected Sandpaper block.`, 'npx @nynb/sandpaper upgrade');
    }

    const hookFile = join(target, provider === 'claude' ? '.claude/settings.json' : '.codex/hooks.json');
    const hookRead = safeRead(target, hookFile, `${provider} hook config`);
    let hookInspection = { status: hookRead.status, ownedCounts: {} };
    if (hookRead.status === 'file') hookInspection = inspectHookConfigSource(provider, hookRead.bytes);
    const hookRelevant = selected && hooksEnabled;
    if (hookRelevant && (hookInspection.status === 'unsafe' || hookInspection.status === 'invalid')) {
      const relativeHook = provider === 'claude' ? '.claude/settings.json' : '.codex/hooks.json';
      const repair = hookInspection.status === 'unsafe'
        ? uniqueBackupRepair(relativeHook, 'Restore regular valid JSON preserving user hooks. Then execute: npx @nynb/sandpaper doctor')
        : uniqueCopyRepair(relativeHook, 'Restore regular valid JSON preserving user hooks. Then execute: npx @nynb/sandpaper doctor');
      addProblem(
        `${provider}-hook-config-${hookInspection.status}`,
        `${provider === 'claude' ? 'Claude' : 'Codex'} hook configuration is invalid or unsafe.`,
        repair,
      );
    } else if (hookInspection.status === 'valid') {
      const owned = Object.values(hookInspection.ownedCounts);
      const exactOnce = owned.length > 0 && owned.every((count) => count === 1);
      const anyOwned = owned.some((count) => count > 0);
      if (hookRelevant && !exactOnce) {
        addProblem(`${provider}-hook-drift`, `${provider === 'claude' ? 'Claude' : 'Codex'} Sandpaper hooks are missing or duplicated.`, driftRepair());
      } else if ((!selected || !hooksEnabled) && anyOwned) {
        addWarning(`${provider}-disabled-hook-drift`, `Owned ${provider} hooks remain despite disabled or unselected intent.`, 'npx @nynb/sandpaper upgrade');
      }
    }
  }

  if (manifest) {
    for (const script of ['brain-inject.js', 'brain-stamp-check.js']) {
      const installed = safeRead(target, join(target, '.sandpaper', 'hooks', script), 'shared hook script');
      const packaged = safeRead(packageRoot, join(packageRoot, 'bin', script), 'package hook script');
      if (packaged.status === 'unsafe') {
        addProblem(
          'package-hook-script-unsafe',
          `Executing package hook script ${script} is missing or unsafe.`,
          'Repair or reinstall the executing Sandpaper package; target upgrade cannot repair package source.',
        );
      } else if (installed.status === 'unsafe') {
        addProblem(
          'shared-hook-script-unsafe',
          `Shared hook script ${script} is an unsafe path.`,
          uniqueBackupRepair(`.sandpaper/hooks/${script}`, 'Then execute: npx @nynb/sandpaper upgrade'),
        );
      } else if (packaged.status === 'file'
        && (installed.status !== 'file' || !installed.bytes.equals(packaged.bytes))) {
        addProblem('shared-hook-script-drift', `Shared hook script ${script} is missing, stale, or unsafe.`, 'npx @nynb/sandpaper upgrade');
      }
    }
  }

  const session = inspectSessionState(target);
  if (session.status === 'unsafe') {
    addProblem('session-unsafe', 'Session state path is a symlink or special/unsafe file.', uniqueBackupRepair('.sandpaper/session.json', 'Start Sandpaper with a new session.'));
  } else if (session.status === 'corrupt') {
    addWarning('session-corrupt', 'Session state is corrupt; resume safely fails closed.', uniqueBackupRepair('.sandpaper/session.json', 'Start Sandpaper with a new session.'));
  } else if (session.status === 'unsupported') {
    addWarning('session-unsupported', 'Session state schema is unsupported; resume safely fails closed.', uniqueBackupRepair('.sandpaper/session.json', 'Start Sandpaper with a new session.'));
  } else if (session.status === 'legacy') {
    addWarning('session-legacy', 'Legacy Claude session state will migrate on normal runtime use.', 'Start Sandpaper once to migrate this local resume state.');
  }

  if (manifest && hooksEnabled && integrations.includes('codex')) {
    addWarning('codex-hook-trust', 'Codex project and command-hook trust is an external prerequisite.', 'Review and trust the project at startup, then review commands through /hooks.');
  }

  return {
    problems,
    warnings,
    providers,
    manifestStatus: manifestResult.status,
    defaultProvider,
    integrations,
    hooksEnabled,
  };
}
