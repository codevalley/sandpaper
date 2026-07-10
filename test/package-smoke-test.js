import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APPROVED_FILE_RULES = [
  'bin/brain-inject.js',
  'bin/brain-stamp-check.js',
  'bin/cli.js',
  'bin/syntax-check.js',
  'bin/verify-publish.js',
  'src/claude.js',
  'src/edit.js',
  'src/path-policy.js',
  'src/server.js',
  'src/setup.js',
  'public/sp-client.js',
  'public/sp-markdown.js',
  'public/toolbar.css',
  'public/toolbar.js',
  'skill/sandpaper/SKILL.md',
  'skill/sandpaper/commands/canvas.md',
  'skill/sandpaper/commands/decide.md',
  'skill/sandpaper/commands/help.md',
  'skill/sandpaper/commands/init.md',
  'skill/sandpaper/commands/learn.md',
  'skill/sandpaper/commands/log.md',
  'skill/sandpaper/commands/open.md',
  'skill/sandpaper/commands/plan.md',
  'skill/sandpaper/commands/release.md',
  'skill/sandpaper/commands/serve.md',
  'skill/sandpaper/commands/stamp.md',
  'skill/sandpaper/commands/sync.md',
  'skill/sandpaper/commands/theme.md',
  'brain/assets/brain.css',
  'brain/assets/brain.js',
  'brain/assets/theme.css',
  '!brain/README.md',
  'README.md',
  'CHANGELOG.md',
];
const FORBIDDEN_PATH = /^(?:\.agents|\.claude|\.codex|\.github|\.playwright-mcp|\.sandpaper|\.superpowers|\.vercel|docs|node_modules|playwright-report|site|test|test-results)(?:\/|$)|^(?:AGENTS\.md|CLAUDE\.md|engg-spec\.html|playwright\.config\.js|sandpaper\.html)$/;
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.git-credentials$|\.netrc$|\.npmrc$|\.pypirc$|credentials\.json$|id_(?:dsa|ecdsa|ed25519|rsa)$|service-account\.json$)|\.(?:cer|crt|key|p12|pem|pfx)$/i;
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{10,}['"]/i,
  /password\s*[:=]\s*['"][^'"]{4,}['"]/i,
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    ...options,
  });
}

function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push(file);
    }
  };
  visit(root);
  return files;
}

function expectedPackedPaths(manifest) {
  assert.deepEqual(manifest.files, APPROVED_FILE_RULES, 'package files rules must stay on the reviewed allowlist');
  const positiveRules = manifest.files.filter((rule) => !rule.startsWith('!'));
  const expected = new Set(['LICENSE', 'package.json']);
  const tracked = run('git', ['ls-files', '--', ...positiveRules], { cwd: ROOT })
    .split('\n').filter(Boolean);
  for (const path of tracked) expected.add(path);
  for (const rule of manifest.files.filter((entry) => entry.startsWith('!'))) expected.delete(rule.slice(1));
  return [...expected].sort();
}

