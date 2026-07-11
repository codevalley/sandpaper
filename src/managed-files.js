import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const TEMP_ATTEMPTS = 8;
const TEMP_FLAGS = constants.O_CREAT
  | constants.O_EXCL
  | constants.O_WRONLY
  | (constants.O_NOFOLLOW || 0);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

function invalidMarkers() {
  return { ok: false, changed: false, error: 'Invalid Sandpaper markers' };
}

function occurrences(source, marker) {
  if (!marker) return [];
  const offsets = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const offset = source.indexOf(marker, cursor);
    if (offset === -1) break;
    offsets.push(offset);
    cursor = offset + marker.length;
  }
  return offsets;
}

function markerRegion(source, begin, end) {
  if (typeof begin !== 'string' || !begin || typeof end !== 'string' || !end || begin === end) {
    return invalidMarkers();
  }
  const begins = occurrences(source, begin);
  const ends = occurrences(source, end);
  if (begins.length > 1 || ends.length > 1 || begins.length !== ends.length) return invalidMarkers();
  if (!begins.length) return { ok: true, present: false };
  if (ends[0] < begins[0] + begin.length) return invalidMarkers();
  return {
    ok: true,
    present: true,
    start: begins[0],
    finish: ends[0] + end.length,
  };
}

function newlineFor(source) {
  return source.includes('\r\n') ? '\r\n' : '\n';
}

function normalizedContent(content, newline) {
  if (typeof content !== 'string') throw new TypeError('Sandpaper managed content must be text');
  return content.trim().replace(/\r\n|\r|\n/g, newline);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function nearestExisting(path) {
  let current = path;
  while (!lstatIfPresent(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

export function assertManagedPath(file) {
  const fileStats = lstatIfPresent(file);
  if (fileStats) {
    const stats = fileStats;
    if (stats.isSymbolicLink()) throw new Error('Sandpaper managed file is a symlink');
    if (!stats.isFile()) throw new Error('Sandpaper managed file is not a regular file');
  }
  const parent = nearestExisting(dirname(file));
  if (parent) {
    const stats = lstatSync(parent);
    if (stats.isSymbolicLink()) throw new Error('Sandpaper managed path contains a symlink');
    if (!stats.isDirectory()) throw new Error('Sandpaper managed path contains a special file');
  }
  return fileStats;
}

function readManagedFile(file) {
  let descriptor;
  try {
    descriptor = openSync(file, READ_FLAGS);
    if (!fstatSync(descriptor).isFile()) throw new Error('Sandpaper managed file is not a regular file');
    return readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error && error.code === 'ELOOP') throw new Error('Sandpaper managed file is a symlink');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function planManagedBlock(file, { begin, end, content }, { remove = false } = {}) {
  const stats = assertManagedPath(file);
  const exists = Boolean(stats);
  const source = exists ? readManagedFile(file) : '';
  const region = markerRegion(source, begin, end);
  if (!region.ok) return { ...region, source, exists, mode: stats ? stats.mode & 0o777 : 0o644 };

  if (remove) {
    if (!region.present) {
      return { ok: true, changed: false, action: exists ? 'unchanged' : 'absent', source, next: source, exists, mode: stats ? stats.mode & 0o777 : 0o644 };
    }
    const newline = newlineFor(source.slice(region.start, region.finish));
    let prefix = source.slice(0, region.start);
    const suffix = source.slice(region.finish);
    const trailingOwnedNewline = suffix === newline;
    if ((trailingOwnedNewline || suffix === '') && prefix.endsWith(newline)) {
      prefix = prefix.slice(0, -newline.length);
    }
    const next = prefix + (trailingOwnedNewline ? '' : suffix);
    return {
      ok: true,
      changed: true,
      action: next ? 'removed' : 'deleted',
      source,
      next: next || null,
      exists,
      mode: stats ? stats.mode & 0o777 : 0o644,
    };
  }

  if (typeof content !== 'string') throw new TypeError('Sandpaper managed content must be text');
  if (content.includes(begin) || content.includes(end)) return { ...invalidMarkers(), source, exists, mode: stats ? stats.mode & 0o777 : 0o644 };
  const newline = newlineFor(source);
  const block = `${begin}${newline}${normalizedContent(content, newline)}${newline}${end}`;
  const next = region.present
    ? source.slice(0, region.start) + block + source.slice(region.finish)
    : source
      ? `${source}${newline}${block}${newline}`
      : `${block}${newline}`;
  if (next === source) {
    return { ok: true, changed: false, action: 'unchanged', source, next, exists, mode: stats ? stats.mode & 0o777 : 0o644 };
  }
  return {
    ok: true,
    changed: true,
    action: region.present ? 'updated' : 'added',
    source,
    next,
    exists,
    mode: stats ? stats.mode & 0o777 : 0o644,
  };
}

function createTemporary(file, mode) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
    const suffix = randomBytes(16).toString('hex');
    const temporary = join(dirname(file), `.${basename(file)}.sandpaper-${suffix}`);
    try {
      const descriptor = openSync(temporary, TEMP_FLAGS, mode);
      return { descriptor, temporary };
    } catch (error) {
      if (error && (error.code === 'EEXIST' || error.code === 'ELOOP')) continue;
      throw new Error('Could not create Sandpaper managed temporary file');
    }
  }
  throw new Error('Could not create Sandpaper managed temporary file');
}

function applyPlan(file, plan) {
  if (!plan.ok || !plan.changed) return plan.ok
    ? { ok: true, changed: false, action: plan.action }
    : { ok: false, changed: false, error: plan.error };
  const current = assertManagedPath(file);
  if (Boolean(current) !== plan.exists || (plan.exists && readManagedFile(file) !== plan.source)) {
    throw new Error('Sandpaper managed file changed during update');
  }
  if (plan.next === null) {
    rmSync(file);
    return { ok: true, changed: true, action: plan.action };
  }

  const mode = plan.mode;
  const temporary = createTemporary(file, mode);
  let descriptor = temporary.descriptor;
  let path = temporary.temporary;
  try {
    writeFileSync(descriptor, plan.next);
    fchmodSync(descriptor, mode);
    closeSync(descriptor);
    descriptor = null;
    assertManagedPath(file);
    renameSync(path, file);
    path = null;
  } catch {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* retain bounded error */ }
    }
    if (path !== null) {
      try { rmSync(path, { force: true }); } catch { /* best effort for owned temporary */ }
    }
    throw new Error('Could not update Sandpaper managed file');
  }
  return { ok: true, changed: true, action: plan.action };
}

export function upsertManagedBlock(file, options) {
  return applyPlan(file, planManagedBlock(file, options));
}

export function removeManagedBlock(file, options) {
  return applyPlan(file, planManagedBlock(file, options, { remove: true }));
}
