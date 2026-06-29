# Runtime Server SP1 — Authoritative Spin Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `runtime/server/` — the authoritative, zero-AI, audited Rust/axum game server that loads a signed package, draws a seed, expands it via the certified math engine, audits the round, and returns the outcome.

**Architecture:** A new Cargo workspace member `runtime/server` (crate `bloom-runtime-server`). It reuses `bloom-package` (verify/load) and `bloom-math` (evaluate) **natively** — no Python, no PyO3, no subprocess, no duplicated spin logic. Internal seams (`Draw`, `AuditSink`) isolate the RNG and audit backends. The HTTP surface is three axum handlers (`/spin`, `/handshake`, `/health`) tested in-process via `oneshot`.

**Tech Stack:** Rust 2021, axum 0.7, tokio 1, serde / serde_json, rand 0.8 (OS CSPRNG index draw), ed25519-dalek 2 (verify), postcard (via bloom-math/package). Demo package minted by the existing `curate` bin.

## Global Constraints

- **Dependency rule (architecture §3):** `runtime/server` may depend on `trusted/` only. It MUST NOT depend on anything under `studio/`.
- **Determinism contract (architecture §4/§9):** seed expansion uses the **same compiled `bloom-math` crate** the package was certified against — a direct library call, never a reimplementation or subprocess.
- **No AI in `runtime/`** (per `runtime/AGENTS.md`).
- **Audit is append-only:** records are only ever appended, never mutated/deleted. A round that cannot be audited is NOT served (handler returns 500).
- **Authoritative server:** the client can never supply or override the index, seed, or outcome.
- **TypeScript interface `I` prefix** standard does not apply here (no TS in this plan).
- **Commits:** Conventional Commits, imperative mood. Scope `runtime` for server work, `simulator` for the curate change.
- **Dev keys only:** sign with `SigningKey::from_bytes(&[7u8; 32])`; server embeds the matching dev verifying key. Real key management is a deferred labeled seam.
- **Ports:** server port = `BLOOM_RUNTIME_PORT` (default `9000`) `+ BLOOM_PORT_OFFSET` (default `0`); bind `0.0.0.0` (LAN access — never hardcode localhost on a bound address).

---

### Task 1: Crate scaffold — boot on a verified package, report `/health`

Creates the crate, wires it into the workspace, and delivers the first observable behavior: the server constructs `AppState` by verifying + decoding a package, and `GET /health` reports the loaded package id. Scaffolding (Cargo.toml, lib/main, config, state) folds into this deliverable because `/health` needs all of it.

**Files:**
- Modify: `Cargo.toml` (workspace `members`)
- Create: `runtime/server/Cargo.toml`
- Create: `runtime/server/src/lib.rs`
- Create: `runtime/server/src/main.rs`
- Create: `runtime/server/src/config.rs`
- Create: `runtime/server/src/state.rs`
- Create: `runtime/server/src/routes.rs`
- Test: inline `#[cfg(test)]` in `state.rs` and `routes.rs`

**Interfaces:**
- Produces:
  - `config::ServerConfig { package_path: PathBuf, audit_path: PathBuf, bind_addr: SocketAddr }` with `ServerConfig::from_env() -> ServerConfig`.
  - `state::AppState { package: PackageContent, model: SlotModel, draw: Box<dyn Draw>, audit: Box<dyn AuditSink> }` (the `draw`/`audit` fields are added in Tasks 2–3; in Task 1 the struct holds only `package` + `model`, and the two boxed fields are introduced when their seams land).
  - `state::AppState::from_package_bytes(bytes: &[u8], draw: Box<dyn Draw>, audit: Box<dyn AuditSink>) -> Result<AppState, StartupError>` — note: in Task 1 this signature is `from_package_bytes(bytes: &[u8]) -> Result<AppState, StartupError>`; Tasks 2–3 widen it to take the seams. Mark the Task-1 form clearly so later tasks know to change it.
  - `state::AppState::load(config: &ServerConfig) -> Result<AppState, StartupError>`.
  - `state::StartupError` enum.
  - `state::dev_verifying_key() -> ed25519_dalek::VerifyingKey`.
  - `lib::build_app(state: std::sync::Arc<AppState>) -> axum::Router`.

