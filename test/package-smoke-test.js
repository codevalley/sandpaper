import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  APPROVED_FILE_RULES,
  MAX_PACKED_KB,
  MAX_UNPACKED_KB,
  RUNTIME_DEPENDENCY_FIELDS,
  assertNoRuntimeDependencyMetadata,
  containsSecretPattern,
  expectedPackedPaths,
  isForbiddenPackagePath,
  isSecretPackagePath,
  normalizePackagePath,
} from '../src/package-contract.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTIONS = ['canvas', 'decide', 'help', 'init', 'learn', 'log', 'open', 'plan', 'release', 'serve', 'stamp', 'sync', 'theme'];

test('packed gate rejects every runtime dependency metadata field while allowing dev dependencies', () => {
  assert.doesNotThrow(() => assertNoRuntimeDependencyMetadata({ devDependencies: { testOnly: '1.0.0' } }));
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    assert.throws(() => assertNoRuntimeDependencyMetadata({ [field]: {} }), new RegExp(field));
  }
});

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    ...options,
  });
}

function strictFilesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      const path = relative(root, file).split(sep).join('/');
      assert.equal(stat.isSymbolicLink(), false, `unexpected symlink in package tree: ${path}`);
      if (stat.isDirectory()) visit(file);
      else {
        assert.equal(stat.isFile(), true, `unexpected special file in package tree: ${path}`);
        files.push(file);
      }
    }
  };
  visit(root);
  return files;
}

function scratchInventory(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      const path = relative(root, file).split(sep).join('/');
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special';
      entries.push({ path, type });
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(root);
  return entries;
}

function createMinimalEnvironment(scratch, sandboxHome, npmCache, temporary) {
  const userConfig = join(scratch, 'empty-user-npmrc');
  const globalConfig = join(scratch, 'empty-global-npmrc');
  writeFileSync(userConfig, '');
  writeFileSync(globalConfig, '');
  const env = {
    HOME: sandboxHome,
    USERPROFILE: sandboxHome,
    PATH: process.env.PATH || '',
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    NO_COLOR: '1',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_OFFLINE: 'true',
    NPM_CONFIG_PREFER_OFFLINE: 'true',
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
  };
  for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const credentialNames = Object.keys(process.env).filter((name) => (
    /^(?:AWS|AZURE|CLAUDE|CODEX|GITHUB|GH_|GOOGLE|OPENAI|ANTHROPIC|STRIPE|VERCEL)/i.test(name)
    || /^(?:NODE_AUTH_TOKEN|NPM_TOKEN)$/i.test(name)
    || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(name)
  ));
  assert.deepEqual(credentialNames.filter((name) => Object.hasOwn(env, name)), []);
  return env;
}

function installPackedRepository(repositories, name, tarball, env) {
  const repo = join(repositories, name);
  mkdirSync(repo);
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: `sandpaper-${name}`, private: true }, null, 2)}\n`);
  run('git', ['init', '--quiet'], { cwd: repo, env });
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], {
    cwd: repo,
    env,
  });
  const installedRoot = join(repo, 'node_modules', '@nynb', 'sandpaper');
  return {
    repo,
    installedRoot,
    cli(args, extra = {}) {
      return run(process.execPath, [join(installedRoot, 'bin', 'cli.js'), ...args], {
        cwd: repo,
        env: { ...env, ...(extra.env || {}) },
        ...extra,
      });
    },
  };
}

function writeExecutable(file, lines) {
  writeFileSync(file, [`#!${process.execPath}`, ...lines, ''].join('\n'));
  chmodSync(file, 0o755);
}

function createFakeProviderBinaries(fakeBin) {
  mkdirSync(fakeBin);
  writeExecutable(join(fakeBin, 'claude'), [
    "const args = process.argv.slice(2).join(' ');",
    "if (args === '--version') process.stdout.write('claude 3.4.5\\nFAKE_CLAUDE_PRIVATE_LINE\\n');",
    "else if (args === 'auth status --json') process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'private@example.test',apiKey:'FAKE_CLAUDE_SECRET'}));",
    "else process.exitCode = 2;",
  ]);
  writeExecutable(join(fakeBin, 'codex'), [
    "const args = process.argv.slice(2).join(' ');",
    "if (args === '--version') process.stdout.write('codex-cli 0.143.0\\nFAKE_CODEX_PRIVATE_LINE\\n');",
    "else if (args === '--help') process.stdout.write('Options:\\n  --ask-for-approval <POLICY>\\n  --sandbox <MODE>\\n  --config <key=value>\\n  --disable <FEATURE>\\n');",
    "else if (args === 'exec --help') process.stdout.write('Commands:\\n  resume  Resume a session\\nOptions:\\n  --json\\n  --ignore-user-config\\n  --ignore-rules\\n');",
    "else if (args === 'exec resume --help') process.stdout.write('Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]\\nOptions:\\n  --config <key=value>\\n  --json\\n  --ignore-user-config\\n  --ignore-rules\\n');",
    "else if (args === 'login status') process.stdout.write('Logged in using ChatGPT as private@example.test\\n');",
    "else process.exitCode = 2;",
  ]);
}

