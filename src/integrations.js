import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import {
  ensureTrustedParents,
  inspectTrustedPath,
  planManagedBlock,
} from './managed-files.js';

const PROVIDERS = ['claude', 'codex'];
const MARKERS = Object.freeze({
  begin: '<!-- sandpaper:begin -->',
  end: '<!-- sandpaper:end -->',
});

const MANAGED_CONTENT = Object.freeze({
  claude: [
    '## Sandpaper project brain',
    '',
    'Repository files are the shared truth for implementation and rendered output. `brain/` is the shared truth for durable intent, decisions, plans, progress, work history, and learnings.',
    'Read `brain/index.html` first. Enter through `/sandpaper:<action>` when working with the shared brain.',
  ].join('\n'),
  codex: [
    '## Sandpaper project brain',
    '',
    'Repository files are the shared truth for implementation and rendered output. `brain/` is the shared truth for durable intent, decisions, plans, progress, work history, and learnings.',
    'Read `brain/index.html` first. Enter through `$sandpaper <action>` when working with the shared brain.',
  ].join('\n'),
});

function runtimeFs(overrides) {
  return overrides ? { ...nodeFs, ...overrides } : nodeFs;
}

function lstatIfPresent(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new Error('Could not inspect Sandpaper filesystem path');
  }
}

function typeOf(stats) {
  if (!stats) return 'absent';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'special';
}

function identity(stats) {
  return stats ? { dev: stats.dev, ino: stats.ino, type: typeOf(stats) } : null;
}

function sameIdentity(stats, expected) {
  if (!stats || !expected) return !stats && !expected;
  return stats.dev === expected.dev && stats.ino === expected.ino && typeOf(stats) === expected.type;
}

function unsafe(pathClass, kind) {
  throw new Error(`Sandpaper ${pathClass} contains a ${kind}`);
}

function assertDirectory(path, pathClass, fs) {
  const stats = lstatIfPresent(path, fs);
  if (!stats) throw new Error(`Sandpaper ${pathClass} is missing`);
  if (stats.isSymbolicLink()) unsafe(pathClass, 'symlink');
  if (!stats.isDirectory()) unsafe(pathClass, 'special file');
  return stats;
}