> **Note for later tasks:** to avoid churn, implement `AppState` in Task 1 already carrying `draw: Box<dyn Draw>` and `audit: Box<dyn AuditSink>` is NOT possible (those types don't exist yet). Task 1 builds the minimal `AppState`; Tasks 2 and 3 add the fields and widen `from_package_bytes`/`load`. The `/health` test only reads `package`, so it survives the widening unchanged.

- [ ] **Step 1: Add the workspace member**

Modify `Cargo.toml` (repo root):

```toml
[workspace]
resolver = "2"
members = ["trusted/math", "trusted/package", "studio/simulator", "studio/tuner", "runtime/server"]
```

- [ ] **Step 2: Create the crate manifest**

Create `runtime/server/Cargo.toml`:

```toml
[package]
name = "bloom-runtime-server"
version = "0.0.0"
edition = "2021"

[dependencies]
bloom-math = { path = "../../trusted/math" }
bloom-package = { path = "../../trusted/package" }
axum = "0.7"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rand = "0.8"
ed25519-dalek = "2"

[dev-dependencies]
tower = { version = "0.5", features = ["util"] }
```

- [ ] **Step 3: Write the failing test for package verification + decode (state.rs)**

Create `runtime/server/src/state.rs` with the test first (it won't compile yet — that is the RED state):

```rust
//! Server startup state: the verified package + decoded model, plus the
//! runtime seams. A package that fails to verify or decode aborts boot loudly.

use bloom_math::mechanics::slots::{from_payload, SlotModel};
use bloom_package::{verify_and_load, PackageContent, PackageError};
use ed25519_dalek::{SigningKey, VerifyingKey};

/// The development verifying key (matches the dev signing key `[7u8; 32]`).
/// Real signing-key management is a deferred sign-off-gate concern.
pub fn dev_verifying_key() -> VerifyingKey {
    SigningKey::from_bytes(&[7u8; 32]).verifying_key()
}

#[derive(Debug)]
pub enum StartupError {
    BadPackage(PackageError),
    BadPayload(postcard::Error),
    Io(std::io::Error),
}

pub struct AppState {
    pub package: PackageContent,
    pub model: SlotModel,
}

impl AppState {
    /// Verify the package bytes against the dev key, then decode its model.
    pub fn from_package_bytes(bytes: &[u8]) -> Result<AppState, StartupError> {
        let package =
            verify_and_load(bytes, &dev_verifying_key()).map_err(StartupError::BadPackage)?;
        let model = from_payload(&package.math_payload).map_err(StartupError::BadPayload)?;
        Ok(AppState { package, model })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{
        to_payload, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
    };
    use bloom_package::{build, Envelope, PackageContent};

    fn dev_signing_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn tiny_model() -> SlotModel {
        SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }],
            },
            bonuses: vec![],
        }
    }

    fn good_package_bytes() -> Vec<u8> {
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-test".into(),
                package_version: 1,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&tiny_model()),
            seeds: vec![1, 2, 3, 4, 5],
            presentation: Vec::new(),
        };
        build(&content, &dev_signing_key())
    }

    #[test]
    fn loads_and_decodes_a_valid_package() {
        let state = AppState::from_package_bytes(&good_package_bytes()).expect("loads");
        assert_eq!(state.package.envelope.package_id, "pkg-test");
        assert_eq!(state.model.reels.len(), 3);
    }

    #[test]
    fn rejects_a_tampered_package() {
        let mut bytes = good_package_bytes();
        let i = 8 + 2 + 1; // inside the signed content region
        bytes[i] ^= 0xFF;
        assert!(matches!(
            AppState::from_package_bytes(&bytes),
            Err(StartupError::BadPackage(_))
        ));
    }

    #[test]
    fn rejects_a_wrong_key_package() {
        let content_bytes = {
            let other = SigningKey::from_bytes(&[9u8; 32]);
            let content = PackageContent {
                envelope: Envelope {
                    package_id: "pkg-x".into(),
                    package_version: 1,
                    mechanic: "slots@1".into(),
                },
                math_payload: to_payload(&tiny_model()),
                seeds: vec![1],
                presentation: Vec::new(),
            };
            build(&content, &other)
        };
        assert!(matches!(
            AppState::from_package_bytes(&content_bytes),
            Err(StartupError::BadPackage(_))
        ));
    }
}
```

Add `postcard` to dependencies so `postcard::Error` resolves — append to `runtime/server/Cargo.toml` `[dependencies]`:

```toml
postcard = { version = "1", features = ["use-std"] }
```

- [ ] **Step 4: Run the state tests to verify they fail**

Run: `cargo test -p bloom-runtime-server state::`
Expected: FAIL — first because other modules referenced below don't exist yet; ensure `state.rs` alone compiles by completing Step 5 wiring before running. (If `lib.rs` is missing, the crate won't build — proceed to Step 5, then run.)

- [ ] **Step 5: Create `config.rs`, `routes.rs`, `lib.rs`, `main.rs`**

Create `runtime/server/src/config.rs`:

```rust
//! Server configuration, sourced from environment with sane defaults.

use std::net::SocketAddr;
use std::path::PathBuf;

pub struct ServerConfig {
    pub package_path: PathBuf,
    pub audit_path: PathBuf,
    pub bind_addr: SocketAddr,
}

impl ServerConfig {
    pub fn from_env() -> ServerConfig {
        let base: u16 = std::env::var("BLOOM_RUNTIME_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(9000);
        let offset: u16 = std::env::var("BLOOM_PORT_OFFSET")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let port = base + offset;

        let package_path = std::env::var("BLOOM_RUNTIME_PACKAGE")
            .unwrap_or_else(|_| "runtime/server/demo/demo.pkg".to_string())
            .into();
        let audit_path = std::env::var("BLOOM_RUNTIME_AUDIT")
            .unwrap_or_else(|_| "runtime/server/var/audit.jsonl".to_string())
            .into();

        ServerConfig {
            package_path,
            audit_path,
            bind_addr: SocketAddr::from(([0, 0, 0, 0], port)),
        }
    }
}
```

Create `runtime/server/src/routes.rs`:

```rust
//! axum handlers. Thin orchestration over the AppState seams.

use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use std::sync::Arc;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub package_id: String,
    pub package_version: u32,
    pub mechanic: String,
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        package_id: state.package.envelope.package_id.clone(),
        package_version: state.package.envelope.package_version,
        mechanic: state.package.envelope.mechanic.clone(),
    })
}
```

Create `runtime/server/src/lib.rs`:

```rust
//! `bloom-runtime-server` — the authoritative, zero-AI, audited game server.
//! See docs/superpowers/specs/2026-06-28-runtime-server-spin-service-design.md.

pub mod config;
pub mod routes;
pub mod state;

use axum::routing::get;
use axum::Router;
use std::sync::Arc;

pub fn build_app(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health))
        .with_state(state)
}
```

Create `runtime/server/src/main.rs`:

```rust
//! Binary entrypoint: load+verify the package, build state, serve.

use bloom_runtime_server::config::ServerConfig;
use bloom_runtime_server::{build_app, state::AppState};
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let config = ServerConfig::from_env();
    let state = Arc::new(
        AppState::load(&config).expect("failed to load/verify the game package at boot"),
    );
    let app = build_app(state);
    let listener = TcpListener::bind(config.bind_addr)
        .await
        .expect("failed to bind runtime/server port");
    println!("runtime/server listening on {}", config.bind_addr);
    axum::serve(listener, app)
        .await
        .expect("server error");
}
```

- [ ] **Step 6: Add `AppState::load` to `state.rs`**

Add to the `impl AppState` block in `state.rs`:

```rust
    /// Load the package file named by `config`, verify + decode it.
    pub fn load(config: &crate::config::ServerConfig) -> Result<AppState, StartupError> {
        let bytes = std::fs::read(&config.package_path).map_err(StartupError::Io)?;
        AppState::from_package_bytes(&bytes)
    }
```

- [ ] **Step 7: Write the failing `/health` handler test (routes.rs)**

Add to `routes.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_app;
    use bloom_math::mechanics::slots::{
        to_payload, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
    };
    use bloom_package::{build, Envelope, PackageContent};
    use ed25519_dalek::SigningKey;
    use tower::ServiceExt; // for `oneshot`

    fn test_state() -> Arc<AppState> {
        let model = SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }],
            },
            bonuses: vec![],
        };
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-health".into(),
                package_version: 7,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&model),
            seeds: vec![1, 2, 3],
            presentation: Vec::new(),
        };
        let bytes = build(&content, &SigningKey::from_bytes(&[7u8; 32]));
        Arc::new(AppState::from_package_bytes(&bytes).unwrap())
    }

    #[tokio::test]
    async fn health_reports_loaded_package() {
        let app = build_app(test_state());
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["package_id"], "pkg-health");
        assert_eq!(v["package_version"], 7);
    }
}
```

- [ ] **Step 8: Run all crate tests to verify they pass**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — `state::tests` (3) and `routes::tests::health_reports_loaded_package` (1) all green.

- [ ] **Step 9: Verify the binary compiles and the workspace builds**

Run: `cargo build -p bloom-runtime-server`
Expected: builds with no errors.

- [ ] **Step 10: Commit**

```bash
git add Cargo.toml runtime/server/
git commit -m "feat(runtime): scaffold runtime/server, boot on verified package + /health"
```

---

### Task 2: Draw seam — uniform CSPRNG index

Adds the `Draw` trait + the OS-CSPRNG impl and a fixed test impl, and wires `draw` into `AppState`.

**Files:**
- Create: `runtime/server/src/draw.rs`
- Modify: `runtime/server/src/lib.rs` (add `pub mod draw;`)
- Modify: `runtime/server/src/state.rs` (add `draw` field; widen `from_package_bytes` / `load`)
- Test: inline `#[cfg(test)]` in `draw.rs`; update `state.rs` + `routes.rs` test constructors

**Interfaces:**
- Produces:
  - `draw::Draw` — `pub trait Draw: Send + Sync { fn index(&self, pool_size: usize) -> usize; }`
  - `draw::OsRngDraw` (unit struct) implementing `Draw` via `rand`.
  - `draw::FixedDraw { index: usize }` (test helper, `#[cfg(test)]`-agnostic — make it public for reuse in `routes.rs` tests) implementing `Draw`.
- Consumes: `state::AppState` gains `pub draw: Box<dyn Draw>`.

- [ ] **Step 1: Write the failing draw tests**

Create `runtime/server/src/draw.rs`:

```rust
//! The index-draw seam. The runtime RNG's ONLY job is to pick an index into the
//! curated seed pool (architecture §4). SP1 uses the OS CSPRNG; the
//! certification-appropriate CSPRNG choice (§18) can be swapped behind this seam.

use rand::Rng;

pub trait Draw: Send + Sync {
    /// Return a uniform index in `[0, pool_size)`. `pool_size` must be > 0.
    fn index(&self, pool_size: usize) -> usize;
}

/// Production draw: OS-backed CSPRNG (`getrandom` via `rand`).
pub struct OsRngDraw;

impl Draw for OsRngDraw {
    fn index(&self, pool_size: usize) -> usize {
        rand::thread_rng().gen_range(0..pool_size)
    }
}

/// Deterministic draw for tests: always returns `index` (clamped into range).
pub struct FixedDraw {
    pub index: usize,
}

impl Draw for FixedDraw {
    fn index(&self, pool_size: usize) -> usize {
        self.index % pool_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_draw_is_always_in_range() {
        let d = OsRngDraw;
        for _ in 0..10_000 {
            let i = d.index(7);
            assert!(i < 7);
        }
    }

    #[test]
    fn os_draw_covers_the_whole_range() {
        // With 10k draws over a 7-slot pool, every index should appear.
        let d = OsRngDraw;
        let mut seen = [false; 7];
        for _ in 0..10_000 {
            seen[d.index(7)] = true;
        }
        assert!(seen.iter().all(|&s| s), "every index must be reachable");
    }

    #[test]
    fn fixed_draw_returns_configured_index() {
        let d = FixedDraw { index: 3 };
        assert_eq!(d.index(5), 3);
        assert_eq!(d.index(2), 1); // wraps via modulo
    }
}
```

- [ ] **Step 2: Run the draw tests to verify they fail**

Run: `cargo test -p bloom-runtime-server draw::`
Expected: FAIL — `draw` module not declared in `lib.rs` yet (compile error).

- [ ] **Step 3: Declare the module and widen `AppState`**

Modify `runtime/server/src/lib.rs` — add `pub mod draw;` to the module list.

Modify `runtime/server/src/state.rs`:

Add the import near the top:

```rust
use crate::draw::Draw;
```

Change the struct to include the seam:

```rust
pub struct AppState {
    pub package: PackageContent,
    pub model: SlotModel,
    pub draw: Box<dyn Draw>,
}
```

Widen the constructor:

```rust
    pub fn from_package_bytes(
        bytes: &[u8],
        draw: Box<dyn Draw>,
    ) -> Result<AppState, StartupError> {
        let package =
            verify_and_load(bytes, &dev_verifying_key()).map_err(StartupError::BadPackage)?;
        let model = from_payload(&package.math_payload).map_err(StartupError::BadPayload)?;
        Ok(AppState { package, model, draw })
    }
```

Widen `load` to supply the production draw:

```rust
    pub fn load(config: &crate::config::ServerConfig) -> Result<AppState, StartupError> {
        let bytes = std::fs::read(&config.package_path).map_err(StartupError::Io)?;
        AppState::from_package_bytes(&bytes, Box::new(crate::draw::OsRngDraw))
    }
```

- [ ] **Step 4: Update the existing test constructors to pass a draw**

In `state.rs` tests, update the three call sites:
- `loads_and_decodes_a_valid_package`: `AppState::from_package_bytes(&good_package_bytes(), Box::new(crate::draw::OsRngDraw))`
- `rejects_a_tampered_package`: `AppState::from_package_bytes(&bytes, Box::new(crate::draw::OsRngDraw))`
- `rejects_a_wrong_key_package`: `AppState::from_package_bytes(&content_bytes, Box::new(crate::draw::OsRngDraw))`

In `routes.rs` `test_state()`, update the final line:

```rust
        Arc::new(AppState::from_package_bytes(&bytes, Box::new(crate::draw::FixedDraw { index: 0 })).unwrap())
```

- [ ] **Step 5: Run all crate tests to verify they pass**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — `draw::tests` (3) plus the previously-green state/routes tests.

- [ ] **Step 6: Commit**

```bash
git add runtime/server/
git commit -m "feat(runtime): add Draw seam (OS CSPRNG index) wired into AppState"
```

---

### Task 3: Audit seam — append-only JSONL record

Adds the `AuditRecord`, the `AuditSink` trait, the JSONL file impl, and an in-memory test impl; wires `audit` into `AppState`. Adds the additive `ENGINE_VERSION` constant to `bloom-math` so the audit record can name the engine that expanded the seed.

**Files:**
- Modify: `trusted/math/src/lib.rs` (add `pub const ENGINE_VERSION`)
- Create: `runtime/server/src/audit.rs`
- Modify: `runtime/server/src/lib.rs` (add `pub mod audit;`)
- Modify: `runtime/server/src/state.rs` (add `audit` field; widen constructor/`load`)
- Test: inline `#[cfg(test)]` in `audit.rs`; update `state.rs` + `routes.rs` test constructors

**Interfaces:**
- Produces:
  - `bloom_math::ENGINE_VERSION: &str` (the math crate version).
  - `audit::AuditRecord` — a serde struct (defined below); its `outcome` field uses `crate::wire::OutcomeWire`, which does not exist until Task 4. **Order note:** in Task 3 the `AuditRecord.outcome` field is typed as `serde_json::Value` (a placeholder); Task 5 retypes it to `wire::OutcomeWire`. The JSONL append/read tests in Task 3 use a `Value` outcome, so they survive the retype.
  - `audit::AuditSink` — `pub trait AuditSink: Send + Sync { fn append(&self, rec: &AuditRecord) -> std::io::Result<()>; }`
  - `audit::JsonlAuditSink { path: PathBuf }` with `JsonlAuditSink::new(path: impl Into<PathBuf>) -> Self`.
  - `audit::MemoryAuditSink` (test helper, public) collecting records in a `Mutex<Vec<AuditRecord>>`, with `fn records(&self) -> Vec<AuditRecord>`.
- Consumes: `state::AppState` gains `pub audit: Box<dyn AuditSink>`.

- [ ] **Step 1: Add the additive engine-version constant to `bloom-math`**

Modify `trusted/math/src/lib.rs` — append (this is purely additive provenance, not a mechanic/behavior change, so not a re-certification event):

```rust
/// The math-engine crate version, recorded in each runtime audit record so a
/// round names the exact engine that expanded its seed (architecture §9).
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
```

- [ ] **Step 2: Write the failing audit tests**

Create `runtime/server/src/audit.rs`:

```rust
//! The append-only audit seam (architecture §9). Each served round appends one
//! record naming the package, the seed drawn, the engine version, the bet, a
//! timestamp, and the outcome — so any historical round is bit-reproducible.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditRecord {
    pub package_id: String,
    pub package_version: u32,
    pub mechanic: String,
    pub math_engine_version: String,
    pub seed: u64,
    pub bet: u64,
    pub timestamp_ms: u128,
    /// The served outcome. Typed as `serde_json::Value` in Task 3; retyped to
    /// `crate::wire::OutcomeWire` in Task 5.
    pub outcome: serde_json::Value,
}

pub trait AuditSink: Send + Sync {
    fn append(&self, rec: &AuditRecord) -> std::io::Result<()>;
}

/// Durable append-only sink: one JSON line per record. Opens the file in append
/// mode per write (create-if-missing) so the sink is cheap to share and never
/// truncates.
pub struct JsonlAuditSink {
    path: PathBuf,
}

impl JsonlAuditSink {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        JsonlAuditSink { path: path.into() }
    }
}

impl AuditSink for JsonlAuditSink {
    fn append(&self, rec: &AuditRecord) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut line = serde_json::to_string(rec).map_err(std::io::Error::other)?;
        line.push('\n');
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        f.write_all(line.as_bytes())
    }
}

/// In-memory sink for tests.
pub struct MemoryAuditSink {
    records: Mutex<Vec<AuditRecord>>,
}

impl MemoryAuditSink {
    pub fn new() -> Self {
        MemoryAuditSink { records: Mutex::new(Vec::new()) }
    }
    pub fn records(&self) -> Vec<AuditRecord> {
        self.records.lock().unwrap().clone()
    }
}

impl AuditSink for MemoryAuditSink {
    fn append(&self, rec: &AuditRecord) -> std::io::Result<()> {
        self.records.lock().unwrap().push(rec.clone());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(seed: u64) -> AuditRecord {
        AuditRecord {
            package_id: "pkg".into(),
            package_version: 1,
            mechanic: "slots@1".into(),
            math_engine_version: "0.0.0".into(),
            seed,
            bet: 1,
            timestamp_ms: 123,
            outcome: serde_json::json!({"total_payout": 0}),
        }
    }

    #[test]
    fn jsonl_sink_appends_one_line_per_record() {
        let dir = std::env::temp_dir().join(format!("bloom-audit-{}", std::process::id()));
        let path = dir.join("audit.jsonl");
        let _ = std::fs::remove_file(&path);
        let sink = JsonlAuditSink::new(&path);

        sink.append(&sample(10)).unwrap();
        sink.append(&sample(20)).unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);

        let r0: AuditRecord = serde_json::from_str(lines[0]).unwrap();
        let r1: AuditRecord = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(r0.seed, 10);
        assert_eq!(r1.seed, 20);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn memory_sink_collects_records() {
        let sink = MemoryAuditSink::new();
        sink.append(&sample(1)).unwrap();
        sink.append(&sample(2)).unwrap();
        let recs = sink.records();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[1].seed, 2);
    }
}
```

> Note: `std::io::Error::other` is stable since Rust 1.74. If the toolchain is older, substitute `std::io::Error::new(std::io::ErrorKind::Other, e)`.

- [ ] **Step 3: Run the audit tests to verify they fail**

Run: `cargo test -p bloom-runtime-server audit::`
Expected: FAIL — `audit` module not declared in `lib.rs` (compile error).

- [ ] **Step 4: Declare the module and widen `AppState`**

Modify `runtime/server/src/lib.rs` — add `pub mod audit;`.

Modify `runtime/server/src/state.rs`:

Add the import:

```rust
use crate::audit::AuditSink;
```

Extend the struct + constructor:

```rust
pub struct AppState {
    pub package: PackageContent,
    pub model: SlotModel,
    pub draw: Box<dyn Draw>,
    pub audit: Box<dyn AuditSink>,
}

impl AppState {
    pub fn from_package_bytes(
        bytes: &[u8],
        draw: Box<dyn Draw>,
        audit: Box<dyn AuditSink>,
    ) -> Result<AppState, StartupError> {
        let package =
            verify_and_load(bytes, &dev_verifying_key()).map_err(StartupError::BadPackage)?;
        let model = from_payload(&package.math_payload).map_err(StartupError::BadPayload)?;
        Ok(AppState { package, model, draw, audit })
    }

    pub fn load(config: &crate::config::ServerConfig) -> Result<AppState, StartupError> {
        let bytes = std::fs::read(&config.package_path).map_err(StartupError::Io)?;
        AppState::from_package_bytes(
            &bytes,
            Box::new(crate::draw::OsRngDraw),
            Box::new(crate::audit::JsonlAuditSink::new(config.audit_path.clone())),
        )
    }
}
```

- [ ] **Step 5: Update existing test constructors to pass an audit sink**

In `state.rs` tests, add a `MemoryAuditSink` to each `from_package_bytes` call, e.g.:

```rust
AppState::from_package_bytes(
    &good_package_bytes(),
    Box::new(crate::draw::OsRngDraw),
    Box::new(crate::audit::MemoryAuditSink::new()),
)
```

Apply the same third argument to the `rejects_a_tampered_package` and `rejects_a_wrong_key_package` call sites.

In `routes.rs` `test_state()`:

```rust
Arc::new(
    AppState::from_package_bytes(
        &bytes,
        Box::new(crate::draw::FixedDraw { index: 0 }),
        Box::new(crate::audit::MemoryAuditSink::new()),
    )
    .unwrap(),
)
```

- [ ] **Step 6: Run all crate tests + the math crate to verify they pass**

Run: `cargo test -p bloom-runtime-server -p bloom-math`
Expected: PASS — audit (2), draw (3), state (3), routes (1), and all existing `bloom-math` tests still green.

- [ ] **Step 7: Commit**

```bash
git add trusted/math/src/lib.rs runtime/server/
git commit -m "feat(runtime): add append-only JSONL audit seam + bloom-math ENGINE_VERSION"
```

---

### Task 4: Wire DTOs — the mechanic-tagged outcome contract

Defines the server-owned outcome wire type (one `slots@1` arm), the `RoundOutcome` → wire mapping, and the handshake/spin response DTOs. Keeps `trusted/math` untouched (no serde on `RoundOutcome`).

**Files:**
- Create: `runtime/server/src/wire.rs`
- Modify: `runtime/server/src/lib.rs` (add `pub mod wire;`)
- Test: inline `#[cfg(test)]` in `wire.rs`

**Interfaces:**
- Produces:
  - `wire::SlotsOutcomeWire`, `wire::FeatureWire` (serde structs).
  - `wire::OutcomeWire` — mechanic-tagged enum, one variant `Slots`, tagged `"slots@1"`.
  - `wire::OutcomeWire::from_round(o: &bloom_math::mechanics::slots::RoundOutcome) -> OutcomeWire`.
  - `wire::SpinResponse { seed: u64, bet: u64, outcome: OutcomeWire }`.
  - `wire::HandshakeResponse { package_id: String, package_version: u32, mechanic: String, presentation: serde_json::Value }`.

- [ ] **Step 1: Write the failing wire-mapping tests**

Create `runtime/server/src/wire.rs`:

```rust
//! The server -> client outcome contract (architecture §7): a tagged union keyed
//! by mechanic, one arm today (`slots@1`). `trusted/math`'s `RoundOutcome` stays a
//! pure (non-serde) certified type; we map it here.

use bloom_math::mechanics::slots::{FeatureOutcome, RoundOutcome, Symbol};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeatureWire {
    pub triggered: bool,
    pub spins_played: u32,
    pub payout: u64,
    pub spins: Vec<Vec<Vec<Symbol>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlotsOutcomeWire {
    pub base_grid: Vec<Vec<Symbol>>,
    pub base_payout: u64,
    pub feature_payout: u64,
    pub total_payout: u64,
    pub features: Vec<FeatureWire>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mechanic")]
pub enum OutcomeWire {
    #[serde(rename = "slots@1")]
    Slots(SlotsOutcomeWire),
}

impl OutcomeWire {
    pub fn from_round(o: &RoundOutcome) -> OutcomeWire {
        OutcomeWire::Slots(SlotsOutcomeWire {
            base_grid: o.base_grid.clone(),
            base_payout: o.base_payout,
            feature_payout: o.feature_payout,
            total_payout: o.total_payout,
            features: o.features.iter().map(feature_wire).collect(),
        })
    }
}

fn feature_wire(f: &FeatureOutcome) -> FeatureWire {
    FeatureWire {
        triggered: f.triggered,
        spins_played: f.spins_played,
        payout: f.payout,
        spins: f.spins.clone(),
    }
}

#[derive(Debug, Serialize)]
pub struct SpinResponse {
    pub seed: u64,
    pub bet: u64,
    pub outcome: OutcomeWire,
}

#[derive(Debug, Serialize)]
pub struct HandshakeResponse {
    pub package_id: String,
    pub package_version: u32,
    pub mechanic: String,
    pub presentation: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{
        evaluate, BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, SymbolDef,
        SymbolRole, TriggerSpec,
    };

    fn model_with_feature() -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 9, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![0, 9, 0, 0, 0], vec![0, 0, 9, 0, 0], vec![9, 0, 0, 9, 0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 0, count: 3, payout: 5 },
                    PaytableEntry { symbol: 9, count: 3, payout: 8 },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec { symbol: 9, min_count: 3 },
                config: FreeSpinsConfig {
                    spins_awarded: 3,
                    retrigger: false,
                    multiplier: 2,
                    feature_reels: None,
                },
            }],
        }
    }

    #[test]
    fn maps_round_outcome_faithfully() {
        let m = model_with_feature();
        let o = evaluate(&m, 53); // a seed known to trigger in bloom-math goldens
        let wire = OutcomeWire::from_round(&o);
        let OutcomeWire::Slots(s) = &wire;
        assert_eq!(s.base_grid, o.base_grid);
        assert_eq!(s.total_payout, o.total_payout);
        assert_eq!(s.features.len(), o.features.len());
    }

    #[test]
    fn serializes_with_mechanic_tag_and_round_trips() {
        let m = model_with_feature();
        let wire = OutcomeWire::from_round(&evaluate(&m, 53));
        let json = serde_json::to_value(&wire).unwrap();
        assert_eq!(json["mechanic"], "slots@1");
        let back: OutcomeWire = serde_json::from_value(json).unwrap();
        assert_eq!(back, wire);
    }
}
```

- [ ] **Step 2: Run the wire tests to verify they fail**

Run: `cargo test -p bloom-runtime-server wire::`
Expected: FAIL — `wire` module not declared in `lib.rs`.

- [ ] **Step 3: Declare the module**

Modify `runtime/server/src/lib.rs` — add `pub mod wire;`.

- [ ] **Step 4: Run the wire tests to verify they pass**

Run: `cargo test -p bloom-runtime-server wire::`
Expected: PASS — both wire tests green.

- [ ] **Step 5: Commit**

```bash
git add runtime/server/
git commit -m "feat(runtime): add mechanic-tagged outcome wire contract + DTOs"
```

---

### Task 5: `POST /spin` — the authoritative round

Wires draw → evaluate → audit → response, returning the mechanic-tagged outcome. Retypes the audit record's `outcome` to `OutcomeWire`. Proves the round is authoritative AND reproducible.

**Files:**
- Modify: `runtime/server/src/audit.rs` (retype `AuditRecord.outcome` to `wire::OutcomeWire`; fix the sample in its tests)
- Modify: `runtime/server/src/routes.rs` (add the `spin` handler + request type)
- Modify: `runtime/server/src/lib.rs` (route `POST /spin`)
- Test: inline `#[cfg(test)]` in `routes.rs`

**Interfaces:**
- Consumes: `state::AppState` (`draw`, `package.seeds`, `model`, `audit`), `wire::{OutcomeWire, SpinResponse}`, `bloom_math::mechanics::slots::evaluate`, `bloom_math::ENGINE_VERSION`.
- Produces: `routes::spin` handler; `routes::SpinRequest { bet: u64 }` (serde, default bet = 1).

- [ ] **Step 1: Retype the audit outcome field**

Modify `runtime/server/src/audit.rs`:

- Change the field type:

```rust
    /// The served outcome (mechanic-tagged).
    pub outcome: crate::wire::OutcomeWire,
```

- Update the `sample` helper in `audit.rs` tests to build a real outcome:

```rust
    fn sample(seed: u64) -> AuditRecord {
        use bloom_math::mechanics::slots::{
            evaluate, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
        };
        let model = SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }],
            },
            bonuses: vec![],
        };
        AuditRecord {
            package_id: "pkg".into(),
            package_version: 1,
            mechanic: "slots@1".into(),
            math_engine_version: "0.0.0".into(),
            seed,
            bet: 1,
            timestamp_ms: 123,
            outcome: crate::wire::OutcomeWire::from_round(&evaluate(&model, seed)),
        }
    }
```

- [ ] **Step 2: Write the failing `/spin` handler tests**

Add to `runtime/server/src/routes.rs` test module (extend the existing `tests` mod). First add a helper that builds state with a known multi-seed pool and a `MemoryAuditSink` we can inspect — make `test_state` return both:

```rust
    use crate::audit::MemoryAuditSink;
    use crate::draw::FixedDraw;
    use crate::wire::OutcomeWire;
    use bloom_math::mechanics::slots::evaluate;
    use std::sync::Arc;

    /// Build state whose pool has 5 distinct seeds, a FixedDraw at `idx`, and a
    /// shared MemoryAuditSink returned alongside so the test can read records.
    fn spin_state(idx: usize) -> (Arc<AppState>, Arc<MemoryAuditSink>) {
        let model = SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0, 0, 0, 0, 1], vec![0, 0, 1, 0, 0], vec![1, 0, 0, 0, 0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }],
            },
            bonuses: vec![],
        };
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-spin".into(),
                package_version: 1,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&model),
            seeds: vec![11, 22, 33, 44, 55],
            presentation: Vec::new(),
        };
        let bytes = build(&content, &SigningKey::from_bytes(&[7u8; 32]));
        let audit = Arc::new(MemoryAuditSink::new());
        // AppState needs to OWN its audit sink, but the test also needs a handle.
        // Use a thin forwarding sink that shares the Arc.
        struct Shared(Arc<MemoryAuditSink>);
        impl crate::audit::AuditSink for Shared {
            fn append(&self, rec: &crate::audit::AuditRecord) -> std::io::Result<()> {
                self.0.append(rec)
            }
        }
        let state = AppState::from_package_bytes(
            &bytes,
            Box::new(FixedDraw { index: idx }),
            Box::new(Shared(audit.clone())),
        )
        .unwrap();
        (Arc::new(state), audit)
    }

    async fn post_spin(app: axum::Router, body: &str) -> (axum::http::StatusCode, serde_json::Value) {
        let req = axum::http::Request::builder()
            .method("POST")
            .uri("/spin")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, v)
    }

    #[tokio::test]
    async fn spin_returns_authoritative_reproducible_outcome() {
        let (state, _audit) = spin_state(2); // draws seeds[2] == 33
        let model = state.model.clone();
        let app = build_app(state);
        let (status, v) = post_spin(app, "{}").await;
        assert_eq!(status, 200);
        assert_eq!(v["seed"], 33);
        // The served outcome must equal re-evaluating the returned seed.
        let expected = serde_json::to_value(OutcomeWire::from_round(&evaluate(&model, 33))).unwrap();
        assert_eq!(v["outcome"], expected);
    }

    #[tokio::test]
    async fn spin_appends_one_audit_record_that_reproduces() {
        let (state, audit) = spin_state(0); // seeds[0] == 11
        let model = state.model.clone();
        let app = build_app(state);
        let (status, _v) = post_spin(app, "{}").await;
        assert_eq!(status, 200);
        let recs = audit.records();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].seed, 11);
        assert_eq!(recs[0].bet, 1);
        // Re-expand the recorded seed; the audit outcome must match (reproducible).
        assert_eq!(recs[0].outcome, OutcomeWire::from_round(&evaluate(&model, 11)));
    }

    #[tokio::test]
    async fn spin_defaults_bet_to_one_and_honors_supplied_bet() {
        let (state_a, audit_a) = spin_state(0);
        let app_a = build_app(state_a);
        let (s_a, _) = post_spin(app_a, "").await; // empty body -> bet 1
        assert_eq!(s_a, 200);
        assert_eq!(audit_a.records()[0].bet, 1);

        let (state_b, audit_b) = spin_state(0);
        let app_b = build_app(state_b);
        let (s_b, v_b) = post_spin(app_b, "{\"bet\":5}").await;
        assert_eq!(s_b, 200);
        assert_eq!(v_b["bet"], 5);
        assert_eq!(audit_b.records()[0].bet, 5);
    }
```

- [ ] **Step 3: Run the spin tests to verify they fail**

Run: `cargo test -p bloom-runtime-server routes::tests::spin`
Expected: FAIL — `spin` handler and route don't exist; compile error on `SpinRequest`.

- [ ] **Step 4: Implement the `spin` handler**

Add to `runtime/server/src/routes.rs` (top-level, not in tests):

```rust
use crate::wire::{OutcomeWire, SpinResponse};
use axum::http::StatusCode;
use bloom_math::mechanics::slots::evaluate;
use serde::Deserialize;

fn default_bet() -> u64 {
    1
}

#[derive(Deserialize)]
pub struct SpinRequest {
    #[serde(default = "default_bet")]
    pub bet: u64,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The authoritative round: draw an index, expand the seed, audit, respond.
/// A round that cannot be audited is NOT served (500) — every served round is
/// recorded (architecture §9).
pub async fn spin(
    State(state): State<Arc<AppState>>,
    body: Option<Json<SpinRequest>>,
) -> Result<Json<SpinResponse>, StatusCode> {
    let bet = body.map(|Json(b)| b.bet).unwrap_or(1);

    let idx = state.draw.index(state.package.seeds.len());
    let seed = state.package.seeds[idx];
    let outcome = OutcomeWire::from_round(&evaluate(&state.model, seed));

    let record = crate::audit::AuditRecord {
        package_id: state.package.envelope.package_id.clone(),
        package_version: state.package.envelope.package_version,
        mechanic: state.package.envelope.mechanic.clone(),
        math_engine_version: bloom_math::ENGINE_VERSION.to_string(),
        seed,
        bet,
        timestamp_ms: now_ms(),
        outcome: outcome.clone(),
    };
    state
        .audit
        .append(&record)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SpinResponse { seed, bet, outcome }))
}
```

- [ ] **Step 5: Route `POST /spin`**

Modify `runtime/server/src/lib.rs` `build_app`:

```rust
use axum::routing::post;

pub fn build_app(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health))
        .route("/spin", post(routes::spin))
        .with_state(state)
}
```

- [ ] **Step 6: Run all crate tests to verify they pass**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — the three `/spin` tests plus all prior tests green.

- [ ] **Step 7: Commit**

```bash
git add runtime/server/
git commit -m "feat(runtime): POST /spin — authoritative, audited, reproducible round"
```

---

### Task 6: `GET /handshake` — hand the client presentation

Returns the package's presentation bytes (parsed as JSON) plus the envelope, so the client can render. No client wiring.

**Files:**
- Modify: `runtime/server/src/routes.rs` (add `handshake` handler)
- Modify: `runtime/server/src/lib.rs` (route `GET /handshake`)
- Test: inline `#[cfg(test)]` in `routes.rs`

**Interfaces:**
- Consumes: `state::AppState` (`package.presentation`, `package.envelope`), `wire::HandshakeResponse`.
- Produces: `routes::handshake` handler.

- [ ] **Step 1: Write the failing handshake tests**

Add to `routes.rs` tests. First a helper to build state carrying a presentation manifest:

```rust
    fn state_with_presentation(presentation: &[u8]) -> Arc<AppState> {
        let model = SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }],
            },
            bonuses: vec![],
        };
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-hs".into(),
                package_version: 2,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&model),
            seeds: vec![1, 2, 3],
            presentation: presentation.to_vec(),
        };
        let bytes = build(&content, &SigningKey::from_bytes(&[7u8; 32]));
        Arc::new(
            AppState::from_package_bytes(
                &bytes,
                Box::new(crate::draw::FixedDraw { index: 0 }),
                Box::new(crate::audit::MemoryAuditSink::new()),
            )
            .unwrap(),
        )
    }

    async fn get_json(app: axum::Router, uri: &str) -> (axum::http::StatusCode, serde_json::Value) {
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(uri)
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn handshake_returns_envelope_and_parsed_presentation() {
        let manifest = br#"{"cols":3,"rows":3,"symbols":["0","1","2","9"]}"#;
        let app = build_app(state_with_presentation(manifest));
        let (status, v) = get_json(app, "/handshake").await;
        assert_eq!(status, 200);
        assert_eq!(v["package_id"], "pkg-hs");
        assert_eq!(v["package_version"], 2);
        assert_eq!(v["mechanic"], "slots@1");
        assert_eq!(v["presentation"]["cols"], 3);
        assert_eq!(v["presentation"]["symbols"][3], "9");
    }

    #[tokio::test]
    async fn handshake_empty_presentation_is_null() {
        let app = build_app(state_with_presentation(b""));
        let (status, v) = get_json(app, "/handshake").await;
        assert_eq!(status, 200);
        assert_eq!(v["presentation"], serde_json::Value::Null);
    }
```

- [ ] **Step 2: Run the handshake tests to verify they fail**

Run: `cargo test -p bloom-runtime-server routes::tests::handshake`
Expected: FAIL — `handshake` handler and route do not exist.

- [ ] **Step 3: Implement the `handshake` handler**

Add to `routes.rs` (top-level):

```rust
use crate::wire::HandshakeResponse;

/// Hand the untrusted client the package presentation (parsed as JSON; null if
/// empty or non-JSON) plus the envelope. SP1 demo packages carry a small JSON
/// manifest. Consuming this is SP2.
pub async fn handshake(State(state): State<Arc<AppState>>) -> Json<HandshakeResponse> {
    let presentation = serde_json::from_slice(&state.package.presentation)
        .unwrap_or(serde_json::Value::Null);
    Json(HandshakeResponse {
        package_id: state.package.envelope.package_id.clone(),
        package_version: state.package.envelope.package_version,
        mechanic: state.package.envelope.mechanic.clone(),
        presentation,
    })
}
```

- [ ] **Step 4: Route `GET /handshake`**

Modify `runtime/server/src/lib.rs` `build_app` — add `.route("/handshake", get(routes::handshake))`.

- [ ] **Step 5: Run all crate tests to verify they pass**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — handshake (2) plus all prior tests green.

- [ ] **Step 6: Commit**

```bash
git add runtime/server/
git commit -m "feat(runtime): GET /handshake — serve package presentation + envelope"
```

---

### Task 7: Curation accepts presentation bytes (studio/simulator)

The one change outside `runtime/`: let `curate` write a presentation manifest into the package. Backward compatible — omitting it yields today's empty presentation. Threads `presentation` through `run_curation_streamed` only (keeping `run_curation`'s signature and its callers unchanged), and switches the `curate` binary to the streamed path so it can pass presentation.

