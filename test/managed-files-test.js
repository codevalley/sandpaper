import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';

import { copyTree } from '../src/integrations.js';
import * as managed from '../src/managed-files.js';
import { removeManagedBlock, upsertManagedBlock } from '../src/managed-files.js';

const MARKERS = {
  begin: '<!-- sandpaper:begin -->',
  end: '<!-- sandpaper:end -->',
};

function fixture(t, prefix = 'sandpaper-managed-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function thrown(fn) {
  let error;
  assert.throws(fn, (value) => { error = value; return true; });
  return error;
}

function snapshot(root) {
  const entries = [];
  const walk = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = lstatSync(file);
      if (stats.isDirectory()) {
        entries.push({ path: `${relative}/`, mode: stats.mode & 0o777, type: 'directory' });
        walk(file, relative);
      } else {
        const type = stats.isSymbolicLink() ? 'symlink' : stats.isFile() ? 'file' : 'special';
        entries.push({
          path: relative,
          mode: stats.mode & 0o777,
          type,
          bytes: type === 'file' ? readFileSync(file).toString('base64') : null,
        });
      }
    }
  };
  walk(root);
  return entries;
}

test('managed blocks append, update, converge, and remove with exact outside bytes', (t) => {
  const root = fixture(t);
  const file = join(root, 'AGENTS.md');
  const original = '# User rules\r\nKeep this exactly.';
  writeFileSync(file, original);

  const first = upsertManagedBlock(file, { ...MARKERS, content: 'Read `brain/index.html`.\nUse the shared truth.', trustedRoot: root });
  const appended = readFileSync(file, 'utf8');
  assert.deepEqual(first, { ok: true, changed: true, action: 'added' });
  assert.equal(appended, `${original}${MARKERS.begin}\r\nRead \`brain/index.html\`.\r\nUse the shared truth.\r\n${MARKERS.end}`);

  const second = upsertManagedBlock(file, { ...MARKERS, content: 'Read `brain/index.html`.\nUse the shared truth.', trustedRoot: root });
  assert.deepEqual(second, { ok: true, changed: false, action: 'unchanged' });
  assert.equal(readFileSync(file, 'utf8'), appended);

  const updated = upsertManagedBlock(file, { ...MARKERS, content: 'Updated contract.', trustedRoot: root });
  assert.deepEqual(updated, { ok: true, changed: true, action: 'updated' });
  assert.equal(readFileSync(file, 'utf8'), `${original}${MARKERS.begin}\r\nUpdated contract.\r\n${MARKERS.end}`);

  const removed = removeManagedBlock(file, { ...MARKERS, trustedRoot: root });
  assert.deepEqual(removed, { ok: true, changed: true, action: 'removed' });
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('managed block removal deletes only a wholly Sandpaper-owned file', (t) => {
  const root = fixture(t);
  const owned = join(root, 'CLAUDE.md');
  upsertManagedBlock(owned, { ...MARKERS, content: 'Shared truth.', trustedRoot: root });
  assert.equal(existsSync(owned), true);
  assert.deepEqual(removeManagedBlock(owned, { ...MARKERS, trustedRoot: root }), {
    ok: true,
    changed: true,
    action: 'deleted',
  });
  assert.equal(existsSync(owned), false);

  const absent = join(root, 'AGENTS.md');
  assert.deepEqual(removeManagedBlock(absent, { ...MARKERS, trustedRoot: root }), {
    ok: true,
    changed: false,
    action: 'absent',
  });
});

test('malformed, duplicate, reversed, and nested managed markers reject without writing', (t) => {
  const root = fixture(t);
  const cases = [
    `prefix\n${MARKERS.begin}\nmissing end\n`,
    `prefix\n${MARKERS.end}\nmissing begin\n`,
    `${MARKERS.end}\nreversed\n${MARKERS.begin}\n`,
    `${MARKERS.begin}\none\n${MARKERS.end}\n${MARKERS.begin}\ntwo\n${MARKERS.end}\n`,
    `${MARKERS.begin}\nouter\n${MARKERS.begin}\ninner\n${MARKERS.end}\n${MARKERS.end}\n`,
  ];

  for (const [index, bytes] of cases.entries()) {
    const file = join(root, `invalid-${index}.md`);
    writeFileSync(file, bytes);
    const result = upsertManagedBlock(file, { ...MARKERS, content: 'replacement', trustedRoot: root });
    assert.equal(result.ok, false, `case ${index}`);
    assert.equal(result.changed, false, `case ${index}`);
    assert.match(result.error, /Invalid Sandpaper markers/);
    assert.equal(readFileSync(file, 'utf8'), bytes, `case ${index}`);
    const removal = removeManagedBlock(file, { ...MARKERS, trustedRoot: root });
    assert.equal(removal.ok, false, `remove case ${index}`);
    assert.equal(readFileSync(file, 'utf8'), bytes, `remove case ${index}`);
  }
});

test('managed files and direct parent symlinks reject without mutating their targets', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = fixture(t);
  const outsideFile = join(root, 'outside.md');
  writeFileSync(outsideFile, 'outside bytes\n');
  const linkedFile = join(root, 'AGENTS.md');
  symlinkSync(outsideFile, linkedFile);
  assert.throws(
    () => upsertManagedBlock(linkedFile, { ...MARKERS, content: 'must not land', trustedRoot: root }),
    /Sandpaper managed (?:file|path).*symlink/i,
  );
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside bytes\n');

  const danglingFile = join(root, 'CLAUDE.md');
  symlinkSync(join(root, 'missing.md'), danglingFile);
  assert.throws(
    () => upsertManagedBlock(danglingFile, { ...MARKERS, content: 'must not replace the link', trustedRoot: root }),
    /Sandpaper managed (?:file|path).*symlink/i,
  );
  assert.equal(lstatSync(danglingFile).isSymbolicLink(), true);

  const outsideDirectory = join(root, 'outside-directory');
  mkdirSync(outsideDirectory);
  const linkedDirectory = join(root, 'linked-directory');
  symlinkSync(outsideDirectory, linkedDirectory);
  assert.throws(
    () => upsertManagedBlock(join(linkedDirectory, 'CLAUDE.md'), { ...MARKERS, content: 'must not land', trustedRoot: root }),
    /Sandpaper managed path.*symlink/i,
  );
  assert.deepEqual(readdirSync(outsideDirectory), []);
});

test('copyTree converges an owned namespace and preserves source file modes', (t) => {
  const root = fixture(t, 'sandpaper-copy-tree-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'a.md'), 'source a\n');
  writeFileSync(join(source, 'nested', 'b.md'), 'source b\n');
  chmodSync(join(source, 'nested', 'b.md'), 0o640);
  mkdirSync(destination);
  writeFileSync(join(destination, 'a.md'), 'stale a\n');
  writeFileSync(join(destination, 'stale.md'), 'remove me\n');

  copyTree(source, destination, { overwriteNamespaced: true, sourceRoot: root, destinationRoot: root });

  assert.deepEqual(readdirSync(destination).sort(), ['a.md', 'nested']);
  assert.equal(readFileSync(join(destination, 'a.md'), 'utf8'), 'source a\n');
  assert.equal(readFileSync(join(destination, 'nested', 'b.md'), 'utf8'), 'source b\n');
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(destination, 'nested', 'b.md')).mode & 0o777, 0o640);
  }
  const once = snapshot(destination);
  copyTree(source, destination, { overwriteNamespaced: true, sourceRoot: root, destinationRoot: root });
  assert.deepEqual(snapshot(destination), once);
});

