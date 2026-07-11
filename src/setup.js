// setup.js — the `npx sandpaper` packaging commands: install-skill · init (scaffold) · doctor.
// The plumbing half of Sandpaper (no AI): copy the skill + hooks + design-system templates from
// THIS package into a target repo, write the manifest, and health-check a setup. Zero deps.
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, basename, extname, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareInstallIntegrations } from './integrations.js';
import { installationHookPlans } from './hooks.js';
import {
  captureExactTree,
  ensureTrustedParents,
  inspectTrustedPath,
  quarantineCleanup,
  sameExactTree,
  statIdentity,
} from './managed-files.js';
import { PATH_REASONS, resolveRepositoryPath } from './path-policy.js';
import { inspectInstallation } from './diagnostics.js';
import { inspectManifest, migrateManifest, PROVIDERS, readManifest, serializeManifest, writeManifest } from './manifest.js';

const ok = (m) => console.log('  ✓ ' + m);
const warn = (m) => console.log('  · ' + m);
const bad = (m) => console.log('  ✗ ' + m);

const ensureDir = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); };
const projectName = (target) => {
  try { return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name || basename(target); }
  catch { return basename(target); }
};
const today = () => new Date().toISOString().slice(0, 10);

export function parseSetupOptions(argv) {
  const integrations = [];
  let defaultProvider = 'claude';
  let providerSeen = false;
  let hooksEnabled = true;
  let noHooksSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--integration') {
      const provider = argv[index + 1];
      if (provider === undefined || provider.startsWith('-')) {
        throw new Error('--integration requires a value');
      }
      if (!PROVIDERS.includes(provider)) throw new Error(`Unknown integration: ${provider}`);
      integrations.push(provider);
      index += 1;
      continue;
    }
    if (option === '--provider') {
      if (providerSeen) throw new Error('--provider may only be specified once');
      providerSeen = true;
      const provider = argv[index + 1];
      if (provider === undefined || provider.startsWith('-')) {
        throw new Error('--provider requires a value');
      }
      if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
      defaultProvider = provider;
      index += 1;
      continue;
    }
    if (option === '--no-hooks') {
      if (noHooksSeen) throw new Error('--no-hooks may only be specified once');
      noHooksSeen = true;
      hooksEnabled = false;
      continue;
    }
    if (option.startsWith('-')) throw new Error(`Unknown setup option: ${option}`);
    throw new Error(`Unexpected setup argument: ${option}`);
  }

  const normalizedIntegrations = integrations.length
    ? PROVIDERS.filter((provider) => integrations.includes(provider))
    : [...PROVIDERS];
  if (!normalizedIntegrations.includes(defaultProvider)) {
    throw new Error(`Default provider ${defaultProvider} is not installed`);
  }
  return { integrations: normalizedIntegrations, defaultProvider, hooksEnabled };
}

function normalizeSetupOptions(options = {}) {
  const manifest = migrateManifest({ version: 2, ...parseSetupOptions([]), ...options });
  return {
    integrations: manifest.integrations,
    defaultProvider: manifest.defaultProvider,
    hooksEnabled: manifest.hooksEnabled,
  };
}

// ---- branded terminal output (degrades to plain on a non-TTY or with NO_COLOR) ----
const useColor = (process.stdout.isTTY || process.env.FORCE_COLOR) && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => paint('1', s), dim = (s) => paint('2', s), green = (s) => paint('32', s), clay = (s) => paint('38;5;173', s);
function banner() {
  console.log('\n' + clay([
    '  ░█▀▀░█▀█░█▀█░█▀▄░█▀█░█▀█░█▀█░█▀▀░█▀▄',
    '  ░▀▀█░█▀█░█░█░█░█░█▀▀░█▀█░█▀▀░█▀▀░█▀▄',
    '  ░▀▀▀░▀░▀░▀░▀░▀▀░░▀░░░▀░▀░▀░░░▀▀▀░▀░▀',
  ].join('\n')));
  console.log('  ' + dim('a living brain for your repo — refine it on the page') + '\n');
}
const section = (name) => console.log(`  ${bold(name)}`);
const row = (label, target, note) => console.log(`   ${green('✓')}  ${label.padEnd(18)}${(target + '  ').padEnd(32)}${note ? dim(note) : ''}`); // the two spaces guarantee a gap when target overruns the column
const nextStep = (integrations = ['claude']) => {
  const entry = integrations.length === 2
    ? `${bold('/sandpaper:init')} in Claude Code or ${bold('$sandpaper init')} in Codex`
    : integrations[0] === 'codex'
      ? `${bold('$sandpaper init')} in Codex`
      : `${bold('/sandpaper:init')} in Claude Code`;
  console.log(`\n  ${clay('▸ NEXT')}   run  ${entry} — it reads this repo`);
  console.log('           and fills your brain: the cover, the lenses, and the books.\n');
};

