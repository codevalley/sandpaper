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
const isIdentifierStart = (character) => /[A-Za-z_$]/.test(character || '');
const isIdentifierPart = (character) => /[A-Za-z0-9_$]/.test(character || '');

function readStringToken(text, start) {
  const quote = text[start];
  let value = '';
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === quote) return { token: { type: 'string', value, start }, next: index + 1 };
    if (character !== '\\') {
      value += character;
      index += 1;
      continue;
    }
    const escaped = text[index + 1];
    if (escaped === undefined) break;
    if (escaped === '\n') { index += 2; continue; }
    if (escaped === '\r') { index += text[index + 2] === '\n' ? 3 : 2; continue; }
    const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };
    if (Object.hasOwn(simple, escaped)) {
      value += simple[escaped];
      index += 2;
      continue;
    }
    if (escaped === 'x' && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 2, index + 4))) {
      value += String.fromCodePoint(Number.parseInt(text.slice(index + 2, index + 4), 16));
      index += 4;
      continue;
    }
    if (escaped === 'u') {
      const braced = text.slice(index + 2).match(/^\{([0-9A-Fa-f]{1,6})\}/);
      const fixed = text.slice(index + 2, index + 6);
      if (braced && Number.parseInt(braced[1], 16) <= 0x10ffff) {
        value += String.fromCodePoint(Number.parseInt(braced[1], 16));
        index += 2 + braced[0].length;
        continue;
      }
      if (/^[0-9A-Fa-f]{4}$/.test(fixed)) {
        value += String.fromCodePoint(Number.parseInt(fixed, 16));
        index += 6;
        continue;
      }
    }
    value += escaped;
    index += 2;
  }
  return { token: null, next: text.length };
}

function skipRegularExpression(text, start) {
  let index = start + 1;
  let characterClass = false;
  while (index < text.length) {
    if (text[index] === '\\') { index += 2; continue; }
    if (text[index] === '[') characterClass = true;
    else if (text[index] === ']') characterClass = false;
    else if (text[index] === '/' && !characterClass) {
      index += 1;
      while (/[A-Za-z]/.test(text[index] || '')) index += 1;
      return index;
    }
    if (text[index] === '\n' || text[index] === '\r') return start + 1;
    index += 1;
  }
  return start + 1;
}

function regularExpressionCanStart(tokens) {
  if (!tokens.length) return true;
  const previous = tokens[tokens.length - 1];
  return previous.type === 'punctuator' && '([{=,:;!?&|+-*%^~<>'.includes(previous.value)
    || previous.type === 'identifier' && ['await', 'case', 'delete', 'return', 'throw', 'typeof', 'void', 'yield'].includes(previous.value);
}

function tokenizeModuleSource(source) {
  const text = String(source);
  if (text.length > MAX_ESM_SCAN_CHARACTERS) throw new Error('ESM source exceeds the bounded import scan');
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    const next = text[index + 1];
    if (/\s/.test(character)) { index += 1; continue; }
    if (character === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += Math.min(2, text.length - index);
      continue;
    }
    if (character === "'" || character === '"') {
      const read = readStringToken(text, index);
      if (read.token) tokens.push(read.token);
      index = read.next;
      continue;
    }
    if (character === '`') {
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') index += 2;
        else if (text[index] === '`') { index += 1; break; }
        else index += 1;
      }
      continue;
    }
    if (character === '/' && regularExpressionCanStart(tokens)) {
      const after = skipRegularExpression(text, index);
      if (after > index + 1) { index = after; continue; }
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(text[index])) index += 1;
      tokens.push({ type: 'identifier', value: text.slice(start, index), start });
      continue;
    }
    tokens.push({ type: 'punctuator', value: character, start: index });
    index += 1;
  }
  return tokens;
}

export function relativeEsmImports(source) {
  const tokens = tokenizeModuleSource(source);
  const found = [];
  const addString = (token) => {
    if (token?.type === 'string' && token.value.startsWith('.')) found.push({ index: token.start, specifier: token.value });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier' || (token.value !== 'import' && token.value !== 'export')) continue;
    const previous = tokens[index - 1];
    if (token.value === 'import' && previous?.type === 'punctuator' && (previous.value === '.' || previous.value === '#')) continue;
    const next = tokens[index + 1];
    if (token.value === 'import' && next?.type === 'string') {
      addString(next);
      continue;
    }
    if (token.value === 'import' && next?.value === '(') {
      if (tokens[index + 3]?.value === ')' || tokens[index + 3]?.value === ',') addString(tokens[index + 2]);
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ';'; cursor += 1) {
      if (tokens[cursor].type === 'identifier' && tokens[cursor].value === 'from') {
        addString(tokens[cursor + 1]);
        break;
      }
    }
  }
  return found.sort((left, right) => left.index - right.index).map(({ specifier }) => specifier);
}
