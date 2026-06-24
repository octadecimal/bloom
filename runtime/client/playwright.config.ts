import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://localhost:4300', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx nx serve client',
    url: 'http://localhost:4300',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
