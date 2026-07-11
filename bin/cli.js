#!/usr/bin/env node
// Sandpaper CLI. Subcommands are the "plumbing" (no AI); a bare path falls through to serve.
import { resolve, dirname, join } from 'node:path';
import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer } from '../src/server.js';
import { createFirstPartyRegistry } from '../src/provider-registry.js';
import { createProviderPreferenceStore } from '../src/provider-preferences.js';
import { createSessionStore } from '../src/session-store.js';
import { installSkill, parseSetupOptions, scaffold, doctor, upgrade, rebuild } from '../src/setup.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = new Set(['claude', 'codex']);

export function parseServeArguments(argv) {
  let target = null;
  let provider = null;
  let providerSeen = false;
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!optionsEnded && value === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value === '--provider') {
      if (providerSeen) throw new Error('--provider may only be specified once');
      providerSeen = true;
      const selected = argv[index + 1];
      if (selected === undefined || selected === '--' || selected.startsWith('-')) {
        throw new Error('--provider requires a value');
      }
      if (!PROVIDERS.has(selected)) throw new Error(`Unknown provider: ${selected}`);
      provider = selected;
      index += 1;
      continue;
    }
    if (!optionsEnded && value.startsWith('-')) throw new Error(`Unknown option: ${value}`);
    if (target !== null) throw new Error('Sandpaper accepts only one target');
    target = value;
  }
  return { target, provider };
}

const usageText = `
  🪵  sandpaper — a living project brain

  sandpaper install-skill [--integration claude|codex] [--provider claude|codex] [--no-hooks]
                              install the Sandpaper integration + hooks into this repo
  sandpaper init [--provider claude|codex]
                              scaffold brain/ with an optional initial provider
  sandpaper upgrade            bring an existing brain up to date (assets · hooks · commands · canvas)
  sandpaper rebuild            full reset — back up the old brain + lay down a fresh skeleton
  sandpaper doctor             health-check a Sandpaper setup
  sandpaper open [--provider claude|codex]
                              serve this repo's brain + open it in a browser
  sandpaper [--provider claude|codex] <doc.html | dir>
                              serve with the on-page refine toolbar
  sandpaper help               this

  Fresh repo? → sandpaper install-skill, then /sandpaper:init in Claude Code.
`;

function defaultDependencies() {
  return {
    cwd: () => process.cwd(),
    env: process.env,
    platform: process.platform,
    existsSync,
    statSync,
    readFileSync,
    execFile,
    startServer,
    createFirstPartyRegistry,
    createProviderPreferenceStore,
    createSessionStore,
    installSkill,
    scaffold,
    doctor,
    upgrade,
    rebuild,
    log: console.log,
  };
}

function startPort(runtime, cwd) {
  if (runtime.env?.SANDPAPER_PORT) return Number(runtime.env.SANDPAPER_PORT);
  try {
    const manifest = JSON.parse(runtime.readFileSync(join(cwd, '.sandpaper', 'manifest.json'), 'utf8'));
    if (manifest.port) return Number(manifest.port);
  } catch { /* use the stable default */ }
  return 4848;
}

async function serve(parsed, { openBrowser, runtime, cwd }) {
  const rawTarget = parsed.target || cwd;
  const target = resolve(cwd, rawTarget);
  if (!runtime.existsSync(target)) throw new Error(`unknown command or path: ${rawTarget}`);

  const isDir = runtime.statSync(target).isDirectory();
  const root = isDir ? target : dirname(target);
  const preferences = runtime.createProviderPreferenceStore(root);
  const sessions = runtime.createSessionStore(root);
  const registry = runtime.createFirstPartyRegistry();
  const initialProvider = parsed.provider || preferences.getDefaultProvider();
  const url = await runtime.startServer(target, startPort(runtime, root), {
    brain: isDir,
    initialProvider,
    registry,
    preferences,
    sessions,
  });

  runtime.log(`\n  🪵  Sandpaper\n  ↳ ${isDir ? 'serving' : 'editing'}  ${target}\n  ↳ open     ${url}\n`);
  if (openBrowser) {
    const browserUrl = isDir && runtime.existsSync(join(target, 'brain', 'index.html'))
      ? `${url}brain/index.html` : url;
    const opener = runtime.platform === 'darwin'
      ? 'open' : runtime.platform === 'win32' ? 'start' : 'xdg-open';
    runtime.execFile(opener, [browserUrl], () => {});
  }
}

export async function runCli(argv = process.argv.slice(2), injected = {}) {
  const runtime = { ...defaultDependencies(), ...injected };
  const cwd = runtime.cwd();
  const [command, ...rest] = argv;

  const rejectArguments = (name) => {
    if (rest.length) throw new Error(`${name} does not accept options or arguments`);
  };

  if (!command) {
    runtime.log(usageText);
    return;
  }
  if (command === 'help' || command === '-h' || command === '--help') {
    rejectArguments(command);
    runtime.log(usageText);
    return;
  }
  if (command === 'install-skill') {
    return runtime.installSkill(cwd, PKG, parseSetupOptions(rest));
  }
  if (command === 'init') {
    for (let index = 0; index < rest.length; index += 2) {
      if (rest[index] !== '--provider') throw new Error(`Unknown init option: ${rest[index]}`);
    }
    const options = parseSetupOptions(rest);
    return runtime.scaffold(cwd, PKG, rest.length ? options : undefined);
  }
  if (command === 'upgrade' || command === 'update') {
    rejectArguments(command); return runtime.upgrade(cwd, PKG);
  }
  if (command === 'rebuild' || command === 'reset') {
    rejectArguments(command); return runtime.rebuild(cwd, PKG);
  }
  if (command === 'doctor') { rejectArguments(command); return runtime.doctor(cwd); }
  if (command === 'open') {
    const parsed = parseServeArguments(rest);
    if (parsed.target !== null) throw new Error('open does not accept a target; it always serves the current repository');
    return serve(parsed, { openBrowser: true, runtime, cwd });
  }
  return serve(parseServeArguments(argv), { openBrowser: false, runtime, cwd });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) {
  runCli().catch((error) => {
    console.error('  sandpaper:', error.message);
    process.exitCode = 1;
  });
}
