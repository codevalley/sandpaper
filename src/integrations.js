import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { planManagedBlock } from './managed-files.js';

const PROVIDERS = ['claude', 'codex'];
const MARKERS = Object.freeze({
  begin: '<!-- sandpaper:begin -->',
  end: '<!-- sandpaper:end -->',
});
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
const WRITE_FLAGS = constants.O_CREAT
  | constants.O_EXCL
  | constants.O_WRONLY
  | (constants.O_NOFOLLOW || 0);

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

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function unsafe(pathClass, kind) {
  throw new Error(`Sandpaper ${pathClass} contains a ${kind}`);
}

function assertDirectory(path, pathClass) {
  const stats = lstatIfPresent(path);
  if (!stats) throw new Error(`Sandpaper ${pathClass} is missing`);
  if (stats.isSymbolicLink()) unsafe(pathClass, 'symlink');
  if (!stats.isDirectory()) unsafe(pathClass, 'special file');
  return stats;
}

function readRegularFile(path, pathClass) {
  const before = lstatIfPresent(path);
  if (!before) throw new Error(`Sandpaper ${pathClass} is missing`);
  if (before.isSymbolicLink()) unsafe(pathClass, 'symlink');
  if (!before.isFile()) unsafe(pathClass, 'special file');
  let descriptor;
  try {
    descriptor = openSync(path, READ_FLAGS);
    const during = fstatSync(descriptor);
    if (!during.isFile()) unsafe(pathClass, 'special file');
    const bytes = readFileSync(descriptor);
    return { bytes, mode: during.mode & 0o777 };
  } catch (error) {
    if (error && error.code === 'ELOOP') unsafe(pathClass, 'symlink');
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function emptySnapshot(rootMode = 0o755) {
  return { rootMode, directories: new Map(), files: new Map() };
}

function scanTree(path, pathClass) {
  const root = assertDirectory(path, pathClass);
  const snapshot = emptySnapshot(root.mode & 0o777);
  const walk = (directory, prefix) => {
    const entries = readdirSync(directory).sort();
    for (const name of entries) {
      const child = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = lstatIfPresent(child);
      if (!stats) throw new Error(`Sandpaper ${pathClass} changed during preflight`);
      if (stats.isSymbolicLink()) unsafe(pathClass, 'symlink');
      if (stats.isDirectory()) {
        snapshot.directories.set(relative, stats.mode & 0o777);
        walk(child, relative);
      } else if (stats.isFile()) {
        snapshot.files.set(relative, readRegularFile(child, pathClass));
      } else {
        unsafe(pathClass, 'special file');
      }
    }
  };
  walk(path, '');
  return snapshot;
}

function cloneSnapshot(snapshot) {
  const copy = emptySnapshot(snapshot.rootMode);
  for (const [path, mode] of snapshot.directories) copy.directories.set(path, mode);
  for (const [path, file] of snapshot.files) copy.files.set(path, { bytes: Buffer.from(file.bytes), mode: file.mode });
  return copy;
}

function addSnapshot(target, source, prefix = '') {
  const qualify = (path) => prefix ? (path ? `${prefix}/${path}` : prefix) : path;
  if (prefix) {
    const parts = prefix.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
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

function ensureStandaloneParent(path, pathClass) {
  let current = dirname(path);
  const missing = [];
  while (true) {
    const stats = lstatIfPresent(current);
    if (stats) {
      if (stats.isSymbolicLink()) unsafe(pathClass, 'symlink');
      if (!stats.isDirectory()) unsafe(pathClass, 'special file');
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error(`Sandpaper ${pathClass} has no directory parent`);
    current = parent;
  }
  for (const directory of missing.reverse()) mkdirSync(directory);
}

function writeExclusiveFile(path, file) {
  const descriptor = openSync(path, WRITE_FLAGS, file.mode);
  try {
    writeFileSync(descriptor, file.bytes);
    fchmodSync(descriptor, file.mode);
  } finally {
    closeSync(descriptor);
  }
}

function materializeSnapshot(path, snapshot) {
  mkdirSync(path, { mode: snapshot.rootMode });
  chmodSync(path, snapshot.rootMode);
  const directories = [...snapshot.directories].sort(([left], [right]) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth || left.localeCompare(right);
  });
  for (const [relative, mode] of directories) {
    const directory = join(path, ...relative.split('/'));
    mkdirSync(directory, { mode });
    chmodSync(directory, mode);
  }
  for (const [relative, file] of [...snapshot.files].sort(([left], [right]) => left.localeCompare(right))) {
    writeExclusiveFile(join(path, ...relative.split('/')), file);
  }
}

function replaceTree(destination, snapshot) {
  ensureStandaloneParent(destination, 'destination path');
  const parent = dirname(destination);
  const transaction = mkdtempSync(join(parent, `.${basename(destination)}.sandpaper-`));
  const staged = join(transaction, 'next');
  const previous = join(transaction, 'previous');
  let movedPrevious = false;
  let installed = false;
  try {
    materializeSnapshot(staged, snapshot);
    if (lstatIfPresent(destination)) {
      renameSync(destination, previous);
      movedPrevious = true;
    }
    renameSync(staged, destination);
    installed = true;
    rmSync(transaction, { recursive: true, force: true });
    return { ok: true, changed: true, files: snapshot.files.size };
  } catch {
    if (installed) {
      try { rmSync(destination, { recursive: true, force: true }); } catch { /* bounded rollback */ }
    }
    if (movedPrevious) {
      try { renameSync(previous, destination); } catch { /* bounded rollback */ }
    }
    try { rmSync(transaction, { recursive: true, force: true }); } catch { /* owned temporary */ }
    throw new Error('Could not replace Sandpaper destination tree');
  }
}

export function copyTree(source, destination, { overwriteNamespaced } = {}) {
  if (typeof overwriteNamespaced !== 'boolean') {
    throw new TypeError('Sandpaper copyTree requires overwriteNamespaced');
  }
  const sourceSnapshot = scanTree(source, 'source tree');
  const destinationStats = lstatIfPresent(destination);
  if (destinationStats?.isSymbolicLink()) unsafe('destination tree', 'symlink');
  if (destinationStats && !destinationStats.isDirectory()) unsafe('destination tree', 'special file');
  const destinationSnapshot = destinationStats ? scanTree(destination, 'destination tree') : null;
  if (overwriteNamespaced || !destinationSnapshot) return replaceTree(destination, sourceSnapshot);

  const merged = cloneSnapshot(destinationSnapshot);
  addSnapshot(merged, sourceSnapshot);
  return replaceTree(destination, merged);
}

function assertAnchoredPath(root, relative, pathClass, rootClass = 'target root') {
  assertDirectory(root, rootClass);
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const stats = lstatIfPresent(current);
    if (!stats) return;
    if (stats.isSymbolicLink()) unsafe(pathClass, 'symlink');
    if (index < parts.length - 1 && !stats.isDirectory()) unsafe(pathClass, 'special file');
  }
}

function ensureAnchoredParent(root, destination, created) {
  const relative = destination.slice(root.length + 1);
  const parts = dirname(relative).split('/').filter((part) => part && part !== '.');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stats = lstatIfPresent(current);
    if (stats) {
      if (stats.isSymbolicLink()) unsafe('destination path', 'symlink');
      if (!stats.isDirectory()) unsafe('destination path', 'special file');
    } else {
      mkdirSync(current);
      created.push(current);
    }
  }
}

function prefixedSnapshot(source, prefix) {
  const result = emptySnapshot(0o755);
  addSnapshot(result, source, prefix);
  return result;
}

function integrationSnapshots(packageRoot, integrations) {
  assertDirectory(packageRoot, 'package root');
  const sandpaper = join(packageRoot, 'skill', 'sandpaper');
  assertAnchoredPath(packageRoot, 'skill/sandpaper/references/workflows', 'source path', 'package root');
  const workflows = scanTree(join(sandpaper, 'references', 'workflows'), 'source tree');
  const snapshots = {};

  if (integrations.includes('claude')) {
    assertAnchoredPath(packageRoot, 'skill/sandpaper/commands', 'source path', 'package root');
    const commands = scanTree(join(sandpaper, 'commands'), 'source tree');
    const claude = cloneSnapshot(commands);
    addSnapshot(claude, workflows, 'references/workflows');
    snapshots.claude = claude;
  }

  if (integrations.includes('codex')) {
    assertAnchoredPath(packageRoot, 'skill/sandpaper/SKILL.md', 'source path', 'package root');
    const skill = readRegularFile(join(sandpaper, 'SKILL.md'), 'source tree');
    const codex = prefixedSnapshot(workflows, 'references/workflows');
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

function stageManagedFile(plan) {
  return { bytes: Buffer.from(plan.next), mode: plan.mode };
}

function removeEmptyCreatedDirectories(created) {
  for (const directory of [...created].reverse()) {
    try { rmSync(directory); } catch { /* preserve non-empty user parents */ }
  }
}

function applyOperations(target, operations) {
  const transaction = mkdtempSync(join(target, '.sandpaper-integrations-'));
  const prepared = [];
  const created = [];
  const applied = [];
  try {
    for (const [index, operation] of operations.entries()) {
      if (!operation.changed) continue;
      let staged = null;
      if (operation.snapshot) {
        staged = join(transaction, `next-${index}`);
        materializeSnapshot(staged, operation.snapshot);
      } else if (operation.file) {
        staged = join(transaction, `next-${index}`);
        writeExclusiveFile(staged, operation.file);
      }
      prepared.push({ ...operation, staged, backup: join(transaction, `previous-${index}`) });
    }

    for (const operation of prepared) {
      ensureAnchoredParent(target, operation.destination, created);
      const existing = lstatIfPresent(operation.destination);
      if (Boolean(existing) !== operation.expectedExists) {
        throw new Error('Sandpaper integration path changed during update');
      }
      if (existing?.isSymbolicLink()) unsafe('destination path', 'symlink');
      if (existing && operation.kind === 'directory' && !existing.isDirectory()) unsafe('destination path', 'special file');
      if (existing && operation.kind === 'file') {
        if (!existing.isFile()) unsafe('managed path', 'special file');
        const current = readRegularFile(operation.destination, 'managed file').bytes;
        if (!current.equals(operation.expectedBytes)) throw new Error('Sandpaper managed file changed during update');
      }
      const state = { ...operation, hadExisting: false, installed: false };
      applied.push(state);
      if (existing) {
        renameSync(operation.destination, operation.backup);
        state.hadExisting = true;
      }
      if (operation.staged) {
        renameSync(operation.staged, operation.destination);
        state.installed = true;
      }
    }
  } catch {
    for (const operation of [...applied].reverse()) {
      try {
        if (operation.installed && lstatIfPresent(operation.destination)) {
          rmSync(operation.destination, { recursive: true, force: true });
        }
        if (operation.hadExisting && lstatIfPresent(operation.backup)) renameSync(operation.backup, operation.destination);
      } catch { /* best effort within exact Sandpaper operation paths */ }
    }
    try { rmSync(transaction, { recursive: true, force: true }); } catch { /* owned temporary */ }
    removeEmptyCreatedDirectories(created);
    throw new Error('Could not install Sandpaper integration files');
  }
  try { rmSync(transaction, { recursive: true, force: true }); } catch { /* committed; leave only the owned backup transaction */ }
}

export function installIntegrations(target, packageRoot, options = {}) {
  const integrations = validateIntegrations(options);
  const snapshots = integrationSnapshots(packageRoot, integrations);
  const definitions = {
    claude: {
      namespace: '.claude/commands/sandpaper',
      managed: 'CLAUDE.md',
    },
    codex: {
      namespace: '.agents/skills/sandpaper',
      managed: 'AGENTS.md',
    },
  };
  const operations = [];

  for (const provider of PROVIDERS) {
    const selected = integrations.includes(provider);
    const definition = definitions[provider];
    const namespace = join(target, ...definition.namespace.split('/'));
    assertAnchoredPath(target, definition.namespace, 'destination path');
    const namespaceStats = lstatIfPresent(namespace);
    if (namespaceStats?.isSymbolicLink()) unsafe('destination namespace', 'symlink');
    if (namespaceStats && !namespaceStats.isDirectory()) unsafe('destination namespace', 'special file');
    if (namespaceStats) scanTree(namespace, 'destination namespace');
    operations.push({
      destination: namespace,
      snapshot: selected ? snapshots[provider] : null,
      changed: selected || Boolean(namespaceStats),
      expectedExists: Boolean(namespaceStats),
      kind: 'directory',
    });

    const managed = join(target, definition.managed);
    assertAnchoredPath(target, definition.managed, 'managed path');
    const plan = planManagedBlock(
      managed,
      { ...MARKERS, content: MANAGED_CONTENT[provider] },
      { remove: !selected },
    );
    if (!plan.ok) throw new Error('Invalid Sandpaper managed markers');
    operations.push({
      destination: managed,
      file: plan.changed && plan.next !== null ? stageManagedFile(plan) : null,
      changed: plan.changed,
      expectedExists: plan.exists,
      expectedBytes: Buffer.from(plan.source),
      kind: 'file',
    });
  }

  applyOperations(target, operations);
  return { integrations, claude: integrations.includes('claude'), codex: integrations.includes('codex') };
}
