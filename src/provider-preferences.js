import { join } from 'node:path';
import { migrateManifest, PROVIDERS, readManifest, writeManifest } from './manifest.js';

const validProvider = (value) => PROVIDERS.includes(value);

export function createProviderPreferenceStore(root) {
  const file = join(root, '.sandpaper', 'manifest.json');
  const read = () => {
    try {
      return readManifest(file) || migrateManifest({ version: 2 });
    } catch {
      throw new Error('Provider preferences are corrupt');
    }
  };
  return {
    getDefaultProvider() {
      return read().defaultProvider || 'claude';
    },
    setDefaultProvider(provider) {
      if (!validProvider(provider)) throw new TypeError('Invalid provider');
      const state = read();
      if (state.defaultProvider === provider) return;
      state.defaultProvider = provider;
      writeManifest(file, state);
    },
  };
}
