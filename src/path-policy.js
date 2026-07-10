import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export const PATH_REASONS = Object.freeze({
  OUTSIDE_ROOT: 'outside-root',
  HIDDEN_PATH: 'hidden-path',
  RUNTIME_PATH: 'runtime-path',
  SECRET_PATH: 'secret-path',
  MISSING: 'missing',
  UNREADABLE: 'unreadable',
});

const SECRET_BASENAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'service-account.json',
]);

const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer']);

const denied = (reason) => ({ ok: false, reason });
const portable = (value) => value.split(sep).join('/').replaceAll('\\', '/');

export function classifyRepositoryRelative(relativePath, { mutable = false } = {}) {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    return denied(PATH_REASONS.UNREADABLE);
  }

  const normalized = portable(relativePath);
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return denied(PATH_REASONS.OUTSIDE_ROOT);
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return denied(PATH_REASONS.OUTSIDE_ROOT);
  }

  for (const segment of segments) {
    const name = segment.toLowerCase();
    if (name === '.sandpaper') return denied(PATH_REASONS.RUNTIME_PATH);
    if (name === '.env' || name.startsWith('.env.') || SECRET_BASENAMES.has(name) ||
        SECRET_EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) {
      return denied(PATH_REASONS.SECRET_PATH);
    }
  }

  for (let index = 0; index < segments.length; index++) {
    if (!segments[index].startsWith('.')) continue;
    if (!mutable && index === 0 && segments[index] === '.github') continue;
    return denied(PATH_REASONS.HIDDEN_PATH);
  }

  return { ok: true };
}

export function resolveRepositoryPath(root, candidate, { mustExist = true, mutable = false } = {}) {
  if (typeof root !== 'string' || typeof candidate !== 'string' ||
      root.includes('\0') || candidate.includes('\0')) {
    return denied(PATH_REASONS.UNREADABLE);
  }
  if (!isAbsolute(candidate)) return denied(PATH_REASONS.OUTSIDE_ROOT);

  const lexicalRoot = resolve(root);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(lexicalRoot);
  } catch {
    return denied(PATH_REASONS.UNREADABLE);
  }

  const lexicalFile = normalize(candidate);
  const lexicalRelative = containedRelative(lexicalRoot, lexicalFile);
  if (lexicalRelative == null) return denied(PATH_REASONS.OUTSIDE_ROOT);

  const lexicalPolicy = classifyRepositoryRelative(portable(lexicalRelative), { mutable });
  if (!lexicalPolicy.ok) return lexicalPolicy;

  const canonicalFile = canonicalizeCandidate(lexicalFile);
  if (!canonicalFile.ok) return denied(PATH_REASONS.UNREADABLE);
  if (!canonicalFile.exists && mustExist) return denied(PATH_REASONS.MISSING);

  const canonicalRelative = containedRelative(canonicalRoot, canonicalFile.file);
  if (canonicalRelative == null) return denied(PATH_REASONS.OUTSIDE_ROOT);

  const canonicalPolicy = classifyRepositoryRelative(portable(canonicalRelative), { mutable });
  if (!canonicalPolicy.ok) return canonicalPolicy;

  return {
    ok: true,
    file: canonicalFile.file,
    relative: portable(canonicalRelative),
  };
}

function containedRelative(root, file) {
  const rel = relative(root, file);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) return rel;
  return null;
}

function canonicalizeCandidate(candidate) {
  try {
    return { ok: true, exists: true, file: realpathSync(candidate) };
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return { ok: false };
  }

  const suffix = [];
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return { ok: false };
    suffix.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    ancestor = parent;
  }

  try {
    return { ok: true, exists: false, file: normalize(join(realpathSync(ancestor), ...suffix)) };
  } catch {
    return { ok: false };
  }
}