function readRegularFile(path, pathClass, fs) {
  const before = lstatIfPresent(path, fs);
  if (!before) throw new Error(`Sandpaper ${pathClass} is missing`);
  if (before.isSymbolicLink()) unsafe(pathClass, 'symlink');
  if (!before.isFile()) unsafe(pathClass, 'special file');
  const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(path, readFlags);
    const during = fs.fstatSync(descriptor);
    if (!during.isFile()) unsafe(pathClass, 'special file');
    return { bytes: fs.readFileSync(descriptor), mode: during.mode & 0o777, identity: identity(during) };
  } catch (error) {
    if (error?.message?.startsWith('Sandpaper ')) throw error;
    if (error && error.code === 'ELOOP') unsafe(pathClass, 'symlink');
    throw new Error(`Could not read Sandpaper ${pathClass}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function emptySnapshot(rootMode = 0o755) {
  return { rootMode, directories: new Map(), files: new Map() };
}

function scanTree(path, pathClass, fs, pathApi) {
  const root = assertDirectory(path, pathClass, fs);
  const snapshot = emptySnapshot(root.mode & 0o777);
  const walk = (directory, prefix) => {
    let entries;
    try { entries = fs.readdirSync(directory).sort(); }
    catch { throw new Error(`Could not inspect Sandpaper ${pathClass}`); }
    for (const name of entries) {
      const child = pathApi.join(directory, name);
      const relative = prefix ? pathApi.join(prefix, name) : name;
      const stats = lstatIfPresent(child, fs);
      if (!stats) throw new Error(`Sandpaper ${pathClass} changed during preflight`);
      if (stats.isSymbolicLink()) unsafe(pathClass, 'symlink');
      if (stats.isDirectory()) {
        snapshot.directories.set(relative, stats.mode & 0o777);
        walk(child, relative);
      } else if (stats.isFile()) {
        snapshot.files.set(relative, readRegularFile(child, pathClass, fs));
      } else {
        unsafe(pathClass, 'special file');
      }
    }
  };
  walk(path, '');
  return { snapshot, identity: identity(root) };
}

function cloneSnapshot(snapshot) {
  const copy = emptySnapshot(snapshot.rootMode);
  for (const [path, mode] of snapshot.directories) copy.directories.set(path, mode);
  for (const [path, file] of snapshot.files) copy.files.set(path, { bytes: Buffer.from(file.bytes), mode: file.mode });
  return copy;
}

function relativeParts(path, pathApi) {
  return pathApi.normalize(path).split(pathApi.sep).filter(Boolean);
}

function addSnapshot(target, source, prefix, pathApi) {
  const qualify = (path) => prefix ? (path ? pathApi.join(prefix, path) : prefix) : path;
  if (prefix) {
    const parts = relativeParts(prefix, pathApi);
    for (let index = 1; index <= parts.length; index += 1) {
      const directory = pathApi.join(...parts.slice(0, index));
      if (target.files.has(directory)) throw new Error('Sandpaper destination tree has a path conflict');
      if (!target.directories.has(directory)) target.directories.set(directory, index === parts.length ? source.rootMode : 0o755);
    }
  }
  for (const [path, mode] of source.directories) {
    const destination = qualify(path);
    if (target.files.has(destination)) throw new Error('Sandpaper destination tree has a path conflict');
    if (!target.directories.has(destination)) target.directories.set(destination, mode);
  }
  for (const [path, file] of source.files) {
    const destination = qualify(path);
    if (target.files.has(destination) || target.directories.has(destination)) {
      throw new Error('Sandpaper destination tree has an existing file');
    }
    target.files.set(destination, { bytes: Buffer.from(file.bytes), mode: file.mode });
  }
}

function writeExclusiveFile(path, file, fs) {
  const flags = fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(path, flags, file.mode);
  try {
    fs.writeFileSync(descriptor, file.bytes);
    fs.fchmodSync(descriptor, file.mode);
  } finally {
    fs.closeSync(descriptor);
  }
}

function materializeSnapshot(path, snapshot, fs, pathApi) {
  fs.mkdirSync(path, { mode: snapshot.rootMode });
  fs.chmodSync(path, snapshot.rootMode);
  const directories = [...snapshot.directories].sort(([left], [right]) => {
    const depth = relativeParts(left, pathApi).length - relativeParts(right, pathApi).length;
    return depth || left.localeCompare(right);
  });
  for (const [relative, mode] of directories) {
    const directory = pathApi.join(path, relative);
    fs.mkdirSync(directory, { mode });
    fs.chmodSync(directory, mode);
  }
  for (const [relative, file] of [...snapshot.files].sort(([left], [right]) => left.localeCompare(right))) {
    writeExclusiveFile(pathApi.join(path, relative), file, fs);
  }
}

export class SandpaperRecoveryError extends Error {
  constructor(recoveryPath) {
    super('Sandpaper transaction recovery required');
    this.name = 'SandpaperRecoveryError';
    this.code = 'SANDPAPER_RECOVERY_REQUIRED';
    this.recoveryPath = recoveryPath;
  }
}

function safeRemoveTransaction(transaction, transactionIdentity, fs) {
  const current = lstatIfPresent(transaction, fs);
  if (!sameIdentity(current, transactionIdentity) || !current?.isDirectory()) return false;
  try {
    fs.rmSync(transaction, { recursive: true, force: true });
    return !lstatIfPresent(transaction, fs);
  } catch {
    return false;
  }
}

function removeCreatedParents(created, fs) {
  for (const entry of [...created].reverse()) {
    const current = lstatIfPresent(entry.path, fs);
    if (!sameIdentity(current, entry.identity)) continue;
    try { fs.rmSync(entry.path); } catch { /* retain non-empty or concurrently changed parent */ }
  }
}

function validateCurrent(operation, fs) {
  const current = lstatIfPresent(operation.destination, fs);
  if (!sameIdentity(current, operation.expectedIdentity)) {
    throw new Error('Sandpaper transaction path changed before commit');
  }
  if (current && operation.kind === 'file') {
    if (!current.isFile()) throw new Error('Sandpaper transaction file changed before commit');
    const bytes = readRegularFile(operation.destination, 'managed file', fs).bytes;
    if (!bytes.equals(operation.expectedBytes)) throw new Error('Sandpaper transaction file changed before commit');
  }
}

function rollbackTransaction(state) {
  const { fs, pathApi, transaction, transactionIdentity, operations, created } = state;
  let recoveryRequired = false;

  for (const operation of [...operations].reverse()) {
    const destinationStats = lstatIfPresent(operation.destination, fs);
    const backupStats = lstatIfPresent(operation.backup, fs);
    const installedExpected = operation.installedIdentity || operation.stageIdentity;
    const destinationIsInstalled = Boolean(installedExpected) && sameIdentity(destinationStats, installedExpected);
    const destinationIsOriginal = sameIdentity(destinationStats, operation.expectedIdentity);
    const backupIsOriginal = sameIdentity(backupStats, operation.expectedIdentity);

    if (destinationIsInstalled) {
      const failed = pathApi.join(transaction, `failed-${operation.index}`);
      try {
        fs.renameSync(operation.destination, failed);
        const moved = lstatIfPresent(failed, fs);
        if (!sameIdentity(moved, operation.installedIdentity || operation.stageIdentity)) recoveryRequired = true;
      } catch {
        recoveryRequired = true;
      }
    } else if (destinationStats && !destinationIsOriginal) {
      recoveryRequired = true;
    }

    if (backupStats) {
      if (!backupIsOriginal) {
        recoveryRequired = true;
      } else if (!lstatIfPresent(operation.destination, fs)) {
        try {
          fs.renameSync(operation.backup, operation.destination);
          if (!sameIdentity(lstatIfPresent(operation.destination, fs), operation.expectedIdentity)) recoveryRequired = true;
        } catch {
          recoveryRequired = true;
        }
      } else if (!sameIdentity(lstatIfPresent(operation.destination, fs), operation.expectedIdentity)) {
        recoveryRequired = true;
      }
    } else if (operation.expectedIdentity && !destinationIsOriginal) {
      recoveryRequired = true;
    }
  }

  if (recoveryRequired) return false;
  const cleaned = safeRemoveTransaction(transaction, transactionIdentity, fs);
  removeCreatedParents(created, fs);
  return cleaned;
}

function prepareTransaction({
  trustedRoot,
  transactionParent,
  prefix,
  operations,
  fs: overrides,
  pathApi = nodePath,
  hooks = {},
  errorClass,
}) {
  const fs = runtimeFs(overrides);
  const created = [];
  ensureTrustedParents(trustedRoot, pathApi.join(transactionParent, 'placeholder'), {
    fs,
    pathApi,
    pathClass: 'transaction path',
    onCreate(path, stats) { created.push({ path, identity: identity(stats) }); },
  });
  inspectTrustedPath(trustedRoot, transactionParent, {
    fs,
    pathApi,
    pathClass: 'transaction path',
    finalType: 'directory',
  });

  let transaction;
  let transactionIdentity;
  const prepared = [];
  try {
    transaction = fs.mkdtempSync(pathApi.join(transactionParent, prefix));
    transactionIdentity = identity(assertDirectory(transaction, 'transaction', fs));
    for (const [index, operation] of operations.entries()) {
      if (!operation.changed) continue;
      const safeLabel = operation.label.replace(/[^a-z0-9-]/gi, '-');
      const staged = operation.desired === null ? null : pathApi.join(transaction, `next-${safeLabel}`);
      hooks.beforeStage?.(operation);
      if (operation.snapshot) materializeSnapshot(staged, operation.snapshot, fs, pathApi);
      else if (operation.file) writeExclusiveFile(staged, operation.file, fs);
      const stageIdentity = staged ? identity(lstatIfPresent(staged, fs)) : null;
      if (staged && (!stageIdentity || stageIdentity.type !== operation.kind)) {
        throw new Error('Sandpaper staged artifact identity mismatch');
      }
      prepared.push({
        ...operation,
        index,
        staged,
        stageIdentity,
        backup: pathApi.join(transaction, operations.length === 1 ? 'previous' : `previous-${index}`),
        installedIdentity: null,
      });
    }
  } catch {
    if (transaction && transactionIdentity) safeRemoveTransaction(transaction, transactionIdentity, fs);
    removeCreatedParents(created, fs);
    throw new Error(`Could not prepare Sandpaper ${errorClass}`);
  }

  let settled = false;
  const state = { fs, pathApi, transaction, transactionIdentity, operations: prepared, created };
  return {
    recoveryPath: transaction,
    commit() {
      if (settled) throw new Error('Sandpaper transaction is already settled');
      try {
        for (const operation of prepared) {
          ensureTrustedParents(trustedRoot, operation.destination, {
            fs,
            pathApi,
            pathClass: 'destination path',
            onCreate(path, stats) { created.push({ path, identity: identity(stats) }); },
          });
          inspectTrustedPath(trustedRoot, pathApi.dirname(operation.destination), {
            fs,
            pathApi,
            pathClass: 'destination path',
            finalType: 'directory',
          });
          validateCurrent(operation, fs);
          if (operation.expectedIdentity) {
            fs.renameSync(operation.destination, operation.backup);
            if (!sameIdentity(lstatIfPresent(operation.backup, fs), operation.expectedIdentity)) {
              throw new Error('Sandpaper backup identity mismatch');
            }
          }
          if (operation.staged) {
            fs.renameSync(operation.staged, operation.destination);
            const installed = lstatIfPresent(operation.destination, fs);
            if (!sameIdentity(installed, operation.stageIdentity)) throw new Error('Sandpaper installed identity mismatch');
            operation.installedIdentity = identity(installed);
            hooks.afterInstall?.({
              label: operation.label,
              destination: operation.destination,
              identity: operation.installedIdentity,
            });
          }
        }
        for (const operation of prepared) {
          const current = lstatIfPresent(operation.destination, fs);
          if (operation.staged && !sameIdentity(current, operation.installedIdentity)) {
            throw new Error('Sandpaper installed path changed before cleanup');
          }
          if (!operation.staged && current) throw new Error('Sandpaper removed path reappeared before cleanup');
        }
      } catch {
        settled = true;
        if (!rollbackTransaction(state)) throw new SandpaperRecoveryError(transaction);
        throw new Error(`Could not commit Sandpaper ${errorClass}`);
      }
      settled = true;
      if (!safeRemoveTransaction(transaction, transactionIdentity, fs)) {
        throw new SandpaperRecoveryError(transaction);
      }
      return true;
    },
    abort() {
      if (settled) return;
      settled = true;
      if (!safeRemoveTransaction(transaction, transactionIdentity, fs)) {
        throw new SandpaperRecoveryError(transaction);
      }
      removeCreatedParents(created, fs);
    },
  };
}

export function copyTree(source, destination, {
  overwriteNamespaced,
  sourceRoot,
  destinationRoot,
  fs: overrides,
  pathApi = nodePath,
  hooks,
} = {}) {
  if (typeof overwriteNamespaced !== 'boolean') throw new TypeError('Sandpaper copyTree requires overwriteNamespaced');
  if (!sourceRoot || !destinationRoot) throw new TypeError('Sandpaper copyTree requires trusted source and destination roots');
  const fs = runtimeFs(overrides);
  inspectTrustedPath(sourceRoot, source, { fs, pathApi, pathClass: 'source path', finalType: 'directory' });
  const sourceRead = scanTree(source, 'source tree', fs, pathApi);
  const destinationInspection = inspectTrustedPath(destinationRoot, destination, { fs, pathApi, pathClass: 'destination path' });
  if (destinationInspection.exists && !destinationInspection.stats.isDirectory()) unsafe('destination tree', typeOf(destinationInspection.stats));
  const destinationRead = destinationInspection.exists ? scanTree(destination, 'destination tree', fs, pathApi) : null;
  let desired = sourceRead.snapshot;
  if (!overwriteNamespaced && destinationRead) {
    desired = cloneSnapshot(destinationRead.snapshot);
    addSnapshot(desired, sourceRead.snapshot, '', pathApi);
  }
  const operation = {
    label: 'tree',
    destination,
    kind: 'directory',
    snapshot: desired,
    file: null,
    desired,
    changed: true,
    expectedIdentity: destinationRead?.identity || null,
    expectedBytes: null,
  };
  const transaction = prepareTransaction({
    trustedRoot: destinationRoot,
    transactionParent: pathApi.dirname(destination),
    prefix: `.${pathApi.basename(destination)}.sandpaper-`,
    operations: [operation],
    fs,
    pathApi,
    hooks,
    errorClass: 'destination tree',
  });
  transaction.commit();
  return { ok: true, changed: true, files: desired.files.size };
}

function integrationSnapshots(packageRoot, integrations, fs, pathApi) {
  assertDirectory(packageRoot, 'package root', fs);
  const sandpaper = pathApi.join(packageRoot, 'skill', 'sandpaper');
  const workflowPath = pathApi.join(sandpaper, 'references', 'workflows');
  inspectTrustedPath(packageRoot, workflowPath, { fs, pathApi, pathClass: 'source path', finalType: 'directory' });
  const workflows = scanTree(workflowPath, 'source tree', fs, pathApi).snapshot;
  const snapshots = {};

  if (integrations.includes('claude')) {
    const commandsPath = pathApi.join(sandpaper, 'commands');
    inspectTrustedPath(packageRoot, commandsPath, { fs, pathApi, pathClass: 'source path', finalType: 'directory' });
    const claude = cloneSnapshot(scanTree(commandsPath, 'source tree', fs, pathApi).snapshot);
    addSnapshot(claude, workflows, pathApi.join('references', 'workflows'), pathApi);
    snapshots.claude = claude;
  }

  if (integrations.includes('codex')) {
    const skillPath = pathApi.join(sandpaper, 'SKILL.md');
    inspectTrustedPath(packageRoot, skillPath, { fs, pathApi, pathClass: 'source path', finalType: 'file' });
    const skill = readRegularFile(skillPath, 'source tree', fs);
    const codex = emptySnapshot(0o755);
    addSnapshot(codex, workflows, pathApi.join('references', 'workflows'), pathApi);
    codex.files.set('SKILL.md', { bytes: Buffer.from(skill.bytes), mode: skill.mode });
    snapshots.codex = codex;
  }
  return snapshots;
}

function validateIntegrations(options = {}) {
  const integrations = options.integrations === undefined ? [...PROVIDERS] : options.integrations;
  if (!Array.isArray(integrations) || !integrations.length) throw new Error('Invalid Sandpaper integrations');
  if (integrations.some((provider) => !PROVIDERS.includes(provider))) throw new Error('Invalid Sandpaper integration provider');
  return PROVIDERS.filter((provider) => integrations.includes(provider));
}

function fileOperation({ label, destination, plan, fs }) {
  const inspected = lstatIfPresent(destination, fs);
  return {
    label,
    destination,
    kind: 'file',
    snapshot: null,
    file: plan.next === null ? null : { bytes: Buffer.from(plan.next), mode: plan.mode },
    desired: plan.next,
    changed: plan.changed,
    expectedIdentity: identity(inspected),
    expectedBytes: Buffer.from(plan.source),
  };
}

export function prepareInstallIntegrations(target, packageRoot, options = {}, {
  fs: overrides,
  pathApi = nodePath,
  hooks,
  manifest = null,
} = {}) {
  const fs = runtimeFs(overrides);
  const integrations = validateIntegrations(options);
  inspectTrustedPath(target, target, { fs, pathApi, pathClass: 'target root', finalType: 'directory' });
  const snapshots = integrationSnapshots(packageRoot, integrations, fs, pathApi);
  const definitions = {
    claude: {
      namespace: pathApi.join('.claude', 'commands', 'sandpaper'),
      managed: 'CLAUDE.md',
    },
    codex: {
      namespace: pathApi.join('.agents', 'skills', 'sandpaper'),
      managed: 'AGENTS.md',
    },
  };
  const operations = [];

  for (const provider of PROVIDERS) {
    const selected = integrations.includes(provider);
    const definition = definitions[provider];
    const namespace = pathApi.join(target, definition.namespace);
    const namespaceInspection = inspectTrustedPath(target, namespace, { fs, pathApi, pathClass: 'destination path' });
    let namespaceIdentity = null;
    if (namespaceInspection.exists) {
      if (!namespaceInspection.stats.isDirectory()) unsafe('destination namespace', typeOf(namespaceInspection.stats));
      namespaceIdentity = scanTree(namespace, 'destination namespace', fs, pathApi).identity;
    }
    operations.push({
      label: `${provider}-namespace`,
      destination: namespace,
      kind: 'directory',
      snapshot: selected ? snapshots[provider] : null,
      file: null,
      desired: selected ? snapshots[provider] : null,
      changed: selected || Boolean(namespaceIdentity),
      expectedIdentity: namespaceIdentity,
      expectedBytes: null,
    });

    const managed = pathApi.join(target, definition.managed);
    const plan = planManagedBlock(
      managed,
      { ...MARKERS, content: MANAGED_CONTENT[provider], trustedRoot: target },
      { remove: !selected, fs, pathApi },
    );
    if (!plan.ok) throw new Error('Invalid Sandpaper managed markers');
    operations.push(fileOperation({ label: `${provider}-managed`, destination: managed, plan, fs }));
  }

  if (manifest) {
    const manifestInspection = inspectTrustedPath(target, manifest.file, { fs, pathApi, pathClass: 'manifest path' });
    if (manifestInspection.exists && !manifestInspection.stats.isFile()) unsafe('manifest path', typeOf(manifestInspection.stats));
    const source = manifestInspection.exists ? readRegularFile(manifest.file, 'manifest file', fs).bytes : Buffer.alloc(0);
    const desired = Buffer.from(manifest.bytes);
    operations.push({
      label: 'manifest',
      destination: manifest.file,
      kind: 'file',
      snapshot: null,
      file: { bytes: desired, mode: manifest.mode ?? 0o600 },
      desired,
      changed: !source.equals(desired),
      expectedIdentity: identity(manifestInspection.stats),
      expectedBytes: source,
    });
  }

  const transaction = prepareTransaction({
    trustedRoot: target,
    transactionParent: target,
    prefix: '.sandpaper-integrations-',
    operations,
    fs,
    pathApi,
    hooks,
    errorClass: 'integration transaction',
  });
  return {
    ...transaction,
    integrations,
    claude: integrations.includes('claude'),
    codex: integrations.includes('codex'),
  };
}

export function installIntegrations(target, packageRoot, options = {}, dependencies = {}) {
  const transaction = prepareInstallIntegrations(target, packageRoot, options, dependencies);
  transaction.commit();
  return { integrations: transaction.integrations, claude: transaction.claude, codex: transaction.codex };
}
