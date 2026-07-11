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
const CONTROL_PAREN_KEYWORDS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']);
const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
]);

function tokenizeModuleSource(source) {
  const text = String(source);
  if (text.length > MAX_ESM_SCAN_CHARACTERS) throw new Error('ESM source exceeds the bounded import scan');

  const tokens = [];
  const delimiters = [];
  const modes = [{ kind: 'code', canStartRegex: true, controlPending: false }];
  let index = 0;
  let work = 0;

  const token = (type, value, start, depth = delimiters.length) => {
    tokens.push({ type, value, start, depth });
  };
  const step = (amount = 1) => { index += amount; work += amount; };
  const fail = (message) => { throw new Error(`Malformed ESM source: ${message}`); };

  while (index < text.length) {
    const mode = modes[modes.length - 1];
    const character = text[index];
    const next = text[index + 1];

    if (mode.kind === 'template') {
      if (character === '\\') {
        if (next === undefined) fail('unterminated template escape');
        step(2);
      } else if (character === '`') {
        step();
        modes.pop();
        const parent = modes[modes.length - 1];
        if (!parent || parent.kind !== 'code') fail('unbalanced template');
        parent.canStartRegex = false;
        parent.controlPending = false;
      } else if (character === '$' && next === '{') {
        const start = index;
        step(2);
        delimiters.push({ character: '{', templateExpression: true });
        token('boundary', 'template-start', start);
        modes.push({ kind: 'code', canStartRegex: true, controlPending: false });
      } else {
        step();
      }
      continue;
    }

    if (index === 0 && character === '#' && next === '!') {
      step(2);
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') step();
      continue;
    }
    if (/\s/.test(character)) { step(); continue; }
    if (character === '/' && next === '/') {
      step(2);
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') step();
      continue;
    }
    if (character === '/' && next === '*') {
      step(2);
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) step();
      if (index >= text.length) fail('unterminated block comment');
      step(2);
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const start = index;
      let value = '';
      step();
      let closed = false;
      while (index < text.length) {
        const current = text[index];
        if (current === quote) { step(); closed = true; break; }
        if (current === '\n' || current === '\r') fail('unterminated string');
        if (current !== '\\') { value += current; step(); continue; }
        const escaped = text[index + 1];
        if (escaped === undefined) fail('unterminated string escape');
        if (escaped === '\n') { step(2); continue; }
        if (escaped === '\r') { step(text[index + 2] === '\n' ? 3 : 2); continue; }
        const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };
        if (Object.hasOwn(simple, escaped)) { value += simple[escaped]; step(2); continue; }
        if (escaped === 'x') {
          const digits = text.slice(index + 2, index + 4);
          if (!/^[0-9A-Fa-f]{2}$/.test(digits)) fail('malformed hexadecimal string escape');
          value += String.fromCodePoint(Number.parseInt(digits, 16));
          step(4);
          continue;
        }
        if (escaped === 'u') {
          const braced = text.slice(index + 2, index + 10).match(/^\{([0-9A-Fa-f]{1,6})\}/);
          const fixed = text.slice(index + 2, index + 6);
          if (braced && Number.parseInt(braced[1], 16) <= 0x10ffff) {
            value += String.fromCodePoint(Number.parseInt(braced[1], 16));
            step(2 + braced[0].length);
            continue;
          }
          if (/^[0-9A-Fa-f]{4}$/.test(fixed)) {
            value += String.fromCodePoint(Number.parseInt(fixed, 16));
            step(6);
            continue;
          }
          fail('malformed Unicode string escape');
        }
        value += escaped;
        step(2);
      }
      if (!closed) fail('unterminated string');
      token('string', value, start);
      mode.canStartRegex = false;
      mode.controlPending = false;
      continue;
    }
    if (character === '`') {
      step();
      mode.controlPending = false;
      modes.push({ kind: 'template' });
      continue;
    }
    if (character === '/' && mode.canStartRegex) {
      const start = index;
      let characterClass = false;
      let closed = false;
      step();
      while (index < text.length) {
        const current = text[index];
        if (current === '\n' || current === '\r') fail('unterminated regular expression');
        if (current === '\\') {
          if (text[index + 1] === undefined) fail('unterminated regular expression escape');
          step(2);
          continue;
        }
        if (current === '[') characterClass = true;
        else if (current === ']') characterClass = false;
        else if (current === '/' && !characterClass) {
          step();
          while (/[A-Za-z]/.test(text[index] || '')) step();
          closed = true;
          break;
        }
        step();
      }
      if (!closed || characterClass) fail('unterminated regular expression');
      token('regex', '', start);
      mode.canStartRegex = false;
      mode.controlPending = false;
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      step();
      while (isIdentifierPart(text[index])) step();
      const value = text.slice(start, index);
      token('identifier', value, start);
      mode.controlPending = CONTROL_PAREN_KEYWORDS.has(value);
      mode.canStartRegex = REGEX_PREFIX_KEYWORDS.has(value);
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index;
      step();
      while (/[A-Za-z0-9_.]/.test(text[index] || '')) step();
      token('number', text.slice(start, index), start);
      mode.canStartRegex = false;
      mode.controlPending = false;
      continue;
    }

    if (character === '}' && delimiters[delimiters.length - 1]?.templateExpression) {
      const start = index;
      step();
      delimiters.pop();
      modes.pop();
      token('boundary', 'template-end', start);
      continue;
    }

    const start = index;
    if (character === '(' || character === '[' || character === '{') {
      const control = character === '(' && mode.controlPending;
      token('punctuator', character, start);
      delimiters.push({ character, control });
      step();
      mode.canStartRegex = true;
      mode.controlPending = false;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      const expected = { ')': '(', ']': '[', '}': '{' }[character];
      const opened = delimiters.pop();
      if (!opened || opened.character !== expected || opened.templateExpression) fail(`unbalanced ${character}`);
      step();
      token('punctuator', character, start);
      mode.canStartRegex = character === ')' && Boolean(opened.control);
      mode.controlPending = false;
      continue;
    }
    if ((character === '+' || character === '-') && next === character) {
      token('punctuator', character + next, start);
      step(2);
      mode.canStartRegex = false;
      mode.controlPending = false;
      continue;
    }

    token('punctuator', character, start);
    step();
    mode.controlPending = false;
    if (character === '.') mode.canStartRegex = false;
    else if (character === '/') mode.canStartRegex = true;
    else if (character === ';' || character === ',' || character === ':' || character === '?'
      || '=!&|+-*%^~<>'.includes(character)) mode.canStartRegex = true;
    else mode.canStartRegex = false;
  }

  if (modes.length !== 1 || modes[0].kind !== 'code') fail('unterminated template or substitution');
  if (delimiters.length) fail(`unbalanced ${delimiters[delimiters.length - 1].character}`);
  return { tokens, work };
}

