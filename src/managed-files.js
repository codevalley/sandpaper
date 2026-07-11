import * as nodeFs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as nodePath from 'node:path';

const TEMP_ATTEMPTS = 8;

function runtimeFs(overrides) {
  return overrides ? { ...nodeFs, ...overrides } : nodeFs;
}

export class SandpaperRecoveryError extends Error {
  constructor(recoveryPath) {
    super('Sandpaper transaction recovery required');
    this.name = 'SandpaperRecoveryError';
    this.code = 'SANDPAPER_RECOVERY_REQUIRED';
    this.recoveryPath = recoveryPath;
  }
}

export function statIdentity(stats) {
  if (!stats) return null;
  const type = stats.isDirectory() ? 'directory'
    : stats.isFile() ? 'file'
      : stats.isSymbolicLink() ? 'symlink' : 'special';
  return { dev: stats.dev, ino: stats.ino, type };
}

export function sameStatIdentity(stats, expected) {
  if (!stats || !expected) return !stats && !expected;
  const current = statIdentity(stats);
  return current.dev === expected.dev && current.ino === expected.ino && current.type === expected.type;
}

function boundedPathError(pathClass, detail) {
  return new Error(`Sandpaper ${pathClass} ${detail}`);
}

function lstatIfPresent(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw boundedPathError('filesystem path', 'could not be inspected');
  }
}

