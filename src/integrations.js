import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import {
  ensureTrustedParents,
  identityTree,
  inspectTrustedPath,
  planManagedBlock,
  quarantineCleanup,
  sameIdentityTree,
  SandpaperRecoveryError,
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

export function integrationContract(provider) {
  if (!PROVIDERS.includes(provider)) throw new Error('Unknown Sandpaper integration');
  return {
    markers: { ...MARKERS },
    managedContent: MANAGED_CONTENT[provider],
    namespace: provider === 'claude'
      ? nodePath.join('.claude', 'commands', 'sandpaper')
      : nodePath.join('.agents', 'skills', 'sandpaper'),
    managedFile: provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md',
  };
}

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
  const readFlags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
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

function sameRecordedIdentity(left, right) {
  return Boolean(left && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.type === right.type);
}

function captureTree(path, pathClass, fs, pathApi) {
  const root = assertDirectory(path, pathClass, fs);
  const snapshot = emptySnapshot(root.mode & 0o777);
  const metadata = new Map([['', {
    identity: identity(root),
    kind: 'directory',
    mode: root.mode & 0o777,
  }]]);
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
        const mode = stats.mode & 0o777;
        snapshot.directories.set(relative, mode);
        metadata.set(relative, { identity: identity(stats), kind: 'directory', mode });
        walk(child, relative);
      } else if (stats.isFile()) {
        const file = readRegularFile(child, pathClass, fs);
        if (!sameRecordedIdentity(identity(stats), file.identity)) {
          throw new Error(`Sandpaper ${pathClass} changed during preflight`);
        }
        snapshot.files.set(relative, { bytes: Buffer.from(file.bytes), mode: file.mode });
        metadata.set(relative, {
          identity: file.identity,
          kind: 'file',
          mode: file.mode,
          bytes: Buffer.from(file.bytes),
        });
      } else {
        unsafe(pathClass, 'special file');
      }
    }
  };
  walk(path, '');
  return { snapshot, metadata };
}

function sameTreeMetadata(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const actual = right.get(path);
    if (!actual
      || actual.kind !== expected.kind
      || actual.mode !== expected.mode
      || !sameRecordedIdentity(actual.identity, expected.identity)) return false;
    if (expected.kind === 'file' && !actual.bytes.equals(expected.bytes)) return false;
  }
  return true;
}

function metadataIdentities(metadata) {
  return new Map([...metadata].map(([path, entry]) => [path, { ...entry.identity }]));
}