test('copyTree non-overwrite mode preflights conflicts and leaves the tree unchanged', (t) => {
  const root = fixture(t, 'sandpaper-copy-tree-conflict-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'new.md'), 'new\n');
  writeFileSync(join(source, 'same.md'), 'source\n');
  writeFileSync(join(destination, 'same.md'), 'user\n');
  const before = snapshot(destination);

  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: false, sourceRoot: root, destinationRoot: root }),
    /Sandpaper destination tree.*existing file/i,
  );
  assert.deepEqual(snapshot(destination), before);
});

test('copyTree rejects source, destination, internal symlinks and special files before mutation', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = fixture(t, 'sandpaper-copy-tree-unsafe-');
  const outside = join(root, 'outside.md');
  writeFileSync(outside, 'outside\n');

  const sourceSymlink = join(root, 'source-symlink');
  symlinkSync(outside, sourceSymlink);
  const destination = join(root, 'destination');
  assert.throws(
    () => copyTree(sourceSymlink, destination, { overwriteNamespaced: true, sourceRoot: root, destinationRoot: root }),
    /Sandpaper source (?:tree|path).*symlink/i,
  );
  assert.equal(existsSync(destination), false);

  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'safe.md'), 'safe\n');
  symlinkSync(outside, join(source, 'linked.md'));
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true, sourceRoot: root, destinationRoot: root }),
    /Sandpaper source tree.*symlink/i,
  );
  assert.equal(existsSync(destination), false);
  rmSync(join(source, 'linked.md'));

  const fifo = join(source, 'special');
  execFileSync('mkfifo', [fifo]);
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true, sourceRoot: root, destinationRoot: root }),
    /Sandpaper source tree.*special file/i,
  );
  assert.equal(existsSync(destination), false);
  rmSync(fifo);

  const destinationTarget = join(root, 'destination-target');
  mkdirSync(destinationTarget);
  symlinkSync(destinationTarget, destination);
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true, sourceRoot: root, destinationRoot: root }),
    /Sandpaper destination (?:tree|path).*symlink/i,
  );
  assert.deepEqual(readdirSync(destinationTarget), []);

  rmSync(destination);
  rmSync(destinationTarget, { recursive: true });
  mkdirSync(destination);
  const destinationFifo = join(destination, 'special');
  execFileSync('mkfifo', [destinationFifo]);
  const beforeDestination = snapshot(destination);
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true, sourceRoot: root, destinationRoot: root }),
    /Sandpaper destination tree.*special file/i,
  );
  assert.deepEqual(snapshot(destination), beforeDestination);
});

