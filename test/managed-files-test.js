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
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyTree } from '../src/integrations.js';
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

  const first = upsertManagedBlock(file, { ...MARKERS, content: 'Read `brain/index.html`.\nUse the shared truth.' });
  const appended = readFileSync(file, 'utf8');
  assert.deepEqual(first, { ok: true, changed: true, action: 'added' });
  assert.equal(appended, `${original}\r\n${MARKERS.begin}\r\nRead \`brain/index.html\`.\r\nUse the shared truth.\r\n${MARKERS.end}\r\n`);

  const second = upsertManagedBlock(file, { ...MARKERS, content: 'Read `brain/index.html`.\nUse the shared truth.' });
  assert.deepEqual(second, { ok: true, changed: false, action: 'unchanged' });
  assert.equal(readFileSync(file, 'utf8'), appended);

  const updated = upsertManagedBlock(file, { ...MARKERS, content: 'Updated contract.' });
  assert.deepEqual(updated, { ok: true, changed: true, action: 'updated' });
  assert.equal(readFileSync(file, 'utf8'), `${original}\r\n${MARKERS.begin}\r\nUpdated contract.\r\n${MARKERS.end}\r\n`);

  const removed = removeManagedBlock(file, MARKERS);
  assert.deepEqual(removed, { ok: true, changed: true, action: 'removed' });
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('managed block removal deletes only a wholly Sandpaper-owned file', (t) => {
  const root = fixture(t);
  const owned = join(root, 'CLAUDE.md');
  upsertManagedBlock(owned, { ...MARKERS, content: 'Shared truth.' });
  assert.equal(existsSync(owned), true);
  assert.deepEqual(removeManagedBlock(owned, MARKERS), {
    ok: true,
    changed: true,
    action: 'deleted',
  });
  assert.equal(existsSync(owned), false);

  const absent = join(root, 'AGENTS.md');
  assert.deepEqual(removeManagedBlock(absent, MARKERS), {
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
    const result = upsertManagedBlock(file, { ...MARKERS, content: 'replacement' });
    assert.equal(result.ok, false, `case ${index}`);
    assert.equal(result.changed, false, `case ${index}`);
    assert.match(result.error, /Invalid Sandpaper markers/);
    assert.equal(readFileSync(file, 'utf8'), bytes, `case ${index}`);
    const removal = removeManagedBlock(file, MARKERS);
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
    () => upsertManagedBlock(linkedFile, { ...MARKERS, content: 'must not land' }),
    /Sandpaper managed file.*symlink/i,
  );
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside bytes\n');

  const danglingFile = join(root, 'CLAUDE.md');
  symlinkSync(join(root, 'missing.md'), danglingFile);
  assert.throws(
    () => upsertManagedBlock(danglingFile, { ...MARKERS, content: 'must not replace the link' }),
    /Sandpaper managed file.*symlink/i,
  );
  assert.equal(lstatSync(danglingFile).isSymbolicLink(), true);

  const outsideDirectory = join(root, 'outside-directory');
  mkdirSync(outsideDirectory);
  const linkedDirectory = join(root, 'linked-directory');
  symlinkSync(outsideDirectory, linkedDirectory);
  assert.throws(
    () => upsertManagedBlock(join(linkedDirectory, 'CLAUDE.md'), { ...MARKERS, content: 'must not land' }),
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

  copyTree(source, destination, { overwriteNamespaced: true });

  assert.deepEqual(readdirSync(destination).sort(), ['a.md', 'nested']);
  assert.equal(readFileSync(join(destination, 'a.md'), 'utf8'), 'source a\n');
  assert.equal(readFileSync(join(destination, 'nested', 'b.md'), 'utf8'), 'source b\n');
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(destination, 'nested', 'b.md')).mode & 0o777, 0o640);
  }
  const once = snapshot(destination);
  copyTree(source, destination, { overwriteNamespaced: true });
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
    () => copyTree(source, destination, { overwriteNamespaced: false }),
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
    () => copyTree(sourceSymlink, destination, { overwriteNamespaced: true }),
    /Sandpaper source tree.*symlink/i,
  );
  assert.equal(existsSync(destination), false);

  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'safe.md'), 'safe\n');
  symlinkSync(outside, join(source, 'linked.md'));
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true }),
    /Sandpaper source tree.*symlink/i,
  );
  assert.equal(existsSync(destination), false);
  rmSync(join(source, 'linked.md'));

  const fifo = join(source, 'special');
  execFileSync('mkfifo', [fifo]);
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true }),
    /Sandpaper source tree.*special file/i,
  );
  assert.equal(existsSync(destination), false);
  rmSync(fifo);

  const destinationTarget = join(root, 'destination-target');
  mkdirSync(destinationTarget);
  symlinkSync(destinationTarget, destination);
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true }),
    /Sandpaper destination tree.*symlink/i,
  );
  assert.deepEqual(readdirSync(destinationTarget), []);

  rmSync(destination);
  rmSync(destinationTarget, { recursive: true });
  mkdirSync(destination);
  const destinationFifo = join(destination, 'special');
  execFileSync('mkfifo', [destinationFifo]);
  const beforeDestination = snapshot(destination);
  assert.throws(
    () => copyTree(source, destination, { overwriteNamespaced: true }),
    /Sandpaper destination tree.*special file/i,
  );
  assert.deepEqual(snapshot(destination), beforeDestination);
});
