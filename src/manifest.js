import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const MANIFEST_VERSION = 2;
export const PROVIDERS = Object.freeze(['claude', 'codex']);

let temporaryCounter = 0;

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

export function readManifest(file) {
  if (!existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Manifest JSON is invalid');
  }
  return migrateManifest(value);
}

export function writeManifest(file, value) {
  if (existsSync(file)) readManifest(file);
  const normalized = migrateManifest(value);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  temporaryCounter += 1;
  const temporary = join(
    directory,
    `.${basename(file)}.tmp-${process.pid}-${temporaryCounter}`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return normalized;
}