test('public filesystem helpers require explicit trusted roots', (t) => {
  const root = fixture(t, 'sandpaper-trust-contract-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source);
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true }),
    /trusted source and destination roots/i,
  );
  assert.throws(
    () => upsertManagedBlock(join(root, 'AGENTS.md'), { ...MARKERS, content: 'contract' }),
    /trusted root/i,
  );
});

test('component symlinks below trusted roots reject without writing outside', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = fixture(t, 'sandpaper-component-link-');
  const trusted = join(root, 'trusted');
  const outside = join(root, 'outside');
  const outsideSource = join(root, 'outside-source');
  mkdirSync(join(trusted, 'source'), { recursive: true });
  mkdirSync(join(outside, 'deep'), { recursive: true });
  mkdirSync(join(outsideSource, 'deep', 'source'), { recursive: true });
  writeFileSync(join(trusted, 'source', 'safe.md'), 'safe\n');
  writeFileSync(join(outsideSource, 'deep', 'source', 'outside.md'), 'outside source\n');
  symlinkSync(outside, join(trusted, 'destination-link'));
  symlinkSync(outsideSource, join(trusted, 'source-link'));

  const escapedDestination = join(trusted, 'destination-link', 'deep', 'namespace');
  assert.throws(
    () => copyTree(join(trusted, 'source'), escapedDestination, {
      overwriteNamespaced: true,
      sourceRoot: trusted,
      destinationRoot: trusted,
    }),
    /Sandpaper destination path.*symlink/i,
  );
  assert.deepEqual(readdirSync(join(outside, 'deep')), []);

  assert.throws(
    () => copyTree(join(trusted, 'source-link', 'deep', 'source'), join(trusted, 'safe-destination'), {
      overwriteNamespaced: true,
      sourceRoot: trusted,
      destinationRoot: trusted,
    }),
    /Sandpaper source path.*symlink/i,
  );
  assert.equal(existsSync(join(trusted, 'safe-destination')), false);

  const escapedManaged = join(trusted, 'destination-link', 'deep', 'AGENTS.md');
  assert.throws(
    () => upsertManagedBlock(escapedManaged, { ...MARKERS, content: 'must not escape', trustedRoot: trusted }),
    /Sandpaper managed path.*symlink/i,
  );
  assert.equal(existsSync(join(outside, 'deep', 'AGENTS.md')), false);

  symlinkSync(join(root, 'missing-outside'), join(trusted, 'dangling'));
  assert.throws(
    () => copyTree(join(trusted, 'source'), join(trusted, 'dangling', 'deeper', 'namespace'), {
      overwriteNamespaced: true,
      sourceRoot: trusted,
      destinationRoot: trusted,
    }),
    /Sandpaper destination path.*symlink/i,
  );
  assert.throws(
    () => upsertManagedBlock(join(trusted, 'dangling', 'deeper', 'CLAUDE.md'), {
      ...MARKERS,
      content: 'must not escape dangling link',
      trustedRoot: trusted,
    }),
    /Sandpaper managed path.*symlink/i,
  );
  assert.equal(lstatSync(join(trusted, 'dangling')).isSymbolicLink(), true);
});

test('managed removal preserves every prefix and suffix byte outside marker offsets', (t) => {
  const root = fixture(t, 'sandpaper-managed-outside-bytes-');
  const file = join(root, 'AGENTS.md');
  const prefix = Buffer.from('user prose\n');
  const block = Buffer.from(`${MARKERS.begin}\nmanaged\n${MARKERS.end}`);
  const suffix = Buffer.from('\n');
  writeFileSync(file, Buffer.concat([prefix, block, suffix]));

  removeManagedBlock(file, { ...MARKERS, trustedRoot: root });

  assert.deepEqual(readFileSync(file), Buffer.concat([prefix, suffix]));
});