export function trustedPathParts(root, target, { pathApi = nodePath } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('Sandpaper trusted root is required');
  const resolvedRoot = pathApi.resolve(root);
  const resolvedTarget = pathApi.resolve(target);
  const relative = pathApi.relative(resolvedRoot, resolvedTarget);
  if (relative === '') return [];
  if (pathApi.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${pathApi.sep}`)) {
    throw boundedPathError('path', 'escapes its trusted root');
  }
  return relative.split(pathApi.sep).filter(Boolean);
}

export function trustedParentPaths(root, target, { pathApi = nodePath } = {}) {
  const resolvedRoot = pathApi.resolve(root);
  const parts = trustedPathParts(root, target, { pathApi }).slice(0, -1);
  const parents = [];
  let current = resolvedRoot;
  for (const part of parts) {
    current = pathApi.join(current, part);
    parents.push(current);
  }
  return parents;
}

export function inspectTrustedPath(root, target, {
  fs: overrides,
  pathApi = nodePath,
  pathClass = 'path',
  finalType = null,
} = {}) {
  const fs = runtimeFs(overrides);
  const resolvedRoot = pathApi.resolve(root);
  const parts = trustedPathParts(root, target, { pathApi });
  const rootStats = lstatIfPresent(resolvedRoot, fs);
  if (!rootStats) throw boundedPathError(pathClass, 'trusted root is missing');
  if (rootStats.isSymbolicLink()) throw boundedPathError(pathClass, 'trusted root is a symlink');
  if (!rootStats.isDirectory()) throw boundedPathError(pathClass, 'trusted root is not a directory');
  if (!parts.length) return { exists: true, stats: rootStats, path: resolvedRoot };

  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = pathApi.join(current, parts[index]);
    const stats = lstatIfPresent(current, fs);
    if (!stats) return { exists: false, stats: null, path: current, missingIndex: index };
    if (stats.isSymbolicLink()) throw boundedPathError(pathClass, 'contains a symlink');
    if (index < parts.length - 1 && !stats.isDirectory()) {
      throw boundedPathError(pathClass, 'contains a non-directory component');
    }
    if (index === parts.length - 1) {
      if (finalType === 'file' && !stats.isFile()) throw boundedPathError(pathClass, 'is not a regular file');
      if (finalType === 'directory' && !stats.isDirectory()) throw boundedPathError(pathClass, 'is not a directory');
      return { exists: true, stats, path: current };
    }
  }
  throw new Error('Sandpaper path inspection failed');
}

export function ensureTrustedParents(root, target, {
  fs: overrides,
  pathApi = nodePath,
  pathClass = 'path',
  onCreate = () => {},
} = {}) {
  const fs = runtimeFs(overrides);
  inspectTrustedPath(root, root, { fs, pathApi, pathClass, finalType: 'directory' });
  for (const parent of trustedParentPaths(root, target, { pathApi })) {
    const inspected = inspectTrustedPath(root, parent, { fs, pathApi, pathClass });
    if (!inspected.exists) {
      try {
        fs.mkdirSync(parent);
      } catch {
        throw boundedPathError(pathClass, 'parent creation failed');
      }
      const created = inspectTrustedPath(root, parent, { fs, pathApi, pathClass, finalType: 'directory' });
      onCreate(created.path, created.stats);
    } else if (!inspected.stats.isDirectory()) {
      throw boundedPathError(pathClass, 'contains a non-directory component');
    }
  }
}

function identitySnapshot(root, fs, pathApi) {
  const entries = new Map();
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = pathApi.join(directory, name);
      const relative = prefix ? pathApi.join(prefix, name) : name;
      const stats = fs.lstatSync(path);
      entries.set(relative, statIdentity(stats));
      if (stats.isDirectory()) walk(path, relative);
    }
  };
  walk(root);
  return entries;
}

function sameSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const actual = right.get(path);
    if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.type !== expected.type) return false;
  }
  return true;
}

export function quarantineCleanup(transaction, transactionIdentity, {
  fs: overrides,
  pathApi = nodePath,
  hooks = {},
} = {}) {
  const fs = runtimeFs(overrides);
  const current = lstatIfPresent(transaction, fs);
  if (!sameStatIdentity(current, transactionIdentity) || !current?.isDirectory()) {
    throw new SandpaperRecoveryError(transaction);
  }
  let expected;
  try { expected = identitySnapshot(transaction, fs, pathApi); }
  catch { throw new SandpaperRecoveryError(transaction); }

  const quarantineRoot = fs.mkdtempSync(pathApi.join(pathApi.dirname(transaction), '.sandpaper-quarantine-'));
  const quarantineIdentity = statIdentity(fs.lstatSync(quarantineRoot));
  const quarantinedTransaction = pathApi.join(quarantineRoot, 'transaction');
  try {
    hooks.beforeQuarantineRename?.({ transaction, quarantineRoot, quarantinedTransaction });
    const beforeMove = lstatIfPresent(transaction, fs);
    if (!sameStatIdentity(beforeMove, transactionIdentity)) throw new SandpaperRecoveryError(quarantineRoot);
    const beforeSnapshot = identitySnapshot(transaction, fs, pathApi);
    if (!sameSnapshot(beforeSnapshot, expected)) throw new SandpaperRecoveryError(quarantineRoot);
    fs.renameSync(transaction, quarantinedTransaction);
    const moved = lstatIfPresent(quarantinedTransaction, fs);
    if (!sameStatIdentity(moved, transactionIdentity)) throw new SandpaperRecoveryError(quarantineRoot);
    if (!sameSnapshot(identitySnapshot(quarantinedTransaction, fs, pathApi), expected)) {
      throw new SandpaperRecoveryError(quarantineRoot);
    }
    hooks.beforeRecursiveCleanup?.({ quarantineRoot, quarantinedTransaction });
    const finalMoved = lstatIfPresent(quarantinedTransaction, fs);
    if (!sameStatIdentity(finalMoved, transactionIdentity)) throw new SandpaperRecoveryError(quarantineRoot);
    if (!sameSnapshot(identitySnapshot(quarantinedTransaction, fs, pathApi), expected)) {
      throw new SandpaperRecoveryError(quarantineRoot);
    }
    fs.rmSync(quarantinedTransaction, { recursive: true, force: true });
    if (lstatIfPresent(quarantinedTransaction, fs)) throw new SandpaperRecoveryError(quarantineRoot);
    if (!sameStatIdentity(lstatIfPresent(quarantineRoot, fs), quarantineIdentity)) {
      throw new SandpaperRecoveryError(quarantineRoot);
    }
    fs.rmdirSync(quarantineRoot);
    return true;
  } catch (error) {
    if (error instanceof SandpaperRecoveryError) throw error;
    throw new SandpaperRecoveryError(quarantineRoot);
  }
}

function invalidMarkers() {
  return { ok: false, changed: false, error: 'Invalid Sandpaper markers' };
}

function markerBytes(marker) {
  return typeof marker === 'string' && marker ? Buffer.from(marker, 'utf8') : null;
}

function occurrences(source, marker) {
  if (!marker?.length) return [];
  const offsets = [];
  let cursor = 0;
  while (cursor <= source.length - marker.length) {
    const offset = source.indexOf(marker, cursor);
    if (offset === -1) break;
    offsets.push(offset);
    cursor = offset + marker.length;
  }
  return offsets;
}

function markerRegion(source, begin, end) {
  const beginBytes = markerBytes(begin);
  const endBytes = markerBytes(end);
  if (!beginBytes || !endBytes || begin === end) return invalidMarkers();
  const begins = occurrences(source, beginBytes);
  const ends = occurrences(source, endBytes);
  if (begins.length > 1 || ends.length > 1 || begins.length !== ends.length) return invalidMarkers();
  if (!begins.length) return { ok: true, present: false, beginBytes, endBytes };
  if (ends[0] < begins[0] + beginBytes.length) return invalidMarkers();
  return {
    ok: true,
    present: true,
    start: begins[0],
    finish: ends[0] + endBytes.length,
    beginBytes,
    endBytes,
  };
}

function newlineFor(source) {
  return source.indexOf(Buffer.from('\r\n')) !== -1 ? Buffer.from('\r\n') : Buffer.from('\n');
}

function normalizedContent(content, newline) {
  if (typeof content !== 'string') throw new TypeError('Sandpaper managed content must be text');
  const newlineText = newline.equals(Buffer.from('\r\n')) ? '\r\n' : '\n';
  return Buffer.from(content.trim().replace(/\r\n|\r|\n/g, newlineText), 'utf8');
}

function readManagedFile(file, fs) {
  const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(file, readFlags);
    if (!fs.fstatSync(descriptor).isFile()) throw boundedPathError('managed file', 'is not a regular file');
    return fs.readFileSync(descriptor);
  } catch (error) {
    if (error?.message?.startsWith('Sandpaper ')) throw error;
    if (error && error.code === 'ELOOP') throw boundedPathError('managed file', 'is a symlink');
    throw boundedPathError('managed file', 'could not be read');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function planManagedBlock(file, { begin, end, content, trustedRoot }, {
  remove = false,
  fs: overrides,
  pathApi = nodePath,
} = {}) {
  if (!trustedRoot) throw new TypeError('Sandpaper managed helper requires a trusted root');
  const fs = runtimeFs(overrides);
  const inspected = inspectTrustedPath(trustedRoot, file, {
    fs,
    pathApi,
    pathClass: 'managed path',
  });
  if (inspected.exists && !inspected.stats.isFile()) throw boundedPathError('managed file', 'is not a regular file');
  const exists = inspected.exists;
  const source = exists ? readManagedFile(file, fs) : Buffer.alloc(0);
  const region = markerRegion(source, begin, end);
  const mode = inspected.stats ? inspected.stats.mode & 0o777 : 0o644;
  const originalIdentity = statIdentity(inspected.stats);
  if (!region.ok) return { ...region, source, exists, mode, identity: originalIdentity };

  if (remove) {
    if (!region.present) {
      return { ok: true, changed: false, action: exists ? 'unchanged' : 'absent', source, next: source, exists, mode, identity: originalIdentity };
    }
    const prefix = source.subarray(0, region.start);
    const suffix = source.subarray(region.finish);
    const newline = newlineFor(source.subarray(region.start, region.finish));
    const whollyOwned = prefix.length === 0 && (suffix.length === 0 || suffix.equals(newline));
    const next = whollyOwned ? null : Buffer.concat([prefix, suffix]);
    return {
      ok: true,
      changed: true,
      action: whollyOwned ? 'deleted' : 'removed',
      source,
      next,
      exists,
      mode,
      identity: originalIdentity,
    };
  }

  if (typeof content !== 'string') throw new TypeError('Sandpaper managed content must be text');
  if (content.includes(begin) || content.includes(end)) return { ...invalidMarkers(), source, exists, mode, identity: originalIdentity };
  const newline = newlineFor(source);
  const block = Buffer.concat([
    region.beginBytes,
    newline,
    normalizedContent(content, newline),
    newline,
    region.endBytes,
  ]);
  let next;
  if (region.present) {
    next = Buffer.concat([source.subarray(0, region.start), block, source.subarray(region.finish)]);
  } else if (source.length) {
    next = Buffer.concat([source, block]);
  } else {
    next = Buffer.concat([block, newline]);
  }
  if (next.equals(source)) {
    return { ok: true, changed: false, action: 'unchanged', source, next, exists, mode, identity: originalIdentity };
  }
  return {
    ok: true,
    changed: true,
    action: region.present ? 'updated' : 'added',
    source,
    next,
    exists,
    mode,
    identity: originalIdentity,
  };
}

function createTemporary(file, mode, trustedRoot, fs, pathApi) {
  ensureTrustedParents(trustedRoot, file, { fs, pathApi, pathClass: 'managed path' });
  const tempFlags = fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
    const suffix = randomBytes(16).toString('hex');
    const temporary = pathApi.join(pathApi.dirname(file), `.${pathApi.basename(file)}.sandpaper-${suffix}`);
    try {
      const descriptor = fs.openSync(temporary, tempFlags, mode);
      return { descriptor, temporary };
    } catch (error) {
      if (error && (error.code === 'EEXIST' || error.code === 'ELOOP')) continue;
      throw new Error('Could not create Sandpaper managed temporary file');
    }
  }
  throw new Error('Could not create Sandpaper managed temporary file');
}

function currentMatchesPlan(file, plan, trustedRoot, fs, pathApi) {
  const inspected = inspectTrustedPath(trustedRoot, file, { fs, pathApi, pathClass: 'managed path' });
  if (inspected.exists !== plan.exists) return false;
  if (!plan.exists) return true;
  if (!inspected.stats.isFile()) return false;
  if (!sameStatIdentity(inspected.stats, plan.identity)) return false;
  return readManagedFile(file, fs).equals(plan.source);
}

function applyPlan(file, plan, trustedRoot, { fs: overrides, pathApi = nodePath, hooks = {} } = {}) {
  const fs = runtimeFs(overrides);
  if (!plan.ok || !plan.changed) return plan.ok
    ? { ok: true, changed: false, action: plan.action }
    : { ok: false, changed: false, error: plan.error };
  ensureTrustedParents(trustedRoot, file, { fs, pathApi, pathClass: 'managed path' });
  const transaction = fs.mkdtempSync(pathApi.join(pathApi.dirname(file), `.${pathApi.basename(file)}.sandpaper-managed-`));
  const transactionIdentity = statIdentity(fs.lstatSync(transaction));
  const staged = plan.next === null ? null : pathApi.join(transaction, 'next');
  const backup = pathApi.join(transaction, 'backup');
  const failed = pathApi.join(transaction, 'failed');
  let stageIdentity = null;
  let backupMoved = false;
  try {
    if (staged) {
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
      const descriptor = fs.openSync(staged, flags, plan.mode);
      try {
        fs.writeFileSync(descriptor, plan.next);
        fs.fchmodSync(descriptor, plan.mode);
      } finally { fs.closeSync(descriptor); }
      stageIdentity = statIdentity(fs.lstatSync(staged));
    }
    if (!currentMatchesPlan(file, plan, trustedRoot, fs, pathApi)) {
      throw new Error('Sandpaper managed file changed during update');
    }
    if (plan.exists) {
      hooks.beforeBackup?.({ file, transaction });
      if (!currentMatchesPlan(file, plan, trustedRoot, fs, pathApi)) {
        throw new Error('Sandpaper managed file changed during update');
      }
      fs.renameSync(file, backup);
      backupMoved = true;
      if (!sameStatIdentity(lstatIfPresent(backup, fs), plan.identity)) throw new Error('Sandpaper managed backup identity mismatch');
      hooks.afterBackup?.({ file, transaction, backup });
    }
    if (staged) {
      hooks.beforeInstall?.({ file, transaction, staged });
      fs.linkSync(staged, file);
      if (!sameStatIdentity(lstatIfPresent(file, fs), stageIdentity)) throw new Error('Sandpaper managed install identity mismatch');
    }
    const current = lstatIfPresent(file, fs);
    if (staged ? !sameStatIdentity(current, stageIdentity) : Boolean(current)) {
      throw new Error('Sandpaper managed destination changed before cleanup');
    }
  } catch (error) {
    let recoveryRequired = false;
    const current = lstatIfPresent(file, fs);
    if (stageIdentity && sameStatIdentity(current, stageIdentity)) {
      try {
        fs.renameSync(file, failed);
        if (!sameStatIdentity(lstatIfPresent(failed, fs), stageIdentity)) recoveryRequired = true;
      } catch { recoveryRequired = true; }
    } else if (current && !(plan.exists && sameStatIdentity(current, plan.identity))) {
      recoveryRequired = true;
    }
    if (backupMoved) {
      if (!lstatIfPresent(file, fs)) {
        try {
          fs.renameSync(backup, file);
          if (!sameStatIdentity(lstatIfPresent(file, fs), plan.identity)) recoveryRequired = true;
        } catch { recoveryRequired = true; }
      } else if (!sameStatIdentity(lstatIfPresent(file, fs), plan.identity)) {
        recoveryRequired = true;
      }
    }
    if (recoveryRequired) throw new SandpaperRecoveryError(transaction);
    quarantineCleanup(transaction, transactionIdentity, { fs, pathApi, hooks });
    if (error?.message === 'Sandpaper managed file changed during update') throw error;
    throw new Error('Could not update Sandpaper managed file');
  }
  quarantineCleanup(transaction, transactionIdentity, { fs, pathApi, hooks });
  return { ok: true, changed: true, action: plan.action };
}

export function upsertManagedBlock(file, options, dependencies = {}) {
  return applyPlan(file, planManagedBlock(file, options, dependencies), options.trustedRoot, dependencies);
}

export function removeManagedBlock(file, options, dependencies = {}) {
  return applyPlan(
    file,
    planManagedBlock(file, options, { ...dependencies, remove: true }),
    options.trustedRoot,
    dependencies,
  );
}
