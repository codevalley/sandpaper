import * as nodeFs from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as nodePath from 'node:path';

const TEMP_ATTEMPTS = 8;

function runtimeFs(overrides) {
  return overrides ? { ...nodeFs, ...overrides } : nodeFs;
}

export class SandpaperRecoveryError extends Error {
  constructor(recoveryPath, { phase = 'unknown', destinationsCommitted = false } = {}) {
    super('Sandpaper transaction recovery required');
    this.name = 'SandpaperRecoveryError';
    this.code = 'SANDPAPER_RECOVERY_REQUIRED';
    this.recoveryPath = recoveryPath;
    this.phase = phase;
    this.destinationsCommitted = destinationsCommitted;
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

export function identityTree(root, { fs: overrides, pathApi = nodePath } = {}) {
  const fs = runtimeFs(overrides);
  const rootStats = lstatIfPresent(root, fs);
  if (!rootStats) throw new Error('Sandpaper owned artifact is missing');
  const entries = new Map([['', statIdentity(rootStats)]]);
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = pathApi.join(directory, name);
      const relative = prefix ? pathApi.join(prefix, name) : name;
      const stats = fs.lstatSync(path);
      entries.set(relative, statIdentity(stats));
      if (stats.isDirectory()) walk(path, relative);
    }
  };
  if (rootStats.isDirectory()) walk(root);
  return entries;
}

export function sameIdentityTree(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const actual = right.get(path);
    if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.type !== expected.type) return false;
  }
  return true;
}

function exactTreeError(detail = 'could not be inspected safely') {
  return new Error(`Sandpaper exact tree ${detail}`);
}

function readExactFile(path, expectedStats, fs) {
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(path, flags);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !sameStatIdentity(before, statIdentity(expectedStats))) {
      throw exactTreeError('regular file changed before descriptor read');
    }
    const mode = before.mode & 0o777;
    if (mode !== (expectedStats.mode & 0o777)) throw exactTreeError('file mode changed before descriptor read');
    const bytes = Buffer.from(fs.readFileSync(descriptor));
    const after = fs.fstatSync(descriptor);
    if (!after.isFile() || !sameStatIdentity(after, statIdentity(before)) || (after.mode & 0o777) !== mode) {
      throw exactTreeError('regular file changed during descriptor read');
    }
    return { bytes, mode, identity: statIdentity(after), type: 'file' };
  } catch (error) {
    if (error?.message?.startsWith('Sandpaper exact tree')) throw error;
    throw exactTreeError('regular file could not be read safely');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function scanExactTree(root, fs, pathApi) {
  const rootStats = lstatIfPresent(root, fs);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) throw exactTreeError('root is unsafe');
  const inventory = new Map([['', {
    type: 'directory',
    mode: rootStats.mode & 0o777,
    identity: statIdentity(rootStats),
  }]]);
  const walk = (directory, prefix, expectedDirectory) => {
    const currentDirectory = lstatIfPresent(directory, fs);
    if (!currentDirectory?.isDirectory()
      || !sameStatIdentity(currentDirectory, expectedDirectory.identity)
      || (currentDirectory.mode & 0o777) !== expectedDirectory.mode) {
      throw exactTreeError('directory changed during scan');
    }
    let names;
    try { names = fs.readdirSync(directory).sort(); }
    catch { throw exactTreeError('directory could not be read safely'); }
    for (const name of names) {
      const path = pathApi.join(directory, name);
      const relative = prefix ? pathApi.join(prefix, name) : name;
      let inspected;
      try {
        inspected = inspectTrustedPath(root, path, {
          fs,
          pathApi,
          pathClass: 'exact tree component',
        });
      } catch { throw exactTreeError('contains an unsafe component'); }
      const stats = inspected.stats;
      if (!inspected.exists || stats.isSymbolicLink()) throw exactTreeError('contains an unsafe component');
      if (stats.isDirectory()) {
        const entry = { type: 'directory', mode: stats.mode & 0o777, identity: statIdentity(stats) };
        inventory.set(relative, entry);
        walk(path, relative, entry);
        const verified = lstatIfPresent(path, fs);
        if (!verified?.isDirectory()
          || !sameStatIdentity(verified, entry.identity)
          || (verified.mode & 0o777) !== entry.mode) {
          throw exactTreeError('directory changed during scan');
        }
      } else if (stats.isFile()) {
        inventory.set(relative, readExactFile(path, stats, fs));
      } else {
        throw exactTreeError('contains a special file');
      }
    }
    const finalDirectory = lstatIfPresent(directory, fs);
    if (!finalDirectory?.isDirectory()
      || !sameStatIdentity(finalDirectory, expectedDirectory.identity)
      || (finalDirectory.mode & 0o777) !== expectedDirectory.mode) {
      throw exactTreeError('directory changed during scan');
    }
  };
  walk(root, '', inventory.get(''));
  return inventory;
}

