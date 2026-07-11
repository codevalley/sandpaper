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
export const MAX_UNPACKED_KB = 450;

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

export function relativeEsmImports(source) {
  const text = String(source);
  const code = new Uint8Array(text.length);
  for (let index = 0; index < text.length;) {
    const current = text[index];
    const next = text[index + 1];
    if (current === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += Math.min(2, text.length - index);
      continue;
    }
    if (current === "'" || current === '"' || current === '`') {
      const quote = current;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index] === quote) { index += 1; break; }
        else index += 1;
      }
      continue;
    }
    code[index] = 1;
    index += 1;
  }

  const found = [];
  const staticImport = /\b(?:import|export)(?:\s|\/\*[\s\S]*?\*\/)+(?:[^'";]*?\bfrom(?:\s|\/\*[\s\S]*?\*\/)+)?(['"])(\.[^'"]+)\1/g;
  const dynamicImport = /\bimport(?:\s|\/\*[\s\S]*?\*\/)*\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
  for (const pattern of [staticImport, dynamicImport]) {
    for (const match of text.matchAll(pattern)) {
      if (code[match.index]) found.push({ index: match.index, specifier: match[2] });
    }
  }
  return found.sort((left, right) => left.index - right.index).map(({ specifier }) => specifier);
}