**Files:**
- Modify: `studio/simulator/src/run.rs` (`run_curation_streamed` gains `presentation: &[u8]`; `run_curation` passes `&[]`)
- Modify: `studio/simulator/src/bin/curate.rs` (accept optional `presentation.json`; call `run_curation_streamed`)
- Modify: `studio/simulator/src/bin/curate_json.rs` (pass `&[]` at its call site)
- Test: `studio/simulator/src/run.rs` (add a presentation round-trip test; update 2 existing streamed call sites)

**Interfaces:**
- Consumes (unchanged externally): `run_curation(model, target, master_seed, package_id, signing_key)`.
- Produces (changed): `run_curation_streamed(model, target, master_seed, package_id, presentation: &[u8], signing_key, on_progress)`.

- [ ] **Step 1: Write a failing test that presentation is carried into the package**

Add to `studio/simulator/src/run.rs` tests:

```rust
    #[test]
    fn presentation_bytes_are_carried_into_the_package() {
        let pres = br#"{"cols":1}"#;
        let s = run_curation_streamed(
            &measurable_model(),
            &target_09(),
            2026,
            "pkg-pres",
            pres,
            &key(),
            &mut |_| {},
        );
        let out = s.outcome.expect("passes");
        let content =
            bloom_package::verify_and_load(&out.package_bytes, &key().verifying_key()).unwrap();
        assert_eq!(content.presentation, pres.to_vec());
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p bloom-simulator presentation_bytes_are_carried`
Expected: FAIL — `run_curation_streamed` takes 6 args, not 7 (compile error).

