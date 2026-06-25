# Worktree-Unique Ports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let parallel git worktrees run the dev stack (`just backend-serve-replay` + `just e2e`) simultaneously without colliding on `:8000` / `:4200` / `:4300` or on shared Mongo data, driven by a single per-worktree `BLOOM_PORT_OFFSET`.

**Architecture:** One pure TS resolver (`tools/ports.ts`) turns `BLOOM_PORT_OFFSET` (plus optional per-service overrides) into concrete ports + a backend URL; both Vite configs, both Playwright configs, and the e2e global-setup consume it. The `justfile` derives the backend port + an isolated Mongo DB + media dir from the same offset in `sh` (Python can't import the TS util), and `just wt-new` auto-assigns the lowest free offset into a new worktree's `.env`.

**Tech Stack:** TypeScript, Vite 8 (`loadEnv`), Vitest 4, Nx 23, Playwright, `just` (sh + PowerShell recipes), Python/uvicorn backend (unchanged), MongoDB (one shared service, isolated by DB name).

**Reference spec:** [`docs/superpowers/specs/2026-06-24-worktree-unique-ports-design.md`](../specs/2026-06-24-worktree-unique-ports-design.md)

## Global Constraints

- **Default-preservation invariant (hard):** with `BLOOM_PORT_OFFSET` unset/`0` and no explicit override, the resolver and recipes MUST produce backend `8000`, frontend `4200`, runtime `4300`, `MONGO_DB=bloom_studio`, `MEDIA_DIR=var/media`. The primary checkout (`C:\code\bloom`) behaves exactly as today. Any deviation is a bug.
- **Resolution order per service:** explicit per-service env var → `base + offset` → base. Explicit always wins.
- **TypeScript interfaces use an `I` prefix** (`IResolvedPorts`) — per `docs/coding-standards.md`.
- **Live mode stays a singleton:** the GPU / ComfyUI (`:8188`) is never offset; offsets shift ports + data namespaces only.
- **Frontend CI gates (all must pass before PR):** `npx prettier --check .`, `npx nx run-many -t typecheck`, `npx nx run-many -t test`, `npx nx run-many -t build`.
- **Commits:** Conventional Commits, imperative mood.
- **Before any PR/merge:** run `just e2e` against a replay backend (Task 7 is the authoritative behavioral gate).
- **Shell note:** `just` runs recipe lines with `sh -cu` by default on this Windows box (existing recipes rely on it); `-u` means unset vars error, so always default with `${VAR:-0}`.

---

### Task 1: `tools/ports.ts` resolver (pure core, TDD)

**Files:**

- Create: `tools/ports.ts`
- Create: `tools/ports.spec.ts`
- Create: `tools/project.json` (registers an Nx project so CI's `run-many` covers it)
- Create: `tools/tsconfig.json`

**Interfaces:**

- Consumes: nothing (leaf).
- Produces:
  - `export interface IResolvedPorts { offset: number; backend: number; frontend: number; runtime: number; backendUrl: string }`
  - `export function resolvePorts(env: Record<string, string | undefined>): IResolvedPorts` — pure.
  - `export function readRepoEnv(): Record<string, string | undefined>` — glue: repo-root `.env` (via Vite `loadEnv`) with `process.env` overlaid on top. Later tasks call `resolvePorts(readRepoEnv())`.

- [ ] **Step 1: Create the Nx project + tsconfig so the test runs under nx**

`tools/project.json`:

```json
{
  "name": "tools",
  "$schema": "../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "tools",
  "projectType": "library",
  "tags": [],
  "targets": {
    "test": {
      "executor": "nx:run-commands",
      "options": { "cwd": "tools", "command": "npx vitest run" }
    },
    "typecheck": {
      "executor": "nx:run-commands",
      "options": { "cwd": "tools", "command": "npx tsc --noEmit -p tsconfig.json" }
    }
  }
}
```

`tools/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "lib": ["es2023"],
    "types": ["node"],
    "noEmit": true,
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["ports.ts", "ports.spec.ts"]
}
```

- [ ] **Step 2: Write the failing test**

`tools/ports.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolvePorts } from './ports';

describe('resolvePorts', () => {
  it('returns the current defaults when the offset is unset', () => {
    expect(resolvePorts({})).toEqual({
      offset: 0,
      backend: 8000,
      frontend: 4200,
      runtime: 4300,
      backendUrl: 'http://localhost:8000',
    });
  });

  it('derives every port from a single offset', () => {
    expect(resolvePorts({ BLOOM_PORT_OFFSET: '1' })).toEqual({
      offset: 1,
      backend: 8001,
      frontend: 4201,
      runtime: 4301,
      backendUrl: 'http://localhost:8001',
    });
  });

  it('lets explicit per-service ports override the offset', () => {
    const p = resolvePorts({
      BLOOM_PORT_OFFSET: '2',
      VITE_BLOOM_BACKEND_PORT: '9000',
      BLOOM_FRONTEND_PORT: '5000',
      BLOOM_RUNTIME_PORT: '6000',
    });
    expect(p.backend).toBe(9000);
    expect(p.frontend).toBe(5000);
    expect(p.runtime).toBe(6000);
    expect(p.backendUrl).toBe('http://localhost:9000');
  });

  it('honors VITE_FRONTEND_PORT as the frontend alias', () => {
    expect(resolvePorts({ BLOOM_PORT_OFFSET: '3', VITE_FRONTEND_PORT: '4250' }).frontend).toBe(4250);
  });

  it('prefers BLOOM_FRONTEND_PORT over VITE_FRONTEND_PORT', () => {
    expect(resolvePorts({ BLOOM_FRONTEND_PORT: '5000', VITE_FRONTEND_PORT: '5001' }).frontend).toBe(5000);
  });

  it('uses VITE_BLOOM_BACKEND_URL verbatim but still derives the proxy port', () => {
    const p = resolvePorts({ BLOOM_PORT_OFFSET: '1', VITE_BLOOM_BACKEND_URL: 'http://192.168.1.5:8000' });
    expect(p.backendUrl).toBe('http://192.168.1.5:8000');
    expect(p.backend).toBe(8001);
  });

  it('ignores blank / non-numeric values and falls back to derived', () => {
    expect(resolvePorts({ BLOOM_PORT_OFFSET: '1', VITE_BLOOM_BACKEND_PORT: '' }).backend).toBe(8001);
    expect(resolvePorts({ BLOOM_PORT_OFFSET: 'abc' }).offset).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd tools && npx vitest run`
Expected: FAIL — `Cannot find module './ports'` (implementation not written yet).

- [ ] **Step 4: Write the minimal implementation**

`tools/ports.ts`:

```ts
import path from 'node:path';
import { loadEnv } from 'vite';

/** Base ports per dev-stack service. Offset 0 = today's defaults. */
const BASE = { backend: 8000, frontend: 4200, runtime: 4300 } as const;

/** Repo root, relative to this file (`tools/ports.ts` -> `..`). */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export interface IResolvedPorts {
  /** The worktree's port offset (0 in the primary checkout). */
  offset: number;
  /** Studio backend (uvicorn) port. */
  backend: number;
  /** Studio frontend (Vite) dev-server port. */
  frontend: number;
  /** Runtime client (Vite) dev-server port. */
  runtime: number;
  /** Backend base URL the browser/e2e talk to (proxy target / health check). */
  backendUrl: string;
}

/** Parse a positive-integer port, or undefined for blank/invalid. */
function port(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Parse a non-negative-integer offset; blank/invalid -> 0. */
function offsetOf(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Resolve every dev-stack port from a single BLOOM_PORT_OFFSET, with explicit
 * per-service overrides taking precedence. Pure — pass the env map in.
 */
export function resolvePorts(env: Record<string, string | undefined>): IResolvedPorts {
  const offset = offsetOf(env.BLOOM_PORT_OFFSET);
  const backend = port(env.VITE_BLOOM_BACKEND_PORT) ?? BASE.backend + offset;
  const frontend = port(env.BLOOM_FRONTEND_PORT) ?? port(env.VITE_FRONTEND_PORT) ?? BASE.frontend + offset;
  const runtime = port(env.BLOOM_RUNTIME_PORT) ?? BASE.runtime + offset;
  const url = env.VITE_BLOOM_BACKEND_URL;
  const backendUrl = url && url.trim() !== '' ? url : `http://localhost:${backend}`;
  return { offset, backend, frontend, runtime, backendUrl };
}

/** Repo-root `.env` (all keys) with `process.env` overlaid on top (explicit wins). */
export function readRepoEnv(): Record<string, string | undefined> {
  return { ...loadEnv('development', REPO_ROOT, ''), ...process.env };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd tools && npx vitest run`
Expected: PASS — 7 tests green.

- [ ] **Step 6: Verify it runs under Nx + typechecks + formats**

Run: `npx nx test tools`
Expected: PASS.
Run: `npx nx typecheck tools`
Expected: PASS (no type errors).
Run: `npx prettier --write tools/ports.ts tools/ports.spec.ts tools/project.json tools/tsconfig.json`
Expected: files formatted.

- [ ] **Step 7: Commit**

```bash
git add tools/ports.ts tools/ports.spec.ts tools/project.json tools/tsconfig.json
git commit -m "feat(ports): pure BLOOM_PORT_OFFSET resolver + repo-env reader"
```

---

### Task 2: Studio frontend Vite config consumes the resolver

**Files:**

- Modify: `studio/frontend/vite.config.mts` (server port + preview port + all 9 proxy targets)

**Interfaces:**

- Consumes: `resolvePorts`, `readRepoEnv` from `../../tools/ports`.
- Produces: nothing for later tasks.

- [ ] **Step 1: Wire the resolver into the config**

Replace the whole file `studio/frontend/vite.config.mts` with:

```ts
/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';
import path from 'node:path';
import { resolvePorts, readRepoEnv } from '../../tools/ports';

export default defineConfig(() => {
  const { backend, frontend } = resolvePorts(readRepoEnv());
  const target = `http://localhost:${backend}`;
  return {
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/studio/frontend',
    server: {
      port: frontend,
      host: '0.0.0.0',
      // Dev proxy: the browser talks only to the frontend origin and Vite forwards
      // API + WebSocket to the backend. Both ports follow BLOOM_PORT_OFFSET so
      // parallel worktrees never collide. Set the client's backend base URL to ''
      // (same-origin) to use this — see config.ts.
      proxy: {
        '/rooms': { target, changeOrigin: true },
        '/models': { target, changeOrigin: true },
        '/skills': { target, changeOrigin: true },
        '/tools': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true },
        '/socket.io': { target, changeOrigin: true, ws: true },
        '/games': { target, changeOrigin: true },
        '/assets': { target, changeOrigin: true },
        '/media': { target, changeOrigin: true },
      },
    },
    preview: { port: frontend, host: '0.0.0.0' },
    plugins: [react(), tailwindcss(), nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: '../../dist/studio/frontend',
      emptyOutDir: true,
      reportCompressedSize: true,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/*.{spec,test}.{ts,tsx}'],
      reporters: ['default'],
      setupFiles: ['./vitest.setup.ts'],
    },
  };
});
```

- [ ] **Step 2: Verify default-preservation (offset 0) and typecheck**

Run: `npx nx typecheck frontend`
Expected: PASS.
Run: `npx nx test frontend`
Expected: PASS (existing unit suite still green — config eval unaffected).

- [ ] **Step 3: Verify the offset shifts the dev-server port**

Run (PowerShell): `$env:BLOOM_PORT_OFFSET=8; npx nx serve frontend`
Expected: Vite reports it is listening on `http://localhost:4208` (and on the LAN host). Stop it with Ctrl-C.
Run: `Remove-Item Env:BLOOM_PORT_OFFSET; npx nx serve frontend`
Expected: Vite listens on `http://localhost:4200` (default preserved). Stop it.

- [ ] **Step 4: Format + commit**

```bash
npx prettier --write studio/frontend/vite.config.mts
git add studio/frontend/vite.config.mts
git commit -m "feat(frontend): derive Vite dev port + proxy target from port offset"
```

---

### Task 3: Studio frontend Playwright config + global-setup follow the offset

**Files:**

- Modify: `studio/frontend/playwright.config.ts` (baseURL + webServer.url)
- Modify: `studio/frontend/e2e/global-setup.ts` (health-check target)

**Interfaces:**

- Consumes: `resolvePorts`, `readRepoEnv` from `../../tools/ports` (config) and `../../../tools/ports` (global-setup).

- [ ] **Step 1: Wire the resolver into the Playwright config**

Replace `studio/frontend/playwright.config.ts` with:

```ts
import { defineConfig, devices } from '@playwright/test';
import { resolvePorts, readRepoEnv } from '../../tools/ports';

const { frontend } = resolvePorts(readRepoEnv());
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
```

- [ ] **Step 2: Wire the resolver into global-setup**

Replace `studio/frontend/e2e/global-setup.ts` with:

```ts
// studio/frontend/e2e/global-setup.ts
import { resolvePorts, readRepoEnv } from '../../../tools/ports';

const { backendUrl } = resolvePorts(readRepoEnv());

export default async function globalSetup() {
  const res = await fetch(`${backendUrl}/health`).catch(() => null);
  if (!res || !res.ok) throw new Error(`e2e: backend not reachable at ${backendUrl}/health — start it first`);
  const body = (await res.json()) as { providerMode?: string };
  if (!body.providerMode) {
    throw new Error('e2e: backend has no providerMode on /health — it is too old or not the parity build. Refusing to run against an unknown stack.');
  }
  if (process.env.BLOOM_E2E_TIER === 'live' && body.providerMode !== 'live') {
    throw new Error(`e2e-live requires PROVIDER_MODE=live, but /health says "${body.providerMode}"`);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npx nx typecheck frontend`
Expected: PASS.

- [ ] **Step 4: Smoke-check the resolved URLs (no backend needed)**

Run (PowerShell): `$env:BLOOM_PORT_OFFSET=8; npx playwright test --config=studio/frontend/playwright.config.ts --list`
Expected: Playwright lists specs without a config error (it resolves baseURL `http://localhost:4208`). A `--list` run does not start the backend, so global-setup is not invoked. Clear the var afterward: `Remove-Item Env:BLOOM_PORT_OFFSET`.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write studio/frontend/playwright.config.ts studio/frontend/e2e/global-setup.ts
git add studio/frontend/playwright.config.ts studio/frontend/e2e/global-setup.ts
git commit -m "test(frontend): point Playwright baseURL + health check at offset ports"
```

---

### Task 4: Runtime client Vite + Playwright configs follow the offset

**Files:**

- Modify: `runtime/client/vite.config.mts` (server + preview port)
- Modify: `runtime/client/playwright.config.ts` (baseURL + webServer.url)

**Interfaces:**

- Consumes: `resolvePorts`, `readRepoEnv` from `../../tools/ports`.

- [ ] **Step 1: Wire the resolver into the runtime Vite config**

Replace `runtime/client/vite.config.mts` with:

```ts
/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { resolvePorts, readRepoEnv } from '../../tools/ports';

export default defineConfig(() => {
  const { runtime } = resolvePorts(readRepoEnv());
  return {
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/runtime/client',
    server: { port: runtime, host: '0.0.0.0' },
    preview: { port: runtime, host: '0.0.0.0' },
    plugins: [nxViteTsPaths()],
    build: {
      outDir: '../../dist/runtime/client',
      emptyOutDir: true,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/*.{spec,test}.ts'],
      reporters: ['default'],
    },
  };
});
```

- [ ] **Step 2: Wire the resolver into the runtime Playwright config**

Replace `runtime/client/playwright.config.ts` with:

```ts
import { defineConfig, devices } from '@playwright/test';
import { resolvePorts, readRepoEnv } from '../../tools/ports';

const { runtime } = resolvePorts(readRepoEnv());
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
```

- [ ] **Step 3: Typecheck**

Run: `npx nx typecheck client`
Expected: PASS.

- [ ] **Step 4: Verify default + offset port**

Run (PowerShell): `npx nx serve client`
Expected: listens on `http://localhost:4300`. Stop it.
Run (PowerShell): `$env:BLOOM_PORT_OFFSET=8; npx nx serve client`
Expected: listens on `http://localhost:4308`. Stop it, then `Remove-Item Env:BLOOM_PORT_OFFSET`.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write runtime/client/vite.config.mts runtime/client/playwright.config.ts
git add runtime/client/vite.config.mts runtime/client/playwright.config.ts
git commit -m "feat(client): derive runtime Vite port + Playwright baseURL from offset"
```

---

### Task 5: justfile derives backend port + isolated Mongo/media; `wt-new` auto-assigns the offset

**Files:**

- Modify: `justfile` (add `set dotenv-load`; `backend-serve`, `backend-serve-replay`, `preflight`, `wt-new`)
- Create: `tools/wt-assign-offset.ps1`

**Interfaces:**

- Consumes: `BLOOM_PORT_OFFSET` from the root `.env` (made available to recipes by `set dotenv-load := true`).
- Produces: a `BLOOM_PORT_OFFSET=N` line in each new worktree's `.env`.

- [ ] **Step 1: Load the root `.env` into every recipe**

In `justfile`, insert a line immediately after the top comment block (before `default:`):

```just
set dotenv-load := true
```

- [ ] **Step 2: Derive backend port + Mongo DB + media dir in the serve recipes**

Replace the `backend-serve` recipe with:

```just
backend-serve:
    cd studio/backend && off="${BLOOM_PORT_OFFSET:-0}"; if [ "$off" = "0" ]; then db=bloom_studio; media=var/media; else db=bloom_studio_wt$off; media=var/media_wt$off; fi; MONGO_DB="$db" MEDIA_DIR="$media" uv run uvicorn app.main:app --reload --port $((8000 + off))
```

Replace the `backend-serve-replay` recipe with:

```just
# Serve the backend in replay mode (recorded-real fixtures; offline, no API key/GPU).
# Backend port + Mongo DB + media dir all follow BLOOM_PORT_OFFSET so parallel
# worktrees never share data. Offset 0 keeps the defaults (8000 / bloom_studio / var/media).
backend-serve-replay:
    cd studio/backend && off="${BLOOM_PORT_OFFSET:-0}"; if [ "$off" = "0" ]; then db=bloom_studio; media=var/media; else db=bloom_studio_wt$off; media=var/media_wt$off; fi; PROVIDER_MODE=replay MONGO_DB="$db" MEDIA_DIR="$media" uv run uvicorn app.main:app --port $((8000 + off))
```

- [ ] **Step 3: Make preflight check the offset backend port**

Replace the `preflight` recipe with:

```just
# Preflight: refuse to "serve to a human" if the backend is in replay mode.
preflight:
    powershell -NoProfile -Command "$off = [int]($env:BLOOM_PORT_OFFSET); $port = 8000 + $off; $h = Invoke-RestMethod ('http://localhost:{0}/health' -f $port); Write-Host ('Provider mode: ' + $h.providerMode.ToUpper() + ' (port ' + $port + ')'); if ($h.providerMode -ne 'live') { Write-Error 'Backend is in REPLAY mode — not safe to hand to a user. Start it with PROVIDER_MODE=live.'; exit 1 }"
```

- [ ] **Step 4: Create the offset-allocation script**

`tools/wt-assign-offset.ps1`:

```powershell
param([Parameter(Mandatory = $true)][string]$Target)

# Copy the primary checkout's .env into the new worktree (if present).
if (Test-Path .env) {
    Copy-Item .env (Join-Path $Target '.env') -Force
}

# Strip any inherited BLOOM_PORT_OFFSET so we never leave a duplicate key.
$envOut = Join-Path $Target '.env'
if (Test-Path $envOut) {
    (Get-Content $envOut) |
        Where-Object { $_ -notmatch '^\s*BLOOM_PORT_OFFSET\s*=' } |
        Set-Content $envOut
}

# Collect offsets already in use across every registered worktree (primary = 0).
$used = @(0)
$paths = (git worktree list --porcelain) |
    Where-Object { $_ -like 'worktree *' } |
    ForEach-Object { $_.Substring(9) }
foreach ($p in $paths) {
    $f = Join-Path $p '.env'
    if (Test-Path $f) {
        $m = Select-String -Path $f -Pattern '^\s*BLOOM_PORT_OFFSET\s*=\s*(\d+)' | Select-Object -First 1
        if ($m) { $used += [int]$m.Matches[0].Groups[1].Value }
    }
}

# Lowest free positive offset (reuses gaps left by removed worktrees).
$offset = 1
while ($used -contains $offset) { $offset++ }

Add-Content -Path $envOut -Value ("BLOOM_PORT_OFFSET={0}" -f $offset)
Write-Host ("BLOOM_PORT_OFFSET={0}  ->  backend {1} / frontend {2} / runtime {3}" -f $offset, (8000 + $offset), (4200 + $offset), (4300 + $offset))
```

- [ ] **Step 5: Call the script from `wt-new`**

Replace the `wt-new` recipe with:

```just
# Create a sibling worktree on a new branch, copy local .env, and auto-assign the
# lowest free BLOOM_PORT_OFFSET so its dev stack never collides with another worktree.
# Usage:  just wt-new gdd-viewer            -> ..\bloom.wt\gdd-viewer  on feat/gdd-viewer
#         just wt-new audit-store fix       -> ..\bloom.wt\audit-store on fix/audit-store
wt-new name type='feat':
    git worktree add ../bloom.wt/{{name}} -b {{type}}/{{name}}
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/wt-assign-offset.ps1 ../bloom.wt/{{name}}
    @echo "Worktree ..\bloom.wt\{{name}} on {{type}}/{{name}} is ready. Inside it run: just bootstrap"
    @echo "── active worktrees (who else is working where) ──"
    git worktree list
```

- [ ] **Step 6: Verify the backend port + DB isolation (offset)**

Run (PowerShell, from the worktree root, with a replay backend): `$env:BLOOM_PORT_OFFSET=5; just backend-serve-replay`
Expected: uvicorn starts on port `8005`. In another shell: `Invoke-RestMethod http://localhost:8005/health` returns `providerMode: replay`. Stop the server, `Remove-Item Env:BLOOM_PORT_OFFSET`.
Run: `just backend-serve-replay` (no offset)
Expected: uvicorn starts on `8000` (default preserved). Stop it.

- [ ] **Step 7: Verify default-preservation of `just e2e` plumbing**

Run: `just --evaluate` (or `just --dump`)
Expected: prints the recipe set without error (validates the justfile parses with `set dotenv-load`).

- [ ] **Step 8: Format + commit**

```bash
npx prettier --write tools/wt-assign-offset.ps1 2>/dev/null || true
git add justfile tools/wt-assign-offset.ps1
git commit -m "feat(just): offset-derived backend port + isolated Mongo/media; wt-new auto-assigns offset"
```

(Prettier does not format `.ps1`; the `|| true` keeps the step from failing. The justfile is not a prettier target either.)

---

### Task 6: Document the convention (AGENTS.md + docs/worktrees.md)

**Files:**

- Modify: `AGENTS.md` ("Working alongside other sessions" → the "One live stack at a time" bullet)
- Modify: `docs/worktrees.md` (the isolation table + the "Upgrade path" section, which predicted this work)

**Interfaces:** none.

- [ ] **Step 1: Update the AGENTS.md rule**

In `AGENTS.md`, replace the bullet that currently reads:

```markdown
- **One live stack at a time.** The dev stack is singletons — ports
  `:4200` / `:8000` / `:8188` and one Mongo service / one GPU. Parallel edits and
  unit tests are safe; before `serve` / `e2e` / asset generation, confirm no other
  session already has the stack running.
```

with:

```markdown
- **Per-worktree port offset.** Each worktree gets a `BLOOM_PORT_OFFSET` (the
  primary checkout is `0`); every dev-stack port derives as `base + offset` —
  backend `8000+N`, studio frontend `4200+N`, runtime client `4300+N` — and the
  replay backend isolates its data as `bloom_studio_wt{N}` / `var/media_wt{N}` on
  the one shared `mongod`. `just wt-new` auto-assigns the lowest free offset into
  the new worktree's `.env`. This lets parallel worktrees run `just
backend-serve-replay` + `just e2e` at the same time without colliding. The math
  lives in two mirrored places — `tools/ports.ts` (frontend/runtime/Playwright) and
  the `justfile` (backend) — keep them in sync. See [`docs/worktrees.md`](docs/worktrees.md).
- **Live mode is still a singleton.** The offset shifts ports + data, not the one
  GPU/ComfyUI (`:8188`) or a live OpenRouter session — only one session runs the
  **live** stack at a time.
```

- [ ] **Step 2: Update the worktrees.md isolation table**

In `docs/worktrees.md`, replace the "Shared — single-tenant" table and the sentence under it:

```markdown
**Shared — single-tenant — across the whole machine:**

| Resource          | Port / form                      | Rule                |
| ----------------- | -------------------------------- | ------------------- |
| Vite frontend     | `:4200`                          | one at a time       |
| Backend (uvicorn) | `:8000`                          | one at a time       |
| MongoDB           | native Windows Service, `:27017` | one shared instance |
| ComfyUI           | `:8188`, one GPU                 | one at a time       |

**The rule: only one session runs the live app stack at a time.** Whoever needs the
running app (`just serve-frontend` + `just backend-serve`, `just e2e`, asset
generation) takes it solo. Everyone else does code + unit-test work, which is freely
parallel.
```

with:

```markdown
**Offset-addressable per worktree (replay stacks run in parallel):** every dev-stack
port derives from the worktree's `BLOOM_PORT_OFFSET` (primary = `0`), which
`wt-new` auto-assigns:

| Resource          | Base / form                   | Per worktree         |
| ----------------- | ----------------------------- | -------------------- |
| Vite frontend     | `:4200`                       | `4200 + offset`      |
| Backend (uvicorn) | `:8000`                       | `8000 + offset`      |
| Runtime client    | `:4300`                       | `4300 + offset`      |
| Mongo database    | `bloom_studio` (one `mongod`) | `bloom_studio_wt{N}` |
| Media dir         | `var/media`                   | `var/media_wt{N}`    |

So two worktrees can each run `just backend-serve-replay` + `just e2e` at once
without colliding on a port or on Mongo data.

**Still single-tenant:** MongoDB itself (one native service on `:27017`, many logical
DBs) and ComfyUI / the GPU (`:8188`). **Only one session runs the _live_ app stack
at a time** — the offset shifts ports + data, never the GPU. Need the live app
(`just serve-frontend` + `just backend-serve`, `just e2e-live`, asset generation)?
Take it solo.
```

- [ ] **Step 3: Update the "Upgrade path" section (this work delivered it)**

In `docs/worktrees.md`, replace the entire `## Upgrade path (only if "one stack at a time" starts to hurt)` section (through the end of the file) with:

```markdown
## Overriding individual ports

`BLOOM_PORT_OFFSET` is the one knob you normally set (and `wt-new` sets it for you).
For the rare case where one service needs a fixed port, the explicit per-service
variables override the derived value: `VITE_BLOOM_BACKEND_PORT`,
`BLOOM_FRONTEND_PORT` (alias `VITE_FRONTEND_PORT`), `BLOOM_RUNTIME_PORT`, and
`VITE_BLOOM_BACKEND_URL` (a full backend base URL, e.g. for a LAN/remote backend).

To set an offset by hand (e.g. a worktree created with raw `git worktree add`),
add a line to that worktree's `.env`:
```

BLOOM_PORT_OFFSET=1

```

## Still shared regardless of offset

- **Cut Rust disk/recompile cost:** point all worktrees at one shared
  `CARGO_TARGET_DIR`. Saves disk and recompiles, but concurrent `cargo` builds will
  serialize on a shared lock — so it's a deliberate trade, not the default. (Not
  built yet — YAGNI.)
```

- [ ] **Step 4: Format + commit**

```bash
npx prettier --write AGENTS.md docs/worktrees.md
git add AGENTS.md docs/worktrees.md
git commit -m "docs: document the per-worktree port-offset convention"
```

---

### Task 7: End-to-end parallel validation (authoritative gate)

**Files:** none (verification only).

**Interfaces:** exercises everything from Tasks 1–6 together.

This is the behavioral source of truth per `AGENTS.md`. It proves two stacks coexist
and that the primary checkout is unchanged. Requires the primary checkout
(`C:\code\bloom`, offset 0) and this worktree (`feat/worktree-ports`, assign it an
offset for the test, e.g. via `.env` `BLOOM_PORT_OFFSET=1`).

- [ ] **Step 1: Confirm default-preservation in the primary checkout**

In `C:\code\bloom` (no `BLOOM_PORT_OFFSET` in `.env`):
Run: `just backend-serve-replay`
Expected: uvicorn on `:8000`, `Invoke-RestMethod http://localhost:8000/health` → `providerMode: replay`. Leave it running.

- [ ] **Step 2: Bring up this worktree's stack on the offset ports**

In the worktree, ensure `.env` contains `BLOOM_PORT_OFFSET=1`, then:
Run: `just backend-serve-replay`
Expected: uvicorn on `:8001`; `Invoke-RestMethod http://localhost:8001/health` → `providerMode: replay`. The two backends coexist (8000 + 8001). Leave it running.

- [ ] **Step 3: Run e2e against the offset stack**

In the worktree:
Run: `just e2e`
Expected: Vite serves on `:4201`, global-setup's `/health` check hits `:8001`, the Playwright suite runs against `:4201` and PASSES — with the primary stack on `:8000`/`:4200` untouched.

- [ ] **Step 4: Confirm data isolation**

Run (PowerShell): `mongosh --eval "db.getMongo().getDBNames()"` (or the studio's Mongo client)
Expected: both `bloom_studio` and `bloom_studio_wt1` exist as separate databases; the worktree's e2e wrote only to `bloom_studio_wt1`. Confirm `studio/backend/var/media_wt1` exists separately from `var/media`.

- [ ] **Step 5: Tear down**

Stop both backends. Optionally drop the test DB: `mongosh bloom_studio_wt1 --eval "db.dropDatabase()"`.

- [ ] **Step 6: Full CI-gate sweep before PR**

Run: `npx prettier --check .`
Run: `npx nx run-many -t typecheck`
Run: `npx nx run-many -t test`
Run: `npx nx run-many -t build`
Expected: all PASS (includes the new `tools` project's test + typecheck).

---

## Self-Review

**1. Spec coverage**

- §1 single offset knob → Task 1 (resolver), Tasks 2–5 (consumers). ✓
- §3.1 `tools/ports.ts` `resolvePorts` + `readRepoEnv`, repo-root `loadEnv` ⊕ `process.env` → Task 1. ✓
- §3.2 all five TS consumers (2 Vite, 2 Playwright, global-setup) → Tasks 2, 3, 4. ✓ (all 9 proxy targets explicitly listed in Task 2.)
- §3.3 `set dotenv-load`, backend port + `MONGO_DB`/`MEDIA_DIR` from offset, `config.py` untouched → Task 5. ✓
- §3.4 `wt-new` lowest-free auto-assignment → Task 5 (`tools/wt-assign-offset.ps1`). ✓
- §4 default-preservation invariant → verified in Tasks 2/4/5/7. ✓
- §6 unit test (resolver) + e2e parallel validation + CI gates → Task 1, Task 7. ✓
- §8 AGENTS.md + worktrees.md → Task 6. ✓
- §2 explicit-override precedence → tested in Task 1; documented in Task 6 Step 3. ✓
- §9 `SceneHub.apply_op` is out of scope → tracked separately (not a task here). ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step shows full content. ✓

**3. Type consistency:** `IResolvedPorts` fields (`offset`, `backend`, `frontend`, `runtime`, `backendUrl`) and the two exports (`resolvePorts`, `readRepoEnv`) are referenced identically in Tasks 2, 3, 4. Import depths verified: `../../tools/ports` from `studio/frontend/*` and `runtime/client/*`; `../../../tools/ports` from `studio/frontend/e2e/`. ✓

**Note carried forward:** the base numbers (`8000` / `4200` / `4300` / `bloom_studio` / `var/media`) intentionally appear in both `tools/ports.ts` and the `justfile` (two runtimes); Task 6 documents that they must stay in sync. This is the accepted trade-off from spec §7.
