import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes as secureRandomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { inspectTrustedPath } from './managed-files.js';

export const MANIFEST_VERSION = 2;
export const PROVIDERS = Object.freeze(['claude', 'codex']);

const MAX_TEMPORARY_ATTEMPTS = 8;
const TEMPORARY_OPEN_FLAGS = constants.O_CREAT
  | constants.O_EXCL
  | constants.O_WRONLY
  | (constants.O_NOFOLLOW || 0);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const supportedProvider = (value) => PROVIDERS.includes(value);
const boundedVersion = (value) => String(value).slice(0, 80);

export function migrateManifest(value) {
  if (!isPlainObject(value)) throw new TypeError('Manifest must be a plain object');
  if (!hasOwn(value, 'version')) throw new Error('Missing manifest version');
  if (value.version !== 1 && value.version !== MANIFEST_VERSION) {
    throw new Error(`Unsupported manifest version: ${boundedVersion(value.version)}`);
  }

  if (value.version === 1) {
    return {
      ...value,
      version: MANIFEST_VERSION,
      defaultProvider: 'claude',
      integrations: [...PROVIDERS],
      hooksEnabled: true,
    };
  }

  const defaultProvider = hasOwn(value, 'defaultProvider') ? value.defaultProvider : 'claude';
  if (!supportedProvider(defaultProvider)) throw new Error('Invalid default provider');

  const integrations = hasOwn(value, 'integrations') ? value.integrations : [...PROVIDERS];
  if (!Array.isArray(integrations)) throw new Error('Invalid integrations list');
  if (!integrations.length) throw new Error('Manifest requires at least one integration');
  if (integrations.some((provider) => !supportedProvider(provider))) {
    throw new Error('Invalid integration provider');
  }
  const normalizedIntegrations = PROVIDERS.filter((provider) => integrations.includes(provider));
  if (!normalizedIntegrations.includes(defaultProvider)) {
    throw new Error(`Default provider ${defaultProvider} is not installed`);
  }

  const hooksEnabled = hasOwn(value, 'hooksEnabled') ? value.hooksEnabled : true;
  if (typeof hooksEnabled !== 'boolean') throw new Error('Invalid hooks flag');

  return {
    ...value,
    version: MANIFEST_VERSION,
    defaultProvider,
    integrations: normalizedIntegrations,
    hooksEnabled,
  };
}

export function readManifest(file, { trustedRoot = dirname(file) } = {}) {
  const inspected = inspectTrustedPath(trustedRoot, file, {
    pathClass: 'manifest path',
  });
  if (!inspected.exists) return null;
  if (!inspected.stats.isFile()) throw new Error('Manifest path is not a regular file');
  const flags = constants.O_RDONLY
    | (constants.O_NOFOLLOW || 0)
    | (constants.O_NONBLOCK || 0);
  let descriptor;
  let value;
  try {
    descriptor = openSync(file, flags);
    if (!fstatSync(descriptor).isFile()) throw new Error('Manifest path is not a regular file');
    value = JSON.parse(readFileSync(descriptor, 'utf8'));
  } catch {
    throw new Error('Manifest JSON is invalid');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return migrateManifest(value);
}

export function serializeManifest(value) {
  const normalized = migrateManifest(value);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function createTemporaryManifest(file, randomBytes) {
  const directory = dirname(file);
  for (let attempt = 0; attempt < MAX_TEMPORARY_ATTEMPTS; attempt += 1) {
    let suffix;
    try {
      suffix = Buffer.from(randomBytes(16)).toString('hex');
    } catch {
      throw new Error('Could not create manifest temporary file');
    }
    const temporary = join(directory, `.${basename(file)}.tmp-${suffix}`);
    try {
      const descriptor = openSync(temporary, TEMPORARY_OPEN_FLAGS, 0o600);
      return { descriptor, temporary };
    } catch (error) {
      if (error && (error.code === 'EEXIST' || error.code === 'ELOOP')) continue;
      throw new Error('Could not create manifest temporary file');
    }
  }
  throw new Error('Could not create manifest temporary file after bounded retries');
}

export function writeManifest(file, value, { randomBytes = secureRandomBytes } = {}) {
  if (existsSync(file)) readManifest(file, { trustedRoot: dirname(file) });
  const normalized = migrateManifest(value);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const created = createTemporaryManifest(file, randomBytes);
  let descriptor = created.descriptor;
  let temporary = created.temporary;
  try {
    writeFileSync(descriptor, serializeManifest(normalized));
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    temporary = null;
  } catch {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* preserve the bounded manifest error */ }
    }
    if (temporary !== null) {
      try { rmSync(temporary, { force: true }); } catch { /* best-effort owned-temp cleanup */ }
    }
    throw new Error('Could not write manifest');
  }
  return normalized;
}
