import { defineConfig, devices } from '@playwright/test';

// Runtime dev port derives from BLOOM_PORT_OFFSET (0 = default 4300). Computed inline
// (not via a shared module) because the @nx/playwright graph-inference plugin loads
// this file under a bare Node loader that can't follow a cross-file TS import.
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const runtime = 4300 + offset;
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
