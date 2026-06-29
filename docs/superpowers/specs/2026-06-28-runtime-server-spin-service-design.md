# Runtime Server — SP1: the authoritative spin service (`runtime/server/`)

- **Date:** 2026-06-28
- **Status:** Approved (design) — ready for implementation plan
- **Parent:** [`2026-06-18-bloom-platform-architecture-design.md`](2026-06-18-bloom-platform-architecture-design.md)
  §5 "the game server", §6 flow, §9 audit
- **Scope:** SP1 of the runtime-server decomposition. Builds the first real
  `runtime/server/` — the authoritative, zero-AI, audited spin service. SP2 (client
  direct play-mode) is a separate spec and depends on this.

---

## 1. Why this exists

Bloom has **two planes**: the `studio/` authoring plane (AI, human-in-the-loop, not
certified) and the `runtime/` authoritative plane (deterministic, zero AI, audited).
Today the **Python studio backend stands in** for the game server — it serves
`scene_spin` by spawning the `spin_json` kernel as a subprocess. That is an authoring
tool doing a runtime job: the wrong plane, the wrong language, a subprocess where a
library call belongs, and (on Windows under `uvicorn --reload`) it is currently broken.

`runtime/server/` is the missing runtime-plane keystone. It is the authoritative
source of truth for real-money outcomes: it loads a signed package, draws a seed,
expands it via the **same compiled math engine** the simulator used to certify the
package, writes an append-only audit record, and returns the outcome. The client is
untrusted and animates exactly what the server dictates.

This spec builds that service end-to-end as **pure Rust** — no Python, no PyO3, no
subprocess, no duplicated spin logic. It reuses the existing building blocks natively.

## 2. What already exists (reused natively, not rebuilt)

- **`bloom-package`** (`trusted/package`): `verify_and_load(bytes, &VerifyingKey) ->
Result<PackageContent, PackageError>` — ed25519 + postcard, signature-checked, pure.
  `PackageContent { envelope { package_id, package_version, mechanic }, math_payload:
Vec<u8>, seeds: Vec<u64>, presentation: Vec<u8> }`.
- **`bloom-math`** (`trusted/math`): `mechanics::slots::evaluate(&model, seed) ->
RoundOutcome` and `from_payload(&[u8]) -> Result<SlotModel, _>`. `RoundOutcome {
base_grid, base_payout, features: Vec<FeatureOutcome>, feature_payout, total_payout }`.
  Deterministic (SplitMix64); same `(model, seed)` is bit-identical forever.
- **`curate`** (`studio/simulator/src/bin/curate.rs`): mints a signed `.pkg` from a
  model JSON + target JSON using the dev signing key `[7u8; 32]`. Sets
  `presentation = Vec::new()` today (see §7 — SP1 extends it to carry a manifest).

**`runtime/` currently contains only `client/` and `AGENTS.md`. `runtime/server/`
does not exist yet — this spec creates it.**

## 3. Architecture

A single new Cargo workspace member, `runtime/server` (crate `bloom-runtime-server`),
added to the root `Cargo.toml` `members` list. It is an axum HTTP service plus a thin
set of internal seams. Pure Rust; depends only on `trusted/` crates (never on
`studio/` — the dependency rule from architecture §3).

```
runtime/server/
├─ Cargo.toml
└─ src/
   ├─ main.rs        # binary: parse config, load+verify package, build state, serve
   ├─ lib.rs         # wires modules; exposes build_app(state) for tests
   ├─ config.rs      # ServerConfig: package path, audit path, bind addr/port
   ├─ state.rs       # AppState: verified package, model, draw source, audit sink
   ├─ draw.rs        # Draw seam: uniform index into [0, pool_size)
   ├─ audit.rs       # AuditSink seam + JSONL file impl + the AuditRecord type
   ├─ wire.rs        # server-owned outcome contract (mechanic-tagged) + handshake DTO
   └─ routes.rs      # axum handlers: /spin, /handshake, /health
```

### 3.1 Module responsibilities

- **`config.rs`** — `ServerConfig { package_path, audit_path, bind_addr }`. Built from
  CLI args / env (`BLOOM_RUNTIME_PORT`, default `9000`; honors `BLOOM_PORT_OFFSET` so a
  worktree's server doesn't collide — derived port = `9000 + offset`). No I/O beyond
  reading env.