export function sameExactTree(left, right) {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const actual = right.get(path);
    if (!actual
      || actual.type !== expected.type
      || actual.mode !== expected.mode
      || actual.identity.dev !== expected.identity.dev
      || actual.identity.ino !== expected.identity.ino
      || actual.identity.type !== expected.identity.type) return false;
    if (expected.type === 'file' && !actual.bytes.equals(expected.bytes)) return false;
  }
  return true;
}

export function captureExactTree(root, { fs: overrides, pathApi = nodePath } = {}) {
  const fs = runtimeFs(overrides);
  const first = scanExactTree(root, fs, pathApi);
  const second = scanExactTree(root, fs, pathApi);
  if (!sameExactTree(first, second)) throw exactTreeError('changed between validation scans');
  return first;
}

function sameExactTreeContents(left, right) {
  if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const actual = right.get(path);
    if (!actual || actual.type !== expected.type || actual.mode !== expected.mode) return false;
    if (expected.type === 'file' && !actual.bytes.equals(expected.bytes)) return false;
  }
  return true;
}

function exactDirectoryDescriptor(path, expectedIdentity, fs) {
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY || 0)
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
  const descriptor = fs.openSync(path, flags);
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isDirectory() || !sameStatIdentity(stats, expectedIdentity)) {
      throw exactTreeError('destination directory identity changed');
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function createExactDirectory(path, mode, fs) {
  fs.mkdirSync(path, { mode });
  const stats = fs.lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw exactTreeError('destination directory is unsafe');
  const identity = statIdentity(stats);
  const descriptor = exactDirectoryDescriptor(path, identity, fs);
  try { fs.fchmodSync(descriptor, mode); }
  finally { fs.closeSync(descriptor); }
  const verified = fs.lstatSync(path);
  if (!sameStatIdentity(verified, identity) || (verified.mode & 0o777) !== mode) {
    throw exactTreeError('destination directory changed during creation');
  }
  return identity;
}

function setExactDirectoryMode(path, identity, mode, fs) {
  const descriptor = exactDirectoryDescriptor(path, identity, fs);
  try { fs.fchmodSync(descriptor, mode); }
  finally { fs.closeSync(descriptor); }
  const verified = fs.lstatSync(path);
  if (!sameStatIdentity(verified, identity) || (verified.mode & 0o777) !== mode) {
    throw exactTreeError('destination directory changed during mode restoration');
  }
}

function createExactFile(path, entry, fs) {
  const flags = fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
  const descriptor = fs.openSync(path, flags, entry.mode);
  let identity;
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) throw exactTreeError('destination file is unsafe');
    identity = statIdentity(stats);
    fs.writeFileSync(descriptor, entry.bytes);
    fs.fchmodSync(descriptor, entry.mode);
    const verified = fs.fstatSync(descriptor);
    if (!verified.isFile()
      || !sameStatIdentity(verified, identity)
      || (verified.mode & 0o777) !== entry.mode) {
      throw exactTreeError('destination file changed during creation');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const installed = fs.lstatSync(path);
  if (!sameStatIdentity(installed, identity) || (installed.mode & 0o777) !== entry.mode) {
    throw exactTreeError('destination file identity changed');
  }
}

export function materializeExactTree(source, destination, {
  trustedRoot,
  fs: overrides,
  pathApi = nodePath,
} = {}) {
  if (typeof trustedRoot !== 'string' || !trustedRoot) {
    throw new TypeError('Sandpaper trusted root is required');
  }
  const fs = runtimeFs(overrides);
  inspectTrustedPath(trustedRoot, source, {
    fs,
    pathApi,
    pathClass: 'exact tree source',
    finalType: 'directory',
  });
  const destinationInspection = inspectTrustedPath(trustedRoot, destination, {
    fs,
    pathApi,
    pathClass: 'exact tree destination',
  });
  if (destinationInspection.exists) throw exactTreeError('destination is occupied');
  const sourceInventory = captureExactTree(source, { fs, pathApi });
  const rootEntry = sourceInventory.get('');
  const temporaryRootMode = rootEntry.mode | 0o700;
  const rootIdentity = createExactDirectory(destination, temporaryRootMode, fs);
  const verifyRoot = () => {
    const stats = lstatIfPresent(destination, fs);
    if (!stats?.isDirectory() || !sameStatIdentity(stats, rootIdentity)) {
      throw exactTreeError('destination root changed during restoration');
    }
  };
  const depth = (path) => path.split(pathApi.sep).filter(Boolean).length;
  const directories = [...sourceInventory]
    .filter(([path, entry]) => path && entry.type === 'directory')
    .sort(([left], [right]) => depth(left) - depth(right) || left.localeCompare(right));
  const directoryIdentities = new Map();
  for (const [relative, entry] of directories) {
    verifyRoot();
    const path = pathApi.join(destination, relative);
    inspectTrustedPath(destination, pathApi.dirname(path), {
      fs,
      pathApi,
      pathClass: 'exact tree destination parent',
      finalType: 'directory',
    });
    directoryIdentities.set(relative, createExactDirectory(path, entry.mode | 0o700, fs));
  }
  const files = [...sourceInventory]
    .filter(([path, entry]) => path && entry.type === 'file')
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [relative, entry] of files) {
    verifyRoot();
    const path = pathApi.join(destination, relative);
    inspectTrustedPath(destination, pathApi.dirname(path), {
      fs,
      pathApi,
      pathClass: 'exact tree destination parent',
      finalType: 'directory',
    });
    createExactFile(path, entry, fs);
  }
  for (const [relative, entry] of [...directories].sort(([left], [right]) => (
    depth(right) - depth(left) || right.localeCompare(left)
  ))) {
    verifyRoot();
    setExactDirectoryMode(
      pathApi.join(destination, relative),
      directoryIdentities.get(relative),
      entry.mode,
      fs,
    );
  }
  setExactDirectoryMode(destination, rootIdentity, rootEntry.mode, fs);
  if (!sameExactTree(captureExactTree(source, { fs, pathApi }), sourceInventory)) {
    throw exactTreeError('source changed during restoration');
  }
  if (!sameExactTreeContents(captureExactTree(destination, { fs, pathApi }), sourceInventory)) {
    throw exactTreeError('destination does not match source contents');
  }
  return { sourceInventory, rootIdentity };
}

