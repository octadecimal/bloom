import { defineConfig, devices } from '@playwright/test';

// IMPORTANT: this file is loaded by the @nx/playwright graph-inference plugin under a
// bare Node loader (no ts-node/swc in CI), which CANNOT follow a cross-file TS import.
// So it must NOT import tools/ports. Instead it computes the frontend port inline from
// the same env vars the resolver uses — keep this in sync with tools/ports.ts. Under
// `just e2e` (set dotenv-load) BLOOM_PORT_OFFSET is present in the environment.
// (global-setup.ts and the specs ARE loaded at test runtime via jiti — not by the
// inference plugin — so they still import the resolver.)
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const frontend = Number(process.env.BLOOM_FRONTEND_PORT ?? process.env.VITE_FRONTEND_PORT ?? 4200 + offset);
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