export function relativeEsmImports(source, options = {}) {
  const text = String(source);
  const { tokens, work: lexicalWork } = tokenizeModuleSource(text);
  const found = [];
  let candidate = null;
  let previous = null;

  const addString = (current) => {
    if (current?.type === 'string' && current.value.startsWith('.')) {
      found.push({ index: current.start, specifier: current.value });
    }
  };

  for (const current of tokens) {
    if (current.type === 'boundary') {
      candidate = null;
      previous = current;
      continue;
    }

    const isModuleKeyword = current.type === 'identifier'
      && (current.value === 'import' || current.value === 'export')
      && !(previous?.type === 'punctuator' && (previous.value === '.' || previous.value === '#'));
    if (isModuleKeyword) {
      candidate = {
        kind: current.value,
        stage: current.value === 'import' ? 'after-import' : 'after-export',
        depth: current.depth,
      };
      previous = current;
      continue;
    }

    if (candidate?.stage === 'after-import') {
      if (current.type === 'string') { addString(current); candidate = null; }
      else if (current.value === '(') candidate.stage = 'dynamic-first';
      else if (current.value === '.') candidate = null;
      else {
        candidate.stage = 'static';
        if (current.type === 'identifier' && current.value === 'from' && current.depth === candidate.depth) {
          candidate.stage = 'from-specifier';
        }
      }
    } else if (candidate?.stage === 'after-export') {
      if ((current.value === '*' || current.value === '{') && current.depth === candidate.depth) {
        candidate.stage = 'static';
      } else {
        candidate = null;
      }
    } else if (candidate?.stage === 'dynamic-first') {
      addString(current);
      candidate = null;
    } else if (candidate?.stage === 'static') {
      if (current.value === ';' && current.depth === candidate.depth) candidate = null;
      else if (current.type === 'identifier' && current.value === 'from' && current.depth === candidate.depth) {
        candidate.stage = 'from-specifier';
      }
    } else if (candidate?.stage === 'from-specifier') {
      addString(current);
      candidate = null;
    }

    previous = current;
  }

  if (options.metrics && typeof options.metrics === 'object') {
    options.metrics.characters = text.length;
    options.metrics.work = lexicalWork + tokens.length;
  }
  return found.map(({ specifier }) => specifier);
}
