import { defineConfig, devices } from '@playwright/test';
import { resolvePorts, readRepoEnv } from '../../tools/ports.ts';

const { runtime } = resolvePorts(readRepoEnv());
const baseURL = `http://localhost:${runtime}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx nx serve client',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
