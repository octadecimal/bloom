// runtime/client/e2e/start-server.cjs
//
// Playwright webServer launcher for the runtime/server (CommonJS — no __dirname
// or import.meta issues; works in both Node 22 and Node 24 native-TS mode).
//
// Responsibilities:
//   1. Mint the demo package (curate) if it is missing.
//   2. Spawn `cargo run -p bloom-runtime-server` and proxy its stdio/exit code.
//
// Why a wrapper: Playwright 1.61 starts webServer plugins *before* globalSetup
// runs, so globalSetup cannot be used to create the package on a cold start.
// This launcher handles the ordering inline as the webServer command itself.
//
// CWD: set to the repo root by Playwright via `webServer.cwd: '../../'` in the
// Playwright config, so all relative paths here are relative to the repo root.

'use strict';

const { execFileSync, spawn } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const root = process.cwd(); // repo root (Playwright sets cwd via webServer.cwd)
const pkg = resolve(root, 'runtime/server/demo/demo.pkg');

// Ensure audit dir exists.
mkdirSync(resolve(root, 'runtime/server/var'), { recursive: true });

// Mint the package on first run (bloom-simulator may need to compile — allow time).
// Mint only when THIS instance serves the slots demo (composed.pkg is checked
// in); prevents the two webServer launchers racing to write demo.pkg cold.
const served = resolve(root, process.env.BLOOM_RUNTIME_PACKAGE || 'runtime/server/demo/demo.pkg');
if (served === pkg && !existsSync(pkg)) {
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
    { cwd: root, stdio: 'inherit' },
  );
}

// Start the server and forward its exit code so Playwright knows when it stops.
const server = spawn('cargo', ['run', '-p', 'bloom-runtime-server'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
server.on('exit', (code) => process.exit(code ?? 0));
