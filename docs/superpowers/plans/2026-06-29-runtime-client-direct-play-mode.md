# Runtime Client Direct Play-Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the untrusted Pixi client (`runtime/client`) to talk directly to the authoritative `runtime/server` — a standalone "direct play-mode" that handshakes the server, builds the reels scene from `presentation`, and on a player's Spin animates exactly the server-dictated outcome via the existing reels settle.

**Architecture:** Two small additive server changes (string-encode the client-facing `seed`; add a permissive CORS layer) plus a new client `play/` subsystem (pure URL/adapter/config helpers, a thin `fetch` client, and a `playMode` boot orchestrator) selected by a `?server=`/`?play` boot branch in `main.ts`. The reels module, engine, orchestrator, and responsive scaling are reused unchanged. The studio is untouched.

**Tech Stack:** Rust (axum 0.7, tower-http CORS) for the server; TypeScript + Pixi v8 + Vitest (jsdom) + Playwright for the client.

**Spec:** [`docs/superpowers/specs/2026-06-29-runtime-client-direct-play-mode-design.md`](../specs/2026-06-29-runtime-client-direct-play-mode-design.md)

## Global Constraints

- **Worktree:** `C:\code\bloom.wt\runtime-client-play-mode` on branch `feat/runtime-client-play-mode`, `BLOOM_PORT_OFFSET=1` → runtime client `:4301`, runtime server `:9001`. Use these ports, never the defaults ([worktree-independent-ports]).
- **TypeScript interfaces use an `I` prefix** (`IRuntimeClient`, `IPresentation`) — repo coding standard.
- **Never hardcode `http://localhost:<port>`** in any browser-facing URL. The server base URL is host-derived from `window.location.hostname` or an explicit `?server=` override ([lan-remote-access]).
- **Formatting:** format new/changed `.md`/`.json`/`.ts` with the **pinned** prettier — `C:\code\bloom\node_modules\.bin\prettier` (3.6.2), **not** `npx` (npx pulls a newer prettier that disagrees on markdown).
- **Frontend gates before PR:** `node_modules/.bin/prettier --check .`, `npx nx typecheck client`, `npx nx test client`, `npx nx build client`.
- **Rust gates before PR:** `cargo fmt --check`, `cargo clippy`, `cargo test` (workspace). Debug builds/tests work without WinLibs; only a `--release` build needs WinLibs `mingw64\bin` prepended to `PATH` (the e2e uses `cargo run` debug, so no WinLibs needed for this plan).
- **Commits:** Conventional Commits, imperative mood.
- **Mechanic:** exactly one arm (`slots@1`). A non-`slots@1` handshake/outcome is a clear error, never a silent blank scene. No plugin/registry machinery.

---

## Task 1: Server — string-encode `seed` in the `/spin` wire

The client-facing `seed` is a `u64` that can exceed `2^53`; a JS client parsing it as a JSON number loses precision. Serialize it as a string. Only the client-facing `SpinResponse` changes; the internal `AuditRecord` and all reproducibility logic keep `u64`.

**Files:**

- Modify: `runtime/server/src/wire.rs` (the `SpinResponse` struct + a serializer helper + a unit test)
- Modify: `runtime/server/src/routes.rs` (update the one route test that asserts `seed` numerically)

**Interfaces:**

- Consumes: nothing new.
- Produces: `SpinResponse { seed: u64 (serialized as a JSON string), bet: u64, outcome: OutcomeWire }` — the `/spin` response body the client reads as `{ seed: string, ... }`.

- [ ] **Step 1: Write the failing test** — add to `runtime/server/src/wire.rs` inside `mod tests`:

```rust
    #[test]
    fn spin_response_serializes_seed_as_a_string() {
        let outcome = OutcomeWire::from_round(&evaluate(&model_with_feature(), 53));
        // 2^53 + 1 — the smallest u64 that a JS number cannot represent exactly.
        let resp = SpinResponse {
            seed: 9_007_199_254_740_993,
            bet: 1,
            outcome,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["seed"].is_string(), "seed must serialize as a string");
        assert_eq!(json["seed"], serde_json::Value::String("9007199254740993".into()));
        assert_eq!(json["bet"], 1);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bloom-runtime-server spin_response_serializes_seed_as_a_string`
Expected: FAIL — `seed` currently serializes as a number, so `is_string()` is false.

- [ ] **Step 3: Write the minimal implementation** — in `runtime/server/src/wire.rs`, add the serializer helper and annotate the field. Replace the existing `SpinResponse` definition:

```rust
#[derive(Debug, Serialize)]
pub struct SpinResponse {
    #[serde(serialize_with = "serialize_seed_as_string")]
    pub seed: u64,
    pub bet: u64,
    pub outcome: OutcomeWire,
}

/// The seed is a `u64` that can exceed 2^53; a JS client parsing it as a JSON
/// number would silently lose precision, so the client-facing wire encodes it as
/// a string. Internal types (`AuditRecord`) keep the numeric `u64`.
fn serialize_seed_as_string<S>(seed: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&seed.to_string())
}
```

- [ ] **Step 4: Update the SP1 route test that asserts `seed` numerically** — in `runtime/server/src/routes.rs`, in `spin_returns_authoritative_reproducible_outcome`, change the seed assertion from the numeric form to the string form:

```rust
        assert_eq!(v["seed"], "33");
```

