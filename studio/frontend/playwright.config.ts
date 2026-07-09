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
  webServer: [
    {
      command: 'npx nx serve frontend',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Dir-mode runtime server over studio-built packages (SP4 build->play).
      // 9300 base (NOT 9000/9100/9200) so reuseExistingServer can never attach
      // to another suite's differently-configured server.
      command: 'cargo run --release -p bloom-runtime-server',
      cwd: '../..',
      env: { BLOOM_RUNTIME_PACKAGES: 'var/packages', BLOOM_RUNTIME_PORT: '9300' },
      url: `http://localhost:${9300 + offset}/health`,
      reuseExistingServer: true,
      timeout: 300_000, // first run compiles the server
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
