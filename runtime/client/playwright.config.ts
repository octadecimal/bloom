import { defineConfig, devices } from '@playwright/test';

// Runtime dev port derives from BLOOM_PORT_OFFSET (0 = default 4300). Computed inline
// (not via a shared module) because the @nx/playwright graph-inference plugin loads
// this file under a bare Node loader that can't follow a cross-file TS import.
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const runtime = 4300 + offset;
const serverPort = 9000 + offset;
const composedServerPort = 9100 + offset;
const dirServerPort = 9200 + offset;
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
    {
      // Third server instance in dir mode: packages are selected per-request by
      // ?package=<id> (the filename stem), not fixed at boot. The server (config.rs)
      // prefers BLOOM_RUNTIME_PACKAGES over BLOOM_RUNTIME_PACKAGE whenever the former
      // is set, so the value below is inert for the server — it exists only to steer
      // start-server.cjs's mint-guard away from demo.pkg (owned by the first entry),
      // preventing two launchers from racing a non-atomic fs::write of the same file.
      command: 'node runtime/client/e2e/start-server.cjs',
      url: `http://localhost:${dirServerPort}/health`,
      cwd: '../../',
      reuseExistingServer: true,
      timeout: 240_000,
      env: {
        BLOOM_PORT_OFFSET: String(offset),
        BLOOM_RUNTIME_PORT: '9200',
        BLOOM_RUNTIME_PACKAGE: 'runtime/server/demo/composed.pkg',
        BLOOM_RUNTIME_PACKAGES: 'runtime/server/demo',
        BLOOM_RUNTIME_AUDIT: 'runtime/server/var/audit.e2e-dir.jsonl',
      },
    },
  ],
});
