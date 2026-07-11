import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const validProvider = (value) => value === 'claude' || value === 'codex';

export function createProviderPreferenceStore(root) {
  const directory = join(root, '.sandpaper');
  const file = join(directory, 'manifest.json');
  const read = () => {
    if (!existsSync(file)) return {};
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      if (value.defaultProvider !== undefined && !validProvider(value.defaultProvider)) throw new Error();
      return value;
    } catch {
      throw new Error('Provider preferences are corrupt');
    }
  };
  const write = (state) => {
    mkdirSync(directory, { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  };
  return {
    getDefaultProvider() {
      return read().defaultProvider || 'claude';
    },
    setDefaultProvider(provider) {
      if (!validProvider(provider)) throw new TypeError('Invalid provider');
      const state = read();
      if ((state.defaultProvider || 'claude') === provider) return;
      state.defaultProvider = provider;
      write(state);
    },
  };
}
