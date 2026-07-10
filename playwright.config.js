import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 15_000,
  expect: { timeout: 4_000 },
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
