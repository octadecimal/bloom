# Runtime Client — SP2: direct play-mode (`runtime/client` ↔ `runtime/server`)

- **Date:** 2026-06-29
- **Status:** Approved (design) — ready for implementation plan
- **Parent:** [`2026-06-18-bloom-platform-architecture-design.md`](2026-06-18-bloom-platform-architecture-design.md)
  §5–§7 (the game server, the flow, the server→client contract)
- **Predecessor:** [`2026-06-28-runtime-server-spin-service-design.md`](2026-06-28-runtime-server-spin-service-design.md)
  (SP1 — the authoritative spin service; **merged**, PR #126 / `67012ad`)
- **Scope:** SP2 of the runtime-server decomposition. Wires the untrusted Pixi
  game client (`runtime/client`) to talk **directly** to the authoritative game
  server (`runtime/server`) — a standalone "direct play-mode": fetch presentation,
  send a bet, animate exactly the server-dictated outcome. Pure client+server
  wiring; the reels module is reused, not rebuilt. The studio stays authoring-only.

---

## 1. Why this exists

Bloom runs on **two planes** (north-star §6): the `studio/` authoring plane (AI,
human-in-the-loop, uncertified) and the `runtime/` authoritative plane
(deterministic, zero-AI, audited). SP1 built the runtime keystone — `runtime/server`,
which loads a signed package, draws a seed, expands it with the certified math
engine, audits the round, and returns the outcome. But **nothing plays it yet.**

Today the only thing that drives the Pixi client is the **studio stand-in**: the
studio clicks "spin", the Python backend evaluates a round and broadcasts a
`scene_spin_outcome` over socket.io, and the studio relays it into the engine
iframe via `postMessage`. That is an authoring tool doing a runtime job — and on
Windows under `uvicorn --reload` it is currently broken (see
[`reels-spin-windows-reload`]).

SP2 builds the real path: the client connects **directly** to `runtime/server`,
with no studio and no postMessage intermediary. This is the north-star's "a real
spin" (§7, Milestone 2) wired end to end — the untrusted client animating exactly
what the authoritative server dictates (§6).

## 2. What already exists (reused, not rebuilt)

**Server side (`runtime/server`, SP1 — merged):**

- `GET /handshake` → `{ package_id, package_version, mechanic, presentation }`.
  `presentation` is the package's JSON manifest, parsed (the demo carries
  `{ "cols": 3, "rows": 3, "symbols": ["0","1","2","9"], "parentId": "root" }`).
- `POST /spin` (body optional `{ "bet": <u64> }`, default 1) →
  `{ seed, bet, outcome: { mechanic: "slots@1", base_grid, base_payout,
feature_payout, total_payout, features } }`. `base_grid` is `Vec<Vec<Symbol>>`
  with `Symbol = u8`, oriented **`base_grid[reel][row]`** (reel = column; rows top
  to bottom) — `trusted/math/.../eval.rs::spin`.
- `GET /health` → `{ status, package_id, package_version, mechanic }`.
- Binds `0.0.0.0:9000 + BLOOM_PORT_OFFSET`. **No CORS layer today.**

**Client side (`runtime/client`, Pixi v8):**

- A node-graph engine that materializes a game document into a live Pixi scene and
  mutates it over a versioned `postMessage` protocol (`ProtocolHost`,
  `GraphModel` → reconciler → `IRenderer`/`PixiRenderer`).
- **The reels module** (`src/modules/reels/reelsModule.ts`): builds its grid from
  config via `buildDesired`/`project` (idempotent), and animates an outcome via
  the orchestrator: `orchestrator.spin(outcome)` →
  `reels.project()` → `startSpinning()` → `stopSpinning(outcome)`, settling over
  ~600 ms with per-reel stagger. The outcome it consumes is
  `IOutcome { grid: string[][] }` with **`grid[col][row]`** = symbol id **string**
  (`src/modules/module.ts`).