function scanTree(path, pathClass, fs, pathApi) {
  const captured = captureTree(path, pathClass, fs, pathApi);
  const verified = captureTree(path, pathClass, fs, pathApi);
  if (!sameTreeMetadata(captured.metadata, verified.metadata)) {
    throw new Error(`Sandpaper ${pathClass} changed during preflight`);
  }
  return {
    snapshot: captured.snapshot,
    identity: captured.metadata.get('').identity,
    identities: metadataIdentities(captured.metadata),
    metadata: captured.metadata,
  };
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

function writeExclusiveFile(path, file, fs, onCreate = () => {}) {
  const flags = fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(path, flags, file.mode);
  try {
    onCreate(path, fs.fstatSync(descriptor));
    fs.writeFileSync(descriptor, file.bytes);
    fs.fchmodSync(descriptor, file.mode);
  } finally {
    fs.closeSync(descriptor);
  }
}

function materializeSnapshot(path, snapshot, fs, pathApi, onCreate = () => {}) {
  fs.mkdirSync(path, { mode: snapshot.rootMode });
  onCreate(path, fs.lstatSync(path));
  fs.chmodSync(path, snapshot.rootMode);
  const directories = [...snapshot.directories].sort(([left], [right]) => {
    const depth = relativeParts(left, pathApi).length - relativeParts(right, pathApi).length;
    return depth || left.localeCompare(right);
  });
  for (const [relative, mode] of directories) {
    const directory = pathApi.join(path, relative);
    fs.mkdirSync(directory, { mode });
    onCreate(directory, fs.lstatSync(directory));
    fs.chmodSync(directory, mode);
  }
  for (const [relative, file] of [...snapshot.files].sort(([left], [right]) => left.localeCompare(right))) {
    writeExclusiveFile(pathApi.join(path, relative), file, fs, onCreate);
  }
}

function relativeTransactionPath(transaction, path, pathApi) {
  const relative = pathApi.relative(transaction, path);
  if (!relative || pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) {
    throw new Error('Sandpaper transaction ownership path is invalid');
  }
  return relative;
}

function ownCreatedPath(owned, transaction, path, stats, pathApi) {
  owned.set(relativeTransactionPath(transaction, path, pathApi), identity(stats));
}

function addOwnedArtifact(owned, transaction, artifact, identities, pathApi) {
  const prefix = relativeTransactionPath(transaction, artifact, pathApi);
  for (const [relative, artifactIdentity] of identities) {
    owned.set(relative ? pathApi.join(prefix, relative) : prefix, artifactIdentity);
  }
}

function removeOwnedArtifact(owned, transaction, artifact, pathApi) {
  const prefix = relativeTransactionPath(transaction, artifact, pathApi);
  for (const path of [...owned.keys()]) {
    if (path === prefix || path.startsWith(`${prefix}${pathApi.sep}`)) owned.delete(path);
  }
}

function ownedArtifactContents(owned, transaction, artifact, pathApi) {
  const prefix = relativeTransactionPath(transaction, artifact, pathApi);
  const contents = new Map();
  for (const [path, artifactIdentity] of owned) {
    if (path === prefix) contents.set('', artifactIdentity);
    else if (path.startsWith(`${prefix}${pathApi.sep}`)) {
      contents.set(path.slice(prefix.length + pathApi.sep.length), artifactIdentity);
    }
  }
  return contents;
}

function fileIdentityTree(fileIdentity) {
  return fileIdentity ? new Map([['', fileIdentity]]) : new Map();
}

function removeCreatedParents(created, fs) {
  for (const entry of [...created].reverse()) {
    const current = lstatIfPresent(entry.path, fs);
    if (!sameIdentity(current, entry.identity)) continue;
    try { fs.rmSync(entry.path); } catch { /* retain non-empty or concurrently changed parent */ }
  }
}

function validateCurrent(operation, fs, pathApi) {
  const current = lstatIfPresent(operation.destination, fs);
  if (!sameIdentity(current, operation.expectedIdentity)) {
    throw new Error('Sandpaper transaction path changed before commit');
  }
  if (current && operation.kind === 'directory') {
    const captured = captureTree(operation.destination, 'destination tree', fs, pathApi);
    if (!sameTreeMetadata(captured.metadata, operation.expectedMetadata)) {
      throw new Error('Sandpaper transaction contents changed before commit');
    }
  } else if (current && operation.kind === 'file') {
    if (!current.isFile()) throw new Error('Sandpaper transaction file changed before commit');
    const file = readRegularFile(operation.destination, 'managed file', fs);
    if (!sameRecordedIdentity(file.identity, operation.expectedIdentity)
      || !file.bytes.equals(operation.expectedBytes)
      || file.mode !== operation.expectedMode) {
      throw new Error('Sandpaper transaction file changed before commit');
    }
  }
  if (current && operation.kind === 'file'
    && !sameIdentityTree(identityTree(operation.destination, { fs, pathApi }), operation.expectedContents)) {
    throw new Error('Sandpaper transaction contents changed before commit');
  }
}

function validateBackup(operation, fs, pathApi) {
  if (operation.kind === 'directory') {
    const captured = captureTree(operation.backup, 'transaction backup', fs, pathApi);
    if (!sameTreeMetadata(captured.metadata, operation.expectedMetadata)) {
      throw new Error('Sandpaper backup contents mismatch');
    }
    return;
  }
  const file = readRegularFile(operation.backup, 'transaction backup', fs);
  if (!sameRecordedIdentity(file.identity, operation.expectedIdentity)
    || !file.bytes.equals(operation.expectedBytes)
    || file.mode !== operation.expectedMode) {
    throw new Error('Sandpaper backup contents mismatch');
  }
}

function rollbackTransaction(state) {
  const { fs, pathApi, transaction, transactionIdentity, operations, created, hooks, owned } = state;
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
        removeOwnedArtifact(owned, transaction, operation.staged, pathApi);
        addOwnedArtifact(owned, transaction, failed, operation.stageContents, pathApi);
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
          removeOwnedArtifact(owned, transaction, operation.backup, pathApi);
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

  if (recoveryRequired) {
    throw new SandpaperRecoveryError(transaction, {
      phase: 'precommit_recovery',
      destinationsCommitted: false,
    });
  }
  quarantineCleanup(transaction, transactionIdentity, {
    fs,
    pathApi,
    hooks,
    expectedContents: owned,
  });
  removeCreatedParents(created, fs);
}

function phaseRecovery(error, phase, destinationsCommitted) {
  if (!error || typeof error !== 'object') return error;
  error.phase = phase;
  error.destinationsCommitted = destinationsCommitted;
  return error;
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
  const owned = new Map();
  try {
    transaction = fs.mkdtempSync(pathApi.join(transactionParent, prefix));
    transactionIdentity = identity(assertDirectory(transaction, 'transaction', fs));
    const onCreate = (path, stats) => ownCreatedPath(owned, transaction, path, stats, pathApi);
    for (const [index, operation] of operations.entries()) {
      if (!operation.changed) continue;
      const safeLabel = operation.label.replace(/[^a-z0-9-]/gi, '-');
      const staged = operation.desired === null ? null : pathApi.join(transaction, `next-${safeLabel}`);
      hooks.beforeStage?.(operation);
      if (operation.snapshot) materializeSnapshot(staged, operation.snapshot, fs, pathApi, onCreate);
      else if (operation.file) writeExclusiveFile(staged, operation.file, fs, onCreate);
      const stageIdentity = staged ? identity(lstatIfPresent(staged, fs)) : null;
      if (staged && (!stageIdentity || stageIdentity.type !== operation.kind)) {
        throw new Error('Sandpaper staged artifact identity mismatch');
      }
      const stageContents = staged ? ownedArtifactContents(owned, transaction, staged, pathApi) : new Map();
      if (staged && !sameIdentityTree(identityTree(staged, { fs, pathApi }), stageContents)) {
        throw new Error('Sandpaper staged artifact contents mismatch');
      }
      prepared.push({
        ...operation,
        index,
        staged,
        stageIdentity,
        stageContents,
        backup: pathApi.join(transaction, operations.length === 1 ? 'previous' : `previous-${index}`),
        installedIdentity: null,
      });
    }
  } catch {
    if (transaction && transactionIdentity) {
      try {
        quarantineCleanup(transaction, transactionIdentity, {
          fs,
          pathApi,
          hooks,
          expectedContents: owned,
        });
      }
      catch (error) {
        if (error instanceof SandpaperRecoveryError) {
          throw phaseRecovery(error, 'precommit_prepare_cleanup', false);
        }
      }
    }
    removeCreatedParents(created, fs);
    throw new Error(`Could not prepare Sandpaper ${errorClass}`);
  }

  let settled = false;
  const state = { fs, pathApi, transaction, transactionIdentity, operations: prepared, created, hooks, owned };
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
          validateCurrent(operation, fs, pathApi);
          operation.validateInvariant?.();
          if (operation.expectedIdentity) {
            fs.renameSync(operation.destination, operation.backup);
            addOwnedArtifact(owned, transaction, operation.backup, operation.expectedContents, pathApi);
            if (!sameIdentity(lstatIfPresent(operation.backup, fs), operation.expectedIdentity)) {
              throw new Error('Sandpaper backup identity mismatch');
            }
            validateBackup(operation, fs, pathApi);
          }
          if (operation.staged) {
            fs.renameSync(operation.staged, operation.destination);
            removeOwnedArtifact(owned, transaction, operation.staged, pathApi);
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
          operation.validateInvariant?.();
        }
      } catch {
        settled = true;
        try { rollbackTransaction(state); }
        catch (error) { throw phaseRecovery(error, 'precommit_recovery', false); }
        throw new Error(`Could not commit Sandpaper ${errorClass}`);
      }
      settled = true;
      try {
        quarantineCleanup(transaction, transactionIdentity, {
          fs,
          pathApi,
          hooks,
          expectedContents: owned,
        });
      } catch (error) {
        throw phaseRecovery(error, 'postcommit_cleanup', true);
      }
      return true;
    },
    abort() {
      if (settled) return;
      settled = true;
      try {
        quarantineCleanup(transaction, transactionIdentity, {
          fs,
          pathApi,
          hooks,
          expectedContents: owned,
        });
      } catch (error) {
        throw phaseRecovery(error, 'precommit_abort_cleanup', false);
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
    expectedContents: destinationRead?.identities || new Map(),
    expectedMetadata: destinationRead?.metadata || new Map(),
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
  const expectedIdentity = identity(inspected);
  return {
    label,
    destination,
    kind: 'file',
    snapshot: null,
    file: plan.next === null ? null : { bytes: Buffer.from(plan.next), mode: plan.mode },
    desired: plan.next,
    changed: plan.changed,
    expectedIdentity,
    expectedContents: fileIdentityTree(expectedIdentity),
    expectedBytes: Buffer.from(plan.source),
    expectedMode: plan.mode,
  };
}

function externalFileOperation(target, descriptor, fs, pathApi) {
  if (!descriptor || typeof descriptor !== 'object' || !descriptor.label || !descriptor.destination) {
    throw new Error('Invalid Sandpaper file update');
  }
  const inspected = inspectTrustedPath(target, descriptor.destination, {
    fs,
    pathApi,
    pathClass: `${descriptor.label} path`,
  });
  if (inspected.exists && !inspected.stats.isFile()) unsafe(`${descriptor.label} path`, typeOf(inspected.stats));
  const existing = inspected.exists ? readRegularFile(descriptor.destination, descriptor.label, fs) : null;
  let desired;
  let desiredMode;

  if (descriptor.source) {
    inspectTrustedPath(descriptor.sourceRoot, descriptor.source, {
      fs,
      pathApi,
      pathClass: `${descriptor.label} source`,
      finalType: 'file',
    });
    const source = readRegularFile(descriptor.source, `${descriptor.label} source`, fs);
    desired = Buffer.from(source.bytes);
    desiredMode = source.mode;
  } else if (typeof descriptor.update === 'function') {
    const update = descriptor.update(existing ? Buffer.from(existing.bytes) : null);
    if (!update?.ok) throw new Error(update?.reason || `Invalid Sandpaper ${descriptor.label}`);
    desired = update.next === null ? null : Buffer.from(update.next);
    desiredMode = existing?.mode ?? descriptor.mode ?? 0o644;
  } else {
    throw new Error('Invalid Sandpaper file update');
  }

  const expectedIdentity = identity(inspected.stats);
  const changed = desired === null
    ? Boolean(existing)
    : !existing?.bytes.equals(desired) || existing.mode !== desiredMode;
  return {
    label: descriptor.label,
    destination: descriptor.destination,
    kind: 'file',
    snapshot: null,
    file: desired === null ? null : { bytes: desired, mode: desiredMode },
    desired,
    changed,
    expectedIdentity,
    expectedContents: fileIdentityTree(expectedIdentity),
    expectedBytes: existing ? Buffer.from(existing.bytes) : Buffer.alloc(0),
    expectedMode: existing?.mode ?? null,
  };
}

function externalFileOperations(target, descriptors, fs, pathApi) {
  if (!Array.isArray(descriptors)) throw new Error('Invalid Sandpaper file updates');
  return descriptors.map((descriptor) => externalFileOperation(target, descriptor, fs, pathApi));
}

export function prepareFileUpdates(target, descriptors, {
  fs: overrides,
  pathApi = nodePath,
  hooks,
} = {}) {
  const fs = runtimeFs(overrides);
  inspectTrustedPath(target, target, { fs, pathApi, pathClass: 'target root', finalType: 'directory' });
  const operations = externalFileOperations(target, descriptors, fs, pathApi);
  const transaction = prepareTransaction({
    trustedRoot: target,
    transactionParent: target,
    prefix: '.sandpaper-files-',
    operations,
    fs,
    pathApi,
    hooks,
    errorClass: 'file transaction',
  });
  return { ...transaction, changed: operations.some((operation) => operation.changed) };
}

export function prepareInstallIntegrations(target, packageRoot, options = {}, {
  fs: overrides,
  pathApi = nodePath,
  hooks,
  manifest = null,
  files = [],
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
    let namespaceContents = new Map();
    let namespaceMetadata = new Map();
    if (namespaceInspection.exists) {
      if (!namespaceInspection.stats.isDirectory()) unsafe('destination namespace', typeOf(namespaceInspection.stats));
      const namespaceRead = scanTree(namespace, 'destination namespace', fs, pathApi);
      namespaceIdentity = namespaceRead.identity;
      namespaceContents = namespaceRead.identities;
      namespaceMetadata = namespaceRead.metadata;
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
      expectedContents: namespaceContents,
      expectedMetadata: namespaceMetadata,
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
    const manifestSource = manifestInspection.exists ? readRegularFile(manifest.file, 'manifest file', fs) : null;
    const source = manifestSource ? manifestSource.bytes : Buffer.alloc(0);
    const desired = Buffer.from(manifest.bytes);
    const desiredMode = manifest.mode ?? 0o600;
    operations.push({
      label: 'manifest',
      destination: manifest.file,
      kind: 'file',
      snapshot: null,
      file: { bytes: desired, mode: desiredMode },
      desired,
      changed: !source.equals(desired) || manifestSource?.mode !== desiredMode,
      expectedIdentity: identity(manifestInspection.stats),
      expectedContents: fileIdentityTree(identity(manifestInspection.stats)),
      expectedBytes: source,
      expectedMode: manifestSource?.mode ?? null,
      validateInvariant: typeof manifest.validateInvariant === 'function' ? manifest.validateInvariant : null,
    });
  }

  operations.push(...externalFileOperations(target, files, fs, pathApi));

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
