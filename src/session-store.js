import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_VERSION = 2;
const validProvider = (value) => value === 'claude' || value === 'codex';
const validPage = (value) => typeof value === 'string' && value.startsWith('/');

export function createSessionStore(root, { legacyPage = '/' } = {}) {
  const directory = join(root, '.sandpaper');
  const file = join(directory, 'session.json');
  const read = () => {
    if (!existsSync(file)) return { version: SESSION_VERSION, pages: {} };
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (value.version === SESSION_VERSION && value.pages && typeof value.pages === 'object') return value;
      if (typeof value.sessionId === 'string' && value.sessionId) {
        return { version: SESSION_VERSION, pages: { [legacyPage]: { claude: { resumeId: value.sessionId } } }, migrated: true };
      }
      return { version: SESSION_VERSION, pages: {} };
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
  return {
    get(key) { requireKey(key); return read().pages[key.page]?.[key.provider]?.resumeId || null; },
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