- [ ] **Step 3: Thread `presentation` through `run_curation_streamed`**

Modify `studio/simulator/src/run.rs`:

- Change the signature (add `presentation: &[u8]` after `package_id`):

```rust
pub fn run_curation_streamed(
    model: &SlotModel,
    target: &TargetSpec,
    master_seed: u64,
    package_id: &str,
    presentation: &[u8],
    signing_key: &SigningKey,
    on_progress: &mut dyn FnMut(CurationProgress),
) -> StreamedOutcome {
```

- Change the `PackageContent` construction `presentation` field:

```rust
        presentation: presentation.to_vec(),
```

- Update `run_curation` to pass empty presentation:

```rust
pub fn run_curation(
    model: &SlotModel,
    target: &TargetSpec,
    master_seed: u64,
    package_id: &str,
    signing_key: &SigningKey,
) -> Result<CurationOutput, RunError> {
    run_curation_streamed(
        model,
        target,
        master_seed,
        package_id,
        &[],
        signing_key,
        &mut |_| {},
    )
    .outcome
}
```

- Update the two existing streamed call sites in `run.rs` tests (`streamed_matches_run_curation_on_pass` and `streamed_reports_metrics_even_on_verify_fail`) to insert `&[]` before `&key()` / before the signing key argument. For example:

