import { createRequire } from 'node:module';
import { posix } from 'node:path';

// Every rule is an individually reviewed package path. Keep this list in the same
// order as package.json#files; npm also adds LICENSE and package.json.
export const APPROVED_FILE_RULES = Object.freeze([
  'bin/brain-inject.js',
  'bin/brain-stamp-check.js',
  'bin/cli.js',
  'bin/syntax-check.js',
  'bin/verify-publish.js',
  'src/claude.js',
  'src/codex.js',
  'src/diagnostics.js',
  'src/edit.js',
  'src/hooks.js',
  'src/integrations.js',
  'src/managed-files.js',
  'src/manifest.js',
  'src/package-contract.js',
  'src/path-policy.js',
  'src/provider-preferences.js',
  'src/provider-registry.js',
  'src/server.js',
  'src/session-store.js',
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
  'skill/sandpaper/references/workflows/canvas.md',
  'skill/sandpaper/references/workflows/decide.md',
  'skill/sandpaper/references/workflows/help.md',
  'skill/sandpaper/references/workflows/init.md',
  'skill/sandpaper/references/workflows/learn.md',
  'skill/sandpaper/references/workflows/log.md',
  'skill/sandpaper/references/workflows/open.md',
  'skill/sandpaper/references/workflows/plan.md',
  'skill/sandpaper/references/workflows/release.md',
  'skill/sandpaper/references/workflows/serve.md',
  'skill/sandpaper/references/workflows/stamp.md',
  'skill/sandpaper/references/workflows/sync.md',
  'skill/sandpaper/references/workflows/theme.md',
  'brain/assets/brain.css',
  'brain/assets/brain.js',
  'brain/assets/theme.css',
  '!brain/README.md',
  'README.md',
  'CHANGELOG.md',
]);

// These are explicit, rounded release envelopes. They are tightened against the
// measured candidate after each intentional distribution-surface change.
export const MAX_PACKED_KB = 140;
export const MAX_UNPACKED_KB = 475;

// Development-only tooling is allowed in devDependencies. Every npm field that can
// install, bundle, advertise, relax, or rewrite runtime dependencies is forbidden.
export const RUNTIME_DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bundleDependencies',
  'overrides',
]);

export function assertNoRuntimeDependencyMetadata(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Package manifest must be an object');
  }
  const present = RUNTIME_DEPENDENCY_FIELDS.filter((field) => Object.hasOwn(manifest, field));
  if (present.length) throw new Error(`Runtime dependency metadata must remain absent: ${present.join(', ')}`);
  return manifest;
}

// Hidden config/state is forbidden at any depth. The named non-hidden paths are
// repository-only surfaces that must never become package content.
export const FORBIDDEN_PATH = /(?:^|\/)(?:\.[^/]+|docs|node_modules|playwright-report|site|test|test-results)(?:\/|$)|^(?:agents\.md|claude\.md|engg-spec\.html|playwright\.config\.js|sandpaper\.html)$/i;
export const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.git-credentials$|\.netrc$|\.npmrc$|\.pypirc$|credentials\.json$|id_(?:dsa|ecdsa|ed25519|rsa)$|service-account\.json$)|\.(?:cer|crt|key|p12|pem|pfx)$/i;
export const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:(?:RSA|OPENSSH|EC|DSA) |ENCRYPTED )?PRIVATE KEY-----/,
  /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_-]{10,}['"]/i,
  /password\s*[:=]\s*['"][^'"]{4,}['"]/i,
]);

export function normalizePackagePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) {
    throw new Error('Invalid package path');
  }
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) throw new Error('Invalid package path');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Invalid package path');
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized.startsWith('../')) throw new Error('Invalid package path');
  return normalized;
}

export function isForbiddenPackagePath(value) {
  let normalized;
  try { normalized = normalizePackagePath(value); }
  catch { return true; }
  return FORBIDDEN_PATH.test(normalized);
}

export function isSecretPackagePath(value) {
  let normalized;
  try { normalized = normalizePackagePath(value); }
  catch { return true; }
  return SECRET_PATH.test(normalized);
}

export function containsSecretPattern(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function expectedPackedPaths() {
  const expected = new Set(['LICENSE', 'package.json']);
  for (const rule of APPROVED_FILE_RULES) {
    if (rule.startsWith('!')) expected.delete(normalizePackagePath(rule.slice(1)));
    else expected.add(normalizePackagePath(rule));
  }
  return [...expected].sort();
}

const MAX_ESM_SCAN_CHARACTERS = MAX_UNPACKED_KB * 1024;
const require = createRequire(import.meta.url);

function loadDevelopmentParser() {
  try {
    return require('acorn');
  } catch (error) {
    const missing = new Error(
      'ESM import verification requires development dependency acorn@8.17.0; run npm install before release verification',
    );
    missing.cause = error;
    throw missing;
  }
}

function decodedModuleSpecifier(sourceNode) {
  if (sourceNode?.type === 'Literal' && typeof sourceNode.value === 'string') {
    return sourceNode.value;
  }
  if (sourceNode?.type === 'TemplateLiteral'
    && sourceNode.expressions?.length === 0
    && sourceNode.quasis?.length === 1
    && typeof sourceNode.quasis[0]?.value?.cooked === 'string') {
    return sourceNode.quasis[0].value.cooked;
  }
  return null;
}

export function relativeEsmImports(source, options = {}) {
  const text = String(source);
  if (text.length > MAX_ESM_SCAN_CHARACTERS) throw new Error('ESM source exceeds the bounded import scan');

  let tree;
  try {
    tree = loadDevelopmentParser().parse(text, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    });
  } catch (error) {
    if (error.message?.startsWith('ESM import verification requires')) throw error;
    throw new Error(`Malformed ESM source: ${error.message}`, { cause: error });
  }

  const specifiersByStart = new Map();
  const stack = [tree];
  const visited = new WeakSet();
  const maxAstNodes = Math.max(64, text.length * 4);
  let astNodes = 0;

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    visited.add(node);
    astNodes += 1;
    if (astNodes > maxAstNodes) throw new Error('ESM syntax tree exceeds the bounded import scan');

    let sourceNode = null;
    if (node.type === 'ImportDeclaration'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration') {
      sourceNode = node.source;
    } else if (node.type === 'ImportExpression') {
      sourceNode = node.source;
    }
    const specifier = decodedModuleSpecifier(sourceNode);
    if (specifier?.startsWith('.')) {
      const atStart = specifiersByStart.get(sourceNode.start) || [];
      atStart.push(specifier);
      specifiersByStart.set(sourceNode.start, atStart);
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          if (value[index]?.type) stack.push(value[index]);
        }
      } else if (value?.type) {
        stack.push(value);
      }
    }
  }

  const found = [];
  for (let index = 0; index < text.length; index += 1) {
    const atStart = specifiersByStart.get(index);
    if (atStart) found.push(...atStart);
  }
  if (options.metrics && typeof options.metrics === 'object') {
    options.metrics.characters = text.length;
    options.metrics.astNodes = astNodes;
    options.metrics.work = text.length + astNodes;
  }
  return found;
}
