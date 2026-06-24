import { defineConfig, devices } from '@playwright/test';
import { resolvePorts, readRepoEnv } from '../../tools/ports.mts';

const { frontend } = resolvePorts(readRepoEnv());
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