```rust
        let s = run_curation_streamed(
            &measurable_model(),
            &target_09(),
            2026,
            "pkg-test",
            &[],
            &key(),
            &mut |p| match p {
```

and

```rust
        let s = run_curation_streamed(
            &measurable_model(),
            &t,
            2026,
            "pkg-test",
            &[],
            &key(),
            &mut |_| {},
        );
```

- [ ] **Step 4: Update `curate_json.rs` call site**

Modify `studio/simulator/src/bin/curate_json.rs` at its `run_curation_streamed` call (line ~123): insert `&[]` as the new `presentation` argument, in the same position (after the `package_id` argument, before the signing key). Read the surrounding call to place it correctly; the streamed call there does not need a presentation (in-studio curation), so empty is correct.

- [ ] **Step 5: Switch `curate.rs` to the streamed path with optional presentation**

Modify `studio/simulator/src/bin/curate.rs`:

- Update the imports:

```rust
use bloom_simulator::run::run_curation_streamed;
```

- Update the usage string + arg handling to accept an OPTIONAL 6th arg (`presentation.json`):

```rust
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 && args.len() != 7 {
        eprintln!(
            "usage: curate <model.json> <target.json> <package_id> <out.pkg> <out.report.txt> [presentation.json]"
        );
        std::process::exit(2);
    }
```