// ---- the out-link source base: what keeps brain/ publishable away from its repo ----
// The brain's refs to canonical truth (spec · source · package.json) are written RELATIVE —
// local-first. When brain/ is deployed detached, the on-page resolver (brain.js) rewrites them
// to this base at click time. Derived from the git origin, falling back to package.json's
// "repository"; null when neither exists — the meta is then omitted and a detached brain dims
// its out-links instead of rewriting them.
export function repoSource(target) {
  let url = '', dir = '';
  try { url = execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  // the target may sit BELOW the git root (a monorepo package) — out-links are relative to
  // the target, so the base must carry that prefix. show-prefix ends with '/' when non-empty.
  try { dir = execFileSync('git', ['-C', target, 'rev-parse', '--show-prefix'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  if (!url) {
    try {
      const r = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).repository;
      url = typeof r === 'string' ? r : (r && r.url) || '';
      if (!dir && r && r.directory) dir = r.directory.replace(/\/*$/, '/');
    } catch {}
  }
  url = url.replace(/^git\+/, '').replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@([^:/]+)(?::\d+)?\//, 'https://$1/'); // drop any SSH port — dead over TLS
  if (!/^https:\/\//.test(url)) return null;
  url = url.replace(/^(https:\/\/)[^@/]+@/, '$1'); // NEVER carry credentials into a published page
  url = url.replace(/\/+$/, '');
  const view = /\/\/bitbucket\.org\//.test(url) ? '/src/HEAD/' : '/blob/HEAD/'; // GitHub/GitLab grammar, Bitbucket's variant
  let pkgName = '';
  try { pkgName = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name || ''; } catch {}
  return { base: url + view + dir, pkg: pkgName }; // HEAD = default branch, survives renames
}
// escape for interpolation into HTML text/attributes — the base URL and package name come from
// the TARGET repo (its remote, its package.json): treat them as untrusted (a cloned repo could
// carry a hostile name) or the meta becomes stored XSS on every brain page.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sourceMetaTag = (source) => source
  ? `<meta name="sandpaper:source" content="${esc(source.base)}"${source.pkg ? ` data-pkg="${esc(source.pkg)}"` : ''} />`
  : '';

// every .html page under brain/, recursively
function htmlPages(brain) {
  const pages = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const stats = lstatSync(p);
      if (stats.isSymbolicLink()) throw new Error('Sandpaper brain editorial tree contains a symlink');
      if (stats.isDirectory()) walk(p);
      else if (!stats.isFile()) throw new Error('Sandpaper brain editorial tree contains a special file');
      else if (extname(p) === '.html') pages.push(p);
    }
  })(brain);
  return pages;
}

function readEditorialFile(trustedRoot, file, pathClass) {
  const inspected = inspectTrustedPath(trustedRoot, file, { pathClass, finalType: 'file' });
  const flags = constants.O_RDONLY
    | (constants.O_NOFOLLOW || 0)
    | (constants.O_NONBLOCK || 0);
  let descriptor;
  try {
    descriptor = openSync(file, flags);
    const stats = fstatSync(descriptor);
    const expected = statIdentity(inspected.stats);
    const actual = statIdentity(stats);
    if (!stats.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(`Sandpaper ${pathClass} changed during inspection`);
    }
    return { bytes: Buffer.from(readFileSync(descriptor)), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error?.message?.startsWith('Sandpaper ')) throw error;
    throw new Error(`Sandpaper ${pathClass} could not be read safely`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeEditorialFile(trustedRoot, file, bytes, {
  mode = 0o644,
  onlyIfMissing = false,
  setMode = false,
} = {}) {
  ensureTrustedParents(trustedRoot, file, { pathClass: 'brain editorial path' });
  const inspected = inspectTrustedPath(trustedRoot, file, { pathClass: 'brain editorial path' });
  if (inspected.exists && onlyIfMissing) return false;
  if (inspected.exists && !inspected.stats.isFile()) throw new Error('Sandpaper brain editorial path is unsafe');
  const existingIdentity = statIdentity(inspected.stats);
  const flags = inspected.exists
    ? constants.O_WRONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0)
    : constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = openSync(file, flags, mode);
    const stats = fstatSync(descriptor);
    const openedIdentity = statIdentity(stats);
    if (!stats.isFile()
      || (existingIdentity && (openedIdentity.dev !== existingIdentity.dev || openedIdentity.ino !== existingIdentity.ino))) {
      throw new Error('Sandpaper brain editorial path changed before write');
    }
    if (inspected.exists) ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, bytes);
    if (!inspected.exists || setMode) fchmodSync(descriptor, mode);
  } catch (error) {
    if (error?.message?.startsWith('Sandpaper ')) throw error;
    throw new Error('Sandpaper brain editorial write failed safely');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return true;
}

function preflightEditorialTree(trustedRoot, directory, pathClass, { allowAbsent = false } = {}) {
  const inspected = inspectTrustedPath(trustedRoot, directory, { pathClass });
  if (!inspected.exists && allowAbsent) return;
  if (!inspected.exists || !inspected.stats.isDirectory()) throw new Error(`Sandpaper ${pathClass} is unsafe`);
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const child = join(current, name);
      const childInspection = inspectTrustedPath(trustedRoot, child, { pathClass });
      if (!childInspection.exists || childInspection.stats.isSymbolicLink()) {
        throw new Error(`Sandpaper ${pathClass} contains a symlink`);
      }
      if (childInspection.stats.isDirectory()) walk(child);
      else if (childInspection.stats.isFile()) readEditorialFile(trustedRoot, child, pathClass);
      else throw new Error(`Sandpaper ${pathClass} contains a special file`);
    }
  };
  walk(directory);
}

function preflightLifecycleEditorial(target, packageRoot, { allowMissingBrain = false } = {}) {
  preflightEditorialTree(target, join(target, 'brain'), 'brain editorial tree', { allowAbsent: allowMissingBrain });
  preflightEditorialTree(packageRoot, join(packageRoot, 'brain', 'assets'), 'package editorial assets');
}

function copyBrainAssets(packageRoot, brain, { skipExisting }) {
  const sourceRoot = join(packageRoot, 'brain', 'assets');
  preflightEditorialTree(packageRoot, sourceRoot, 'package editorial assets');
  ensureTrustedParents(brain, join(brain, 'assets', 'placeholder'), { pathClass: 'brain editorial path' });
  let copied = 0;
  for (const name of readdirSync(sourceRoot).sort()) {
    const source = join(sourceRoot, name);
    const inspected = inspectTrustedPath(packageRoot, source, { pathClass: 'package editorial asset', finalType: 'file' });
    if (!inspected.exists) throw new Error('Sandpaper package editorial asset is missing');
    const file = readEditorialFile(packageRoot, source, 'package editorial asset');
    if (writeEditorialFile(brain, join(brain, 'assets', name), file.bytes, {
      mode: file.mode,
      onlyIfMissing: skipExisting,
    })) copied += 1;
  }
  return copied;
}

// inject (or refresh) the sandpaper:source meta on every EXISTING brain page. Idempotent;
// returns how many pages were touched. New pages get it via pageShell.
export function ensureSourceMeta(brain, source) {
  if (!source) return 0;
  const tag = sourceMetaTag(source);
  let touched = 0;
  for (const p of htmlPages(brain)) {
    const html = readEditorialFile(brain, p, 'brain HTML page').bytes.toString('utf8');
    const next = html.includes('name="sandpaper:source"')
      ? html.replace(/<meta name="sandpaper:source"[^>]*\/?>/, tag)
      : /<meta name="viewport"/.test(html)
        ? html.replace(/(<meta name="viewport"[^>]*\/?>\s*\n?)/, `$1${tag}\n`)
        : html.replace(/(<head[^>]*>\s*\n?)/i, `$1${tag}\n`); // no viewport meta — inject at the head open
    if (next !== html) { writeEditorialFile(brain, p, Buffer.from(next)); touched++; }
    else if (!html.includes('name="sandpaper:source"')) warn(`could not place the source meta in ${basename(p)} — no <head>?`);
  }
  return touched;
}

function freshManifest(target, pkg, setupOptions) {
  return migrateManifest({
    version: 2,
    project: projectName(target),
    created: today(),
    theme: 'brain/assets/theme.css',
    pkg,
    port: 4848,
    lenses: ['product', 'engineering', 'project'],
    books: ['log', 'decisions', 'learnings'],
    cidPrefixes: { worklog: 'w', task: 't', decision: 'd', learning: 'l', initiative: 'i' },
    counters: { w: 1, t: 0, d: 0, l: 0, i: 0 },
    ...setupOptions,
  });
}

function planInstallationManifest(target, pkg, setupOptions) {
  const file = join(target, '.sandpaper', 'manifest.json');
  const existing = readManifest(file, { trustedRoot: target });
  const hadMan = existing !== null;
  const value = existing
    ? migrateManifest({ ...existing, ...setupOptions })
    : freshManifest(target, pkg, setupOptions);
  return { file, hadMan, existing, value, bytes: Buffer.from(serializeManifest(value)), mode: 0o600 };
}

// Do the brain scaffold work (assets · manifest · multi-page skeleton) and print its BRAIN rows.
function scaffoldBrain(target, pkg, options, {
  updateExistingManifest = false,
  manifestPlan = null,
  skipManifestWrite = false,
  reportManifest = true,
} = {}) {
  const brain = join(target, 'brain'), project = projectName(target), date = today();
  const setupOptions = normalizeSetupOptions(options);
  const manPath = join(target, '.sandpaper', 'manifest.json');
  const hadMan = manifestPlan ? manifestPlan.hadMan : existsSync(manPath);
  const existingManifest = manifestPlan ? manifestPlan.existing : hadMan ? readManifest(manPath) : null;
  let manifestToWrite = null;
  if (manifestPlan) {
    manifestToWrite = manifestPlan.value;
  } else if (!existingManifest) {
    manifestToWrite = freshManifest(target, pkg, setupOptions);
  } else if (updateExistingManifest && options !== undefined) {
    manifestToWrite = migrateManifest({
      ...existingManifest,
      defaultProvider: setupOptions.defaultProvider,
    });
  }

  ensureDir(brain);
  const nA = copyBrainAssets(pkg, brain, { skipExisting: true }); // never clobber a skin
  row('design system', 'brain/assets/', nA ? 'theme · engine · search' : 'kept your skin');
  ensureDir(join(target, '.sandpaper'));
  if (manifestToWrite && !skipManifestWrite) writeManifest(manPath, manifestToWrite);
  const source = repoSource(target);
  const nSkel = writeSkeleton(brain, project, date, source);
  row('multi-page shell', nSkel ? 'cover · 3 lenses · 3 books' : 'already present', nSkel ? 'nav wired · ready to fill' : '');
  if (reportManifest) {
    row('manifest', '.sandpaper/manifest.json', hadMan ? 'kept · id counters' : 'ids · prefixes · port');
  }
  if (source) {
    ensureSourceMeta(brain, source);
    row('source meta', source.base.replace('https://', '').replace('/blob/HEAD/', ''), 'out-links survive any deploy');
  } else {
    row('source meta', 'none yet', 'no git remote — re-run after `git remote add`');
  }
  return { hadManifest: hadMan };
}

export function installSkill(target, pkg, opts = {}, dependencies = {}) {
  const options = normalizeSetupOptions(opts);
  const manifestPlan = planInstallationManifest(target, pkg, options);
  const hookPlans = installationHookPlans(target, pkg, options);
  const installation = prepareInstallIntegrations(target, pkg, options, {
    fs: dependencies.integrationFs,
    hooks: dependencies.integrationHooks,
    manifest: manifestPlan,
    files: hookPlans,
  });
  try {
    banner();
    console.log(`  ${clay('▸')} installing into  ${bold(projectName(target))}\n`);
    // Scaffold first; integration surfaces and manifest selection commit together only after this succeeds.
    section('BRAIN');
    const scaffold = scaffoldBrain(target, pkg, options, {
      manifestPlan,
      skipManifestWrite: true,
      reportManifest: false,
    });
    dependencies.beforeIntegrationCommit?.();
    installation.commit();
    console.log('');
    section('SKILL');
    if (installation.claude) row('13 slash commands', '.claude/commands/sandpaper/', '/sandpaper:<name>');
    else row('Claude integration', '.claude/commands/sandpaper/', 'not selected');
    if (installation.codex) row('Codex skill', '.agents/skills/sandpaper/', '$sandpaper <action>');
    else row('Codex integration', '.agents/skills/sandpaper/', 'not selected');
    section('BRAIN');
    row('manifest', '.sandpaper/manifest.json', scaffold.hadManifest ? 'kept · id counters' : 'ids · prefixes · port');
    section('HOOKS');
    row('2 shared scripts', '.sandpaper/hooks/', 'copied · provider neutral');
    if (!options.hooksEnabled) {
      row('hook configuration', 'Claude + Codex', 'wiring disabled (--no-hooks)');
    } else {
      if (options.integrations.includes('claude')) {
        row('Claude hook config', '.claude/settings.json', 'written · keeps the brain current');
      }
      if (options.integrations.includes('codex')) {
        row('Codex hook config', '.codex/hooks.json', 'written · trust review required');
        console.log('   Codex hook configuration was written, but execution begins only after the project is reviewed and trusted');
        console.log('   and each command hook is separately reviewed and trusted during startup review or through /hooks.');
      }
    }
    nextStep(options.integrations);
  } catch (error) {
    try { installation.abort(); }
    catch (recoveryError) { throw recoveryError; }
    throw error;
  }
}

// ---- init: scaffold brain/ (assets + manifest + the multi-page skeleton) — the mechanical part ----
export function scaffold(target, pkg, options) {
  banner();
  console.log(`  ${clay('▸')} scaffolding the brain into  ${bold(projectName(target))}\n`);
  section('BRAIN');
  scaffoldBrain(target, pkg, options, { updateExistingManifest: true });
  nextStep();
}

function readOptional(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? match[2] : '';
}

function openingTags(html, predicate) {
  return Array.from(html.matchAll(/<[a-z][^>]*>/gi), (match) => match[0]).filter(predicate);
}

function hasClass(tag, name) {
  return (` ${attr(tag, 'class')} `).includes(` ${name} `);
}

function entriesByKind(html, kind) {
  return openingTags(html, (tag) => attr(tag, 'data-kind') === kind
    || hasClass(tag, `entry--${kind}`)
    || (kind === 'component' && hasClass(tag, 'component')));
}

function decodeText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRef(ref) {
  return String(ref || '').replace(/^\.\//, '').replace(/\/\.\//g, '/');
}

function progress(done, total) {
  return `${done}/${total} · ${total ? Math.round(done / total * 100) : 0}%`;
}

// Mechanical brain facts come only from canonical entries. They deliberately do not read
// cover counters or progress labels, so doctor can use them to detect stale fallbacks.
export function deriveBrainFacts(target) {
  const brain = join(target, 'brain');
  const plan = readOptional(join(brain, 'project', 'index.html'));
  const decisionBook = readOptional(join(brain, 'decisions.html'));
  const learningBook = readOptional(join(brain, 'learnings.html'));
  const map = readOptional(join(brain, 'map.html'));

  const taskTags = openingTags(plan, (tag) => hasClass(tag, 'task') && !!attr(tag, 'data-status'));
  const tasks = {
    done: taskTags.filter((tag) => attr(tag, 'data-status') === 'done').length,
    total: taskTags.length,
  };
  const phases = {};
  for (const match of plan.matchAll(/<article\b([^>]*\bentry--initiative\b[^>]*)>([\s\S]*?)<\/article>/gi)) {
    const phase = attr(`<article ${match[1]}>`, 'data-phase');
    if (!phase) continue;
    const phaseTasks = openingTags(match[2], (tag) => hasClass(tag, 'task') && !!attr(tag, 'data-status'));
    const current = phases[phase] || { done: 0, total: 0 };
    current.done += phaseTasks.filter((tag) => attr(tag, 'data-status') === 'done').length;
    current.total += phaseTasks.length;
    phases[phase] = current;
  }

  const decisions = entriesByKind(decisionBook, 'decision')
    .filter((tag) => attr(tag, 'data-status') === 'accepted').length;
  const openQuestions = entriesByKind(decisionBook, 'question')
    .filter((tag) => attr(tag, 'data-status') === 'open')
    .map((tag) => attr(tag, 'id') || attr(tag, 'data-cid'))
    .filter(Boolean);
  const learnings = entriesByKind(learningBook, 'learning').length;
  const componentTags = entriesByKind(map, 'component');
  const components = {
    built: componentTags.filter((tag) => ['built', 'verified'].includes(attr(tag, 'data-status'))).length,
    total: componentTags.length,
  };
  return { tasks, phases, decisions, openQuestions, learnings, components };
}

function sourceMeta(html) {
  const tag = openingTags(html, (candidate) => attr(candidate, 'name') === 'sandpaper:source')[0];
  return tag ? { url: attr(tag, 'content'), pkg: attr(tag, 'data-pkg') } : null;
}

function fallbackNumber(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<[^>]*data-count=["']${escaped}["'][^>]*>\\s*(\\d+)`, 'i'));
  return match ? Number(match[1]) : null;
}

function fallbackProgress(html, selector) {
  const tag = openingTags(html, (candidate) => attr(candidate, 'id') === selector)[0];
  if (!tag) return null;
  const start = html.indexOf(tag) + tag.length;
  const end = html.indexOf('</', start);
  return decodeText(html.slice(start, end < 0 ? start : end));
}

function fallbackPhaseProgress(html, phase) {
  const tag = openingTags(html, (candidate) => attr(candidate, 'data-phase-label') === phase)[0];
  if (!tag) return null;
  const start = html.indexOf(tag) + tag.length;
  const end = html.indexOf('</', start);
  return decodeText(html.slice(start, end < 0 ? start : end));
}

function digestFromCover(cover) {
  const match = cover.match(/<script\b[^>]*\bid=["']brain-state["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return { value: null, error: null };
  try { return { value: JSON.parse(match[1]), error: null }; }
  catch (error) { return { value: null, error }; }
}

function nowFromCover(cover) {
  const match = cover.match(/<([a-z]+)\b([^>]*(?:\bclass=["'][^"']*\bnow-line\b[^"']*["']|\bid=["']now["'])[^>]*)>([\s\S]*?)<\/\1>/i);
  if (!match) return null;
  const tag = `<${match[1]} ${match[2]}>`;
  const withoutLinks = match[3].replace(/<a\b[\s\S]*?<\/a>/gi, '');
  return {
    date: attr(tag, 'data-date'),
    ref: attr(tag, 'data-ref'),
    text: decodeText(withoutLinks),
  };
}

function newestWorklog(logBook) {
  const match = logBook.match(/<li\b([^>]*(?:\bentry--worklog\b|\bdata-kind=["']worklog["'])[^>]*)>([\s\S]*?)<\/li>/i);
  if (!match) return null;
  const tag = `<li ${match[1]}>`;
  const summary = (match[2].match(/<[^>]*\bclass=["'][^"']*\blog-what\b[^"']*["'][^>]*>([\s\S]*?)<\//i) || [])[1];
  return {
    cid: attr(tag, 'data-cid') || attr(tag, 'id'),
    date: attr(tag, 'data-date'),
    text: decodeText(summary == null ? match[2] : summary),
  };
}

export function inspectBrain(target) {
  const brain = join(target, 'brain');
  const problems = [];
  const warnings = [];
  const facts = deriveBrainFacts(target);
  const problem = (code, message, details = {}) => problems.push({ code, message, ...details });
  const warning = (code, message) => warnings.push({ code, message });

  if (!existsSync(brain)) {
    problem('missing-brain', 'no brain/ — run `npx sandpaper init` (then /sandpaper:init)');
    return { problems, warnings, facts };
  }
  for (const asset of ['theme.css', 'brain.css', 'brain.js']) {
    if (!existsSync(join(brain, 'assets', asset))) problem('missing-asset', `missing assets/${asset}`, { asset });
  }
  const css = readOptional(join(brain, 'assets', 'brain.css'));
  if (css && !/@import\s+["']theme\.css/.test(css)) warning('theme-import', 'brain.css does not @import theme.css — re-skins may not propagate');

  const cover = readOptional(join(brain, 'index.html'));
  const logBook = readOptional(join(brain, 'log.html'));
  const populated = facts.tasks.total || facts.decisions || facts.openQuestions.length
    || facts.learnings || facts.components.total || entriesByKind(logBook, 'worklog').length;
  if (!cover) problem('missing-cover', 'brain/index.html unreadable');
  const digest = digestFromCover(cover);
  if (digest.error) problem('digest-json', '#brain-state digest is invalid JSON');
  else if (!digest.value) {
    if (populated) problem('missing-digest', 'populated brain has no #brain-state digest');
    else warning('missing-digest', 'cover has no #brain-state digest');
  }

  for (const broken of checkBrainLinks(target, brain)) {
    problem('brain-link', `${broken.page}: ${broken.reference} — ${broken.message}`, broken);
  }

  const expectedSource = repoSource(target);
  const pages = htmlPages(brain);
  for (const file of pages) {
    const relativePage = relative(target, file).split(sep).join('/');
    const actual = sourceMeta(readOptional(file));
    if (!expectedSource) {
      if (actual) problem('source-url', `${relativePage}: source metadata exists but the repository has no source URL`, { page: relativePage });
      continue;
    }
    if (!actual || actual.url !== expectedSource.base) {
      problem('source-url', `${relativePage}: sandpaper:source must match repoSource()`, { page: relativePage });
    }
    if (!actual || actual.pkg !== expectedSource.pkg) {
      problem('source-package', `${relativePage}: data-pkg must match package.json`, { page: relativePage });
    }
  }
  if (!expectedSource && pages.every((file) => !sourceMeta(readOptional(file)))) {
    warning('missing-source', 'no sandpaper:source meta — detached deploys will dim repository links');
  }

  if (populated && digest.value) {
    const now = nowFromCover(cover);
    const latest = newestWorklog(logBook);
    if (!now) problem('digest-focus', 'populated brain has no stamped NOW entry');
    else {
      if (digest.value.updated !== now.date) problem('digest-updated', 'digest updated date must match NOW date');
      if (normalizeRef(digest.value.focus && digest.value.focus.ref) !== normalizeRef(now.ref)
        || decodeText(digest.value.focus && digest.value.focus.one) !== now.text) {
        problem('digest-focus', 'digest focus must match the stamped NOW sentence and reference');
      }
    }
    if (latest) {
      const stamped = Array.isArray(digest.value.worklog) ? digest.value.worklog[0] : null;
      if (!stamped || stamped.cid !== latest.cid || stamped.date !== latest.date || decodeText(stamped.one) !== latest.text) {
        problem('digest-worklog', 'digest newest worklog must match the ledger newest row');
      }
      if (digest.value.updated !== latest.date) problem('digest-updated', 'digest updated date must match the newest worklog date');
    } else {
      problem('digest-worklog', 'populated brain has no worklog ledger entry');
    }
    const digestOpen = (Array.isArray(digest.value.open) ? digest.value.open : [])
      .map((ref) => String(ref).split('#')[1] || '')
      .filter(Boolean)
      .sort();
    const actualOpen = [...facts.openQuestions].sort();
    if (JSON.stringify(digestOpen) !== JSON.stringify(actualOpen)) {
      problem('digest-open', 'digest open list must match open question status');
    }
  }

  const countChecks = [
    ['question:open', facts.openQuestions.length, 'fallback-question-count'],
    ['decision', facts.decisions, 'fallback-decision-count'],
    ['learning', facts.learnings, 'fallback-learning-count'],
    ['component:built', facts.components.built, 'fallback-component-count'],
    ['component:total', facts.components.total, 'fallback-component-total'],
  ];
  for (const [key, expected, code] of countChecks) {
    const actual = fallbackNumber(cover, key);
    if (actual != null && actual !== expected) problem(code, `${key} fallback is ${actual}; derived truth is ${expected}`);
  }
  const builtHook = openingTags(cover, (tag) => attr(tag, 'data-count') === 'component:built')[0];
  if (builtHook) {
    const after = cover.slice(cover.indexOf(builtHook) + builtHook.length);
    const total = after.match(/<\/[^>]+>\s*\/\s*(\d+)\s+built/i);
    if (total && Number(total[1]) !== facts.components.total) {
      problem('fallback-component-count', `component total fallback is ${total[1]}; derived truth is ${facts.components.total}`);
    }
  }
  const plan = readOptional(join(brain, 'project', 'index.html'));
  const overall = fallbackProgress(plan, 'plan-overall');
  if (overall != null && overall !== progress(facts.tasks.done, facts.tasks.total)) {
    problem('fallback-plan-progress', `overall fallback is ${overall}; derived truth is ${progress(facts.tasks.done, facts.tasks.total)}`);
  }
  for (const [phase, value] of Object.entries(facts.phases)) {
    const actual = fallbackPhaseProgress(plan, phase);
    if (actual != null && actual !== progress(value.done, value.total)) {
      problem('fallback-phase-progress', `phase ${phase} fallback is ${actual}; derived truth is ${progress(value.done, value.total)}`, { phase });
    }
  }

  const openIds = new Set(facts.openQuestions);
  const openList = cover.match(/<(?:ul|ol)\b[^>]*(?:data-open-list|class=["'][^"']*\bneeds\b)[^>]*>([\s\S]*?)<\/(?:ul|ol)>/i);
  if (openList) {
    for (const match of openList[1].matchAll(/<a\b[^>]*href=["'][^"']*#([^"']+)["'][^>]*>/gi)) {
      if (!openIds.has(match[1])) problem('fallback-open-list', `curated open row ${match[1]} is no longer open`, { id: match[1] });
    }
  }

  const manifest = join(target, '.sandpaper', 'manifest.json');
  const manifestInspection = inspectManifest(manifest, { trustedRoot: target });
  if (manifestInspection.status === 'absent') {
    warning('missing-manifest', 'no .sandpaper/manifest.json — run `npx sandpaper init`');
  } else if (['corrupt', 'unsupported', 'unsafe'].includes(manifestInspection.status)) {
    problem('manifest-json', '.sandpaper/manifest.json is invalid or unsafe');
  }
  if (!existsSync(join(target, '.sandpaper', 'hooks', 'brain-stamp-check.js'))) {
    warning('missing-hooks', 'hooks not installed — run `npx sandpaper install-skill`');
  }
  return { problems, warnings, facts };
}

// ---- doctor: print the independently inspected health of a Sandpaper setup ----
export function doctor(target, packageRoot, { runCommand } = {}) {
  console.log('\n  🪵  Sandpaper doctor\n');
  const brain = inspectBrain(target);
  const installation = packageRoot
    ? inspectInstallation(target, packageRoot, { ...(runCommand ? { runCommand } : {}) })
    : null;
  const mergeByCode = (primary, secondary) => {
    const seen = new Set(primary.map(({ code }) => code));
    return [...primary, ...secondary.filter(({ code }) => !seen.has(code))];
  };
  const problems = mergeByCode(brain.problems, installation?.problems || []);
  const warnings = mergeByCode(brain.warnings, installation?.warnings || []);
  if (!brain.problems.some((entry) => entry.code === 'missing-brain')) ok('brain/ exists');
  if (installation) {
    ok(`integrations: ${installation.integrations.length ? installation.integrations.join(' + ') : 'not configured'}`);
    ok(`default provider: ${installation.defaultProvider || 'not configured'}`);
    for (const provider of PROVIDERS) {
      const diagnosis = installation.providers[provider];
      const label = provider === 'claude' ? 'Claude Code' : 'Codex';
      const auth = diagnosis.authMethod || diagnosis.unavailableCode || 'unknown';
      const version = diagnosis.version ? ` · ${diagnosis.version}` : '';
      if (diagnosis.available) ok(`${label}: ${auth}${version}`);
      else warn(`warning [${provider}-${diagnosis.unavailableCode || 'unavailable'}]: ${label} is not ready (${auth})${version}`);
    }
  }
  for (const problem of problems) bad(`${problem.message}${problem.repair ? ` Repair: ${problem.repair}` : ''}`);
  for (const entry of warnings) warn(`warning [${entry.code}]: ${entry.message}${entry.repair ? ` Repair: ${entry.repair}` : ''}`);
  if (!brain.problems.length) {
    const { tasks, decisions, openQuestions, learnings, components } = brain.facts;
    ok(`derived truth agrees (${tasks.done}/${tasks.total} tasks · ${openQuestions.length} open · ${decisions} decisions · ${learnings} learnings · ${components.built}/${components.total} built)`);
  }
  console.log(`\n  ${problems.length ? '✗ ' + problems.length + ' problem(s).' : '✓ healthy.'}\n`);
  process.exitCode = problems.length ? 1 : 0;
  return { problems, warnings, facts: brain.facts, brain, installation };
}

// ---- upgrade: bring an EXISTING brain up to the current package (assets · hooks · commands · the canvas) ----
export function upgrade(target, pkg, overrides = {}, dependencies = {}) {
  return upgradeWithOptions(target, pkg, overrides, dependencies);
}

function lifecycleManifestPlan(target, overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Invalid Sandpaper lifecycle overrides');
  }
  const allowed = new Set(['integrations', 'defaultProvider', 'hooksEnabled']);
  if (Object.keys(overrides).some((key) => !allowed.has(key))) {
    throw new Error('Invalid Sandpaper lifecycle override');
  }
  const file = join(target, '.sandpaper', 'manifest.json');
  const existing = readManifest(file, { trustedRoot: target });
  if (!existing) throw new Error('No Sandpaper manifest is installed');
  const value = migrateManifest({ ...existing, ...overrides });
  return {
    file,
    hadMan: true,
    existing,
    value,
    bytes: Buffer.from(serializeManifest(value)),
    mode: 0o600,
  };
}

function lstatIfPresent(file) {
  try { return lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Could not inspect Sandpaper lifecycle path');
  }
}

function requireRegularBrain(brain, { allowAbsent = false } = {}) {
  const stats = lstatIfPresent(brain);
  if (!stats && allowAbsent) return null;
  if (!stats) throw new Error('No brain/ here; run `npx @nynb/sandpaper init` first');
  if (stats.isSymbolicLink()) throw new Error('Sandpaper brain path is an unsafe symlink');
  if (!stats.isDirectory()) throw new Error('Sandpaper brain path is an unsafe special file');
  return stats;
}

function safeThemeSnapshot(brain) {
  const file = join(brain, 'assets', 'theme.css');
  const inspected = inspectTrustedPath(brain, file, { pathClass: 'brain theme path' });
  if (!inspected.exists) return null;
  return readEditorialFile(brain, file, 'brain theme path');
}

function lifecycleRecovery({ providerError = null, brainError = null, brainBackupPath = null, activeBrainPath = null }) {
  const recovery = new Error('Sandpaper lifecycle recovery required');
  recovery.code = 'SANDPAPER_RECOVERY_REQUIRED';
  recovery.phase = providerError?.phase || brainError?.phase || 'precommit_recovery';
  recovery.destinationsCommitted = Boolean(providerError?.destinationsCommitted);
  if (providerError?.recoveryPath) recovery.providerRecoveryPath = providerError.recoveryPath;
  if (brainBackupPath) recovery.brainBackupPath = brainBackupPath;
  const brainRecoveryPath = brainError?.brainRecoveryPath || brainError?.recoveryPath || activeBrainPath;
  if (brainRecoveryPath) recovery.brainRecoveryPath = brainRecoveryPath;
  recovery.recoveryPath = recovery.providerRecoveryPath
    || brainError?.recoveryPath
    || recovery.brainBackupPath
    || recovery.brainRecoveryPath;
  return recovery;
}

function upgradeWithOptions(target, pkg, overrides = {}, dependencies = {}) {
  console.log(`\n  🪵  Upgrading Sandpaper in ${target}\n`);
  const brain = join(target, 'brain');
  requireRegularBrain(brain);
  preflightLifecycleEditorial(target, pkg);
  // Preflight the complete provider transaction before any editorial brain write.
  const manifestPlan = lifecycleManifestPlan(target, overrides);
  const options = {
    integrations: manifestPlan.value.integrations,
    defaultProvider: manifestPlan.value.defaultProvider,
    hooksEnabled: manifestPlan.value.hooksEnabled,
  };
  const installation = prepareInstallIntegrations(target, pkg, options, {
    fs: dependencies.integrationFs,
    hooks: dependencies.integrationHooks,
    manifest: manifestPlan,
    files: installationHookPlans(target, pkg, options),
  });
  let committed = false;
  let postcommitRecovery = null;
  try {
    dependencies.beforeIntegrationCommit?.();
    installation.commit();
    committed = true;
  } catch (error) {
    if (error?.destinationsCommitted) {
      committed = true;
      postcommitRecovery = error;
    } else if (!committed) {
      try { installation.abort(); } catch (recoveryError) { throw recoveryError; }
      throw error;
    }
  }
  ok(`${options.integrations.join(' + ')} integrations refreshed transactionally`);
  ok(`hook intent preserved (${options.hooksEnabled ? 'enabled' : 'disabled'})`);
  ok('manifest selections and shared hook scripts preserved');

  try {
    dependencies.beforeEditorialPreflight?.({ brain });
    preflightLifecycleEditorial(target, pkg);

  // Editorial brain refresh is deliberately a separate best-effort phase. Provider
  // intent has already committed atomically; custom theme bytes are never replaced.
  //    (the skin). Same-path guard: run inside the Sandpaper repo itself, src and dst are ONE file —
  //    copyFileSync would truncate it before reading.
  const aSrc = join(pkg, 'brain', 'assets'), aDst = join(brain, 'assets');
  const samePath = resolve(aSrc) === resolve(aDst);
  for (const a of ['brain.css', 'brain.js']) {
    if (samePath) { ok(`assets/${a} is the package copy`); continue; }
    const sourceAsset = readEditorialFile(pkg, join(aSrc, a), 'package editorial asset');
    writeEditorialFile(brain, join(aDst, a), sourceAsset.bytes, { mode: sourceAsset.mode });
    ok(`assets/${a} → latest`);
  }
  const installedTheme = inspectTrustedPath(brain, join(aDst, 'theme.css'), { pathClass: 'brain theme path' });
  if (installedTheme.exists) warn('assets/theme.css kept — it is your skin (delete it + re-run to take the shipped one)');
  else {
    const sourceTheme = readEditorialFile(pkg, join(aSrc, 'theme.css'), 'package editorial asset');
    writeEditorialFile(brain, join(aDst, 'theme.css'), sourceTheme.bytes, { mode: sourceTheme.mode });
    ok('assets/theme.css added');
  }

  // 3. multi-page structure → add any MISSING skeleton pages (a single-pager / old brain lacks the
  //    lens pages + books). skipExisting, so real content is never touched.
  const source = repoSource(target);
  const nSkel = writeSkeleton(brain, projectName(target), today(), source);
  if (nSkel) ok(`${nSkel} missing skeleton page(s) added — lens pages / books were absent`);
  else ok('multi-page skeleton already present');
  if (source) {
    const nMeta = ensureSourceMeta(brain, source);
    ok(nMeta ? `sandpaper:source meta set on ${nMeta} page(s) — out-links survive any deploy` : 'sandpaper:source meta already current');
  } else warn('no git remote / repository field — sandpaper:source meta skipped (a detached deploy dims its out-links)');

  // 4. inject the canvas region into the cover if it predates the canvas
  const r = ensureCanvas(brain, join(brain, 'index.html'));
  if (r.had) ok('cover already hosts the canvas');
  else if (r.injected) ok(`canvas added to the cover (${r.anchor})`);
  else { warn('couldn\'t find a safe spot to add the canvas — paste this into brain/index.html just below the NOW plate:'); console.log('\n' + canvasSection() + '\n'); }

  console.log('\n  Upgraded. `npx sandpaper open` to view.');
  if (nSkel) console.log('  Added missing structure — run the Sandpaper init workflow in your selected agent to fill the new pages.');
    console.log('');
  } catch (editorialError) {
    if (postcommitRecovery) {
      postcommitRecovery.providerRecoveryPath ||= postcommitRecovery.recoveryPath;
      postcommitRecovery.editorialError = String(editorialError?.message || 'Editorial phase failed').slice(0, 160);
      postcommitRecovery.editorialCode = String(editorialError?.code || 'EDITORIAL_FAILURE').slice(0, 80);
      throw postcommitRecovery;
    }
    throw editorialError;
  }
  if (postcommitRecovery) {
    postcommitRecovery.providerRecoveryPath ||= postcommitRecovery.recoveryPath;
    throw postcommitRecovery;
  }
}

// ---- rebuild: a full, safe reset — back up the old brain, then reinstall + a fresh skeleton ----
export function rebuild(target, pkg, overrides = {}, dependencies = {}) {
  const brain = join(target, 'brain');
  const oldBrain = requireRegularBrain(brain, { allowAbsent: true });
  preflightLifecycleEditorial(target, pkg, { allowMissingBrain: true });
  const manifestPlan = lifecycleManifestPlan(target, overrides);
  const options = {
    integrations: manifestPlan.value.integrations,
    defaultProvider: manifestPlan.value.defaultProvider,
    hooksEnabled: manifestPlan.value.hooksEnabled,
  };
  const theme = oldBrain ? safeThemeSnapshot(brain) : null;
  const backup = oldBrain ? backupName(target) : null;
  // Preflight provider sources, managed markers, hook configs, scripts and manifest
  // before moving user data out of its active location.
  const installation = prepareInstallIntegrations(target, pkg, options, {
    fs: dependencies.integrationFs,
    hooks: dependencies.integrationHooks,
    manifest: manifestPlan,
    files: installationHookPlans(target, pkg, options),
  });
  let generatedIdentity = null;
  let generatedInventory = null;
  let committed = false;
  try {
    if (backup) {
      renameSync(brain, backup);
      console.log(`\n  ${clay('▸')} backed up your old brain → ${bold(basename(backup) + '/')}   ${dim('(kept, just in case)')}`);
      dependencies.afterBrainBackup?.({ backup });
    }
    mkdirSync(brain, { mode: 0o755 });
    const created = lstatSync(brain);
    generatedIdentity = statIdentity(created);
    dependencies.beforeScaffold?.({ brain, backup });
    banner();
    console.log(`  ${clay('▸')} rebuilding in  ${bold(projectName(target))}\n`);
    section('BRAIN');
    scaffoldBrain(target, pkg, options, {
      manifestPlan,
      skipManifestWrite: true,
      reportManifest: false,
    });
    if (theme) {
      const themeFile = join(brain, 'assets', 'theme.css');
      writeEditorialFile(brain, themeFile, theme.bytes, { mode: theme.mode, setMode: true });
    }
    generatedInventory = captureExactTree(brain);
    dependencies.afterScaffold?.({ brain, backup });
    dependencies.beforeIntegrationCommit?.();
    try {
      installation.commit();
      committed = true;
    } catch (error) {
      if (!error?.destinationsCommitted) throw error;
      committed = true;
      section('SKILL');
      if (options.integrations.includes('claude')) row('Claude integration', '.claude/commands/sandpaper/', 'preserved');
      if (options.integrations.includes('codex')) row('Codex integration', '.agents/skills/sandpaper/', 'preserved');
      row('manifest', '.sandpaper/manifest.json', 'identity · counters · provider intent preserved');
      nextStep(options.integrations);
      throw error;
    }
    section('SKILL');
    if (options.integrations.includes('claude')) row('Claude integration', '.claude/commands/sandpaper/', 'preserved');
    if (options.integrations.includes('codex')) row('Codex integration', '.agents/skills/sandpaper/', 'preserved');
    row('manifest', '.sandpaper/manifest.json', 'identity · counters · provider intent preserved');
    nextStep(options.integrations);
  } catch (error) {
    if (error?.destinationsCommitted || committed) {
      throw error;
    }
    let providerRecovery = error?.code === 'SANDPAPER_RECOVERY_REQUIRED' ? error : null;
    try { installation.abort(); }
    catch (recoveryError) { providerRecovery ||= recoveryError; }
    try {
      const active = lstatIfPresent(brain);
      if (active) {
        const owned = generatedIdentity
          && active.dev === generatedIdentity.dev
          && active.ino === generatedIdentity.ino
          && active.isDirectory()
          && !active.isSymbolicLink();
        const complete = generatedInventory !== null;
        let unchanged = false;
        if (complete) {
          try { unchanged = sameExactTree(captureExactTree(brain), generatedInventory); }
          catch { unchanged = false; }
        }
        if (!owned || !complete || !unchanged) {
          const brainError = new Error('Sandpaper fresh brain changed concurrently');
          brainError.code = 'SANDPAPER_RECOVERY_REQUIRED';
          brainError.recoveryPath = backup;
          brainError.brainRecoveryPath = brain;
          throw lifecycleRecovery({ providerError: providerRecovery, brainError, brainBackupPath: backup, activeBrainPath: brain });
        }
        try {
          quarantineCleanup(brain, generatedIdentity, {
            hooks: dependencies.brainCleanupHooks,
            expectedExactTree: generatedInventory,
          });
        } catch (cleanupError) {
          throw lifecycleRecovery({
            providerError: providerRecovery,
            brainError: cleanupError,
            brainBackupPath: backup,
            activeBrainPath: brain,
          });
        }
      }
      if (backup) renameSync(backup, brain);
    } catch (recoveryError) {
      if (recoveryError?.code === 'SANDPAPER_RECOVERY_REQUIRED') throw recoveryError;
      const recovery = new Error('Sandpaper rebuild recovery required; old brain retained at backup path');
      recovery.code = 'SANDPAPER_RECOVERY_REQUIRED';
      recovery.recoveryPath = backup;
      recovery.brainBackupPath = backup;
      recovery.activeBrainPath = brain;
      throw recovery;
    }
    if (providerRecovery) {
      providerRecovery.providerRecoveryPath ||= providerRecovery.recoveryPath;
      throw providerRecovery;
    }
    throw error;
  }
}
// a non-clobbering backup path: brain.bak-YYYY-MM-DD, then -2, -3, … if that already exists
function backupName(target) {
  const base = join(target, `brain.bak-${today()}`);
  if (!lstatIfPresent(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!lstatIfPresent(candidate)) return candidate;
  }
  throw new Error('Could not choose a bounded Sandpaper brain backup path');
}

// The canvas section (empty state) — shared by the scaffold's starter cover and `upgrade`.
function canvasSection() {
  return `  <section class="canvas" id="s-canvas" data-cid="s-canvas" aria-label="Canvas">
    <div class="canvas-rail"><div class="eyebrow">Canvas <span class="canvas-sub">— where agent explanations show up</span></div></div>
    <!-- BRAIN:CANVAS — the current board lives in .whiteboard; older ones fold into .canvas-earlier below -->
    <div class="whiteboard" data-cid="whiteboard">
      <div class="canvas-empty" data-cid="canvas-empty">
        <p class="canvas-empty-lead">Your canvas is empty — for now.</p>
        <p>As you work with an agent here, the things worth keeping — how a part works, why a choice was
          made — land on this whiteboard as little cards you can read and come back to, instead of
          scrolling past in the terminal.</p>
      </div>
    </div>
    <!-- /BRAIN:CANVAS -->
  </section>`;
}

// Add the canvas section to an existing cover that lacks it. Best-effort: try a few stable anchors.
function ensureCanvas(brain, coverPath) {
  let html;
  try { html = readEditorialFile(brain, coverPath, 'brain cover').bytes.toString('utf8'); }
  catch { return { injected: false }; }
  if (html.includes('BRAIN:CANVAS') || html.includes('class="whiteboard"')) return { had: true };
  const section = canvasSection();
  // ordered anchors: just after the NOW plate, else above the doors / first section
  const anchors = [
    { find: '<!-- /BRAIN:EDITION -->', after: true, name: 'below the NOW plate' },
    { find: '<nav class="doors"', after: false, name: 'above the lens doors' },
    { find: '<section class="zone"', after: false, name: 'above the first section' },
    { find: '</header>', after: true, name: 'below the header' },
  ];
  for (const a of anchors) {
    const i = html.indexOf(a.find);
    if (i < 0) continue;
    const pos = a.after ? i + a.find.length : i;
    const out = html.slice(0, pos) + (a.after ? '\n' + section : section + '\n  ') + html.slice(pos);
    try {
      writeEditorialFile(brain, coverPath, Buffer.from(out));
      return { injected: true, anchor: a.name };
    } catch { return { injected: false }; }
  }
  return { injected: false };
}

// Walk brain/*.html and report local href/src/data-ref targets rejected by repository policy,
// missing on disk, unreadable, or missing their requested anchor.
export function checkBrainLinks(target, brain) {
  const pages = htmlPages(brain);
  const problems = [];
  for (const p of pages) {
    const html = readFileSync(p, 'utf8'), dir = dirname(p);
    for (const m of html.matchAll(/(?:href|src|data-ref)="([^"]+)"/g)) {
      const hr = m[1];
      if (/^(https?:|#|mailto:|data:)/.test(hr)) continue;
      const [path, anchor] = hr.split('#');
      const candidate = resolve(dir, path.endsWith('/') ? path + 'index.html' : path);
      const result = resolveRepositoryPath(target, candidate);
      const page = relative(target, p).split(sep).join('/');
      if (!result.ok) {
        problems.push({
          page,
          reference: hr,
          reason: result.reason,
          message: linkProblemMessage(result.reason),
        });
        continue;
      }
      if (!anchor) continue;
      try {
        const x = readFileSync(result.file, 'utf8').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
        const hasAnchor = openingTags(x, (tag) => attr(tag, 'id') === anchor || attr(tag, 'name') === anchor).length > 0;
        if (!hasAnchor) {
          problems.push({ page, reference: hr, reason: 'missing-anchor', message: `anchor #${anchor} not found` });
        }
      } catch {
        problems.push({ page, reference: hr, reason: PATH_REASONS.UNREADABLE, message: linkProblemMessage(PATH_REASONS.UNREADABLE) });
      }
    }
  }
  return problems;
}

function linkProblemMessage(reason) {
  if (reason === PATH_REASONS.MISSING) return 'target does not exist';
  if (reason === PATH_REASONS.UNREADABLE) return 'target is unreadable';
  return `target rejected by repository policy (${reason})`;
}

// ---- the multi-page skeleton: one shared shell + per-page bodies (so the brain is never a single page) ----
// Write any MISSING skeleton pages (cover + 3 lens pages + 3 books). skipExisting → only adds; returns
// the count added. Shared by scaffold (fresh) and upgrade (fills gaps in an existing brain).
function writeSkeleton(brain, project, date, source = null) {
  let added = 0;
  const write = (rel, html) => {
    const p = join(brain, rel);
    if (writeEditorialFile(brain, p, Buffer.from(html), { onlyIfMissing: true })) added++;
  };
  write('index.html', pageShell({ project, prefix: '', title: 'cover', headExtra: coverDigest(project, date), main: coverMain(project, date), source }));
  for (const [slug, name, blurb] of [['product', 'Product', 'what it is & why it earns its place'],
    ['engineering', 'Engineering', 'how it is built'], ['project', 'Project', 'the plan & progress']])
    write(`${slug}/index.html`, pageShell({ project, prefix: '../', title: name, main: lensMain(name, blurb), source }));
  for (const [slug, name, blurb] of [['log', 'Log', 'the work log — newest first'],
    ['decisions', 'Decisions', 'the ledger of calls made'], ['learnings', 'Learnings', 'gotchas & verdicts']])
    write(`${slug}.html`, pageShell({ project, prefix: '', title: name, main: bookMain(name, blurb), source }));
  const readme = join(brain, 'README.md'); // the deploy guide rides along — not counted as a skeleton PAGE
  writeEditorialFile(brain, readme, Buffer.from(deployReadme()), { onlyIfMissing: true });
  return added;
}

// the deploy guide that ships inside every brain — kept generic (any project's brain)
function deployReadme() {
  return `# Deploying the brain

## What this folder is

This folder is the project's living brain: a small static site — a cover (\`index.html\`),
lens pages, and the books (log · decisions · learnings) — styled by \`assets/theme.css\` +
\`assets/brain.css\` with a little vanilla JS in \`assets/brain.js\`. No framework, no build
step, no server-side anything. It is **always publishable**: point any static host at this
folder as-is and it works.

One design choice shapes everything below: the brain **links, never copies**. Canonical
truth lives in the parent repo — the spec docs, source files, \`package.json\` — and the
brain references them with relative paths (\`../…\`) so they resolve on disk and whenever
the whole repo is served.

## Two deploy shapes

### 1. Whole-repo deploy (recommended for public repos)

Serve the repo root and visit \`/brain/\`. Every out-of-brain link resolves: spec HTML docs
render with working \`#anchors\`, source files are viewable. GitHub Pages serving the repo
root does this perfectly.

### 2. Brain-only deploy (site root = this folder)

The relative \`../\` refs can't resolve — there's nothing above the root. The built-in
resolver in \`assets/brain.js\` handles it. Each page's head carries:

\`\`\`html
<meta name="sandpaper:source" content="https://github.com/<owner>/<repo>/blob/HEAD/" data-pkg="<package-name>" />
\`\`\`

On load, the page probes \`../package.json\` and checks its \`name\` against \`data-pkg\`.
If the probe fails (or the name doesn't match), the page knows it is detached, and
out-links open the source-host copy instead (rewritten at click time). Source and meta
files render fine on GitHub's blob view; spec **HTML** docs land on blob *source* view —
unrendered. Use the whole-repo shape if you want rendered specs. With no meta configured,
out-links dim with a tooltip instead of 404ing.

The meta is written automatically by \`npx sandpaper init\` / \`upgrade\` from the git
origin (or \`package.json\` → \`"repository"\`). \`npx sandpaper doctor\` verifies it is
present and consistent across pages.

## Deployed brains are read-only

The refine toolbar (Sand / Hands / Sling) is injected only by the local \`sandpaper\`
server — a deployed brain has no toolbar and can't be edited from the page. By design:
the public copy is for reading.

## Recipes

**GitHub Pages (simplest)** — Settings → Pages → Source: *Deploy from a branch*, branch
\`main\`, folder \`/ (root)\`. That's the whole-repo shape — visit
\`https://<owner>.github.io/<repo>/brain/\`. For the brain-only shape, use Source:
*GitHub Actions* with this workflow:

\`\`\`yaml
name: Deploy brain
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "\${{ steps.deployment.outputs.page_url }}" }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with: { path: brain }          # 'path: .' switches to the whole-repo shape
      - id: deployment
        uses: actions/deploy-pages@v4
\`\`\`

**Vercel** — New Project → import the repo. Root Directory = repo root (or \`brain/\` for
brain-only), Framework Preset = *Other*, no build command, Output Directory = \`./\`.

**Netlify** — New site from Git. No build command. Publish directory: \`brain\` (or the
repo root).

**Cloudflare Pages** — Connect the repo. No build command. Build output directory:
\`brain\` (or \`/\`).

## Privacy

Deploying the whole repo publishes **all** of its files, not just the brain. Brain-only
publishes just this folder — but its out-links point at the source host, which must be
public for them to work. Either way, assume everything the brain links to is visible.
Don't deploy a brain whose repo isn't ready to be read.
`;
}

// prefix: '' for pages at brain/ root (cover, books), '../' for pages one dir deep (lenses).
function pageShell({ project, prefix, title, headExtra = '', main, source = null }) {
  const link = (href, label) => `<a href="${prefix}${href}">${label}</a>`;
  const meta = sourceMetaTag(source);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
${meta ? meta + '\n' : ''}<title>${esc(project)} — ${title}</title>
<link rel="stylesheet" href="${prefix}assets/brain.css" />
${headExtra}</head>
<body>
<div class="wrap">
  <div class="shell">
    <div class="shell-id">
      <a class="shell-mark" href="${prefix}index.html">${esc(project)}</a>
      <div class="shell-state"><a href="${prefix}log.html">fresh brain</a></div>
    </div>
    <nav class="shell-rail" aria-label="Lenses">
      ${link('index.html', 'Cover')}
      ${link('product/index.html', 'Product')}
      ${link('engineering/index.html', 'Engineering')}
      ${link('project/index.html', 'Project')}
    </nav>
  </div>
${main}
  <footer class="portal-foot" data-cid="footer">
    <div class="foot-col"><div class="foot-h">Books</div>
      ${link('log.html', 'Log')}
      ${link('decisions.html', 'Decisions')}
      ${link('learnings.html', 'Learnings')}
    </div>
  </footer>
</div>
<script src="${prefix}assets/brain.js" defer></script>
</body>
</html>
`;
}

// the cover needs the #brain-state digest in <head> — the SessionStart hook reads it to rehydrate
function coverDigest(project, date) {
  return `<script type="application/json" id="brain-state">
{ "v":1, "project":${JSON.stringify(String(project))}, "phase":"fresh", "updated":"${date}", "session":"S01",
  "focus":{ "one":"Brain scaffolded — run the Sandpaper init workflow to harvest this repo and fill it", "ref":"#" },
  "worklog":[ {"date":"${date}","one":"Brain scaffolded by sandpaper","cid":"w-0001"} ],
  "open":[], "docs":[] }
</script>
`;
}
function coverMain(project, date) {
  return `  <header class="plate" data-cid="cover" style="margin-top:14px">
    <div class="pl-meta">Fresh brain · stamped ${date}</div>
    <p class="now-line" data-cid="now" data-kind="now">Run the Sandpaper init workflow in your agent to harvest
      this repo and fill the brain — it discovers your code, specs, and docs, asks a few questions, then fills
      these pages.</p>
  </header>
${canvasSection()}
  <section class="zone"><div class="eyebrow">Where it stands</div>
    <p class="muted">The plan board, decisions, and log fill in when you initialize the Sandpaper brain.</p>
  </section>`;
}
function lensMain(name, blurb) {
  const slug = name.toLowerCase();
  return `  <header class="lens-hero lens--${slug}" data-cid="lens-${slug}" data-lens="${slug}">
    <div class="eyebrow">${name}</div>
    <h1>${blurb}</h1>
    <p>Run the Sandpaper init workflow to fill this lens with real, linked content.</p>
  </header>
  <!-- FILL: ${name} lens prose + records (.entry grammar). Keep this a SEPARATE page; do not merge lenses. -->
  <section class="zone"><p class="muted">Not filled yet.</p></section>`;
}
function bookMain(name, blurb) {
  return `  <section class="zone flush">
    <div class="eyebrow">${name}</div>
    <h1 style="font-size:30px;letter-spacing:-.02em;margin:6px 0 0">${name}</h1>
    <p class="muted">${blurb}</p>
  </section>
  <!-- FILL: ${name} entries. Keep this a SEPARATE page. -->
  <section class="zone flush"><p class="muted">Empty until the Sandpaper init workflow runs.</p></section>`;
}
