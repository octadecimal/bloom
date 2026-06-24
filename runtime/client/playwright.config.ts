import { defineConfig, devices } from '@playwright/test';

// IMPORTANT: loaded by the @nx/playwright graph-inference plugin under a bare Node
// loader (no ts-node/swc in CI), which CANNOT follow a cross-file TS import — so this
// must NOT import tools/ports. Compute the runtime port inline from the same env vars
// the resolver uses; keep in sync with tools/ports.ts. Under `just e2e` (set
// dotenv-load) BLOOM_PORT_OFFSET is present in the environment.
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const runtime = Number(process.env.BLOOM_RUNTIME_PORT ?? 4300 + offset);
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