- The reels config schema already takes `{ cols, rows, symbols, cellSize, ...,
parentId }` — the same fields the handshake presentation carries.
- Boot (`src/main.ts`) already branches by URL params: **embedded** (`?parentOrigin=`,
  studio iframe) vs **standalone** (`?doc=<url>` fetch). Cross-origin media is
  resolved host-derived via `resolveTextureSrc` + `?mediaBase=` (never hardcoded
  localhost — [`lan-remote-access`]). Dev server: `0.0.0.0:4300 + offset`
  (`vite.config.mts`).
- Responsive root scaling (PR #109) already fits the scene to the viewport;
  play-mode inherits it for free.

**The fortunate alignment:** the server's `base_grid[reel][row]` orientation is
_exactly_ the client's `IOutcome.grid[col][row]`. The adapter is therefore a pure
stringify of `u8` → decimal string (`0` → `"0"`), no transpose — and the
presentation's `symbols: ["0","1","2","9"]` are already those same string ids.

## 3. Architecture

SP2 is mostly a **new client boot path** plus **two small additive server wire
changes**. No existing reels/engine/studio code is rebuilt.

```
runtime/client/src/
  main.ts                     # +third boot branch: direct play-mode
  play/                       # NEW — the direct-play subsystem
    runtimeClient.ts          #   thin fetch wrapper over runtime/server
    runtimeServerUrl.ts       #   host-derived, configurable base URL (no hardcoded localhost)
    outcomeAdapter.ts         #   pure: server OutcomeWire(slots@1) -> client IOutcome
    playMode.ts               #   boot orchestration: handshake -> scene -> spin loop
    presentationConfig.ts     #   pure: handshake presentation -> reels config
  index.html                  # +Spin button overlay (shown only in play-mode)

runtime/server/src/
  wire.rs                     # seed -> string-encoded in SpinResponse (client-facing)
  lib.rs                      # +permissive tower-http CORS layer on build_app
  Cargo.toml                  # +tower-http (cors feature)
```

### 3.1 Module responsibilities (client)

- **`runtimeServerUrl.ts`** (pure) — resolves the server base URL with a strict
  precedence that never hardcodes localhost ([`lan-remote-access`]):
  1. an explicit `?server=<url>` query param (full override), else
  2. host-derived: `http://<window.location.hostname>:<port>` where `port` =
     `VITE_BLOOM_RUNTIME_SERVER_PORT` (default `9000`) `+ BLOOM_PORT_OFFSET`.
     The page's own hostname is used so a LAN browser reaches the dev host, not its
     own `localhost`. Unit-tested by injecting a fake `location` + env.
- **`runtimeClient.ts`** — a thin typed `fetch` wrapper bound to a base URL:
  `handshake(): Promise<HandshakeResponse>` (`GET /handshake`) and
  `spin(bet?): Promise<SpinResponse>` (`POST /spin`, JSON body). It owns the wire
  _types_ (mirrors of the server DTOs, with `seed: string`). No animation, no DOM.
  Unit-tested against a mocked `fetch`.
- **`outcomeAdapter.ts`** (pure) — `toClientOutcome(wire: SpinResponse): IOutcome`.
  For the single `slots@1` arm: `grid = wire.outcome.base_grid.map(reel =>
reel.map(sym => String(sym)))`. Feature/free-spins payouts are carried but **not
  animated** in SP2 (labeled seam, §8). Unit-tested cell-for-cell, including the
  no-transpose orientation contract.
- **`presentationConfig.ts`** (pure) — `toReelsConfig(presentation): ReelsConfig`.
  Maps `{ cols, rows, symbols, parentId? }` to the reels module's config fields,
  applying the module's existing defaults for anything the manifest omits (e.g.
  `cellSize`, `spacing`). A non-`slots@1` mechanic or an empty/`null` presentation
  is surfaced as a clear, user-visible error (§6), not a silent blank scene.
- **`playMode.ts`** — the boot orchestration, the only stateful piece:
  1. resolve the server URL, build a `runtimeClient`;
  2. `handshake()` → `toReelsConfig(presentation)` → seed the scene
     (init a Root + the reels module via the engine, then `project()`), so the
     grid renders **before** the first spin;
  3. wire the Spin gesture: on click, disable the button, `spin(bet=1)`, adapt the
     outcome, `orchestrator.spin(outcome)`, re-enable on `reels:settled`;
  4. surface any handshake/spin/network failure visibly (§6).
