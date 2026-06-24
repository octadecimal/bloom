# Bloom — Worktree-Unique Ports for the Dev Stack Design

- **Date:** 2026-06-24
- **Status:** Approved (design); ready for an implementation plan
- **Scope:** Let parallel git worktrees run the dev stack (`just backend-serve-replay`
  - `just e2e`) at the same time without colliding on the singleton ports
    `:8000` (backend) / `:4200` (studio frontend) / `:4300` (runtime client) or on
    shared Mongo data. Introduce a single per-worktree **port-offset** convention that
    derives every port and the dev backend's Mongo DB + media dir.
- **Reads first:** [`AGENTS.md`](../../../AGENTS.md) (esp. "Working alongside other
  sessions"), [`docs/worktrees.md`](../../worktrees.md),
  [`studio/backend/tests/e2e/conftest.py`](../../../studio/backend/tests/e2e/conftest.py)
  (the existing free-port + isolated-DB pattern this mirrors).

---

## 1. What this delivers (and what it deliberately does not)

Today the dev stack is a set of hard-coded singletons. Two worktrees cannot both
`serve` / `e2e` because the studio frontend is pinned to `:4200`, its Vite proxy and
the Playwright `/health` check point at `localhost:8000`, the runtime client is
pinned to `:4300`, and the `just backend-serve*` recipes pass `--port 8000`. Even on
different ports, two replay backends would still share the `bloom_studio` Mongo
database and `var/media`, clobbering each other's rooms/models/assets.

This effort makes the whole stack **offset-addressable**:

1. **One knob — `BLOOM_PORT_OFFSET`.** A small non-negative integer in the
   worktree's root `.env` (primary checkout = unset = `0`). Every port and the dev
   backend's data namespace derive from it: `base + offset`.
2. **A single TS resolver — `tools/ports.ts`.** A pure function consumed by the two
   Vite configs, the two Playwright configs, and the e2e global-setup, so the
   port math lives in exactly one place on the TS side.
3. **`just` recipes derive the backend port + Mongo DB + media dir** from the same
   offset (in `sh`, since Python can't import the TS util), mirroring the existing
   `tests/e2e/conftest.py` isolation pattern.
4. **`just wt-new` auto-assigns** the lowest free offset into the new worktree's
   `.env` and prints the derived ports.
5. **Docs** — an `AGENTS.md` rule + a `docs/worktrees.md` section codify the
   convention.

**Out of scope (deferred, by decision):**

- **Making `live` mode parallel.** The GPU / ComfyUI (`:8188`) and a live
  OpenRouter session remain true singletons — "one live stack at a time" still
  holds. The offset shifts _ports and data namespaces_, not the one GPU. Live serve
  recipes still parameterize their port (harmless), but parallel _live_ work is not
  a goal here.
- **A port registry / lock service.** Offsets are allocated by scanning existing
  worktree `.env` files at `wt-new` time. No daemon, no lockfile.
- **`SceneHub.apply_op` concurrency hardening.** Unrelated to ports; filed as a
  separate follow-up issue (see §9).

---

## 2. The decision that anchors everything

**Single source of truth: `BLOOM_PORT_OFFSET`.** Rather than ask each worktree to
set a handful of independent port variables, one offset derives them all. This was
chosen over "explicit per-service vars only" (verbose, drift-prone, no single knob)
and over "a port-allocator script that writes a full var set" (more machinery than a
single integer warrants).

The explicit per-service variables still **exist as overrides** — they take
precedence over the derived value when set — so an edge case (e.g. a fixed port
required by some external tool, or a remote LAN backend) is always expressible
without abandoning the convention.

**Resolution order, per service:**

```
explicit per-service env var   (wins if set)
        ↓ else
base + BLOOM_PORT_OFFSET
        ↓ else (offset unset)
base                            (today's defaults, byte-for-byte)
```

---

## 3. Architecture

### 3.1 The TS resolver — `tools/ports.ts`

A new pure module at the repo root. It reads the **repo-root `.env`** via Vite's
`loadEnv` (so it resolves correctly even under bare `nx serve` / `npx playwright
test`, not only under `just`), overlays `process.env` on top (explicit vars win),
and returns the resolved set:

```ts
// tools/ports.ts  (shape — final names fixed in the plan)
export interface IResolvedPorts {
  offset: number;
  backend: number; // VITE_BLOOM_BACKEND_PORT  ?? 8000 + offset
  frontend: number; // BLOOM_FRONTEND_PORT ?? VITE_FRONTEND_PORT ?? 4200 + offset
  runtime: number; // BLOOM_RUNTIME_PORT       ?? 4300 + offset
  backendUrl: string; // VITE_BLOOM_BACKEND_URL   ?? `http://localhost:${backend}`
}
export function resolvePorts(env?: Record<string, string | undefined>): IResolvedPorts;
```

Notes:

- `resolvePorts` accepts an optional `env` map purely so the **unit test** can drive
  it without touching `process.env`. In production it defaults to
  `loadEnv(...) ⊕ process.env`.
- `backendUrl` preserves the existing `VITE_BLOOM_BACKEND_URL` escape hatch (used
  today by `health.ts`, both `config.ts` files, and `global-setup.ts`, and relevant
  to LAN remote access — see the `lan-remote-access` note).
- Interface name uses the repo's `I` prefix per `docs/coding-standards.md`.

### 3.2 TS consumers (one resolver, zero duplicated math)

| File                                   | Uses                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `studio/frontend/vite.config.mts`      | `server.port` / `preview.port` = `frontend`; **all 9 proxy targets** → `http://localhost:${backend}` |
| `studio/frontend/playwright.config.ts` | `baseURL` + `webServer.url` = `http://localhost:${frontend}`                                         |
| `studio/frontend/e2e/global-setup.ts`  | health check at `backendUrl`                                                                         |
| `runtime/client/vite.config.mts`       | `server.port` / `preview.port` = `runtime`                                                           |
| `runtime/client/playwright.config.ts`  | `baseURL` + `webServer.url` = `http://localhost:${runtime}`                                          |

Import paths are relative to `tools/ports.ts` (e.g. `../../tools/ports` from
`studio/frontend/`). The Playwright configs import `loadEnv` transitively via the
resolver — Vite is already a dependency, so no new package.

### 3.3 Backend side — `just` recipes (sh)

The backend is Python and cannot import the TS resolver. The base numbers
(`8000`, `bloom_studio`, `var/media`) therefore appear a **second** time, in the
justfile, computed in `sh` from `$BLOOM_PORT_OFFSET`. This mirrors how
`tests/e2e/conftest.py` already derives an isolated `MONGO_DB` / `MEDIA_DIR`, and is
an **accepted, documented trade-off** (§7): two runtimes, two ~3-line derivations,
kept in sync by the AGENTS.md convention.

- Add `set dotenv-load := true` to the justfile so the worktree's root `.env`
  (hence `BLOOM_PORT_OFFSET`) reaches every recipe's environment.
- `backend-serve` and `backend-serve-replay` derive, from the offset:
  - `--port` = `8000 + offset`
  - `MONGO_DB` = `bloom_studio` when offset `0`, else `bloom_studio_wt{N}`
  - `MEDIA_DIR` = `var/media` when offset `0`, else `var/media_wt{N}`
- `config.py` is **untouched** — the derived `MONGO_DB` / `MEDIA_DIR` flow in as
  ordinary env overrides through pydantic-settings, exactly as the e2e conftest does
  today.

### 3.4 `just wt-new` auto-assignment

`wt-new` gains an offset-allocation step (PowerShell, alongside the existing
`.env` copy):

1. Collect `BLOOM_PORT_OFFSET` values already in use — scan each existing
   worktree's `.env` (primary checkout counts as `0`).
2. Pick the **lowest free positive integer**.
3. Append `BLOOM_PORT_OFFSET=N` to the freshly-copied worktree `.env`.
4. Print the assignment and the derived ports
   (`backend 8001 / frontend 4201 / runtime 4301`).

Lowest-free (not max+1) means offsets get reused after a worktree is removed, so the
numbers stay small and predictable.

### 3.5 Data flow (offset = 1, illustrative)

```
worktree .env: BLOOM_PORT_OFFSET=1
   │
   ├─ just (dotenv-load) ─→ backend-serve-replay
   │        --port 8001  MONGO_DB=bloom_studio_wt1  MEDIA_DIR=var/media_wt1
   │
   ├─ tools/ports.ts (loadEnv ⊕ process.env) → { backend:8001, frontend:4201, runtime:4301,
   │        backendUrl:"http://localhost:8001" }
   │        ├─ vite.config.mts: serve :4201, proxy → :8001
   │        ├─ playwright.config.ts: baseURL :4201, webServer :4201
   │        └─ global-setup.ts: GET http://localhost:8001/health
   │
   └─ Mongo: one shared mongod, logical DB `bloom_studio_wt1`
```

---

## 4. Default-preservation (hard acceptance criterion)

With `BLOOM_PORT_OFFSET` unset or `0` and no explicit per-service override:

- backend `:8000`, studio frontend `:4200`, runtime client `:4300`
- `MONGO_DB=bloom_studio`, `MEDIA_DIR=var/media`

The **primary checkout (`C:\code\bloom`) behaves exactly as it does today** — same
ports, same DB, same media dir, same proxy targets. Any deviation is a bug. This is
the single most important invariant of the change.

---

## 5. Components & boundaries

| Unit                                   | Purpose                                     | Depends on                | Testable in isolation?                                   |
| -------------------------------------- | ------------------------------------------- | ------------------------- | -------------------------------------------------------- |
| `tools/ports.ts` `resolvePorts`        | Pure offset→ports/URL resolution            | `vite` (`loadEnv`)        | **Yes** — unit test drives it with an injected `env` map |
| Vite configs (×2)                      | Bind dev server + proxy to resolved ports   | `tools/ports.ts`          | Via running `serve`; observed port                       |
| Playwright configs (×2) + global-setup | Target the resolved frontend/backend        | `tools/ports.ts`          | Via running `e2e`                                        |
| justfile recipes                       | Backend port + Mongo DB + media from offset | root `.env`, `sh`         | Via running the recipe; observed port/DB                 |
| `wt-new` allocation                    | Assign + persist the offset                 | existing worktree `.env`s | Via running `just wt-new`; observed `.env`               |

---

## 6. Testing strategy

Per `AGENTS.md`: TDD for the pure logic, e2e as the authoritative behavioral
contract.

1. **Unit (TDD, the RED-GREEN core):** a vitest spec for `tools/ports.ts`
   `resolvePorts`, covering:
   - offset unset / `0` → all defaults (the §4 invariant)
   - offset `N` → `8000+N` / `4200+N` / `4300+N`, `backendUrl` follows backend
   - each explicit override wins independently
     (`VITE_BLOOM_BACKEND_PORT`, `BLOOM_FRONTEND_PORT`, `VITE_FRONTEND_PORT`,
     `BLOOM_RUNTIME_PORT`, `VITE_BLOOM_BACKEND_URL`)
   - `VITE_FRONTEND_PORT` honored as the alias when `BLOOM_FRONTEND_PORT` is absent
2. **e2e validation (source of truth):** in a worktree with `BLOOM_PORT_OFFSET=1`,
   `just backend-serve-replay` comes up on `:8001` against `bloom_studio_wt1`, and
   `just e2e` passes against `:4201`, **while** a primary stack on `:8000`/`:4200`
   is running and untouched. (This is exactly the parallel arrangement the
   sim-studio work already exercised manually with `:8001`/`:4201` +
   `MONGO_DB` override — see the `sim-studio-status` note.)
3. **Frontend CI gates** (per the `frontend-ci-gates` note): `prettier --check .`,
   `nx typecheck`, `nx test`, `nx build` must all pass — the new TS resolver and the
   config edits must typecheck and be formatted, not merely pass vitest.

---

## 7. Accepted trade-offs

- **Base numbers in two places.** `8000` / `bloom_studio` / `var/media` live in both
  `tools/ports.ts` (TS, for the frontend/runtime/e2e side) and the justfile (sh, for
  the backend). They cannot share code across the runtime boundary; each derivation
  is tiny and the AGENTS.md convention documents both so they stay in sync. Chosen
  over forcing the backend to depend on a Node tool just to learn its own port.
- **Allocation by `.env` scan, not a registry.** `wt-new` reads existing offsets at
  creation time. A manually-edited `.env` or a worktree created with raw
  `git worktree add` (bypassing `wt-new`) won't be auto-assigned — the manual
  fallback (set `BLOOM_PORT_OFFSET` by hand) is documented for that path.

---

## 8. Documentation changes

- **`AGENTS.md`** — under "Working alongside other sessions", a new rule: each
  worktree gets a `BLOOM_PORT_OFFSET`; all ports = `base + offset`; Mongo is isolated
  by **DB name** on one shared `mongod`; **live mode (GPU/ComfyUI) stays a true
  singleton** — the offset shifts ports/data, not the one GPU. Note the two
  derivation sites (`tools/ports.ts` + justfile) must agree.
- **`docs/worktrees.md`** — the offset convention end to end: what `wt-new` assigns,
  the derived ports, the per-service override variables, and the manual fallback.

---

## 9. Out-of-scope follow-up (filed separately)

**`SceneHub.apply_op` concurrency hardening** — guarding concurrent scene-op
application — is a distinct concern from dev-stack ports and is tracked as its own
issue/todo, not implemented here.

---

## 10. Open questions

None blocking. Final variable names and the exact `wt-new` allocation snippet are
fixed in the implementation plan.
