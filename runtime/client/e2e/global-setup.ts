// runtime/client/e2e/global-setup.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Ensure the runtime/server demo package exists (it is git-ignored). Minted
 *  once via the same `curate` bin `just runtime-demo-pkg` uses.
 *
 *  Note: in Playwright 1.61 the webServer plugin starts before globalSetup, so
 *  `e2e/start-server.cjs` (the webServer command) owns the cold-start ordering.
 *  globalSetup still runs for housekeeping (var/ dir) and provides a safety net
 *  if the pkg was deleted between test runs while the server keeps running
 *  (reuseExistingServer silently reuses an already-running server).
 *
 *  Path anchor: `process.cwd()` is `runtime/client` when tests are run with
 *  `npx playwright test` from that directory (as documented). */
export default function globalSetup(): void {
  // process.cwd() = runtime/client (where `npx playwright test` is run from).
  const repoRoot = resolve(process.cwd(), '../..'); // runtime/client -> runtime -> repo root
  const pkg = resolve(repoRoot, 'runtime/server/demo/demo.pkg');
  mkdirSync(resolve(repoRoot, 'runtime/server/var'), { recursive: true });
  if (existsSync(pkg)) return;
  execFileSync(
    'cargo',
    [
      'run',
      '-p',
      'bloom-simulator',
      '--bin',
      'curate',
      '--',
      'runtime/server/demo/model.json',
      'runtime/server/demo/target.json',
      'bloom-demo-slots',
      'runtime/server/demo/demo.pkg',
      'runtime/server/demo/demo.report.txt',
      'runtime/server/demo/presentation.json',
    ],
    { cwd: repoRoot, stdio: 'inherit' },
  );
}