- **`main.ts`** — add a third boot branch. Selection: **play-mode iff a `?server=`
  param is present OR an explicit `?play` flag is set.** (Embedded keeps requiring
  `?parentOrigin`; `?doc=` standalone is unchanged. The three are mutually
  exclusive; play-mode takes precedence over `?doc=` when both are present, and
  is documented.) In play-mode, `main.ts` constructs the engine and hands off to
  `playMode.ts`; it does **not** install the studio postMessage intake.
- **`index.html`** — a single `<button id="spin">` overlay, hidden by default and
  revealed only by play-mode boot. Minimal styling; this is the player's only
  gesture (there is no studio to click "spin"). Not a full game HUD — balance/bet
  UI is deferred (§8).

### 3.2 Server changes (small, additive, runtime-plane)

- **CORS** — add a permissive `tower-http` `CorsLayer` to `build_app` (in `lib.rs`)
  allowing `GET`/`POST` and any origin, so a browser at the client origin (`:4301`)
  can fetch the server (`:9001`) cross-origin. This is the production-shaped choice:
  "direct play-mode" means the client talks **directly** to the server (a Vite
  proxy would reintroduce the intermediary SP2 exists to remove), and a real game
  client served from an operator/CDN origin is inherently cross-origin. A real
  **origin allowlist** is a labeled seam (§8) — SP2 ships permissive-for-demo,
  consistent with the dev signing key.
- **seed string-encoding** — `SpinResponse.seed` is serialized as a **string**
  (`#[serde(serialize_with = ...)]` or a string field at the wire boundary). The
  seed is a `u64` that can exceed `2^53`; a JS client parsing it as a JSON number
  would silently lose precision. Only the **client-facing** `SpinResponse` is
  affected — the internal `AuditRecord` and all reproducibility logic keep `u64`.
  The two SP1 route tests that assert `v["seed"] == 33` update to `"33"`. The
  client treats `seed` as an opaque string (it does no arithmetic on it).

## 4. Data flow (one spin, end to end)

```
[player opens]  http://<host>:4301/?server=http://<host>:9001    (or ?play, host-derived)
  main.ts -> play-mode branch
  playMode: runtimeClient.handshake()  --GET-->  runtime/server /handshake
            presentation {cols,rows,symbols,parentId}
            -> toReelsConfig -> engine init Root + reels.project()   [grid renders]
[player clicks Spin]
  playMode: runtimeClient.spin(1)      --POST-->  runtime/server /spin {bet:1}
            { seed:"<u64-as-string>", bet:1, outcome:{mechanic:"slots@1",base_grid,...} }
            -> toClientOutcome -> IOutcome{grid}
            -> orchestrator.spin(outcome) -> reels settle (~600ms)
            -> 'reels:settled' -> Spin re-enabled
```

The server is authoritative end to end: the client cannot supply or override the
index, seed, or outcome — it only renders what `/spin` returns.

## 5. Configuration & LAN

- **Never hardcode `localhost`** in any browser-facing URL ([`lan-remote-access`]).
  The server base URL is host-derived from `window.location.hostname` (or a full
  `?server=` override), exactly as `mediaBase`/`backendOrigin` already are.
- **Port offset.** Default server port = `VITE_BLOOM_RUNTIME_SERVER_PORT (9000)
  - BLOOM_PORT_OFFSET`, mirroring how the client (`4300+offset`) and server
(`9000+offset`) already derive ports — so a worktree's play-mode reaches that
    worktree's server.
- A `just` convenience recipe boots play-mode against the demo package: bring up
  `runtime/server` (offset-aware) and the runtime client, and print the play-mode
  URL. (Naming/threading mirrors `runtime-serve` / `serve-runtime-client`.)

## 6. Error handling

The untrusted client must fail **visibly**, never to a silent blank canvas:

- **Handshake failure** (network error, non-200, empty/`null` presentation, or a
  non-`slots@1` mechanic) → render a clear in-canvas/overlay message and do not
  show the Spin button. The mechanic check makes the single-arm assumption explicit
  rather than crashing on an unexpected shape.