test('managed updates and removals preserve invalid UTF-8 bytes losslessly', (t) => {
  const root = fixture(t, 'sandpaper-managed-invalid-utf8-');
  const file = join(root, 'CLAUDE.md');
  const prefix = Buffer.from([0xff, 0xfe, 0x0a]);
  const suffix = Buffer.from([0x0a, 0x80, 0x81]);
  const block = Buffer.from(`${MARKERS.begin}\nold\n${MARKERS.end}`);
  writeFileSync(file, Buffer.concat([prefix, block, suffix]));

  upsertManagedBlock(file, { ...MARKERS, content: 'new', trustedRoot: root });
  const updated = readFileSync(file);
  assert.deepEqual(updated.subarray(0, prefix.length), prefix);
  assert.deepEqual(updated.subarray(updated.length - suffix.length), suffix);

  removeManagedBlock(file, { ...MARKERS, trustedRoot: root });
  assert.deepEqual(readFileSync(file), Buffer.concat([prefix, suffix]));
});

test('trusted path helpers construct Windows integration parents without POSIX splitting', () => {
  assert.equal(typeof managed.trustedPathParts, 'function');
  assert.equal(typeof managed.trustedParentPaths, 'function');
  const root = 'C:\\repo';
  const destination = 'C:\\repo\\.agents\\skills\\sandpaper';
  assert.deepEqual(managed.trustedPathParts(root, destination, { pathApi: win32 }), [
    '.agents',
    'skills',
    'sandpaper',
  ]);
  assert.deepEqual(managed.trustedParentPaths(root, destination, { pathApi: win32 }), [
    'C:\\repo\\.agents',
    'C:\\repo\\.agents\\skills',
  ]);
});

test('copyTree rolls back stage, backup, and install failures without changing the destination', (t) => {
  const root = fixture(t, 'sandpaper-copy-faults-');
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'new.md'), 'new bytes\n');

  const runCase = (name, fs) => {
    const destination = join(root, name);
    mkdirSync(destination);
    writeFileSync(join(destination, 'old.md'), 'old bytes\n');
    const before = snapshot(destination);
    assert.throws(
      () => copyTree(source, destination, {
        overwriteNamespaced: true,
        sourceRoot: root,
        destinationRoot: root,
        fs,
      }),
      /Could not (?:prepare|commit|replace) Sandpaper destination tree/,
    );
    assert.deepEqual(snapshot(destination), before, name);
    assert.deepEqual(
      readdirSync(root).filter((entry) => entry.startsWith(`.${name}.sandpaper-`)),
      [],
      `${name} temporary transaction`,
    );
  };

  runCase('stage-failure', {
    writeFileSync() { throw Object.assign(new Error('injected stage failure'), { code: 'EIO' }); },
  });

  let backupRenames = 0;
  runCase('backup-failure', {
    renameSync(from, to) {
      backupRenames += 1;
      if (backupRenames === 1) throw Object.assign(new Error('injected backup failure'), { code: 'EIO' });
      return renameSync(from, to);
    },
  });

  let installRenames = 0;
  runCase('install-failure', {
    renameSync(from, to) {
      installRenames += 1;
      if (installRenames === 2) throw Object.assign(new Error('injected install failure'), { code: 'EIO' });
      return renameSync(from, to);
    },
  });
});