(The other spin tests assert `recs[0].seed` — the numeric `AuditRecord.seed`, which is unchanged — and `v["bet"]`, also unchanged.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — all server tests green, including the new wire test and the updated route test.

- [ ] **Step 6: Commit**

```bash
git add runtime/server/src/wire.rs runtime/server/src/routes.rs
git commit -m "feat(runtime): string-encode the client-facing /spin seed (JS precision)"
```

---

## Task 2: Server — permissive CORS layer

The browser client (`:4301`) fetches the server (`:9001`) cross-origin; the server has no CORS layer. Add a permissive `tower-http` `CorsLayer` so direct play-mode works without a proxy. A real origin allowlist is a deferred seam.

**Files:**

- Modify: `runtime/server/Cargo.toml` (add `tower-http` with the `cors` feature)
- Modify: `runtime/server/src/lib.rs` (apply the layer in `build_app`)
- Modify: `runtime/server/src/routes.rs` (two CORS tests via `build_app` `oneshot`)

**Interfaces:**

- Consumes: `build_app(state) -> Router` (existing).
- Produces: the same `build_app`, now returning a router whose responses carry `access-control-allow-origin` and that answers CORS preflight `OPTIONS`.

- [ ] **Step 1: Write the failing tests** — add to `runtime/server/src/routes.rs` inside `mod tests`:

```rust
    #[tokio::test]
    async fn cors_exposes_allow_origin_on_handshake() {
        let app = build_app(test_state());
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/handshake")
                    .header("origin", "http://example.com")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers()
                .get("access-control-allow-origin")
                .map(|v| v.to_str().unwrap().to_string()),
            Some("*".to_string())
        );
    }

    #[tokio::test]
    async fn cors_preflight_options_is_allowed() {
        let app = build_app(test_state());
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .method("OPTIONS")
                    .uri("/spin")
                    .header("origin", "http://example.com")
                    .header("access-control-request-method", "POST")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().is_success() || resp.status() == StatusCode::NO_CONTENT);
        assert_eq!(
            resp.headers()
                .get("access-control-allow-origin")
                .map(|v| v.to_str().unwrap().to_string()),
            Some("*".to_string())
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bloom-runtime-server cors_`
Expected: FAIL — no CORS layer yet, so `access-control-allow-origin` is absent (and the preflight `OPTIONS /spin` 405s with no matching method route).

- [ ] **Step 3: Add the dependency** — in `runtime/server/Cargo.toml`, under `[dependencies]`, add:

```toml
tower-http = { version = "0.5", features = ["cors"] }
```

- [ ] **Step 4: Apply the layer** — replace `runtime/server/src/lib.rs`'s `build_app` and imports:

```rust
use axum::http::Method;
use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

pub fn build_app(state: Arc<state::AppState>) -> Router {
    // Permissive for the demo: the untrusted client is served from a different
    // origin (and, in production, a different host entirely) and must reach the
    // authoritative server directly. A real origin allowlist is a deferred seam
    // (see the SP2 spec §8).
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    Router::new()
        .route("/health", get(routes::health))
        .route("/handshake", get(routes::handshake))
        .route("/spin", post(routes::spin))
        .layer(cors)
        .with_state(state)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — the two CORS tests pass and all existing server tests stay green.

- [ ] **Step 6: Commit**

```bash
git add runtime/server/Cargo.toml runtime/server/src/lib.rs runtime/server/src/routes.rs
git commit -m "feat(runtime): permissive CORS layer for direct cross-origin play"
```

---

## Task 3: Client — `resolveRuntimeServerUrl` (host-derived, configurable base URL)

A pure helper that resolves the server base URL with a precedence that never hardcodes localhost: `?server=` override wins; otherwise host-derived from the page hostname + a configured port.

**Files:**

- Create: `runtime/client/src/play/runtimeServerUrl.ts`
- Test: `runtime/client/src/play/runtimeServerUrl.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `resolveRuntimeServerUrl(params: URLSearchParams, location: ILocationLike, opts: { defaultPort: number }): string` and `interface ILocationLike { hostname: string }`.

- [ ] **Step 1: Write the failing test** — `runtime/client/src/play/runtimeServerUrl.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveRuntimeServerUrl } from './runtimeServerUrl';

describe('resolveRuntimeServerUrl', () => {
  it('uses an explicit ?server= override verbatim (trailing slash trimmed)', () => {
    const url = resolveRuntimeServerUrl(new URLSearchParams('server=http://10.0.0.5:9001/'), { hostname: 'ignored' }, { defaultPort: 9000 });
    expect(url).toBe('http://10.0.0.5:9001');
  });

  it('derives from the page hostname + default port when no override', () => {
    const url = resolveRuntimeServerUrl(new URLSearchParams(''), { hostname: '192.168.1.20' }, { defaultPort: 9001 });
    expect(url).toBe('http://192.168.1.20:9001');
  });

  it('never emits localhost when the page host is not localhost', () => {
    const url = resolveRuntimeServerUrl(new URLSearchParams('play'), { hostname: 'dev-host.local' }, { defaultPort: 9000 });
    expect(url).not.toContain('localhost');
    expect(url).toBe('http://dev-host.local:9000');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd runtime/client && npx vitest run src/play/runtimeServerUrl.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the minimal implementation** — `runtime/client/src/play/runtimeServerUrl.ts`:

```ts
export interface ILocationLike {
  hostname: string;
}

/** Resolve the runtime/server base URL. Precedence: an explicit `?server=` query
 *  param wins; otherwise host-derived from the page's own hostname so a LAN
 *  browser reaches the dev host (never a hardcoded localhost). */
export function resolveRuntimeServerUrl(params: URLSearchParams, location: ILocationLike, opts: { defaultPort: number }): string {
  const override = params.get('server');
  if (override) return override.replace(/\/+$/, '');
  return `http://${location.hostname}:${opts.defaultPort}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd runtime/client && npx vitest run src/play/runtimeServerUrl.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/play/runtimeServerUrl.ts runtime/client/src/play/runtimeServerUrl.spec.ts
git commit -m "feat(client): host-derived runtime/server URL resolver"
```

---

## Task 4: Client — wire types + `presentationConfig`

Define the server wire types in one place and a pure validator/mapper from a handshake to a reels config. Validation makes the single-mechanic assumption explicit instead of crashing on an unexpected shape.

**Files:**

- Create: `runtime/client/src/play/wireTypes.ts`
- Create: `runtime/client/src/play/presentationConfig.ts`
- Test: `runtime/client/src/play/presentationConfig.spec.ts`

**Interfaces:**

- Consumes: `JsonValue` from `../model/document`.
- Produces:
  - `wireTypes.ts`: `IPresentation { cols: number; rows: number; symbols: string[]; parentId?: string }`, `IHandshakeResponse { package_id: string; package_version: number; mechanic: string; presentation: unknown }`, `ISlotsOutcomeWire { mechanic: string; base_grid: number[][]; base_payout: number; feature_payout: number; total_payout: number; features: unknown[] }`, `ISpinResponse { seed: string; bet: number; outcome: ISlotsOutcomeWire }`, `IRuntimeClient { handshake(): Promise<IHandshakeResponse>; spin(bet?: number): Promise<ISpinResponse> }`.
  - `presentationConfig.ts`: `class PlayModeError extends Error`, `validatePresentation(hs: IHandshakeResponse): IPresentation`, `toReelsConfig(p: IPresentation): Record<string, JsonValue>`.

- [ ] **Step 1: Write the failing test** — `runtime/client/src/play/presentationConfig.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validatePresentation, toReelsConfig, PlayModeError } from './presentationConfig';
import type { IHandshakeResponse } from './wireTypes';

const ok: IHandshakeResponse = {
  package_id: 'bloom-demo-slots',
  package_version: 1,
  mechanic: 'slots@1',
  presentation: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' },
};

describe('validatePresentation', () => {
  it('returns the presentation for a valid slots@1 handshake', () => {
    expect(validatePresentation(ok)).toEqual({ cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' });
  });

  it('rejects a non-slots@1 mechanic', () => {
    expect(() => validatePresentation({ ...ok, mechanic: 'poker@1' })).toThrow(PlayModeError);
  });

  it('rejects an empty/null presentation', () => {
    expect(() => validatePresentation({ ...ok, presentation: null })).toThrow(PlayModeError);
  });

  it('rejects a presentation missing cols/rows/symbols', () => {
    expect(() => validatePresentation({ ...ok, presentation: { cols: 3 } })).toThrow(PlayModeError);
  });
});

describe('toReelsConfig', () => {
  it('maps the presentation to reels config fields', () => {
    expect(toReelsConfig({ cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' })).toEqual({
      cols: 3,
      rows: 3,
      symbols: ['0', '1', '2', '9'],
      parentId: 'root',
    });
  });

  it('defaults parentId to root when omitted', () => {
    expect(toReelsConfig({ cols: 5, rows: 3, symbols: ['A'] }).parentId).toBe('root');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd runtime/client && npx vitest run src/play/presentationConfig.spec.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Write `wireTypes.ts`** — `runtime/client/src/play/wireTypes.ts`:

```ts
/** The reels presentation manifest the package carries (server /handshake). */
export interface IPresentation {
  cols: number;
  rows: number;
  symbols: string[];
  parentId?: string;
}

/** GET /handshake response. `presentation` is opaque JSON until validated. */
export interface IHandshakeResponse {
  package_id: string;
  package_version: number;
  mechanic: string;
  presentation: unknown;
}

/** The `slots@1` arm of the server's mechanic-tagged outcome union. */
export interface ISlotsOutcomeWire {
  mechanic: string;
  base_grid: number[][];
  base_payout: number;
  feature_payout: number;
  total_payout: number;
  features: unknown[];
}

/** POST /spin response. `seed` is a string (a u64 that can exceed 2^53). */
export interface ISpinResponse {
  seed: string;
  bet: number;
  outcome: ISlotsOutcomeWire;
}

/** The thin transport the play subsystem depends on (impl in runtimeClient.ts). */
export interface IRuntimeClient {
  handshake(): Promise<IHandshakeResponse>;
  spin(bet?: number): Promise<ISpinResponse>;
}
```

- [ ] **Step 4: Write `presentationConfig.ts`** — `runtime/client/src/play/presentationConfig.ts`:

```ts
import type { JsonValue } from '../model/document';
import type { IHandshakeResponse, IPresentation } from './wireTypes';

/** A play-mode failure surfaced to the player (handshake/spin/validation). */
export class PlayModeError extends Error {}

/** Narrow an opaque handshake to a playable slots@1 presentation, or throw a
 *  PlayModeError the caller renders visibly (never a silent blank scene). */
export function validatePresentation(hs: IHandshakeResponse): IPresentation {
  if (hs.mechanic !== 'slots@1') {
    throw new PlayModeError(`unsupported mechanic: ${hs.mechanic}`);
  }
  const p = hs.presentation;
  if (!p || typeof p !== 'object') {
    throw new PlayModeError('handshake presentation is empty');
  }
  const rec = p as Record<string, unknown>;
  if (typeof rec.cols !== 'number' || typeof rec.rows !== 'number' || !Array.isArray(rec.symbols)) {
    throw new PlayModeError('handshake presentation missing cols/rows/symbols');
  }
  return p as IPresentation;
}

/** Map the presentation to the reels module's config fields, defaulting the
 *  parent; the module supplies defaults for everything else (cellSize, spacing). */
export function toReelsConfig(p: IPresentation): Record<string, JsonValue> {
  return {
    cols: p.cols,
    rows: p.rows,
    symbols: p.symbols,
    parentId: p.parentId ?? 'root',
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd runtime/client && npx vitest run src/play/presentationConfig.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add runtime/client/src/play/wireTypes.ts runtime/client/src/play/presentationConfig.ts runtime/client/src/play/presentationConfig.spec.ts
git commit -m "feat(client): play-mode wire types + presentation->reels config"
```

---

## Task 5: Client — `outcomeAdapter` (server outcome → client `IOutcome`)

A pure map from the server's `slots@1` wire outcome to the client's `IOutcome { grid: string[][] }`. The server's `base_grid[reel][row]` already matches the client's `grid[col][row]` — so no transpose, just stringify symbol ids.

**Files:**

- Create: `runtime/client/src/play/outcomeAdapter.ts`
- Test: `runtime/client/src/play/outcomeAdapter.spec.ts`

**Interfaces:**

- Consumes: `ISpinResponse` from `./wireTypes`, `IOutcome` from `../modules/module`.
- Produces: `toClientOutcome(res: ISpinResponse): IOutcome`.

- [ ] **Step 1: Write the failing test** — `runtime/client/src/play/outcomeAdapter.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toClientOutcome } from './outcomeAdapter';
import type { ISpinResponse } from './wireTypes';

function res(base_grid: number[][]): ISpinResponse {
  return {
    seed: '33',
    bet: 1,
    outcome: { mechanic: 'slots@1', base_grid, base_payout: 0, feature_payout: 0, total_payout: 0, features: [] },
  };
}

describe('toClientOutcome', () => {
  it('stringifies symbol ids cell-for-cell', () => {
    expect(
      toClientOutcome(
        res([
          [0, 1, 2],
          [9, 0, 1],
        ]),
      ).grid,
    ).toEqual([
      ['0', '1', '2'],
      ['9', '0', '1'],
    ]);
  });

  it('preserves orientation without transposing (non-square grid proves col/row are not swapped)', () => {
    // 3 reels x 2 rows -> client grid must be 3 columns each of length 2.
    const grid = toClientOutcome(
      res([
        [0, 1],
        [2, 9],
        [1, 0],
      ]),
    ).grid;
    expect(grid.length).toBe(3);
    expect(grid.every((reel) => reel.length === 2)).toBe(true);
    expect(grid).toEqual([
      ['0', '1'],
      ['2', '9'],
      ['1', '0'],
    ]);
  });

  it('throws on an unsupported mechanic', () => {
    const bad = res([[0]]);
    bad.outcome.mechanic = 'poker@1';
    expect(() => toClientOutcome(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd runtime/client && npx vitest run src/play/outcomeAdapter.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the minimal implementation** — `runtime/client/src/play/outcomeAdapter.ts`:

```ts
import type { IOutcome } from '../modules/module';
import type { ISpinResponse } from './wireTypes';

/** Map the server's slots@1 wire outcome to the client's IOutcome. The server's
 *  base_grid[reel][row] orientation already matches IOutcome.grid[col][row], so
 *  this is a pure stringify of the u8 symbol ids — no transpose. */
export function toClientOutcome(res: ISpinResponse): IOutcome {
  const o = res.outcome;
  if (o.mechanic !== 'slots@1') {
    throw new Error(`unsupported mechanic: ${o.mechanic}`);
  }
  return { grid: o.base_grid.map((reel) => reel.map((sym) => String(sym))) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd runtime/client && npx vitest run src/play/outcomeAdapter.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/play/outcomeAdapter.ts runtime/client/src/play/outcomeAdapter.spec.ts
git commit -m "feat(client): adapt server slots@1 outcome to client IOutcome"
```

---

## Task 6: Client — `createRuntimeClient` (thin `fetch` wrapper)

A thin typed client bound to a base URL: `handshake()` and `spin(bet?)`. Injectable `fetch` for testing; rejects on non-2xx.

**Files:**

- Create: `runtime/client/src/play/runtimeClient.ts`
- Test: `runtime/client/src/play/runtimeClient.spec.ts`

**Interfaces:**

- Consumes: `IRuntimeClient`, `IHandshakeResponse`, `ISpinResponse` from `./wireTypes`.
- Produces: `createRuntimeClient(baseUrl: string, fetchImpl?: typeof fetch): IRuntimeClient`.

- [ ] **Step 1: Write the failing test** — `runtime/client/src/play/runtimeClient.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createRuntimeClient } from './runtimeClient';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('createRuntimeClient', () => {
  it('GETs /handshake and parses the response', async () => {
    const body = { package_id: 'p', package_version: 1, mechanic: 'slots@1', presentation: { cols: 3, rows: 3, symbols: ['0'] } };
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const hs = await createRuntimeClient('http://h:9001/', fetchImpl as unknown as typeof fetch).handshake();
    expect(fetchImpl).toHaveBeenCalledWith('http://h:9001/handshake');
    expect(hs).toEqual(body);
  });

  it('POSTs /spin with a JSON bet body and parses the response', async () => {
    const body = { seed: '33', bet: 1, outcome: { mechanic: 'slots@1', base_grid: [[0]], base_payout: 0, feature_payout: 0, total_payout: 0, features: [] } };
    const fetchImpl = vi.fn(async () => jsonResponse(body));
    const res = await createRuntimeClient('http://h:9001', fetchImpl as unknown as typeof fetch).spin(1);
    expect(fetchImpl).toHaveBeenCalledWith('http://h:9001/spin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bet: 1 }),
    });
    expect(res.seed).toBe('33');
  });

  it('rejects when the server returns a non-2xx status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500));
    await expect(createRuntimeClient('http://h:9001', fetchImpl as unknown as typeof fetch).spin()).rejects.toThrow(/spin failed: 500/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd runtime/client && npx vitest run src/play/runtimeClient.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the minimal implementation** — `runtime/client/src/play/runtimeClient.ts`:

```ts
import type { IHandshakeResponse, IRuntimeClient, ISpinResponse } from './wireTypes';

/** A thin transport over runtime/server. The base URL is resolved elsewhere
 *  (host-derived, never hardcoded localhost). `fetch` is injectable for tests. */
export function createRuntimeClient(baseUrl: string, fetchImpl: typeof fetch = fetch): IRuntimeClient {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async handshake(): Promise<IHandshakeResponse> {
      const r = await fetchImpl(`${base}/handshake`);
      if (!r.ok) throw new Error(`handshake failed: ${r.status}`);
      return (await r.json()) as IHandshakeResponse;
    },
    async spin(bet = 1): Promise<ISpinResponse> {
      const r = await fetchImpl(`${base}/spin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bet }),
      });
      if (!r.ok) throw new Error(`spin failed: ${r.status}`);
      return (await r.json()) as ISpinResponse;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd runtime/client && npx vitest run src/play/runtimeClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/play/runtimeClient.ts runtime/client/src/play/runtimeClient.spec.ts
git commit -m "feat(client): thin fetch client for runtime/server handshake+spin"
```

---

## Task 7: Client — `playMode` boot orchestrator

The only stateful piece: handshake → build the init document (Root + reels module decl) → render → wire the Spin gesture → on spin, fetch + adapt + drive the orchestrator → re-enable on settle. Errors surface visibly.

**Files:**

- Create: `runtime/client/src/play/playMode.ts`
- Test: `runtime/client/src/play/playMode.spec.ts`

**Interfaces:**

- Consumes: `IRuntimeClient`, `IPresentation` from `./wireTypes`; `validatePresentation`, `toReelsConfig`, `PlayModeError` from `./presentationConfig`; `toClientOutcome` from `./outcomeAdapter`; `IOutcome` from `../modules/module`; `InboundMessage` from `../protocol/messages`; `IGameDocument` from `../model/document`.
- Produces: `startPlayMode(deps: IPlayModeDeps): Promise<void>`, `buildPlayDocument(pres: IPresentation, rootSize?: { width: number; height: number }): IGameDocument`, and the deps interfaces below.

- [ ] **Step 1: Write the failing test** — `runtime/client/src/play/playMode.spec.ts` (jsdom env; the config already sets `environment: 'jsdom'`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { startPlayMode, buildPlayDocument, type IPlayModeDeps } from './playMode';
import type { IHandshakeResponse, ISpinResponse } from './wireTypes';

const HS: IHandshakeResponse = {
  package_id: 'bloom-demo-slots',
  package_version: 1,
  mechanic: 'slots@1',
  presentation: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' },
};

const SPIN: ISpinResponse = {
  seed: '33',
  bet: 1,
  outcome: {
    mechanic: 'slots@1',
    base_grid: [
      [0, 1, 2],
      [1, 2, 9],
      [2, 9, 0],
    ],
    base_payout: 0,
    feature_payout: 0,
    total_payout: 0,
    features: [],
  },
};

function harness(over: Partial<{ handshake: () => Promise<IHandshakeResponse>; spin: () => Promise<ISpinResponse> }> = {}) {
  const initCalls: unknown[] = [];
  const spun: unknown[] = [];
  const settledCbs: Array<() => void> = [];
  const spinButton = document.createElement('button');
  spinButton.id = 'spin';
  spinButton.hidden = true;
  const errorEl = document.createElement('div');
  errorEl.hidden = true;
  const deps: IPlayModeDeps = {
    client: {
      handshake: over.handshake ?? (async () => HS),
      spin: over.spin ?? (async () => SPIN),
    },
    host: { handle: async (m) => void initCalls.push(m) },
    bus: { on: (event, cb) => (event === 'reels:settled' ? settledCbs.push(cb as () => void) : void 0, () => {}) },
    orchestrator: { spin: (o) => void spun.push(o) },
    spinButton,
    errorEl,
  };
  return { deps, initCalls, spun, settledCbs, spinButton, errorEl };
}

describe('buildPlayDocument', () => {
  it('builds a Root + reels module decl from the presentation', () => {
    const doc = buildPlayDocument({ cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' });
    expect(doc.nodes.root.type).toBe('Root');
    expect(doc.modules).toEqual([{ id: 'reels', type: 'reels', config: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' } }]);
  });
});

describe('startPlayMode', () => {
  it('handshakes, inits the scene, and reveals the Spin button', async () => {
    const h = harness();
    await startPlayMode(h.deps);
    expect(h.initCalls).toHaveLength(1);
    expect((h.initCalls[0] as { kind: string }).kind).toBe('init');
    expect(h.spinButton.hidden).toBe(false);
  });

  it('on Spin: fetches the outcome, adapts it, and drives the orchestrator', async () => {
    const h = harness();
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.spun).toHaveLength(1));
    expect(h.spun[0]).toEqual({
      grid: [
        ['0', '1', '2'],
        ['1', '2', '9'],
        ['2', '9', '0'],
      ],
    });
    // disabled while spinning; re-enabled when the reels settle
    expect(h.spinButton.disabled).toBe(true);
    h.settledCbs.forEach((cb) => cb());
    expect(h.spinButton.disabled).toBe(false);
  });

  it('surfaces a handshake failure and does not show the Spin button', async () => {
    const h = harness({
      handshake: async () => {
        throw new Error('network down');
      },
    });
    await startPlayMode(h.deps);
    expect(h.errorEl.hidden).toBe(false);
    expect(h.errorEl.textContent).toContain('network down');
    expect(h.spinButton.hidden).toBe(true);
    expect(h.initCalls).toHaveLength(0);
  });

  it('surfaces a spin failure and re-enables Spin for retry', async () => {
    const h = harness({
      spin: async () => {
        throw new Error('spin failed: 500');
      },
    });
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.errorEl.textContent).toContain('spin failed: 500'));
    expect(h.spinButton.disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd runtime/client && npx vitest run src/play/playMode.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the minimal implementation** — `runtime/client/src/play/playMode.ts`:

```ts
import type { IGameDocument } from '../model/document';
import type { InboundMessage } from '../protocol/messages';
import type { IOutcome } from '../modules/module';
import type { IPresentation, IRuntimeClient } from './wireTypes';
import { validatePresentation, toReelsConfig } from './presentationConfig';
import { toClientOutcome } from './outcomeAdapter';

/** The minimal slices play-mode needs from the engine + DOM (so the orchestrator
 *  is unit-testable with fakes). The real ProtocolHost, event bus, and
 *  Orchestrator satisfy these structurally. */
export interface IPlayHost {
  handle(msg: InboundMessage): Promise<void>;
}
export interface IPlayBus {
  on(event: string, cb: (payload: unknown) => void): () => void;
}
export interface IPlayOrchestrator {
  spin(outcome: IOutcome): void;
}
export interface IPlayModeDeps {
  client: IRuntimeClient;
  host: IPlayHost;
  bus: IPlayBus;
  orchestrator: IPlayOrchestrator;
  spinButton: HTMLButtonElement;
  errorEl: HTMLElement;
  rootSize?: { width: number; height: number };
}

/** Default scene reference frame. The reels auto-fit/portrait layout rework is a
 *  separate deferred design; play-mode renders the demo presentation as-is. */
const DEFAULT_ROOT_SIZE = { width: 720, height: 1280 };

/** Build the init document: a Root sized to the scene plus a reels module
 *  declaration. ModuleManager.sync projects + mounts it, so the grid renders
 *  before the first spin. */
export function buildPlayDocument(pres: IPresentation, rootSize = DEFAULT_ROOT_SIZE): IGameDocument {
  return {
    version: 1,
    nodes: {
      root: { id: 'root', type: 'Root', props: { width: rootSize.width, height: rootSize.height } },
    },
    edges: [],
    modules: [{ id: 'reels', type: 'reels', config: toReelsConfig(pres) }],
  };
}

function showError(el: HTMLElement, err: unknown): void {
  el.textContent = err instanceof Error ? err.message : String(err);
  el.hidden = false;
}

async function runSpin(deps: IPlayModeDeps): Promise<void> {
  deps.spinButton.disabled = true;
  try {
    const res = await deps.client.spin(1);
    deps.orchestrator.spin(toClientOutcome(res));
  } catch (err) {
    showError(deps.errorEl, err);
    deps.spinButton.disabled = false;
  }
}

/** Boot direct play-mode: handshake -> render scene -> wire the Spin gesture. */
export async function startPlayMode(deps: IPlayModeDeps): Promise<void> {
  let pres: IPresentation;
  try {
    pres = validatePresentation(await deps.client.handshake());
    await deps.host.handle({ v: 1, kind: 'init', id: 'play', document: buildPlayDocument(pres, deps.rootSize) });
  } catch (err) {
    showError(deps.errorEl, err);
    return;
  }
  deps.bus.on('reels:settled', () => {
    deps.spinButton.disabled = false;
  });
  deps.spinButton.hidden = false;
  deps.spinButton.addEventListener('click', () => {
    void runSpin(deps);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd runtime/client && npx vitest run src/play/playMode.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full client unit suite + typecheck**

Run: `cd runtime/client && npx vitest run && cd ../.. && npx nx typecheck client`
Expected: PASS — all unit tests green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add runtime/client/src/play/playMode.ts runtime/client/src/play/playMode.spec.ts
git commit -m "feat(client): play-mode boot orchestrator (handshake->scene->spin)"
```

---

## Task 8: Client — wire play-mode into `main.ts`, `index.html`, and Vite

Add the third boot branch, the Spin button + error overlay, and the server-port define. No new unit tests (the e2e in Task 9 is the contract); this task is verified by typecheck + build.

**Files:**

- Modify: `runtime/client/index.html` (Spin button + error overlay + minimal CSS)
- Modify: `runtime/client/src/main.ts` (play-mode branch)
- Modify: `runtime/client/vite.config.mts` (define `VITE_RUNTIME_SERVER_PORT` = `9000 + offset`)

**Interfaces:**

- Consumes: `resolveRuntimeServerUrl` (Task 3), `createRuntimeClient` (Task 6), `startPlayMode` (Task 7); the engine handle `{ host, modules }` from `createEngine` (existing).
- Produces: a running play-mode entry reachable at `/?server=<url>` or `/?play`.

- [ ] **Step 1: Add the Spin button + error overlay to `index.html`** — inside `<style>`, append:

```css
#spin {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 10;
  padding: 12px 28px;
  font:
    600 16px system-ui,
    sans-serif;
  color: #0b0b0c;
  background: #e8e8ea;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
#spin:disabled {
  opacity: 0.5;
  cursor: default;
}
#play-error {
  position: fixed;
  left: 50%;
  top: 24px;
  transform: translateX(-50%);
  z-index: 10;
  padding: 10px 16px;
  font:
    500 14px system-ui,
    sans-serif;
  color: #fff;
  background: #b00020;
  border-radius: 8px;
  max-width: 80vw;
}
```

Inside `<body>`, after `<div id="stage"></div>`, add:

```html
<button id="spin" hidden>Spin</button>
<div id="play-error" hidden></div>
```

- [ ] **Step 2: Add the play-mode branch to `main.ts`** — add imports near the existing ones:

```ts
import { resolveRuntimeServerUrl } from './play/runtimeServerUrl';
import { createRuntimeClient } from './play/runtimeClient';
import { startPlayMode } from './play/playMode';
```

Then make three precise deletions and one addition. **Delete** the early standalone-default block (the `if (!expectedOrigin) { modules.manager.sync([...]) }` near the top, currently ~lines 32–37) **and** the trailing `?doc=` block (the `const docUrl = params.get('doc'); if (docUrl) { ... }` at the end of the file). **Keep everything between them** — the `reels()` helper, the `settledEvents`/`__engineModules` hooks, the viewport hooks, the serializer/message listener, and `host.start()` (all unchanged). Then **append** this consolidated three-way branch at the very end of the file (after `host.start()`):

```ts
// Direct play-mode: the client talks straight to runtime/server (no studio).
// Selected by an explicit ?server=<url> or a bare ?play flag.
const isPlayMode = params.has('server') || params.has('play');

if (isPlayMode) {
  const env = import.meta.env as Record<string, string | undefined>;
  const defaultPort = Number(env.VITE_RUNTIME_SERVER_PORT ?? '9000') || 9000;
  const serverUrl = resolveRuntimeServerUrl(params, window.location, { defaultPort });
  const client = createRuntimeClient(serverUrl);
  const spinButton = document.getElementById('spin') as HTMLButtonElement;
  const errorEl = document.getElementById('play-error') as HTMLElement;
  void startPlayMode({
    client,
    host,
    bus: modules.bus,
    orchestrator: modules.orchestrator,
    spinButton,
    errorEl,
  });
} else {
  // Standalone (no studio parent) keeps a default reels module so the runtime is
  // usable on its own; embedded studio mode instead instantiates from the
  // document's `modules` declaration on init.
  if (!expectedOrigin) {
    modules.manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root' } }]);
  }
  // Standalone mode: ?doc=<url> loads a document file directly (no studio).
  const docUrl = params.get('doc');
  if (docUrl) {
    void fetch(docUrl)
      .then((r) => r.json())
      .then((document) => host.handle({ v: 1, kind: 'init', id: 'standalone', document }));
  }
}
```

(The existing `reels()`, `settledEvents`, `__engineModules`, and viewport hooks above stay as-is — the e2e relies on `__engineModel` and `__engineModules`.)

- [ ] **Step 3: Define the server port in `vite.config.mts`** — in the returned config object, add a `define` entry (alongside `server`/`build`/`test`). The `offset` const already exists at the top of the file:

```ts
    define: {
      'import.meta.env.VITE_RUNTIME_SERVER_PORT': JSON.stringify(String(9000 + offset)),
    },
```

- [ ] **Step 4: Verify typecheck + build pass**

Run: `npx nx typecheck client && npx nx build client`
Expected: PASS — no type errors; the bundle builds.

- [ ] **Step 5: Format changed files with the pinned prettier**

Run: `C:\code\bloom\node_modules\.bin\prettier --write runtime/client/index.html runtime/client/src/main.ts runtime/client/vite.config.mts`
Expected: files formatted (idempotent on re-run).

- [ ] **Step 6: Commit**

```bash
git add runtime/client/index.html runtime/client/src/main.ts runtime/client/vite.config.mts
git commit -m "feat(client): wire direct play-mode boot branch + Spin overlay"
```

---

## Task 9: End-to-end — Playwright play-mode spec + server webServer + just recipe

The authoritative behavioral contract: boot play-mode against a **live** `runtime/server` (demo package) over a real cross-origin `:4301 → :9001` request, assert the grid renders from the handshake and Spin settles to a server-dictated outcome, and assert the handshake-failure path. This e2e is local-only (never CI), matching the repo's browser-e2e policy.

**Files:**

- Create: `runtime/client/e2e/global-setup.ts` (mint the demo `.pkg` if missing)
- Modify: `runtime/client/playwright.config.ts` (add the runtime/server webServer + globalSetup)
- Create: `runtime/client/e2e/playmode.e2e.spec.ts`
- Modify: `justfile` (a `runtime-playmode` convenience recipe)

**Interfaces:**

- Consumes: the running runtime client (`:4300+offset`) and runtime server (`:9000+offset`) with the demo package; the `?server=` boot param (Task 8); `__engineModel`/`__engineModules` window hooks (existing).
- Produces: a passing `playmode.e2e.spec.ts`.

- [ ] **Step 1: Write the e2e spec (will fail until servers + wiring exist)** — `runtime/client/e2e/playmode.e2e.spec.ts`:

```ts
// runtime/client/e2e/playmode.e2e.spec.ts
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const SERVER = `http://localhost:${9000 + offset}`;
const DEMO_SYMBOLS = ['0', '1', '2', '9'];

test('direct play-mode renders the grid from handshake and settles a server spin', async ({ page }) => {
  await page.goto(`/?server=${encodeURIComponent(SERVER)}`);

  // Handshake built the scene: the demo presentation is 3 reels x 3 rows.
  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes['reels:reel:2'] != null), { timeout: 15000 }).toBe(true);

  // The Spin button is revealed after a successful handshake.
  await expect(page.locator('#spin')).toBeVisible();

  await page.click('#spin');

  // The reels settle to idle with a server-dictated grid of the right shape.
  await expect.poll(() => page.evaluate(() => (window as any).__engineModules.state().phase), { timeout: 10000 }).toBe('idle');

  const grid = await page.evaluate(() => (window as any).__engineModules.state().grid);
  expect(grid.length).toBe(3); // 3 reels
  expect(grid.every((reel: string[]) => reel.length === 3)).toBe(true); // 3 rows
  // Every settled cell is one of the package's declared symbols (server-authoritative).
  expect(grid.flat().every((s: string) => DEMO_SYMBOLS.includes(s))).toBe(true);
});

test('a handshake failure shows an error and no Spin button', async ({ page }) => {
  // Port 1 has nothing listening -> handshake fetch fails.
  await page.goto(`/?server=${encodeURIComponent('http://localhost:1')}`);
  await expect(page.locator('#play-error')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#spin')).toBeHidden();
});
```

- [ ] **Step 2: Write the globalSetup that mints the demo package if missing** — `runtime/client/e2e/global-setup.ts`:

```ts
// runtime/client/e2e/global-setup.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Ensure the runtime/server demo package exists (it is git-ignored). Minted
 *  once via the same `curate` bin `just runtime-demo-pkg` uses. */
export default function globalSetup(): void {
  const repoRoot = resolve(__dirname, '../../..'); // e2e -> client -> runtime -> repo root
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
```

- [ ] **Step 3: Add the runtime/server webServer + globalSetup to the Playwright config** — replace `runtime/client/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

// Runtime dev port derives from BLOOM_PORT_OFFSET (0 = default 4300). Computed inline
// (not via a shared module) because the @nx/playwright graph-inference plugin loads
// this file under a bare Node loader that can't follow a cross-file TS import.
const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const runtime = 4300 + offset;
const serverPort = 9000 + offset;
const baseURL = `http://localhost:${runtime}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  globalSetup: require.resolve('./e2e/global-setup'),
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
      // The authoritative game server, serving the demo package. cwd is the repo
      // root so the relative package/audit paths resolve. Debug build (no WinLibs).
      command: 'cargo run -p bloom-runtime-server',
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
  ],
});
```

- [ ] **Step 4: Run the play-mode e2e**

Run (from the worktree root, offset already in `.env`):
`set BLOOM_PORT_OFFSET=1 && cd runtime/client && npx playwright test playmode.e2e.spec.ts`
(Or, on PowerShell: `$env:BLOOM_PORT_OFFSET=1; cd runtime/client; npx playwright test playmode.e2e.spec.ts`.)
Expected: PASS — both tests green. The first run mints the demo package (globalSetup) and compiles + boots the server (allow up to the 240s timeout); subsequent runs reuse them.

- [ ] **Step 5: Verify the existing client e2e still passes (no regression)**

Run: `cd runtime/client && npx playwright test reels.e2e.spec.ts`
Expected: PASS — the standalone reels e2e is unaffected by the play-mode branch.

- [ ] **Step 6: Add a `just runtime-playmode` convenience recipe** — in `justfile`, in the "Runtime game server" section, after `runtime-serve`, add:

```just
# Print the direct play-mode URL. Start the two servers first (separate shells):
#   just runtime-serve            # authoritative server on 9000+offset
#   just serve-runtime-client     # Pixi client on 4300+offset
# then open the printed URL from any LAN browser.
runtime-playmode:
    @off="${BLOOM_PORT_OFFSET:-0}"; echo "Open: http://<dev-host>:$((4300 + off))/?server=http://<dev-host>:$((9000 + off))"
```

(Replace `<dev-host>` with the dev host's LAN IP/hostname when opening from another machine — never `localhost` from a remote browser.)

- [ ] **Step 7: Format the new docs/JSON/TS with the pinned prettier**

Run: `C:\code\bloom\node_modules\.bin\prettier --write runtime/client/e2e/playmode.e2e.spec.ts runtime/client/e2e/global-setup.ts runtime/client/playwright.config.ts`
Expected: formatted (idempotent).

- [ ] **Step 8: Commit**

```bash
git add runtime/client/e2e/playmode.e2e.spec.ts runtime/client/e2e/global-setup.ts runtime/client/playwright.config.ts justfile
git commit -m "test(e2e): direct play-mode against a live runtime/server"
```

---

## Final verification (before opening the PR)

- [ ] **Rust gates:** `cargo fmt --check && cargo clippy -p bloom-runtime-server && cargo test -p bloom-runtime-server` — all green.
- [ ] **Client unit + types + build:** `npx nx test client && npx nx typecheck client && npx nx build client` — all green.
- [ ] **Prettier (repo-wide check, pinned):** `C:\code\bloom\node_modules\.bin\prettier --check .` — clean.
- [ ] **E2e (local, offset 1):** `playmode.e2e.spec.ts` + `reels.e2e.spec.ts` green against the offset stack (`:4301` client, `:9001` server).
- [ ] **Manual smoke (optional):** `just runtime-serve` + `just serve-runtime-client`, open `http://<dev-host>:4301/?server=http://<dev-host>:9001`, confirm the grid renders and Spin animates a server outcome.
- [ ] Push `feat/runtime-client-play-mode` and open a PR (`gh pr create`).

## Self-review notes (spec coverage)

- Spec §3.1 client modules → Tasks 3–8 (one file per module; `wireTypes` folded into Task 4 as the shared type home; `index.html` Spin button in Task 8).
- Spec §3.2 server changes → Task 1 (seed string) + Task 2 (CORS).
- Spec §4 data flow → Task 7 (`playMode`) + Task 9 (e2e proves it end-to-end).
- Spec §5 config/LAN → Task 3 (host-derived URL) + Task 8 (`VITE_RUNTIME_SERVER_PORT` define) + Task 9 (`just` recipe).
- Spec §6 error handling → Task 7 (handshake/spin failures surface visibly) + Task 9 (handshake-failure e2e).
- Spec §7 testing → unit Tasks 3–7, server Tasks 1–2, e2e Task 9.
- Spec §8 deferred seams → respected: bet fixed at 1, single mechanic with a clear error, no operator/economics/signing/feature-animation/layout work; permissive CORS with the allowlist labeled.
