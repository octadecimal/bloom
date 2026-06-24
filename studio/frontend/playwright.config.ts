import { defineConfig, devices } from '@playwright/test';

// Allow worktrees to run the frontend on an alternate port (e.g. 4201) when the
// default :4200 is held by another session.  Set BLOOM_FRONTEND_PORT=4201 before
// running `just e2e` to shift both the webServer target and the baseURL.
const FRONTEND_PORT = process.env.BLOOM_FRONTEND_PORT ?? '4200';
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: FRONTEND_URL, trace: 'on-first-retry' },
  webServer: {
    command: `npx nx serve frontend`,
    env: { VITE_FRONTEND_PORT: FRONTEND_PORT },
    url: FRONTEND_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