- **Spin failure** (network error, non-200 incl. the server's audit-failure 500) →
  show a transient error, leave the prior grid intact, and re-enable Spin so the
  player can retry. A 500 from `/spin` means the server refused to serve an
  unaudited round (SP1 §6) — the client surfaces "spin failed", never fabricates an
  outcome.
- All error copy is generic/demo-grade; production player-facing messaging is an
  operator concern (§8).

## 7. Testing (TDD; the e2e is the behavioral contract)

Per AGENTS.md: unit tests cover the pure logic; the Playwright e2e is the
authoritative, exhaustive contract for observable behavior.

**Client unit (vitest):**

- `runtimeServerUrl`: `?server=` override wins; otherwise host-derived from a
  faked `location.hostname` + port from env+offset; **never** emits `localhost`
  when the page host isn't localhost.
- `outcomeAdapter`: maps a `slots@1` wire outcome to `IOutcome` cell-for-cell;
  asserts the **no-transpose** orientation (a non-square `base_grid` proves
  col/row aren't swapped); stringifies symbol ids.
- `presentationConfig`: maps `{cols,rows,symbols,parentId}` to reels config and
  applies module defaults for omitted fields; rejects empty/`null`/non-`slots@1`.
- `runtimeClient`: `handshake`/`spin` call the right method+URL+body against a
  mocked `fetch` and parse the response (incl. `seed` as a string); a non-200
  rejects.

**Server unit (cargo):**

- CORS: a request with an `Origin` header gets `access-control-allow-origin` on
  `/handshake` and `/spin` (via `build_app` `oneshot`); a preflight `OPTIONS` is
  answered.
- seed wire: `/spin` serializes `seed` as a JSON **string** whose value equals the
  drawn seed; the updated SP1 tests assert `"33"`. Internal reproducibility
  (re-`evaluate` the recorded `u64`) is unchanged.

**E2e (Playwright — the contract):**

- A spec boots `runtime/client` in **play-mode against a live `runtime/server`**
  (the demo package), then asserts the full observable flow: the grid renders from
  the handshake presentation (cols/rows/symbols), clicking **Spin** settles the
  reels to a server-dictated outcome (phase returns to idle; rendered grid matches
  the `/spin` response), and Spin re-enables. Cross-origin `:4301 → :9001` exercises
  the CORS layer for real. A handshake-failure path (server down / bad URL) asserts
  the visible error and no Spin button. Uses the worktree's offset ports
  ([`worktree-independent-ports`]).

## 8. Deferred — labeled seams, explicitly NOT built in SP2

- **Operator-integration edge** (REST/WS, session tokens, real origin allowlist) —
  SP2 ships permissive CORS for the demo; the operator adapter and a tightened
  allowlist are later (architecture §11).
- **Bet/balance economics** — the bet is sent and echoed, never debited; no wallet,
  balance, or settlement UI (operator-owned). The Spin button uses a fixed `bet=1`.
- **Real signing / the human sign-off gate** — SP2 plays the dev-signed demo
  package; key management and sign-off are unchanged from SP1.
- **Feature / free-spins animation** — the adapter carries `features`/payouts but
  SP2 animates only the base grid (the reels module's current capability). A
  feature-animation pass is additive later.
- **A second mechanic** — the adapter and any mechanic switch have exactly one arm
  (`slots@1`); a non-`slots@1` handshake is a clear error, and no plugin/registry
  machinery is built.
- **Studio-preview repointing** — the studio keeps its current local stand-in
  preview; SP2 does not repoint it at `runtime/server`, and does not patch the
  broken `--reload` studio spin stopgap (SP2 _is_ the real path, separately).
- **Reels portrait / auto-fit layout rework** — the deferred default-scene layout
  direction ([`reels-scene-layout-direction`]) is its own design; play-mode renders
  the demo presentation as-is.
- **Player-facing UX polish** — real HUD, win presentation, error copy, balance
  display — operator/product concerns, not this wiring slice.

## 9. Out of scope

Banking/payments/KYC/accounts (operator's); any AI anywhere in `runtime/`; more
than one mechanic; the studio preview integration; rebuilding the reels module or
the engine; the layout rework.