test('copyTree retains the only backup and reports recovery when restore rename fails', (t) => {
  const root = fixture(t, 'sandpaper-copy-recovery-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'new.md'), 'new bytes\n');
  writeFileSync(join(destination, 'old.md'), 'only old copy\n');
  let renames = 0;

  const error = thrown(() => copyTree(source, destination, {
    overwriteNamespaced: true,
    sourceRoot: root,
    destinationRoot: root,
    fs: {
      renameSync(from, to) {
        renames += 1;
        if (renames === 2 || renames === 3) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
        return renameSync(from, to);
      },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(error.message, 'Sandpaper transaction recovery required');
  assert.equal(typeof error.recoveryPath, 'string');
  assert.equal(existsSync(error.recoveryPath), true);
  assert.equal(readFileSync(join(error.recoveryPath, 'previous', 'old.md'), 'utf8'), 'only old copy\n');
  assert.equal(existsSync(destination), false);
});

test('copyTree rollback never deletes a concurrently swapped destination', (t) => {
  const root = fixture(t, 'sandpaper-copy-concurrent-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const displaced = join(root, 'displaced-installed');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'new.md'), 'new bytes\n');
  writeFileSync(join(destination, 'old.md'), 'old bytes\n');

  const error = thrown(() => copyTree(source, destination, {
    overwriteNamespaced: true,
    sourceRoot: root,
    destinationRoot: root,
    hooks: {
      afterInstall() {
        renameSync(destination, displaced);
        mkdirSync(destination);
        writeFileSync(join(destination, 'concurrent.md'), 'concurrent user bytes\n');
        throw new Error('injected later failure');
      },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(destination, 'concurrent.md'), 'utf8'), 'concurrent user bytes\n');
  assert.equal(readFileSync(join(displaced, 'new.md'), 'utf8'), 'new bytes\n');
  assert.equal(readFileSync(join(error.recoveryPath, 'previous', 'old.md'), 'utf8'), 'old bytes\n');
});

test('transaction cleanup retains data swapped at quarantine rename', (t) => {
  const root = fixture(t, 'sandpaper-cleanup-rename-swap-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'new.md'), 'new\n');
  writeFileSync(join(destination, 'old.md'), 'old\n');
  let savedOriginal;
  let swappedTransaction;

  const error = thrown(() => copyTree(source, destination, {
    overwriteNamespaced: true,
    sourceRoot: root,
    destinationRoot: root,
    hooks: {
      beforeQuarantineRename({ transaction, quarantineRoot }) {
        swappedTransaction = transaction;
        savedOriginal = join(quarantineRoot, 'saved-original');
        renameSync(transaction, savedOriginal);
        mkdirSync(transaction);
        writeFileSync(join(transaction, 'user.md'), 'user swap bytes\n');
      },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(savedOriginal, 'previous', 'old.md'), 'utf8'), 'old\n');
  assert.equal(readFileSync(join(swappedTransaction, 'user.md'), 'utf8'), 'user swap bytes\n');
});

test('transaction cleanup retains data swapped immediately before recursive quarantine cleanup', (t) => {
  const root = fixture(t, 'sandpaper-cleanup-recursive-swap-');
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  writeFileSync(join(source, 'new.md'), 'new\n');
  writeFileSync(join(destination, 'old.md'), 'old\n');
  let savedOriginal;
  let swappedPath;

  const error = thrown(() => copyTree(source, destination, {
    overwriteNamespaced: true,
    sourceRoot: root,
    destinationRoot: root,
    hooks: {
      beforeRecursiveCleanup({ quarantineRoot, quarantinedTransaction }) {
        savedOriginal = join(quarantineRoot, 'saved-original');
        swappedPath = quarantinedTransaction;
        renameSync(quarantinedTransaction, savedOriginal);
        mkdirSync(quarantinedTransaction);
        writeFileSync(join(quarantinedTransaction, 'user.md'), 'late user swap\n');
      },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(join(savedOriginal, 'previous', 'old.md'), 'utf8'), 'old\n');
  assert.equal(readFileSync(join(swappedPath, 'user.md'), 'utf8'), 'late user swap\n');
  assert.equal(error.recoveryPath, dirname(savedOriginal));
});

test('standalone managed upsert never overwrites a concurrent destination after backup', (t) => {
  const root = fixture(t, 'sandpaper-managed-upsert-race-');
  const file = join(root, 'AGENTS.md');
  writeFileSync(file, 'original user bytes\n');

  const error = thrown(() => upsertManagedBlock(file, {
    ...MARKERS,
    content: 'managed',
    trustedRoot: root,
  }, {
    hooks: {
      beforeInstall() { writeFileSync(file, 'concurrent user bytes\n'); },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(file, 'utf8'), 'concurrent user bytes\n');
  assert.equal(readFileSync(join(error.recoveryPath, 'backup'), 'utf8'), 'original user bytes\n');
});

test('standalone managed removal preserves concurrent replacement and original recovery backup', (t) => {
  const root = fixture(t, 'sandpaper-managed-remove-race-');
  const file = join(root, 'CLAUDE.md');
  upsertManagedBlock(file, { ...MARKERS, content: 'managed', trustedRoot: root });
  const original = readFileSync(file);

  const error = thrown(() => removeManagedBlock(file, { ...MARKERS, trustedRoot: root }, {
    hooks: {
      afterBackup() {
        writeFileSync(file, 'concurrent replacement\n');
        throw new Error('injected post-backup failure');
      },
    },
  }));

  assert.equal(error.code, 'SANDPAPER_RECOVERY_REQUIRED');
  assert.equal(readFileSync(file, 'utf8'), 'concurrent replacement\n');
  assert.deepEqual(readFileSync(join(error.recoveryPath, 'backup')), original);
});