function assertIntegrationTrees(repo, installedRoot) {
  for (const action of ACTIONS) {
    assert.deepEqual(
      readFileSync(join(repo, '.claude', 'commands', 'sandpaper', `${action}.md`)),
      readFileSync(join(installedRoot, 'skill', 'sandpaper', 'commands', `${action}.md`)),
    );
    const canonical = readFileSync(join(installedRoot, 'skill', 'sandpaper', 'references', 'workflows', `${action}.md`));
    assert.deepEqual(readFileSync(join(repo, '.claude', 'commands', 'sandpaper', 'references', 'workflows', `${action}.md`)), canonical);
    assert.deepEqual(readFileSync(join(repo, '.agents', 'skills', 'sandpaper', 'references', 'workflows', `${action}.md`)), canonical);
  }
  assert.deepEqual(
    readFileSync(join(repo, '.agents', 'skills', 'sandpaper', 'SKILL.md')),
    readFileSync(join(installedRoot, 'skill', 'sandpaper', 'SKILL.md')),
  );
  for (const script of ['brain-inject.js', 'brain-stamp-check.js']) {
    assert.deepEqual(
      readFileSync(join(repo, '.sandpaper', 'hooks', script)),
      readFileSync(join(installedRoot, 'bin', script)),
    );
  }
  assert.match(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), /sandpaper:begin/);
  assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /sandpaper:begin/);
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

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = once(child, 'exit');
  const timeout = new Promise((resolve) => setTimeout(resolve, 3_000, 'timeout'));
  if (await Promise.race([exited, timeout]) === 'timeout' && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

test('packed artifact exactly matches the contract and survives dual-provider lifecycle flows', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'sandpaper-package-smoke-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const packDirectory = join(scratch, 'pack');
  const extractDirectory = join(scratch, 'extract');
  const repositories = join(scratch, 'repos');
  const sandboxHome = join(scratch, 'home');
  const npmCache = join(scratch, 'npm-cache');
  const temporary = join(scratch, 'tmp');
  const fakeBin = join(scratch, 'fake-bin');
  for (const directory of [packDirectory, extractDirectory, repositories, sandboxHome, npmCache, temporary]) mkdirSync(directory);

  const sentinel = join(sandboxHome, 'sentinel');
  const sentinelBytes = Buffer.from(`sandbox-home-sentinel-${process.pid}`);
  writeFileSync(sentinel, sentinelBytes, { mode: 0o640 });
  const sentinelMode = statSync(sentinel).mode & 0o777;
  const env = createMinimalEnvironment(scratch, sandboxHome, npmCache, temporary);
  createFakeProviderBinaries(fakeBin);
  const providerEnv = { ...env, PATH: `${fakeBin}${delimiter}${env.PATH}` };

  const sourceManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(sourceManifest.files, APPROVED_FILE_RULES);
  assertNoRuntimeDependencyMetadata(sourceManifest);
  assert.deepEqual(
    ['prepack', 'prepare', 'postpack', 'prepublishOnly'].filter((name) => Object.hasOwn(sourceManifest.scripts || {}, name)),
    [],
  );

  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], {
    cwd: ROOT,
    env,
  }))[0];
  assert.ok(packed?.filename);
  assert.equal(packed.entryCount, packed.files.length);
  assert.deepEqual(packed.bundled, []);
  assert.equal(packed.files.length, 58);
  const packedPaths = packed.files.map(({ path }) => normalizePackagePath(path)).sort();
  assert.deepEqual(packedPaths, expectedPackedPaths());
  assert.deepEqual(packedPaths.filter(isForbiddenPackagePath), []);
  assert.deepEqual(packedPaths.filter(isSecretPackagePath), []);
  assert.ok(Math.ceil(packed.size / 1024) <= MAX_PACKED_KB);
  assert.ok(Math.ceil(packed.unpackedSize / 1024) <= MAX_UNPACKED_KB);

  const tarball = join(packDirectory, packed.filename);
  run('tar', ['-xzf', tarball, '-C', extractDirectory], { env, timeout: 30_000 });
  const extractedRoot = join(extractDirectory, 'package');
  const extractedFiles = strictFilesUnder(extractedRoot);
  const extractedRelative = extractedFiles.map((file) => normalizePackagePath(relative(extractedRoot, file).split(sep).join('/'))).sort();
  assert.deepEqual(extractedRelative, packedPaths);
  assert.notEqual(statSync(join(extractedRoot, 'bin', 'cli.js')).mode & 0o111, 0, 'packed CLI must be executable');
  for (const path of extractedRelative) {
    const bytes = readFileSync(join(extractedRoot, ...path.split('/')));
    assert.deepEqual(bytes, readFileSync(join(ROOT, ...path.split('/'))), `packed bytes: ${path}`);
    assert.equal(containsSecretPattern(bytes), false, `secret scan: ${path}`);
  }

  const main = installPackedRepository(repositories, 'main', tarball, env);
  const installedFiles = strictFilesUnder(main.installedRoot);
  assertNoRuntimeDependencyMetadata(JSON.parse(readFileSync(join(main.installedRoot, 'package.json'), 'utf8')));
  const installedRelative = installedFiles.map((file) => normalizePackagePath(relative(main.installedRoot, file).split(sep).join('/'))).sort();
  assert.deepEqual(installedRelative, packedPaths);
  assert.notEqual(statSync(join(main.installedRoot, 'bin', 'cli.js')).mode & 0o111, 0, 'installed CLI must be executable');
  for (const path of installedRelative) {
    assert.deepEqual(
      readFileSync(join(main.installedRoot, ...path.split('/'))),
      readFileSync(join(extractedRoot, ...path.split('/'))),
      `installed bytes: ${path}`,
    );
  }

  const help = main.cli(['help']);
  assert.match(help, /--integration claude\|codex/);
  assert.match(help, /--provider claude\|codex/);
  assert.match(help, /--no-hooks/);
  assert.match(help, /\/sandpaper:<action>/);
  assert.match(help, /\$sandpaper <action>/);

  const installOutput = main.cli(['install-skill', '--no-hooks']);
  assert.match(installOutput, /\/sandpaper:<name>/);
  assert.match(installOutput, /\$sandpaper <action>/);
  assert.match(installOutput, /wiring disabled \(--no-hooks\)/);
  assertIntegrationTrees(main.repo, main.installedRoot);
  assert.equal(existsSync(join(main.repo, '.claude', 'settings.json')), false);
  assert.equal(existsSync(join(main.repo, '.codex', 'hooks.json')), false);
  let manifest = JSON.parse(readFileSync(join(main.repo, '.sandpaper', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.integrations, ['claude', 'codex']);
  assert.equal(manifest.defaultProvider, 'claude');
  assert.equal(manifest.hooksEnabled, false);

  main.cli(['init', '--provider', 'codex']);
  manifest = JSON.parse(readFileSync(join(main.repo, '.sandpaper', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.integrations, ['claude', 'codex']);
  assert.equal(manifest.defaultProvider, 'codex');
  assert.equal(manifest.hooksEnabled, false);

  manifest.project = 'Packed Fixture Identity';
  manifest.counters = { ...manifest.counters, w: 42, d: 7 };
  writeFileSync(join(main.repo, '.sandpaper', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sessionFile = join(main.repo, '.sandpaper', 'session.json');
  const sessionBytes = Buffer.from('{"version":2,"pages":{"brain/index.html":{"codex":{"resumeId":"opaque-packed-id","updatedAt":"2026-07-11T00:00:00.000Z"}}}}\n');
  writeFileSync(sessionFile, sessionBytes, { mode: 0o600 });
  const themeFile = join(main.repo, 'brain', 'assets', 'theme.css');
  const themeBytes = Buffer.from(':root { --accent: #123456; }\n');
  writeFileSync(themeFile, themeBytes, { mode: 0o640 });
  const themeMode = statSync(themeFile).mode & 0o777;

  for (const command of ['upgrade', 'rebuild']) {
    main.cli([command]);
    const after = JSON.parse(readFileSync(join(main.repo, '.sandpaper', 'manifest.json'), 'utf8'));
    assert.equal(after.project, manifest.project, `${command}: identity`);
    assert.deepEqual(after.counters, manifest.counters, `${command}: counters`);
    assert.equal(after.defaultProvider, 'codex', `${command}: default`);
    assert.deepEqual(after.integrations, ['claude', 'codex'], `${command}: integrations`);
    assert.equal(after.hooksEnabled, false, `${command}: hooks`);
    assert.deepEqual(readFileSync(sessionFile), sessionBytes, `${command}: session`);
    assert.deepEqual(readFileSync(themeFile), themeBytes, `${command}: theme`);
    assert.equal(statSync(themeFile).mode & 0o777, themeMode, `${command}: theme mode`);
  }

  const solo = installPackedRepository(repositories, 'solo-codex', tarball, env);
  solo.cli(['install-skill', '--integration', 'codex', '--provider', 'codex', '--no-hooks']);
  assert.equal(existsSync(join(solo.repo, '.agents', 'skills', 'sandpaper', 'SKILL.md')), true);
  assert.equal(existsSync(join(solo.repo, '.claude', 'commands', 'sandpaper')), false);
  assert.equal(existsSync(join(solo.repo, 'AGENTS.md')), true);
  assert.equal(existsSync(join(solo.repo, 'CLAUDE.md')), false);
  const soloManifest = JSON.parse(readFileSync(join(solo.repo, '.sandpaper', 'manifest.json'), 'utf8'));
  assert.deepEqual(soloManifest.integrations, ['codex']);
  assert.equal(soloManifest.defaultProvider, 'codex');
  assert.equal(soloManifest.hooksEnabled, false);

  const doctor = installPackedRepository(repositories, 'doctor', tarball, env);
  doctor.cli(['install-skill'], { env: providerEnv });
  const doctorOutput = doctor.cli(['doctor'], { env: providerEnv });
  assert.match(doctorOutput, /✓ healthy\./);
  assert.match(doctorOutput, /warning \[codex-hook-trust\]/);
  assert.match(doctorOutput, /Claude Code: subscription/);
  assert.match(doctorOutput, /Codex: chatgpt/);
  assert.doesNotMatch(doctorOutput, /private@example|FAKE_(?:CLAUDE|CODEX)_PRIVATE|FAKE_CLAUDE_SECRET/i);

  if (process.platform !== 'win32') {
    const openerSentinel = join(main.repo, '.sandpaper-opened-url');
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    writeExecutable(join(fakeBin, opener), [
      "const { writeFileSync } = require('node:fs');",
      "writeFileSync(process.env.SANDPAPER_OPENER_SENTINEL, process.argv[2] || '');",
    ]);
    const child = spawn(process.execPath, [join(main.installedRoot, 'bin', 'cli.js'), 'open', '--provider', 'codex'], {
      cwd: main.repo,
      env: {
        ...providerEnv,
        SANDPAPER_OPENER_SENTINEL: openerSentinel,
        SANDPAPER_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const { match } = await waitForOutput(child, /↳ open\s+(http:\/\/127\.0\.0\.1:\d+\/)/);
      const rootUrl = match[1];
      const response = await fetch(new URL('brain/index.html', rootUrl), { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      await waitForFile(openerSentinel);
      assert.equal(readFileSync(openerSentinel, 'utf8'), new URL('brain/index.html', rootUrl).href);
    } finally {
      await terminate(child);
    }
  }

  assert.deepEqual(readdirSync(sandboxHome), ['sentinel']);
  assert.deepEqual(readFileSync(sentinel), sentinelBytes);
  assert.equal(statSync(sentinel).mode & 0o777, sentinelMode);
  const inventory = scratchInventory(scratch);
  assert.equal(inventory.some(({ type }) => type === 'special'), false);
  const topLevel = [...new Set(inventory.map(({ path }) => path.split('/')[0]))].sort();
  assert.deepEqual(topLevel, [
    'empty-global-npmrc', 'empty-user-npmrc', 'extract', 'fake-bin', 'home',
    'npm-cache', 'pack', 'repos', 'tmp',
  ]);
  for (const entry of inventory.filter(({ type }) => type === 'symlink')) {
    assert.match(entry.path, /^repos\/[^/]+\/node_modules\/\.bin\/sandpaper$/);
  }
  console.log(`package smoke: ${packed.filename} · ${packed.entryCount} files · ${packed.size} packed bytes · ${packed.unpackedSize} unpacked bytes · ${inventory.length} scratch entries`);
});

test('canonical release workflow stages stamped notes before gates, version, tag, and push', () => {
  const release = readFileSync(join(ROOT, 'skill', 'sandpaper', 'references', 'workflows', 'release.md'), 'utf8');
  const ordered = [
    'git status --porcelain',
    'canonical `stamp` workflow',
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
  assert.match(githubReleaseJob, /actions\/checkout@/);
  assert.match(githubReleaseJob, /actions\/download-artifact@/);
  assert.match(githubReleaseJob, /gh release create[\s\S]*--repo "\$GITHUB_REPOSITORY"/);
});
