import { defineConfig, devices } from '@playwright/test';

// Runtime dev port derives from BLOOM_PORT_OFFSET (0 = default 4300). Computed inline
// (not via a shared module) because the @nx/playwright graph-inference plugin loads
// this file under a bare Node loader that can't follow a cross-file TS import.
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const runtime = 4300 + offset;
const serverPort = 9000 + offset;
const composedServerPort = 9100 + offset;
const baseURL = `http://localhost:${runtime}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npx nx serve client',
      url: baseURL,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // The authoritative game server, serving the demo package. A CJS launcher
      // script (e2e/start-server.cjs) mints the demo package if missing, then
      // spawns the debug-build server. Playwright 1.61 starts webServer plugins
      // before globalSetup, so the launcher owns the cold-start ordering.
      // cwd is the repo root so the relative package/audit paths resolve.
      command: 'node runtime/client/e2e/start-server.cjs',
      url: `http://localhost:${serverPort}/health`,
      cwd: '../../',
      reuseExistingServer: true,
      timeout: 240_000,
      env: {
        BLOOM_PORT_OFFSET: String(offset),
        BLOOM_RUNTIME_PACKAGE: 'runtime/server/demo/demo.pkg',
        BLOOM_RUNTIME_AUDIT: 'runtime/server/var/audit.e2e.jsonl',
      },
    },
    {
      // Second server instance serving the checked-in composed@1 demo package.
      command: 'node runtime/client/e2e/start-server.cjs',
      url: `http://localhost:${composedServerPort}/health`,
      cwd: '../../',
      reuseExistingServer: true,
      timeout: 240_000,
      env: {
        BLOOM_PORT_OFFSET: String(offset),
        BLOOM_RUNTIME_PORT: '9100',
        BLOOM_RUNTIME_PACKAGE: 'runtime/server/demo/composed.pkg',
        BLOOM_RUNTIME_AUDIT: 'runtime/server/var/audit.e2e-composed.jsonl',
      },
    },
  ],
});