function waitForOutput(child, pattern, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for CLI output: ${output}`)), timeout);
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (!match) return;
      clearTimeout(timer);
      resolve({ match, output });
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited before expected output (code ${code}, signal ${signal}): ${output}`));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForFile(file, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('packed package installs cleanly and exercises the production CLI and server', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sandpaper-package-smoke-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const packDirectory = join(scratch, 'pack');
  const fixture = join(scratch, 'fresh-repository');
  const sandboxHome = join(scratch, 'home');
  const npmCache = join(scratch, 'npm-cache');
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(fixture, { recursive: true });
  mkdirSync(sandboxHome, { recursive: true });

  const userSecret = `sandpaper-package-smoke-secret-${process.pid}-${Date.now()}`;
  writeFileSync(join(sandboxHome, 'user-secret.txt'), userSecret);
  const env = {
    ...process.env,
    HOME: sandboxHome,
    USERPROFILE: sandboxHome,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_PREFER_OFFLINE: 'true',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NO_COLOR: '1',
  };

  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: ROOT,
    env,
  }))[0];
  assert.ok(packed?.filename, 'npm pack must return a tarball filename');
  assert.equal(packed.entryCount, packed.files.length, 'npm pack entry count must match its file list');
  assert.deepEqual(packed.bundled, [], 'the package must not bundle runtime dependencies');

  const sourceManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const packedPaths = packed.files.map(({ path }) => path).sort();
  assert.deepEqual(
    packedPaths,
    expectedPackedPaths(sourceManifest),
    'tarball must exactly match tracked files selected by the reviewed package manifest',
  );
  assert.deepEqual(
    packedPaths.filter((path) => FORBIDDEN_PATH.test(path) || SECRET_PATH.test(path)),
    [],
    'tarball must not contain tests, plans/specs, runtime state, user config, artifacts, or secret files',
  );

  assert.deepEqual(sourceManifest.dependencies || {}, {}, 'the published package must have zero runtime dependencies');

  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'sandpaper-package-smoke', private: true }, null, 2) + '\n');
  run('git', ['init', '--quiet'], { cwd: fixture, env });

  const tarball = join(packDirectory, packed.filename);
  run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball,
  ], { cwd: fixture, env, timeout: 120_000 });

  const cli = (args) => run('npx', ['--no-install', 'sandpaper', ...args], { cwd: fixture, env });
  assert.match(cli(['help']), /sandpaper install-skill/);
  assert.match(cli(['install-skill', '--no-hooks']), /not wired \(--no-hooks\)/);
  assert.match(cli(['init']), /scaffolding the brain/);
  assert.match(cli(['doctor']), /✓ healthy\./);

  const installedRoot = join(fixture, 'node_modules', '@nynb', 'sandpaper');
  const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  assert.deepEqual(installedManifest.dependencies || {}, {}, 'installed package must have zero runtime dependencies');

  const installedFiles = filesUnder(installedRoot);
  const installedRelative = installedFiles.map((file) => relative(installedRoot, file).split('\\').join('/')).sort();
  assert.deepEqual(installedRelative, packedPaths, 'installed package bytes must match the reviewed tarball file list');
  assert.deepEqual(
    installedRelative.filter((path) => FORBIDDEN_PATH.test(path) || SECRET_PATH.test(path)),
    [],
    'installed package must not contain forbidden or secret-shaped files',
  );
  for (const file of installedFiles) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes(userSecret), false, `sandbox user secret escaped into ${relative(installedRoot, file)}`);
    for (const pattern of SECRET_PATTERNS) {
      assert.equal(pattern.test(text), false, `possible secret in ${relative(installedRoot, file)} (${pattern})`);
    }
  }

  const moduleUrl = pathToFileURL(join(installedRoot, 'src', 'server.js'));
  const { createSandpaperServer } = await import(`${moduleUrl.href}?package-smoke=${Date.now()}`);
  const controller = createSandpaperServer(fixture, { brain: true });
  try {
    const url = await controller.listen(0);
    const response = await fetch(new URL('brain/index.html', url));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data-sandpaper-token=/);
  } finally {
    await controller.close();
  }

  if (process.platform !== 'win32') {
    const fakeBin = join(scratch, 'fake-bin');
    const openerSentinel = join(scratch, 'opener-called.txt');
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, opener), [
      '#!/usr/bin/env node',
      "require('node:fs').writeFileSync(process.env.SANDPAPER_OPENER_SENTINEL, process.argv[2] || '');",
      '',
    ].join('\n'), { mode: 0o755 });

    const child = spawn(process.execPath, [join(installedRoot, 'bin', 'cli.js'), 'open'], {
      cwd: fixture,
      env: {
        ...env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH || ''}`,
        SANDPAPER_OPENER_SENTINEL: openerSentinel,
        SANDPAPER_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const { match } = await waitForOutput(child, /↳ open\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
      const openUrl = match[1];
      const response = await fetch(new URL('brain/index.html', openUrl));
      assert.equal(response.status, 200);
      await waitForFile(openerSentinel);
      assert.equal(readFileSync(openerSentinel, 'utf8'), new URL('brain/index.html', openUrl).href);
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
      if (child.exitCode == null && child.signalCode == null) {
        await Promise.race([
          once(child, 'exit'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('installed open CLI did not stop')), 5_000)),
        ]);
      }
    }
  }

  assert.deepEqual(readdirSync(sandboxHome).sort(), ['user-secret.txt'], 'CLI must not write into the sandbox user home');
  console.log(`package smoke: ${packed.filename} · ${packed.entryCount} files · ${packed.size} bytes packed · ${packed.unpackedSize} bytes unpacked`);
});

test('release command stages stamped notes before gates, version, tag, and push', () => {
  const release = readFileSync(join(ROOT, 'skill', 'sandpaper', 'commands', 'release.md'), 'utf8');
  const ordered = [
    'git status --porcelain',
    '/sandpaper:stamp',
    'git add --',
    'git commit',
    'npm run check:syntax',
    'npm version <bump>',
    'git push --follow-tags',
  ];
  let previous = -1;
  for (const token of ordered) {
    const position = release.indexOf(token);
    assert.ok(position > previous, `${token} must appear after the preceding release step`);
    previous = position;
  }
  assert.doesNotMatch(release, /^\s*git add (?:-A|\.)\s*$/m);
  assert.doesNotMatch(release, /--force/);
  assert.match(release, /owner.*confirm/i);
});

test('release workflow validates metadata and requires every gate before publish', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const metadata = workflow.indexOf('verify exact tag, lockfile, and changelog');
  const notes = workflow.indexOf('extract strict release notes');
  const publish = workflow.indexOf('publish to npm (with provenance)');
  const release = workflow.indexOf('create the GitHub Release');

  assert.ok(metadata >= 0 && metadata < publish);
  assert.ok(notes >= 0 && notes < publish);
  assert.ok(publish < release);
  assert.match(workflow, /needs: \[metadata, node, browser, package-smoke\]/);
  assert.match(workflow, /package-lock\.json/);
  assert.match(workflow, /packages\[['"]['"]\]\.version/);
  assert.match(workflow, /GITHUB_REF_NAME.*EXPECTED_TAG|EXPECTED_TAG.*GITHUB_REF_NAME/s);
  assert.match(workflow, /npm run check:syntax/);
  assert.match(workflow, /npm run test:browser/);
  assert.match(workflow, /npm run test:package/);
  assert.match(workflow, /node bin\/cli\.js doctor/);
  assert.match(workflow, /npm run verify-publish/);
  assert.doesNotMatch(workflow, /No changelog entry found|fallback/i);
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'), workflow.indexOf('\n  github-release:'));
  const githubReleaseJob = workflow.slice(workflow.indexOf('\n  github-release:'));
  assert.match(publishJob, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.doesNotMatch(publishJob, /contents: write/);
  assert.match(publishJob, /actions\/upload-artifact@/);
  assert.match(githubReleaseJob, /needs: publish/);
  assert.match(githubReleaseJob, /permissions:\n\s+contents: write/);
  assert.doesNotMatch(githubReleaseJob, /id-token: write/);
  assert.match(githubReleaseJob, /actions\/download-artifact@/);
});