- After `validate_target`, read the presentation (empty if not provided):

```rust
    let presentation: Vec<u8> = if args.len() == 7 {
        fs::read(&args[6]).expect("read presentation")
    } else {
        Vec::new()
    };
```

- Replace the `run_curation(...)` match with the streamed call:

```rust
    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only
    let streamed = run_curation_streamed(
        &model,
        &target,
        tj.master_seed,
        &args[3],
        &presentation,
        &signing_key,
        &mut |_| {},
    );
    match streamed.outcome {
        Ok(out) => {
            fs::write(&args[4], &out.package_bytes).expect("write package");
            fs::write(&args[5], &out.report).expect("write report");
            println!("{}", out.report);
            println!("wrote package -> {}\nwrote report  -> {}", args[4], args[5]);
        }
        Err(e) => {
            eprintln!("curation failed: {e:?}");
            std::process::exit(1);
        }
    }
```

- [ ] **Step 6: Run the simulator tests to verify they pass**

Run: `cargo test -p bloom-simulator`
Expected: PASS — the new presentation test plus all existing simulator tests green.

- [ ] **Step 7: Commit**

```bash
git add studio/simulator/
git commit -m "feat(simulator): curate accepts an optional presentation manifest"
```

---

### Task 8: Demo package + end-to-end boot + justfile recipe

