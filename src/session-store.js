import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SESSION_VERSION = 2;
const validProvider = (value) => value === 'claude' || value === 'codex';
const validPage = (value) => typeof value === 'string' && value.startsWith('/');
const validObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactLegacy = (value) => validObject(value)
  && Object.keys(value).length === 1
  && typeof value.sessionId === 'string'
  && !!value.sessionId;
const portable = (value) => value.split(sep).join('/');
const validState = (value) => {
  if (!validObject(value.pages)) return false;
  for (const [page, providers] of Object.entries(value.pages)) {
    if (!validPage(page) || !validObject(providers)) return false;
    for (const [provider, session] of Object.entries(providers)) {
      if (!validProvider(provider) || !validObject(session)) return false;
      if (typeof session.resumeId !== 'string' || !session.resumeId) return false;
    }
  }
  if (value.legacyClaims !== undefined) {
    if (!validObject(value.legacyClaims)) return false;
    for (const [source, claim] of Object.entries(value.legacyClaims)) {
      if (!source || isAbsolute(source) || source.split(/[\\/]/).some((part) => part === '..')) return false;
      if (!validObject(claim) || !validPage(claim.page) || claim.provider !== 'claude') return false;
    }
  }
  return true;
};

export function createSessionStore(root, { legacyPage = '/' } = {}) {
  const directory = join(root, '.sandpaper');
  const file = join(directory, 'session.json');
  const read = () => {
    if (!existsSync(file)) return { version: SESSION_VERSION, pages: {} };
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (value.version === SESSION_VERSION) {
        if (validState(value)) return value;
        return { version: SESSION_VERSION, pages: {}, corrupt: true };
      }
      if (validObject(value) && Object.hasOwn(value, 'version')) {
        return { version: SESSION_VERSION, pages: {}, corrupt: true, unsupportedVersion: true };
      }
      if (exactLegacy(value)) {
        return { version: SESSION_VERSION, pages: { [legacyPage]: { claude: { resumeId: value.sessionId } } }, migrated: true };
      }
      return { version: SESSION_VERSION, pages: {}, corrupt: true };
    } catch {
      return { version: SESSION_VERSION, pages: {}, corrupt: true };
    }
  };
  const write = (state) => {
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  };
  const initial = read();
  if (initial.migrated) {
    delete initial.migrated;
    write(initial);
  }
  const requireKey = ({ page, provider }) => {
    if (!validPage(page) || !validProvider(provider)) throw new TypeError('Invalid session key');
  };
  const pageFileUnderRoot = (page, pageFile) => {
    if (typeof pageFile !== 'string' || pageFile.includes('\0')) throw new TypeError('Invalid legacy page file');
    let rootPath;
    let filePath;
    try {
      rootPath = realpathSync(root);
      filePath = realpathSync(pageFile);
    } catch {
      throw new TypeError('Invalid legacy page file');
    }
    const rel = relative(rootPath, filePath);
    if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new TypeError('Invalid legacy page file');
    }
    if (page !== '/' && page !== `/${portable(rel)}`) throw new TypeError('Legacy page file does not match page');
    return { rootPath, filePath };
  };
  return {
    get(key) { requireKey(key); return read().pages[key.page]?.[key.provider]?.resumeId || null; },
    claimLegacy({ page, provider, pageFile }) {
      requireKey({ page, provider });
      if (provider !== 'claude') return null;
      const state = read();
      if (state.corrupt) return null;
      const current = state.pages[page]?.[provider]?.resumeId;
      if (current) return current;
      const { rootPath, filePath } = pageFileUnderRoot(page, pageFile);
      const legacyFile = join(dirname(filePath), '.sandpaper', 'session.json');
      if (resolve(legacyFile) === resolve(file)) return null;
      let canonicalLegacy;
      try { canonicalLegacy = realpathSync(legacyFile); }
      catch { return null; }
      const legacyRelative = relative(rootPath, canonicalLegacy);
      if (isAbsolute(legacyRelative) || legacyRelative === '..' || legacyRelative.startsWith(`..${sep}`)) return null;
      const source = portable(legacyRelative);
      if (state.legacyClaims?.[source]) return null;
      let legacy;
      try { legacy = JSON.parse(readFileSync(canonicalLegacy, 'utf8')); }
      catch { return null; }
      if (!exactLegacy(legacy)) return null;
      state.pages[page] ||= {};
      state.pages[page].claude = { resumeId: legacy.sessionId, updatedAt: new Date().toISOString() };
      state.legacyClaims ||= {};
      state.legacyClaims[source] = { page, provider: 'claude' };
      write(state);
      return legacy.sessionId;
    },
    set({ page, provider, resumeId }) {
      requireKey({ page, provider });
      if (typeof resumeId !== 'string' || !resumeId) throw new TypeError('Invalid resume ID');
      const state = read();
      if (state.corrupt) throw new Error('Session state is corrupt');
      state.pages[page] ||= {};
      state.pages[page][provider] = { resumeId, updatedAt: new Date().toISOString() };
      write(state);
    },
    clear(key) {
      requireKey(key);
      const state = read();
      if (state.corrupt) throw new Error('Session state is corrupt');
      if (state.pages[key.page]) delete state.pages[key.page][key.provider];
      write(state);
    },
    inspect() { return read(); },
  };
}