- **`state.rs`** — `AppState` holds the verified `PackageContent`, the decoded
  `SlotModel` (decoded once at boot via `from_payload`), a boxed `Draw`, and a boxed
  `AuditSink`. Shared across handlers (axum `State`, `Arc`). Built by a constructor that
  takes a `ServerConfig`: reads the package bytes, `verify_and_load`s them against the
  embedded verifying key, decodes the model, opens the audit sink. **A package that
  fails to verify, or a payload that fails to decode, aborts boot loudly** (the server
  must never run on an unverified package).
- **`draw.rs`** — `trait Draw { fn index(&self, pool_size: usize) -> usize; }`. SP1 impl
  `OsRngDraw` uses `rand`'s OS-backed CSPRNG (`getrandom`) to pick a uniform index in
  `[0, pool_size)`. The seam exists so the certification-appropriate CSPRNG choice
  (architecture §18) can be swapped without touching handlers; tests use a fixed-index
  `Draw` to make outcomes deterministic.
- **`audit.rs`** — the **append-only audit record** (architecture §9):
  `AuditRecord { package_id, package_version, mechanic, math_engine_version, seed, bet,
timestamp_ms, outcome }`. `trait AuditSink { fn append(&self, rec: &AuditRecord) ->
io::Result<()>; }`. SP1 impl `JsonlAuditSink` appends one JSON line per round to a
  file (durable, replayable, genuinely append-only). A real event store / DB is deferred
  behind this trait.
- **`wire.rs`** — the **server → client outcome contract** (architecture §7): a
  serde-serializable DTO that is a **tagged union keyed by mechanic** with exactly one
  arm today (`slots`). `trusted/math`'s `RoundOutcome` is intentionally **not** made
  serde-serializable (it stays a pure certified type); `wire.rs` maps `RoundOutcome` →
  the slots arm. Also defines `HandshakeResponse { package_id, package_version,
mechanic, presentation }` and `SpinResponse { seed, audit_id?, outcome }`.
- **`routes.rs`** — the three handlers (§4), each a thin orchestration over the seams.
- **`main.rs` / `lib.rs`** — `lib.rs::build_app(state) -> axum::Router` so handler tests
  run in-process via `oneshot` with no socket; `main.rs` builds config + state and binds
  the listener.

## 4. Endpoints

### `POST /spin`

The authoritative round. Body is **optional**: `{ "bet": <u64> }` (default `1`). Bet is
recorded and echoed but **not** debited — bet/balance economics are an operator concern,
deferred (architecture §11; this is a labeled seam, not built).

1. `index = draw.index(seeds.len())`.
2. `seed = seeds[index]`.
3. `outcome = evaluate(&model, seed)` (same compiled `bloom-math` the package was
   certified against — the determinism contract, architecture §4/§9).
4. Build `AuditRecord` (seed, bet, math-engine version, timestamp, mapped outcome) and
   `audit.append(&record)`.
5. Respond `200` with `SpinResponse { seed, outcome: <mechanic-tagged wire outcome> }`.

The server is authoritative: the client cannot supply or override the index, seed, or
outcome.

### `GET /handshake`

Hands the untrusted client what it needs to render: `HandshakeResponse { package_id,
package_version, mechanic, presentation }`. `presentation` is the package's opaque bytes,
forwarded verbatim (SP1 mints a small JSON manifest into the demo package — §7). No
client wiring here; consuming this is SP2.

### `GET /health`

Liveness + identity: `{ status: "ok", package_id, package_version, mechanic }`. Parity
with the studio's `/health` convention. No `PROVIDER_MODE` concept here — the runtime
plane has no providers.

## 5. Demo package

A `just` recipe (`runtime-demo-pkg` or similar) mints a demo `.pkg` by running the
existing `curate` bin against a committed demo model + target JSON, writing the package
to a known path the server loads by default. Uses the dev signing key `[7u8; 32]`; the
server embeds the matching **dev verifying key**. Real signing-key management and the
human sign-off gate are deferred (architecture §9) — labeled, not built.

## 6. Determinism & audit (the contract this service must honor)

- **Same compiled engine.** The server expands seeds with the identical `bloom-math`
  crate the simulator used to curate the package. No reimplementation, no subprocess —
  a direct library call. This is the determinism contract (architecture §4); violating
  it would make the certified RTP a lie.