Mints a demo `.pkg` (with a presentation manifest) via `curate`, adds a `just` recipe, and proves the real server boots on it and serves all three endpoints. Finalizes the binary path.

**Files:**
- Create: `runtime/server/demo/model.json`
- Create: `runtime/server/demo/target.json`
- Create: `runtime/server/demo/presentation.json`
- Create: `runtime/server/demo/.gitignore` (ignore the generated `demo.pkg` + report)
- Modify: `justfile` (add `runtime-demo-pkg` and `runtime-serve` recipes)
- Test: `runtime/server/tests/boot.rs` (integration test loading the minted demo package)

**Interfaces:**
- Consumes: the `curate` binary; `AppState::from_package_bytes`; `build_app`.
- Produces: `runtime/server/demo/demo.pkg` (generated, git-ignored); `just runtime-demo-pkg`, `just runtime-serve`.

- [ ] **Step 1: Author the demo fixtures**

Create `runtime/server/demo/model.json` (3×3, no bonuses — matches an empty hit-rate-band target):

```json
{
  "symbols": [
    { "id": 0, "role": "normal" },
    { "id": 1, "role": "normal" },
    { "id": 2, "role": "normal" },
    { "id": 9, "role": "scatter" }
  ],
  "reels": [
    [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
    [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
    [0, 1, 2, 0, 1, 2, 9, 0, 1, 2]
  ],
  "rows": 3,
  "paylines": [[0, 0, 0], [1, 1, 1], [2, 2, 2]],
  "paytable": { "entries": [
    { "symbol": 0, "count": 3, "payout": 5 },
    { "symbol": 1, "count": 3, "payout": 3 },
    { "symbol": 2, "count": 3, "payout": 2 }
  ] },
  "bonuses": []
}
```

