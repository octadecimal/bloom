import { defineConfig, devices } from '@playwright/test';

// Frontend dev port derives from BLOOM_PORT_OFFSET (0 = default 4200). Computed
// inline (not via a shared module) because the @nx/playwright graph-inference plugin
// loads this file under a bare Node loader that can't follow a cross-file TS import.
// Under `just e2e` (set dotenv-load) BLOOM_PORT_OFFSET is in the environment.
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const frontend = 4200 + offset;
const baseURL = `http://localhost:${frontend}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL, trace: 'on-first-retry' },
  webServer: {
    command: 'npx nx serve frontend',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