- **Reproducible rounds.** Every audit record carries the drawn seed and the math-engine
  version, so any historical round is bit-reproducible by re-`evaluate`-ing the seed. A
  test asserts exactly this (§8).
- **Append-only.** The JSONL sink only ever appends; records are never mutated or
  deleted.

## 7. Presentation manifest (small additive change to curation)

So `/handshake` returns something real, the demo package carries a **minimal JSON
presentation manifest** (e.g. the reels grid config: cols/rows/symbols). This requires
`curate` to accept presentation bytes instead of hardcoding `Vec::new()`:

- Extend the `curate` CLI to optionally read a `presentation.json` file and pass its
  bytes into `PackageContent.presentation` (threaded through `run_curation` /
  `run_curation_streamed`, which currently hardcode `presentation: Vec::new()`).
- Keep it **backward compatible**: omitting the presentation arg yields today's empty
  presentation. The package format itself is unchanged (it already carries
  `presentation: Vec<u8>`) — no re-certification of the format.

This is the only change outside `runtime/`. It is additive and lives in the authoring
plane (`studio/simulator`), where building packages belongs.

## 8. Testing (TDD; CI-affordable, non-browser Rust)

All tests are `cargo test` — cheap, deterministic, CI-affordable (the repo's CI-cost
policy welcomes non-browser suites). Test-first throughout.

**Unit**

- `draw`: `OsRngDraw.index(n)` is always in `[0, n)` across many draws; a fixed-index
  test `Draw` returns its configured index.
- `audit`: `JsonlAuditSink.append` writes one parseable JSON line per call and appends
  (two appends → two lines; existing lines preserved).
- `wire`: `RoundOutcome` → slots wire DTO maps grid/payouts faithfully and serializes
  with the mechanic tag.
- `state`: constructor verifies a good package and **errors** on a tampered/wrong-key
  package and on an undecodable payload.

**Handler-level (axum `oneshot` via `build_app`, no socket)**

- `POST /spin`: returns `200`; the returned `seed` is a member of the package pool; the
  returned outcome equals `evaluate(model, returned_seed)` mapped to wire — i.e. the
  served outcome is authoritative **and** reproducible. With a fixed-index test `Draw`,
  the whole response is pinned.
- `POST /spin` appends exactly one audit record per call, and the recorded seed
  re-evaluates to the served outcome (the reproducibility contract, §6).
- `POST /spin` with `{ "bet": k }` echoes/records `bet = k`; with no body, `bet = 1`.
- `GET /handshake`: returns the package's `presentation` bytes + envelope fields; with
  the demo manifest, presentation is non-empty and parses.
- `GET /health`: `200`, reports the loaded package id.

## 9. Deferred — labeled seams, explicitly NOT built in SP1

Named here so no one designs against them and so the seams exist where they belong:

- **Real signing-key management + the human sign-off gate** (architecture §9). SP1 uses
  the dev key pair and an embedded dev verifying key.
- **Operator-integration edge** (REST/WS, session tokens, architecture §11). SP1 exposes
  plain HTTP for the demo; the operator adapter is a later component.
- **Bet/balance economics.** `bet` is recorded and echoed but never debited; no wallet,
  no balance, no payout settlement (operator-owned, §11).
- **SP2 client wiring.** Connecting `runtime/client` (Pixi/reels) to this server, fetching
  presentation, and animating returned outcomes is the next sub-project.
- **Studio-preview repointing.** The studio keeps its current local stand-in preview; we
  do **not** repoint it at `runtime/server` in SP1, and we do **not** patch the broken
  `--reload` studio spin stopgap (the real fix is SP2).
- **Certification-appropriate CSPRNG selection** and **durable event-store audit
  backend** (architecture §18) — both live behind the `Draw` / `AuditSink` seams.
- **A second mechanic.** The outcome wire union and any `match` on mechanic have exactly
  one arm (`slots`); we name and place the slot-specific parts so a second mechanic is
  additive, and build no plugin/registry machinery (architecture §7).

## 10. Out of scope

Banking/payments/KYC/accounts (operator's, §11); any AI anywhere in `runtime/`; more than
one mechanic; the studio preview integration; SP2 client work.