function exactIdentityContents(inventory) {
  const identities = new Map();
  for (const [path, entry] of inventory || []) {
    if (path) identities.set(path, entry.identity);
  }
  return identities;
}

function transactionContents(transaction, fs, pathApi) {
  const snapshot = identityTree(transaction, { fs, pathApi });
  snapshot.delete('');
  return snapshot;
}

function transactionAt(path, transactionIdentity, fs) {
  const current = path ? lstatIfPresent(path, fs) : null;
  return Boolean(current?.isDirectory() && sameStatIdentity(current, transactionIdentity));
}

function locateTransaction(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi) {
  for (const candidate of [quarantinedTransaction, transaction]) {
    if (transactionAt(candidate, transactionIdentity, fs)) return candidate;
  }
  for (const directory of [quarantineRoot, pathApi.dirname(transaction)]) {
    const root = directory ? lstatIfPresent(directory, fs) : null;
    if (!root?.isDirectory()) continue;
    try {
      for (const name of fs.readdirSync(directory).sort()) {
        const candidate = pathApi.join(directory, name);
        if (transactionAt(candidate, transactionIdentity, fs)) return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi) {
  const located = locateTransaction(
    transaction,
    quarantinedTransaction,
    quarantineRoot,
    transactionIdentity,
    fs,
    pathApi,
  );
  if (located) return new SandpaperRecoveryError(located);
  if (quarantineRoot && lstatIfPresent(quarantineRoot, fs)?.isDirectory()) {
    try {
      if (fs.readdirSync(quarantineRoot).length) return new SandpaperRecoveryError(quarantineRoot);
    } catch { /* fall through to a bounded non-recovery error */ }
  }
  throw new Error('Sandpaper transaction recovery location is ambiguous');
}

export function quarantineCleanup(transaction, transactionIdentity, {
  fs: overrides,
  pathApi = nodePath,
  hooks = {},
  expectedContents = new Map(),
  expectedExactTree = null,
} = {}) {
  const fs = runtimeFs(overrides);
  const expectedIdentities = expectedExactTree ? exactIdentityContents(expectedExactTree) : expectedContents;
  const exactMatches = (path) => !expectedExactTree
    || sameExactTree(captureExactTree(path, { fs, pathApi }), expectedExactTree);
  const current = lstatIfPresent(transaction, fs);
  if (!sameStatIdentity(current, transactionIdentity) || !current?.isDirectory()) {
    throw recoveryForPhase(transaction, null, null, transactionIdentity, fs, pathApi);
  }
  try {
    if (!sameIdentityTree(transactionContents(transaction, fs, pathApi), expectedIdentities)
      || !exactMatches(transaction)) {
      throw new SandpaperRecoveryError(transaction);
    }
  } catch (error) {
    if (error instanceof SandpaperRecoveryError) throw error;
    throw recoveryForPhase(transaction, null, null, transactionIdentity, fs, pathApi);
  }

  let quarantineRoot;
  try {
    quarantineRoot = fs.mkdtempSync(pathApi.join(pathApi.dirname(transaction), '.sandpaper-quarantine-'));
  } catch {
    throw recoveryForPhase(transaction, null, null, transactionIdentity, fs, pathApi);
  }
  let quarantineIdentity;
  try { quarantineIdentity = statIdentity(fs.lstatSync(quarantineRoot)); }
  catch { throw recoveryForPhase(transaction, null, quarantineRoot, transactionIdentity, fs, pathApi); }
  const quarantinedTransaction = pathApi.join(quarantineRoot, 'transaction');
  try {
    hooks.beforeQuarantineRename?.({ transaction, quarantineRoot, quarantinedTransaction });
    const beforeMove = lstatIfPresent(transaction, fs);
    if (!sameStatIdentity(beforeMove, transactionIdentity)) {
      throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
    }
    if (!sameIdentityTree(transactionContents(transaction, fs, pathApi), expectedIdentities)
      || !exactMatches(transaction)) {
      throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
    }
    fs.renameSync(transaction, quarantinedTransaction);
    const moved = lstatIfPresent(quarantinedTransaction, fs);
    if (!sameStatIdentity(moved, transactionIdentity)) {
      throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
    }
    if (!sameIdentityTree(transactionContents(quarantinedTransaction, fs, pathApi), expectedIdentities)
      || !exactMatches(quarantinedTransaction)) {
      throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
    }
    hooks.beforeRecursiveCleanup?.({ quarantineRoot, quarantinedTransaction });
    const finalMoved = lstatIfPresent(quarantinedTransaction, fs);
    if (!sameStatIdentity(finalMoved, transactionIdentity)) {
      throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
    }
    if (!sameIdentityTree(transactionContents(quarantinedTransaction, fs, pathApi), expectedIdentities)
      || !exactMatches(quarantinedTransaction)) {
      throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
    }
    if (!sameStatIdentity(lstatIfPresent(quarantineRoot, fs), quarantineIdentity)) {
      throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
    }
  } catch (error) {
    if (error instanceof SandpaperRecoveryError) throw error;
    throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
  }

  // Node 18 has no portable directory-fd recursive removal. Keep this final gap hook-free:
  // the unpredictable quarantine path and immutable identity tree were revalidated immediately above.
  try {
    fs.rmSync(quarantinedTransaction, { recursive: true, force: true });
  } catch {
    throw recoveryForPhase(transaction, quarantinedTransaction, quarantineRoot, transactionIdentity, fs, pathApi);
  }
  try {
    fs.rmdirSync(quarantineRoot);
  } catch {
    throw new Error('Could not remove empty Sandpaper quarantine');
  }
  return true;
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
  const owned = new Map();
  let stageIdentity = null;
  let backupMoved = false;
  try {
    if (staged) {
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0);
      const descriptor = fs.openSync(staged, flags, plan.mode);
      try {
        stageIdentity = statIdentity(fs.fstatSync(descriptor));
        owned.set(pathApi.basename(staged), stageIdentity);
        fs.writeFileSync(descriptor, plan.next);
        fs.fchmodSync(descriptor, plan.mode);
      } finally { fs.closeSync(descriptor); }
      if (!sameStatIdentity(fs.lstatSync(staged), stageIdentity)) {
        throw new Error('Sandpaper managed stage identity mismatch');
      }
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
      owned.set(pathApi.basename(backup), plan.identity);
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
        owned.set(pathApi.basename(failed), stageIdentity);
        if (!sameStatIdentity(lstatIfPresent(failed, fs), stageIdentity)) recoveryRequired = true;
      } catch { recoveryRequired = true; }
    } else if (current && !(plan.exists && sameStatIdentity(current, plan.identity))) {
      recoveryRequired = true;
    }
    if (backupMoved) {
      if (!lstatIfPresent(file, fs)) {
        try {
          fs.renameSync(backup, file);
          owned.delete(pathApi.basename(backup));
          if (!sameStatIdentity(lstatIfPresent(file, fs), plan.identity)) recoveryRequired = true;
        } catch { recoveryRequired = true; }
      } else if (!sameStatIdentity(lstatIfPresent(file, fs), plan.identity)) {
        recoveryRequired = true;
      }
    }
    if (recoveryRequired) throw new SandpaperRecoveryError(transaction);
    quarantineCleanup(transaction, transactionIdentity, { fs, pathApi, hooks, expectedContents: owned });
    if (error?.message === 'Sandpaper managed file changed during update') throw error;
    throw new Error('Could not update Sandpaper managed file');
  }
  quarantineCleanup(transaction, transactionIdentity, { fs, pathApi, hooks, expectedContents: owned });
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