Create `runtime/server/demo/target.json` (deliberately lenient — this is a DEMO package, not a certified one; wide bands guarantee curation succeeds regardless of the model's measured RTP):

```json
{
  "rtp_target": 0.5,
  "rtp_tolerance": 1.0,
  "volatility_min": 0.0,
  "volatility_max": 1000000000.0,
  "bonus_hit_rate_bands": [],
  "pool_size": 1000,
  "candidate_count": 50000,
  "realized_correction_band": 1.0,
  "master_seed": 42
}
```

Create `runtime/server/demo/presentation.json`:

```json
{ "cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root" }
```

Create `runtime/server/demo/.gitignore`:

```
demo.pkg
demo.report.txt
```

- [ ] **Step 2: Add the justfile recipes**

Modify `justfile` — append:

```make
# Mint the runtime/server demo package (dev-signed) from its committed fixtures.
runtime-demo-pkg:
    cargo run --release -p bloom-simulator --bin curate -- \
      runtime/server/demo/model.json runtime/server/demo/target.json \
      bloom-demo-slots runtime/server/demo/demo.pkg runtime/server/demo/demo.report.txt \
      runtime/server/demo/presentation.json

# Run the authoritative runtime game server on the demo package.
runtime-serve: runtime-demo-pkg
    cargo run --release -p bloom-runtime-server
```

- [ ] **Step 3: Mint the demo package and confirm curation succeeds**

Run: `just runtime-demo-pkg`
Expected: prints a provenance report and `wrote package -> runtime/server/demo/demo.pkg`. If curation FAILS verify (it should not, given the lenient target), widen `rtp_tolerance` further — but with `rtp_tolerance = 1.0` any RTP in `[0, 1.5)` passes, which covers any honest slot model.

- [ ] **Step 4: Write the failing end-to-end boot test**

Create `runtime/server/tests/boot.rs`:

```rust
//! End-to-end: boot the real server on the minted demo package and exercise all
//! three endpoints through the router. Requires `just runtime-demo-pkg` to have
//! produced runtime/server/demo/demo.pkg first.

use bloom_runtime_server::build_app;
use bloom_runtime_server::state::AppState;
use std::sync::Arc;
use tower::ServiceExt;

fn demo_state() -> Arc<AppState> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/demo/demo.pkg");
    let bytes = std::fs::read(path)
        .unwrap_or_else(|_| panic!("run `just runtime-demo-pkg` first: missing {path}"));
    Arc::new(
        AppState::from_package_bytes(
            &bytes,
            Box::new(bloom_runtime_server::draw::OsRngDraw),
            Box::new(bloom_runtime_server::audit::MemoryAuditSink::new()),
        )
        .unwrap(),
    )
}

async fn get(app: axum::Router, uri: &str) -> serde_json::Value {
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .uri(uri)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn demo_package_boots_and_health_reports_it() {
    let v = get(build_app(demo_state()), "/health").await;
    assert_eq!(v["status"], "ok");
    assert_eq!(v["package_id"], "bloom-demo-slots");
}

#[tokio::test]
async fn demo_handshake_carries_the_presentation_manifest() {
    let v = get(build_app(demo_state()), "/handshake").await;
    assert_eq!(v["presentation"]["cols"], 3);
    assert_eq!(v["presentation"]["parentId"], "root");
}

#[tokio::test]
async fn demo_spin_returns_an_in_pool_outcome() {
    let app = build_app(demo_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/spin")
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v["seed"].is_u64());
    assert_eq!(v["outcome"]["mechanic"], "slots@1");
}
```

This test needs the modules public. `draw`, `audit`, `state` are already `pub mod` in `lib.rs`. Confirm `OsRngDraw`, `MemoryAuditSink`, and `AppState::from_package_bytes` are `pub` (they are).

- [ ] **Step 5: Run the boot integration test to verify it passes**

Run: `cargo test -p bloom-runtime-server --test boot`
Expected: PASS — all three boot tests green (the demo package exists from Step 3).

- [ ] **Step 6: Smoke-test the real binary over HTTP (manual)**

Run (in the worktree, port = 9000 + offset; this worktree's offset is 1 → 9001):

```bash
just runtime-serve
```

In another shell:

```bash
curl -s http://localhost:9001/health
curl -s -X POST http://localhost:9001/spin -H 'content-type: application/json' -d '{}'
curl -s http://localhost:9001/handshake
```

Expected: `/health` shows `bloom-demo-slots`; `/spin` returns a `seed` + `outcome` with `"mechanic":"slots@1"`; `/handshake` returns the manifest. Confirm `runtime/server/var/audit.jsonl` gained a line per spin. Stop the server (Ctrl-C).

- [ ] **Step 7: Commit**

```bash
git add runtime/server/demo/ runtime/server/tests/ justfile
git commit -m "feat(runtime): demo package, just recipes, end-to-end boot test"
```

---

### Task 9: Final whole-crate verification + workspace gates

A dedicated verification task — no new behavior, but the reviewer gate that the whole workspace is green and formatted before the branch is offered for merge.

**Files:** none (verification only).

- [ ] **Step 1: Format check (Rust)**

Run: `cargo fmt --all -- --check`
Expected: no diff. If it reports formatting, run `cargo fmt --all` and commit the result (`style(runtime): cargo fmt`). (Per memory: `cargo fmt --check` is a CI gate — run it locally, not just `cargo test`.)

- [ ] **Step 2: Clippy (Rust lint)**

Run: `cargo clippy -p bloom-runtime-server -p bloom-simulator -p bloom-math --all-targets`
Expected: no warnings. Fix any and commit.

- [ ] **Step 3: Whole-workspace test**

Run: `cargo test --workspace`
Expected: PASS — every crate green (runtime/server, simulator, math, package, tuner).

- [ ] **Step 4: Confirm the binary builds in release**

Run: `cargo build --release -p bloom-runtime-server`
Expected: builds clean.

- [ ] **Step 5: Commit any fmt/clippy fixes (if not already)**

```bash
git add -A
git commit -m "style(runtime): satisfy fmt + clippy gates" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- §3 crate/module structure → Tasks 1–6 create exactly the modules in the spec tree. ✓
- §3.1 `config`/`state`/`draw`/`audit`/`wire`/`routes`/`main`/`lib` responsibilities → Tasks 1 (config/state/routes/lib/main), 2 (draw), 3 (audit), 4 (wire), 5–6 (routes). ✓
- §4 `POST /spin`, `GET /handshake`, `GET /health` → Tasks 5, 6, 1. ✓
- §4 bet default 1, recorded not debited → Task 5 `spin_defaults_bet_to_one_and_honors_supplied_bet`. ✓
- §5 demo package via curate → Task 8. ✓
- §6 determinism (same compiled engine) + reproducible rounds → Task 5 reproducibility tests; native `evaluate` call (no subprocess). ✓
- §6 append-only → Task 3 JSONL append + Task 5 "not served if not audited" (500). ✓
- §7 presentation manifest + curate change → Tasks 7 (curate) + 8 (manifest). ✓
- §8 all unit + handler tests are cargo (CI-affordable, non-browser) → every task. ✓
- §9 deferred seams (dev key, no operator edge, no economics, no SP2 wiring, no studio repoint, CSPRNG/audit backend behind seams, one mechanic) → embedded dev key (Task 1), `Draw`/`AuditSink` traits (Tasks 2–3), single `OutcomeWire::Slots` arm (Task 4); nothing builds the deferred items. ✓
- Dependency rule (only `trusted/`) → Task 1 manifest depends solely on `bloom-math`/`bloom-package` (+ infra crates). ✓

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N" — every code step shows full code. The one cross-task ordering note (audit `outcome` typed `Value` in Task 3, retyped in Task 5) is explicit with the exact retype in Task 5 Step 1. ✓

**Type consistency:**
- `AppState::from_package_bytes` arity grows deliberately across Tasks 1→2→3; each widening task updates ALL call sites (state tests, routes `test_state`). Final arity (bytes, draw, audit) is consistent in Tasks 5/6/8. ✓
- `Draw::index(&self, pool_size: usize) -> usize`, `AuditSink::append(&self, &AuditRecord) -> io::Result<()>`, `OutcomeWire::from_round`, `SpinResponse`/`HandshakeResponse`/`SpinRequest` names are used identically wherever referenced. ✓
- `run_curation_streamed` new arg position (`presentation` after `package_id`, before `signing_key`) is applied identically in run.rs, curate.rs, curate_json.rs, and both streamed test call sites. ✓
- `bloom_math::ENGINE_VERSION` defined in Task 3 Step 1, consumed in Task 5 Step 4. ✓

No issues outstanding.
