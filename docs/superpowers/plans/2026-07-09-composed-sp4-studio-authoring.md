# Composed SP4 — Studio Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A studio pane plugin (`game-structure`) that authors a `composed@1` GameDefinition per game (Mongo `game_definitions` doc), validates it through the Rust kernel, builds a signed playable `.pkg` with informational metrics, and plays it via a runtime-server package-directory mode.

**Architecture:** Pattern-clone of the `game-config` plugin (hookstate slice, debounced PUT, `game_definition_changed` socket watermark rehydrate) over a new small `app/compose` backend module (store + REST + subprocess runner). A new `compose_json` Rust bin (mirrors `curate_json`) is the single validator/builder/metrics engine. The runtime server gains `BLOOM_RUNTIME_PACKAGES=<dir>` lazy-load mode with `?package=<id>` selection.

**Tech Stack:** Rust (bloom-simulator, bloom-runtime-server, axum), FastAPI + Motor + python-socketio, React + Hookstate + Dockview, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-09-composed-sp4-studio-authoring-design.md` (approved). Read it before starting any task.

## Global Constraints

- Work in the worktree `C:\code\bloom.wt\composed-sp4` (branch `feat/composed-sp4`, `BLOOM_PORT_OFFSET=2` → backend :8002, studio frontend :4202, runtime client :4302, runtime server :9002). NEVER use ports :8000/:4200/:4300 — other sessions may own them. Run `just bootstrap` once if node_modules/.venv are missing.
- Semantic commits (`feat(compose): …`, `feat(runtime): …`, `feat(game-structure): …`, `test: …`); commit after every green task.
- TypeScript interfaces use the `I` prefix. No hex/rgb/hsl literals in `.ts`/`.tsx` (design-language guard test); use token utilities (`bg-surface`, `border-hairline`, `text-text-1/2/3`, `text-danger`, `bg-primary`…). One accent action per region.
- The GameDefinition JSON is the Rust serde wire shape: snake_case keys (`max_steps`, `min_count`, `count_symbol`, `reset_on_full`), `type` for mechanic kind, `override` for binding overrides. Doc-level wire fields are camelCase (`gameId`, `updatedAt`).
- Reducers and normalizers are PURE — never mutate input; return new objects.
- Rust: run `cargo fmt` and `cargo clippy --workspace --all-targets -- -D warnings` before any push, not just `cargo test` (CI gates all three).
- Prettier is pinned: `node_modules/.bin/prettier`, never `npx prettier`.
- Frontend gates before push: `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend` (and `typecheck`/`test` for `client` when runtime/client changed). Backend: `cd studio/backend && uv run pytest -m "not e2e" -q`.
- Known pre-existing failure: `nx run-many -t test` fails 3 port-hardcoded game-plugin tests in any offset≠0 worktree — not yours, ignore those 3 only.
- `DefinitionError` (Rust kernel) has NO Display/serde impls — always serialize via `format!("{e:?}")`.
- Bet units: composed payouts are raw `u64` in bet-unit-1 multiples; the kernel never sees bet. Metrics use bet unit 1.
- Windows note: if cargo fails with `os error 4551` on a build-script exe, delete `target/*/build/<crate>-*` and rebuild.

## File Structure

```
studio/simulator/src/compose.rs                    # + PoolMetrics, measure_pool (Task 1)
studio/simulator/src/bin/compose_json.rs           # NEW stdin/stdout job bin (Task 2)
runtime/server/src/config.rs                       # + packages_dir (Task 3)
runtime/server/src/state.rs                        # LoadedPackage refactor + PackageSource + resolve (Tasks 3-4)
runtime/server/src/routes.rs                       # resolve() plumbing + ?package= + SpinRequest.package (Tasks 3-4)
runtime/server/tests/packages_dir.rs               # NEW dir-mode integration tests (Task 4)
justfile                                           # + runtime-serve-packages recipe (Task 4)

studio/backend/app/compose/__init__.py             # NEW module (Tasks 5-7)
studio/backend/app/compose/models.py               # GameDefinitionDoc + compose_wire
studio/backend/app/compose/templates.py            # demo definition/presentation loaders
studio/backend/app/compose/store.py                # ComposeStore (get/get_or_seed/put + on_change)
studio/backend/app/compose/runner.py               # ComposeRunner protocol + subprocess + fake
studio/backend/app/compose/rest.py                 # GET/PUT/validate/build endpoints
studio/backend/app/config.py                       # + compose_bin/compose_timeout_s/packages_dir
studio/backend/app/main.py                         # + store/runner wiring + socket emit
studio/backend/tests/conftest.py                   # + game_definitions collection
studio/backend/tests/test_compose_store.py         # NEW
studio/backend/tests/test_compose_runner.py        # NEW
studio/backend/tests/test_compose_rest.py          # NEW

studio/frontend/src/plugins/game-structure/        # NEW plugin (Tasks 8-14)
  model.ts + model.spec.ts                         # IGameDefinition types + normalizeDefinition
  vocab.ts + vocab.spec.ts                         # mechanic catalog, actions, emittable events
  reducers.ts + reducers.spec.ts                   # pure definition transforms
  config.ts                                        # BACKEND_URL re-export
  state.ts                                         # IGameStructureState + hooks/slice
  restClient.ts + restClient.spec.ts               # GET/PUT/validate/build
  socketClient.ts                                  # game_definition_changed subscription
  actions.ts + actions.spec.ts                     # open/save/watermark/json/validate/build
  GameStructurePane.tsx + GameStructurePane.spec.tsx
  sections/MechanicsSection.tsx (+ .spec.tsx)
  sections/StatesSection.tsx (+ .spec.tsx)
  sections/TransitionsSection.tsx (+ .spec.tsx)
  sections/JsonSection.tsx (+ .spec.tsx)
  index.ts                                         # IPlugin registration
Modified:
  studio/frontend/src/plugins/index.ts             # + gameStructure entry
  studio/frontend/src/app/routes/RoomRoute.tsx     # + openGameStructure(found.gameId)
  studio/frontend/playwright.config.ts             # + dir-mode runtime server webServer (:9300+off)
  studio/frontend/e2e/game-structure.spec.ts       # NEW authoring e2e

runtime/client/src/main.ts                         # + ?package= param (Task 15)
runtime/client/src/play/runtimeClient.ts           # + packageId on handshake/spin
runtime/client/playwright.config.ts                # + dir-mode server webServer (:9200+off)
runtime/client/e2e/playmode-dir.e2e.spec.ts        # NEW dir-mode play e2e
```

Task order: Rust simulator (1-2) → runtime server (3-4) → Python backend (5-7) → studio plugin (8-14) → runtime client (15) → studio e2e (16) → gates + PR (17). Each task is independently green.

---

### Task 1: Pool metrics in `bloom-simulator` (`measure_pool`)

**Files:**

- Modify: `studio/simulator/src/compose.rs`

**Interfaces:**

- Consumes: `bloom_math::mechanics::composed::{evaluate, CompiledGame, TraceEntry}` (existing), `crate::seedgen::generate_seeds` (existing).
- Produces: `pub struct PoolMetrics { pub rtp: f64, pub hit_rate: f64, pub max_win_x: u64, pub state_visits: BTreeMap<String, u64> }` and `pub fn measure_pool(game: &CompiledGame, seeds: &[u64]) -> PoolMetrics` — Task 2 calls both.

- [ ] **Step 1: Write the failing tests** — append to the existing `#[cfg(test)] mod tests` in `studio/simulator/src/compose.rs` (it already has `valid_def()` and `key()` helpers):

```rust
    #[test]
    fn measure_pool_is_deterministic_and_counts_state_visits() {
        let compiled = bloom_math::mechanics::composed::compile(&valid_def()).unwrap();
        let seeds = crate::seedgen::generate_seeds(42, 200);
        let a = measure_pool(&compiled, &seeds);
        let b = measure_pool(&compiled, &seeds);
        assert_eq!(a, b);
        // Every round enters the start state exactly once.
        assert_eq!(a.state_visits.get("base").copied(), Some(200));
        assert!(a.rtp >= 0.0);
        assert!((0.0..=1.0).contains(&a.hit_rate));
    }

    #[test]
    fn measure_pool_empty_seeds_is_all_zero() {
        let compiled = bloom_math::mechanics::composed::compile(&valid_def()).unwrap();
        let m = measure_pool(&compiled, &[]);
        assert_eq!(m.rtp, 0.0);
        assert_eq!(m.hit_rate, 0.0);
        assert_eq!(m.max_win_x, 0);
        assert!(m.state_visits.is_empty());
    }
```

NOTE: `valid_def()`'s start state id may not be `"base"` — read the helper first and use its actual start-state id in the assertion.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-simulator measure_pool`
Expected: FAIL — `measure_pool` not found.

- [ ] **Step 3: Implement** — add to `studio/simulator/src/compose.rs` (below `build_composed_package`):

```rust
use std::collections::BTreeMap;

/// Informational metrics over an (uncurated) seed pool: every seed through the
/// kernel evaluator, bet unit 1 (golden-vector convention). No gating — verify/
/// freeze for composed stays #172.
#[derive(Debug, Clone, PartialEq)]
pub struct PoolMetrics {
    /// mean total_payout per round (bet unit 1)
    pub rtp: f64,
    /// share of rounds with any payout
    pub hit_rate: f64,
    /// largest single-round payout, in bet multiples
    pub max_win_x: u64,
    /// state id -> total StateEnter count across the pool
    pub state_visits: BTreeMap<String, u64>,
}

pub fn measure_pool(
    game: &bloom_math::mechanics::composed::CompiledGame,
    seeds: &[u64],
) -> PoolMetrics {
    use bloom_math::mechanics::composed::{evaluate, TraceEntry};
    let mut total: u128 = 0;
    let mut hits: u64 = 0;
    let mut max_win: u64 = 0;
    let mut visits: BTreeMap<String, u64> = BTreeMap::new();
    for &seed in seeds {
        let trace = evaluate(game, seed);
        total += u128::from(trace.total_payout);
        if trace.total_payout > 0 {
            hits += 1;
        }
        max_win = max_win.max(trace.total_payout);
        for e in &trace.entries {
            if let TraceEntry::StateEnter { state } = e {
                *visits.entry(state.clone()).or_insert(0) += 1;
            }
        }
    }
    if seeds.is_empty() {
        return PoolMetrics { rtp: 0.0, hit_rate: 0.0, max_win_x: 0, state_visits: visits };
    }
    let n = seeds.len() as f64;
    PoolMetrics {
        rtp: total as f64 / n,
        hit_rate: hits as f64 / n,
        max_win_x: max_win,
        state_visits: visits,
    }
}
```

Adjust the imports to match the file's existing `use` style (it already imports from `bloom_math::mechanics::composed`; extend that line instead of a nested `use` if cleaner).

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p bloom-simulator compose`
Expected: all compose tests PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add studio/simulator/src/compose.rs
git commit -m "feat(simulator): informational pool metrics for composed packages"
```

---

### Task 2: `compose_json` bin (validate / build+metrics over stdin JSON)

**Files:**

- Create: `studio/simulator/src/bin/compose_json.rs` (auto-discovered; no Cargo.toml edit)

**Interfaces:**

- Consumes: `build_composed_package`, `measure_pool`, `PoolMetrics` (Task 1), `bloom_math::mechanics::composed::{compile, GameDefinition}`, `crate seedgen` via `bloom_simulator`.
- Produces: the subprocess contract Task 6 (Python runner) depends on. **Stdin** (single JSON object, snake_case keys):
  `{"definition": <object>, "presentation": <object|null>, "package_id": "<str>", "seed_count": <int, default 10000>, "master_seed": <u64>, "out_path": "<str, required unless validate_only>", "validate_only": <bool, default false>}`
  **Stdout** (single line):
  `{"type":"result","ok":true}` (validate ok) · `{"type":"result","ok":false,"errors":["..."]}` (any failure) · `{"type":"result","ok":true,"metrics":{"rtp":f,"hitRate":f,"maxWinX":n,"stateVisits":{"<state>":n}}}` (build ok).
  Exit codes: 0 for any well-formed result (including ok:false); 2 for unreadable/unparseable stdin job or missing out_path on build; 1 for package write IO failure.

- [ ] **Step 1: Write the file with failing tests first.** Create `studio/simulator/src/bin/compose_json.rs` containing ONLY the test module and stubs that don't compile yet is awkward for a bin — instead write tests + implementation in one file and let the tests drive the helper shapes. The full file:

```rust
//! Studio compose bin: read one JSON job from stdin, validate (kernel compile)
//! or build+measure a composed@1 package, print one NDJSON result line.
//! Mirrors curate_json's contract style; no streaming (compose is fast).
//! Usage: compose_json  (job on stdin)

use bloom_math::mechanics::composed::{compile, GameDefinition};
use bloom_simulator::compose::{build_composed_package, measure_pool, PoolMetrics};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::json;
use std::io::Read;

fn default_seed_count() -> usize {
    10_000
}

#[derive(Deserialize)]
struct ComposeJob {
    definition: serde_json::Value,
    #[serde(default)]
    presentation: Option<serde_json::Value>,
    package_id: String,
    #[serde(default = "default_seed_count")]
    seed_count: usize,
    master_seed: u64,
    #[serde(default)]
    out_path: Option<String>,
    #[serde(default)]
    validate_only: bool,
}

fn result_ok() -> String {
    json!({ "type": "result", "ok": true }).to_string()
}

fn result_errors(errors: &[String]) -> String {
    json!({ "type": "result", "ok": false, "errors": errors }).to_string()
}

fn result_metrics(m: &PoolMetrics) -> String {
    json!({
        "type": "result",
        "ok": true,
        "metrics": {
            "rtp": m.rtp,
            "hitRate": m.hit_rate,
            "maxWinX": m.max_win_x,
            "stateVisits": m.state_visits,
        }
    })
    .to_string()
}

/// Run the job. Returns (stdout line, exit code). Writes the package file as a
/// side effect on a successful build.
fn run_job(job: ComposeJob) -> (String, i32) {
    let def: GameDefinition = match serde_json::from_value(job.definition) {
        Ok(d) => d,
        Err(e) => return (result_errors(&[format!("definition parse: {e}")]), 0),
    };
    if job.validate_only {
        return match compile(&def) {
            Ok(_) => (result_ok(), 0),
            Err(errs) => {
                let msgs: Vec<String> = errs.iter().map(|e| format!("{e:?}")).collect();
                (result_errors(&msgs), 0)
            }
        };
    }
    let Some(out_path) = job.out_path else {
        eprintln!("compose_json: out_path is required unless validate_only");
        return (String::new(), 2);
    };
    let presentation: Vec<u8> = match &job.presentation {
        Some(v) => serde_json::to_vec(v).expect("presentation Value serializes"),
        None => Vec::new(),
    };
    let key = SigningKey::from_bytes(&[7u8; 32]); // dev-only, same as compose/curate
    let bytes = match build_composed_package(
        &def,
        &job.package_id,
        job.seed_count,
        job.master_seed,
        &presentation,
        &key,
    ) {
        Ok(b) => b,
        Err(errs) => {
            let msgs: Vec<String> = errs.iter().map(|e| format!("{e:?}")).collect();
            return (result_errors(&msgs), 0);
        }
    };
    if let Err(e) = std::fs::write(&out_path, &bytes) {
        eprintln!("write package failed: {e}");
        return (String::new(), 1);
    }
    let compiled = compile(&def).expect("compile succeeded during build");
    let seeds = bloom_simulator::seedgen::generate_seeds(job.master_seed, job.seed_count);
    (result_metrics(&measure_pool(&compiled, &seeds)), 0)
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("compose_json: failed to read stdin");
        std::process::exit(2);
    }
    let job: ComposeJob = match serde_json::from_str(&input) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("compose_json: bad job json: {e}");
            std::process::exit(2);
        }
    };
    let (line, code) = run_job(job);
    if !line.is_empty() {
        println!("{line}");
    }
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_definition_value() -> serde_json::Value {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime/server/demo/composed.definition.json"
        ))
        .expect("read demo definition");
        serde_json::from_str(&json).expect("parse demo definition")
    }

    fn job(v: serde_json::Value) -> ComposeJob {
        serde_json::from_value(v).expect("job parses")
    }

    #[test]
    fn job_defaults_apply() {
        let j = job(json!({
            "definition": demo_definition_value(),
            "package_id": "p1",
            "master_seed": 7
        }));
        assert_eq!(j.seed_count, 10_000);
        assert!(!j.validate_only);
        assert!(j.out_path.is_none());
        assert!(j.presentation.is_none());
    }

    #[test]
    fn validate_only_ok_and_errors() {
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "p1",
            "master_seed": 7,
            "validate_only": true
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], true);

        let mut bad = demo_definition_value();
        bad["start"] = json!("no-such-state");
        let (line, code) = run_job(job(json!({
            "definition": bad,
            "package_id": "p1",
            "master_seed": 7,
            "validate_only": true
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        assert!(!v["errors"].as_array().unwrap().is_empty());
    }

    #[test]
    fn definition_parse_failure_is_an_ok_false_result() {
        let (line, code) = run_job(job(json!({
            "definition": {"family": 42},
            "package_id": "p1",
            "master_seed": 7,
            "validate_only": true
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["errors"][0].as_str().unwrap().starts_with("definition parse:"));
    }

    #[test]
    fn build_writes_pkg_and_reports_metrics() {
        let out = std::env::temp_dir().join(format!("compose-json-test-{}.pkg", std::process::id()));
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "presentation": {"p": 1},
            "package_id": "pkg-test",
            "seed_count": 200,
            "master_seed": 42,
            "out_path": out.to_string_lossy(),
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], true);
        let m = &v["metrics"];
        assert!(m["rtp"].as_f64().unwrap() >= 0.0);
        assert!(m["stateVisits"]["base"].as_u64().unwrap() == 200);
        let bytes = std::fs::read(&out).expect("package written");
        assert!(!bytes.is_empty());
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn build_without_out_path_is_usage_error() {
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "p1",
            "master_seed": 7
        })));
        assert_eq!(code, 2);
        assert!(line.is_empty());
    }
}
```

NOTE: check `studio/simulator/src/lib.rs` — `seedgen` must be `pub mod seedgen;` for the bin to call `bloom_simulator::seedgen::generate_seeds`. If it's private, make it `pub` (the `compose` module already consumes it internally).

- [ ] **Step 2: Run the tests**

Run: `cargo test -p bloom-simulator --bin compose_json`
Expected: 5 tests PASS. If `seedgen` visibility fails compilation, fix per the note and rerun.

- [ ] **Step 3: Smoke the real contract once**

Run (Git Bash, from repo root):

```bash
echo '{"definition":'"$(cat runtime/server/demo/composed.definition.json)"',"package_id":"smoke","master_seed":7,"validate_only":true}' | cargo run -p bloom-simulator --bin compose_json
```

Expected: `{"type":"result","ok":true}` on stdout, exit 0.

- [ ] **Step 4: fmt + clippy + commit**

```bash
cargo fmt
cargo clippy -p bloom-simulator --all-targets -- -D warnings
git add studio/simulator/src/bin/compose_json.rs studio/simulator/src/lib.rs
git commit -m "feat(simulator): compose_json bin - stdin job, validate/build/metrics"
```

---

### Task 3: Runtime server refactor — `LoadedPackage` + `PackageSource` + `resolve()` (single mode only)

**Files:**

- Modify: `runtime/server/src/config.rs`
- Modify: `runtime/server/src/state.rs`
- Modify: `runtime/server/src/routes.rs`

Pure refactor: all existing tests stay green; behavior identical. This isolates the mechanical churn from the dir-mode feature (Task 4).

**Interfaces:**

- Produces (Task 4 + existing routes rely on these exact names):
  - `pub struct LoadedPackage { pub package: PackageContent, pub game: LoadedGame, pub definition_hash: String }` with `pub fn from_bytes(bytes: &[u8]) -> Result<LoadedPackage, StartupError>`
  - `pub enum PackageSource { Single(Arc<LoadedPackage>), Dir { dir: PathBuf, cache: RwLock<HashMap<String, CachedPackage>> } }`
  - `pub struct CachedPackage { pub mtime: SystemTime, pub loaded: Arc<LoadedPackage> }`
  - `pub struct AppState { pub source: PackageSource, pub draw: Box<dyn Draw>, pub audit: Box<dyn AuditSink> }`
  - `pub enum ResolveError { PackageParamRequired, NotFound(String), Load(StartupError) }`
  - `impl AppState { pub fn resolve(&self, package: Option<&str>, refresh: bool) -> Result<Arc<LoadedPackage>, ResolveError> }`
  - `ServerConfig.packages_dir: Option<PathBuf>` from env `BLOOM_RUNTIME_PACKAGES`.

- [ ] **Step 1: config.rs** — add to `ServerConfig`:

```rust
pub struct ServerConfig {
    pub package_path: PathBuf,
    pub packages_dir: Option<PathBuf>,
    pub audit_path: PathBuf,
    pub bind_addr: SocketAddr,
}
```

and in `from_env()` (before constructing the struct):

```rust
        let packages_dir = std::env::var("BLOOM_RUNTIME_PACKAGES").ok().map(PathBuf::from);
```

Include `packages_dir` in the returned struct.

- [ ] **Step 2: state.rs refactor.** Extract the family-dispatch body of `AppState::from_package_bytes` into the new type:

```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

/// One verified + decoded package (per-package slice of the old AppState).
pub struct LoadedPackage {
    pub package: PackageContent,
    pub game: LoadedGame,
    pub definition_hash: String,
}

impl LoadedPackage {
    pub fn from_bytes(bytes: &[u8]) -> Result<LoadedPackage, StartupError> {
        let package =
            verify_and_load(bytes, &dev_verifying_key()).map_err(StartupError::BadPackage)?;
        if package.seeds.is_empty() {
            return Err(StartupError::EmptyPool);
        }
        let game = match package.envelope.mechanic.as_str() {
            "slots@1" => LoadedGame::Slots(
                from_payload(&package.math_payload).map_err(StartupError::BadPayload)?,
            ),
            "composed@1" => {
                let def = composed::from_payload(&package.math_payload)
                    .map_err(|e| StartupError::BadDefinition(e.to_string()))?;
                let compiled = composed::compile(&def)
                    .map_err(|errs| StartupError::BadDefinition(format!("{errs:?}")))?;
                LoadedGame::Composed(Box::new(compiled))
            }
            other => return Err(StartupError::UnknownMechanic(other.to_string())),
        };
        let definition_hash = payload_hash(&package.math_payload);
        Ok(LoadedPackage { package, game, definition_hash })
    }
}

pub struct CachedPackage {
    pub mtime: SystemTime,
    pub loaded: Arc<LoadedPackage>,
}

pub enum PackageSource {
    Single(Arc<LoadedPackage>),
    Dir {
        dir: PathBuf,
        cache: RwLock<HashMap<String, CachedPackage>>,
    },
}

#[derive(Debug)]
pub enum ResolveError {
    /// Dir mode requires an explicit package id on every request.
    PackageParamRequired,
    NotFound(String),
    Load(StartupError),
}

pub struct AppState {
    pub source: PackageSource,
    pub draw: Box<dyn Draw>,
    pub audit: Box<dyn AuditSink>,
}

impl AppState {
    pub fn from_package_bytes(
        bytes: &[u8],
        draw: Box<dyn Draw>,
        audit: Box<dyn AuditSink>,
    ) -> Result<AppState, StartupError> {
        Ok(AppState {
            source: PackageSource::Single(Arc::new(LoadedPackage::from_bytes(bytes)?)),
            draw,
            audit,
        })
    }

    pub fn load(config: &crate::config::ServerConfig) -> Result<AppState, StartupError> {
        if let Some(dir) = &config.packages_dir {
            // Dir mode: nothing is read at boot; packages load lazily per request.
            return Ok(AppState {
                source: PackageSource::Dir { dir: dir.clone(), cache: RwLock::new(HashMap::new()) },
                draw: Box::new(crate::draw::OsRngDraw),
                audit: Box::new(crate::audit::JsonlAuditSink::new(config.audit_path.clone())),
            });
        }
        let bytes = std::fs::read(&config.package_path).map_err(StartupError::Io)?;
        AppState::from_package_bytes(
            &bytes,
            Box::new(crate::draw::OsRngDraw),
            Box::new(crate::audit::JsonlAuditSink::new(config.audit_path.clone())),
        )
    }

    /// Resolve the package a request addresses. Single mode ignores the param.
    /// `refresh` (handshake) stats the file and reloads a rebuilt package; spins
    /// serve from cache so a play session keeps its package.
    pub fn resolve(
        &self,
        package: Option<&str>,
        refresh: bool,
    ) -> Result<Arc<LoadedPackage>, ResolveError> {
        match &self.source {
            PackageSource::Single(lp) => Ok(lp.clone()),
            PackageSource::Dir { dir, cache } => {
                let id = package.ok_or(ResolveError::PackageParamRequired)?;
                // Trust boundary: the id becomes a file name. Allow only safe chars.
                if id.is_empty()
                    || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return Err(ResolveError::NotFound(id.to_string()));
                }
                if !refresh {
                    if let Some(c) = cache.read().unwrap().get(id) {
                        return Ok(c.loaded.clone());
                    }
                }
                let path = dir.join(format!("{id}.pkg"));
                let mtime = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .map_err(|_| ResolveError::NotFound(id.to_string()))?;
                if let Some(c) = cache.read().unwrap().get(id) {
                    if c.mtime == mtime {
                        return Ok(c.loaded.clone());
                    }
                }
                let bytes = std::fs::read(&path).map_err(|e| ResolveError::Load(StartupError::Io(e)))?;
                let loaded = Arc::new(LoadedPackage::from_bytes(&bytes).map_err(ResolveError::Load)?);
                cache
                    .write()
                    .unwrap()
                    .insert(id.to_string(), CachedPackage { mtime, loaded: loaded.clone() });
                Ok(loaded)
            }
        }
    }
}
```

Delete the old `AppState { package, game, definition_hash, … }` fields and the old `from_package_bytes`/`load` bodies — the above replaces them wholesale. Keep `dev_verifying_key`, `StartupError`, `LoadedGame`, `payload_hash` unchanged.

- [ ] **Step 3: routes.rs plumbing.** Every handler that read `state.package`/`state.game`/`state.definition_hash` now resolves first. In this task pass `None` (single mode); Task 4 threads the real params.

```rust
use crate::state::{AppState, LoadedGame, LoadedPackage, ResolveError};

fn resolve_status(e: ResolveError) -> StatusCode {
    match e {
        ResolveError::PackageParamRequired => StatusCode::BAD_REQUEST,
        ResolveError::NotFound(_) => StatusCode::NOT_FOUND,
        ResolveError::Load(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
```

`health` (dir mode has no single package to report; keep the wire shape):

```rust
pub async fn health(State(state): State<Arc<AppState>>) -> Result<Json<HealthResponse>, StatusCode> {
    match &state.source {
        crate::state::PackageSource::Single(lp) => Ok(Json(HealthResponse {
            status: "ok",
            package_id: lp.package.envelope.package_id.clone(),
            package_version: lp.package.envelope.package_version,
            mechanic: lp.package.envelope.mechanic.clone(),
        })),
        crate::state::PackageSource::Dir { .. } => Ok(Json(HealthResponse {
            status: "ok",
            package_id: String::new(),
            package_version: 0,
            mechanic: "packages-dir".to_string(),
        })),
    }
}
```

`handshake` and `spin`: replace `state.package` / `state.game` / `state.definition_hash` with a resolved `lp`:

```rust
    let lp = state.resolve(None, true).map_err(resolve_status)?; // handshake
    // ... lp.package.envelope..., &lp.game, lp.definition_hash ...
```

(in `spin`: `state.resolve(None, false)`). `state.draw` and `state.audit` usage is unchanged. Update return types to `Result<Json<…>, StatusCode>` where they weren't already.

- [ ] **Step 4: Fix compilation across the crate** — `cargo build -p bloom-runtime-server` and follow the errors; tests in `runtime/server/tests/*.rs` construct `AppState::from_package_bytes`, which still exists with the same signature, so they should only need changes if they poked `state.package` directly (adjust those to `match &state.source`).

- [ ] **Step 5: Run the full server test suite**

Run: `cargo test -p bloom-runtime-server`
Expected: ALL existing tests PASS (pure refactor).

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt
cargo clippy -p bloom-runtime-server --all-targets -- -D warnings
git add runtime/server/src
git commit -m "refactor(runtime): extract LoadedPackage + PackageSource resolve seam"
```

---

### Task 4: Runtime server dir mode — `?package=` selection, mtime reload, tests, justfile recipe

**Files:**

- Modify: `runtime/server/src/routes.rs`
- Create: `runtime/server/tests/packages_dir.rs`
- Modify: `justfile`

**Interfaces:**

- Consumes: Task 3's `resolve`, `PackageSource::Dir`.
- Produces (Tasks 15/16 depend on this wire): `GET /handshake?package=<id>`; `SpinRequest` gains `"package": <string, optional>`; dir mode without the param → 400; unknown/bad id → 404. `just runtime-serve-packages` serves `var/packages`.

- [ ] **Step 1: Write failing integration tests** — `runtime/server/tests/packages_dir.rs`:

```rust
//! Dir-mode integration: lazy load by id, param required, sanitization,
//! mtime-based reload on handshake, spin cache stability.

use bloom_math::mechanics::composed::{to_payload, GameDefinition};
use bloom_package::{build, Envelope, PackageContent};
use bloom_runtime_server::state::{AppState, PackageSource};
use bloom_runtime_server::build_app;
use ed25519_dalek::SigningKey;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tower::util::ServiceExt;

fn demo_definition() -> GameDefinition {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/demo/composed.definition.json"
    ))
    .expect("read composed.definition.json");
    serde_json::from_str(&json).expect("parse composed.definition.json")
}

fn composed_pkg_bytes(package_id: &str) -> Vec<u8> {
    let def = demo_definition();
    let content = PackageContent {
        envelope: Envelope {
            package_id: package_id.to_string(),
            package_version: 1,
            mechanic: "composed@1".to_string(),
        },
        math_payload: to_payload(&def),
        seeds: (0..500u64).collect(),
        presentation: b"{}".to_vec(),
    };
    build(&content, &SigningKey::from_bytes(&[7u8; 32]))
}

fn dir_state(dir: &std::path::Path) -> Arc<AppState> {
    Arc::new(AppState {
        source: PackageSource::Dir {
            dir: dir.to_path_buf(),
            cache: RwLock::new(HashMap::new()),
        },
        draw: Box::new(bloom_runtime_server::draw::OsRngDraw),
        audit: Box::new(bloom_runtime_server::audit::MemoryAuditSink::new()),
    })
}

fn test_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bloom-pkgdir-{}-{}", std::process::id(), name));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn get(app: axum::Router, uri: &str) -> (axum::http::StatusCode, serde_json::Value) {
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(uri)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, v)
}

async fn post_spin(app: axum::Router, body: &str) -> (axum::http::StatusCode, serde_json::Value) {
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/spin")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, v)
}

#[tokio::test]
async fn handshake_without_package_param_is_400_in_dir_mode() {
    let dir = test_dir("no-param");
    let (status, _) = get(build_app(dir_state(&dir)), "/handshake").await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unknown_and_traversal_ids_are_404() {
    let dir = test_dir("unknown");
    let (status, _) = get(build_app(dir_state(&dir)), "/handshake?package=nope").await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    let (status, _) = get(build_app(dir_state(&dir)), "/handshake?package=..%2Fdemo").await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn handshake_and_spin_resolve_a_dir_package() {
    let dir = test_dir("resolve");
    std::fs::write(dir.join("g1.pkg"), composed_pkg_bytes("g1")).unwrap();
    let state = dir_state(&dir);

    let (status, v) = get(build_app(state.clone()), "/handshake?package=g1").await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(v["package_id"], "g1");
    assert_eq!(v["mechanic"], "composed@1");
    assert!(v["definition"].is_object());

    let (status, v) = post_spin(build_app(state), r#"{"bet":1,"package":"g1"}"#).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(v["trace"].as_array().unwrap().last().unwrap()["t"], "round_end");
}

#[tokio::test]
async fn spin_without_package_is_400_in_dir_mode() {
    let dir = test_dir("spin-no-param");
    std::fs::write(dir.join("g1.pkg"), composed_pkg_bytes("g1")).unwrap();
    let (status, _) = post_spin(build_app(dir_state(&dir)), r#"{"bet":1}"#).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn handshake_reloads_when_the_file_is_rebuilt() {
    let dir = test_dir("reload");
    let path = dir.join("g1.pkg");
    std::fs::write(&path, composed_pkg_bytes("g1-v1")).unwrap();
    let state = dir_state(&dir);
    let (_, v) = get(build_app(state.clone()), "/handshake?package=g1").await;
    assert_eq!(v["package_id"], "g1-v1");

    // Rebuild with different content and force a NEWER mtime (fs mtime
    // granularity can otherwise swallow a fast rewrite).
    std::fs::write(&path, composed_pkg_bytes("g1-v2")).unwrap();
    let f = std::fs::File::options().write(true).open(&path).unwrap();
    f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();

    let (_, v) = get(build_app(state), "/handshake?package=g1").await;
    assert_eq!(v["package_id"], "g1-v2");
}

#[tokio::test]
async fn spin_serves_from_cache_even_if_the_file_churns() {
    let dir = test_dir("cache");
    let path = dir.join("g1.pkg");
    std::fs::write(&path, composed_pkg_bytes("g1")).unwrap();
    let state = dir_state(&dir);
    let (_, _) = get(build_app(state.clone()), "/handshake?package=g1").await;
    std::fs::write(&path, b"garbage").unwrap(); // cached spin must not re-read
    let (status, _) = post_spin(build_app(state), r#"{"package":"g1"}"#).await;
    assert_eq!(status, axum::http::StatusCode::OK);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-runtime-server --test packages_dir`
Expected: FAIL — handshake takes no query, `SpinRequest` has no `package` field.

- [ ] **Step 3: Implement in routes.rs**

```rust
use axum::extract::Query;

#[derive(Deserialize)]
pub struct HandshakeQuery {
    pub package: Option<String>,
}
```

`handshake` signature + first line:

```rust
pub async fn handshake(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HandshakeQuery>,
) -> Result<Json<HandshakeResponse>, StatusCode> {
    let lp = state.resolve(q.package.as_deref(), true).map_err(resolve_status)?;
```

`SpinRequest` + `spin`:

```rust
#[derive(Deserialize)]
pub struct SpinRequest {
    #[serde(default = "default_bet")]
    pub bet: u64,
    #[serde(default)]
    pub package: Option<String>,
}
```

```rust
pub async fn spin(
    State(state): State<Arc<AppState>>,
    body: Option<Json<SpinRequest>>,
) -> Result<Json<SpinResponse>, StatusCode> {
    let (bet, package) = match body {
        Some(Json(b)) => (b.bet, b.package),
        None => (1, None),
    };
    let lp = state.resolve(package.as_deref(), false).map_err(resolve_status)?;
    // ...existing body against lp.* ...
```

- [ ] **Step 4: Run all server tests**

Run: `cargo test -p bloom-runtime-server`
Expected: ALL PASS (new dir tests + old single-mode tests).

- [ ] **Step 5: justfile recipe** — add next to `runtime-serve-composed`:

```makefile
# Serve every studio-built package from var/packages (dir mode, lazy load).
runtime-serve-packages:
    BLOOM_RUNTIME_PACKAGES=var/packages cargo run --release -p bloom-runtime-server
```

- [ ] **Step 6: fmt + clippy + commit**

```bash
cargo fmt
cargo clippy -p bloom-runtime-server --all-targets -- -D warnings
git add runtime/server justfile
git commit -m "feat(runtime): package-directory mode with ?package= selection and mtime reload"
```

---

### Task 5: `app/compose` — models, templates, store

**Files:**

- Create: `studio/backend/app/compose/__init__.py` (empty)
- Create: `studio/backend/app/compose/models.py`
- Create: `studio/backend/app/compose/templates.py`
- Create: `studio/backend/app/compose/store.py`
- Modify: `studio/backend/tests/conftest.py` (add `"game_definitions"` to `_COLLECTIONS`)
- Test: `studio/backend/tests/test_compose_store.py`

**Interfaces:**

- Consumes: the checked-in fixtures `runtime/server/demo/composed.definition.json` + `composed.presentation.json` (canonical template source — do NOT copy their content into Python; load them).
- Produces (Tasks 6-7 rely on these):
  - `GameDefinitionDoc(id, game_id, definition: dict, presentation: dict, created_at, updated_at)` + `compose_wire(doc) -> dict` (camelCase wire: `gameId`, `updatedAt`; `definition`/`presentation` pass through untouched).
  - `templates.default_definition() -> dict`, `templates.default_presentation() -> dict`.
  - `ComposeStore(db, on_change=None)` with `async get(game_id) -> GameDefinitionDoc | None`, `async get_or_seed(game_id) -> GameDefinitionDoc`, `async put(game_id, *, definition=None, presentation=None, source="api") -> GameDefinitionDoc`. `put` fires `await on_change(doc, source)` when definition or presentation was written.

- [ ] **Step 1: Write failing tests** — `studio/backend/tests/test_compose_store.py` (mirror `test_math_store.py` style; tests run against real Mongo db `bloom_studio_test` via the `mongo_db` fixture in conftest):

```python
import pytest

from app.compose.store import ComposeStore
from app.compose import templates


@pytest.mark.asyncio
async def test_get_returns_none_then_seed_creates_from_template(mongo_db):
    store = ComposeStore(mongo_db)
    assert await store.get("g1") is None
    doc = await store.get_or_seed("g1")
    assert doc.game_id == "g1"
    assert doc.definition["family"] == "composed@1"
    assert doc.definition == templates.default_definition()
    assert doc.presentation == templates.default_presentation()
    # idempotent
    again = await store.get_or_seed("g1")
    assert again.id == doc.id


@pytest.mark.asyncio
async def test_put_updates_and_fires_on_change(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    store = ComposeStore(mongo_db, on_change=on_change)
    definition = templates.default_definition()
    definition["caps"]["max_steps"] = 500
    doc = await store.put("g1", definition=definition, source="editor")
    assert doc.definition["caps"]["max_steps"] == 500
    assert events == [("g1", "editor")]

    doc2 = await store.put("g1", presentation={"theme": "x"}, source="api")
    assert doc2.presentation == {"theme": "x"}
    assert doc2.updated_at > doc.updated_at
    assert events[-1] == ("g1", "api")


@pytest.mark.asyncio
async def test_put_with_no_fields_does_not_fire_on_change(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = ComposeStore(mongo_db, on_change=on_change)
    await store.put("g1", source="noop")
    assert events == []
```

Also edit `studio/backend/tests/conftest.py`: add `"game_definitions",` to the `_COLLECTIONS` list.

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_compose_store.py -q`
Expected: FAIL — `app.compose` does not exist.

- [ ] **Step 3: Implement.**

`studio/backend/app/compose/models.py`:

```python
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GameDefinitionDoc(_WireModel):
    id: str
    game_id: str
    definition: dict  # composed@1 GameDefinition, Rust serde wire shape (opaque here)
    presentation: dict = {}  # runtime presentation blob, embedded verbatim at build
    created_at: str
    updated_at: str


def compose_wire(doc: GameDefinitionDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")
```

`studio/backend/app/compose/templates.py`:

```python
"""Seed template for new game-definition docs: the canonical composed demo
fixtures (spec section 4). Loaded from the repo files, not duplicated here."""

import json
from functools import lru_cache
from pathlib import Path

_DEMO_DIR = Path(__file__).resolve().parents[4] / "runtime" / "server" / "demo"


@lru_cache(maxsize=2)
def _load(name: str) -> str:
    return (_DEMO_DIR / name).read_text(encoding="utf-8")


def default_definition() -> dict:
    return json.loads(_load("composed.definition.json"))


def default_presentation() -> dict:
    return json.loads(_load("composed.presentation.json"))
```

NOTE: verify `parents[4]` — `app/compose/templates.py` → parents: `[0]=compose, [1]=app, [2]=backend, [3]=studio, [4]=<repo root>`. The first store test exercises it (template seeding would throw FileNotFoundError if wrong).

`studio/backend/app/compose/store.py` (clone of `MathStore` minus legacy migration/locks):

```python
import uuid
from datetime import datetime, timezone

from pymongo.errors import DuplicateKeyError

from app.compose import templates
from app.compose.models import GameDefinitionDoc


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_doc(doc: GameDefinitionDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> GameDefinitionDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return GameDefinitionDoc.model_validate(data)


class ComposeStore:
    def __init__(self, db, on_change=None):
        # on_change: async (doc, source) -> None; fired after any definition/
        # presentation write. Wired to a socket emit in main.py — the store
        # itself stays socket-free (same choke-point pattern as MathStore).
        self._docs = db["game_definitions"]
        self._on_change = on_change
        self._indexed = False

    async def _ensure_unique_index(self) -> None:
        if self._indexed:
            return
        await self._docs.create_index("game_id", unique=True)
        self._indexed = True

    async def get(self, game_id: str) -> GameDefinitionDoc | None:
        await self._ensure_unique_index()
        raw = await self._docs.find_one({"game_id": game_id})
        return _from_doc(raw) if raw else None

    async def get_or_seed(self, game_id: str) -> GameDefinitionDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = GameDefinitionDoc(
            id=str(uuid.uuid4()),
            game_id=game_id,
            definition=templates.default_definition(),  # never {}
            presentation=templates.default_presentation(),
            created_at=now,
            updated_at=now,
        )
        try:
            await self._docs.insert_one(_to_doc(doc))
        except DuplicateKeyError:
            return await self.get(game_id)  # concurrent seeder won
        return doc

    async def put(
        self,
        game_id: str,
        *,
        definition: dict | None = None,
        presentation: dict | None = None,
        source: str = "api",
    ) -> GameDefinitionDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if definition is not None:
            fields["definition"] = definition
        if presentation is not None:
            fields["presentation"] = presentation
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        changed = definition is not None or presentation is not None
        if self._on_change is not None and changed:
            await self._on_change(doc, source)
        return doc
```

- [ ] **Step 4: Run to verify pass**

Run: `cd studio/backend && uv run pytest tests/test_compose_store.py -q`
Expected: 3 PASS. Then the full backend suite: `uv run pytest -m "not e2e" -q` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/compose studio/backend/tests/test_compose_store.py studio/backend/tests/conftest.py
git commit -m "feat(compose): game_definitions store seeded from the composed demo template"
```

---

### Task 6: Compose subprocess runner + settings

**Files:**

- Create: `studio/backend/app/compose/runner.py`
- Modify: `studio/backend/app/config.py`
- Test: `studio/backend/tests/test_compose_runner.py`

**Interfaces:**

- Consumes: Task 2's `compose_json` stdin/stdout contract; `app.subprocess_guard` (read `studio/backend/app/subprocess_guard.py` first and match how `build_curation_runner` wraps its runner with `LoopSafeRunner`).
- Produces (Task 7 relies on): `ComposeRunner` protocol — `async run(job: dict) -> dict` returning the parsed result object (`{"ok": bool, "errors"?: [str], "metrics"?: {...}}`); `SubprocessComposeRunner(settings)`; `FakeComposeRunner(result)` recording `.jobs`; `build_compose_runner(settings) -> ComposeRunner`. Settings fields `compose_bin: str = ""`, `compose_timeout_s: float = 180.0`, `packages_dir: str = "var/packages"` (repo-root-relative).

- [ ] **Step 1: Write failing tests** — `studio/backend/tests/test_compose_runner.py` (mirror `test_sim_runner.py`'s monkeypatched-`_command` style):

```python
import sys
from types import SimpleNamespace

import pytest

from app.compose.runner import FakeComposeRunner, SubprocessComposeRunner


def _runner(timeout_s: float = 30.0) -> SubprocessComposeRunner:
    r = SubprocessComposeRunner(SimpleNamespace(compose_bin=""))
    r._timeout_s = timeout_s
    return r


def _cmd_for(script: str):
    return lambda: [sys.executable, "-c", script]


_ECHO_RESULT = (
    "import sys, json; sys.stdin.read(); "
    "print(json.dumps({'type': 'result', 'ok': True, 'metrics': {'rtp': 1.5}}))"
)

_NO_RESULT = "import sys; sys.stdin.read(); print('warming up'); sys.exit(3)"

_HANG = "import sys, time; sys.stdin.read(); time.sleep(600)"


@pytest.mark.asyncio
async def test_subprocess_runner_parses_the_result_line():
    runner = _runner()
    runner._command = _cmd_for(_ECHO_RESULT)
    res = await runner.run({"definition": {}, "package_id": "g", "master_seed": 1})
    assert res["ok"] is True
    assert res["metrics"]["rtp"] == 1.5


@pytest.mark.asyncio
async def test_subprocess_runner_no_result_is_error():
    runner = _runner()
    runner._command = _cmd_for(_NO_RESULT)
    res = await runner.run({"definition": {}, "package_id": "g", "master_seed": 1})
    assert res["ok"] is False
    assert "no result" in res["errors"][0]


@pytest.mark.asyncio
async def test_subprocess_runner_timeout_is_error():
    runner = _runner(timeout_s=0.5)
    runner._command = _cmd_for(_HANG)
    res = await runner.run({"definition": {}, "package_id": "g", "master_seed": 1})
    assert res["ok"] is False
    assert "timed out" in res["errors"][0]


@pytest.mark.asyncio
async def test_fake_runner_records_jobs():
    fake = FakeComposeRunner({"ok": True})
    res = await fake.run({"package_id": "g"})
    assert res == {"ok": True}
    assert fake.jobs == [{"package_id": "g"}]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_compose_runner.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement.**

`studio/backend/app/config.py` — add fields beside `simulator_bin`/`tuner_bin`:

```python
    compose_bin: str = ""  # optional path to a prebuilt compose_json; "" => cargo run
    compose_timeout_s: float = 180.0
    packages_dir: str = "var/packages"  # repo-root-relative; runtime server dir mode reads it
```

`studio/backend/app/compose/runner.py`:

```python
"""Subprocess seam to the Rust compose_json bin (mirrors runners/curate.py,
minus streaming: compose emits exactly one result line)."""

import asyncio
import json
from pathlib import Path
from typing import Protocol

from app.subprocess_guard import LoopSafeRunner, kill_proc_tree

# Repo root = .../app/compose/runner.py -> parents[4] (see templates.py note).
_REPO_ROOT = Path(__file__).resolve().parents[4]


class ComposeRunner(Protocol):
    async def run(self, job: dict) -> dict: ...


class SubprocessComposeRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "compose_bin", "") or ""
        self._timeout_s = float(getattr(settings, "compose_timeout_s", 180.0) or 180.0)

    def _command(self) -> list[str]:
        if self._bin:
            return [self._bin]
        # Dev/e2e default: cargo resolves+builds; its logs go to stderr.
        return ["cargo", "run", "--release", "-p", "bloom-simulator", "--bin", "compose_json"]

    async def run(self, job: dict) -> dict:
        proc = await asyncio.create_subprocess_exec(
            *self._command(),
            cwd=str(_REPO_ROOT),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(json.dumps(job).encode()), timeout=self._timeout_s
            )
        except asyncio.TimeoutError:
            kill_proc_tree(proc.pid)
            return {"ok": False, "errors": [f"compose timed out after {self._timeout_s}s"]}
        for line in out.decode().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "result":
                return obj
        return {
            "ok": False,
            "errors": [
                f"compose produced no result (exit {proc.returncode}): {err.decode()[:500]}"
            ],
        }


class FakeComposeRunner:
    def __init__(self, result: dict):
        self._result = result
        self.jobs: list[dict] = []

    async def run(self, job: dict) -> dict:
        self.jobs.append(job)
        return self._result


def build_compose_runner(settings) -> ComposeRunner:
    return LoopSafeRunner(SubprocessComposeRunner(settings))
```

NOTE: read `app/subprocess_guard.py` first — if `LoopSafeRunner` is not a generic passthrough wrapper (e.g. it assumes the curate `run(model, target, on_progress)` signature), don't force it: keep `build_compose_runner(settings)` as the factory and mirror whatever loop-safety mechanism it uses (it exists because Windows `uvicorn --reload` runs a SelectorEventLoop that cannot spawn subprocesses).

- [ ] **Step 4: Run to verify pass**

Run: `cd studio/backend && uv run pytest tests/test_compose_runner.py -q`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/compose/runner.py studio/backend/app/config.py studio/backend/tests/test_compose_runner.py
git commit -m "feat(compose): compose_json subprocess runner behind a mockable seam"
```

---

### Task 7: REST endpoints + socket emit + main.py wiring

**Files:**

- Create: `studio/backend/app/compose/rest.py`
- Modify: `studio/backend/app/main.py`
- Test: `studio/backend/tests/test_compose_rest.py`

**Interfaces:**

- Consumes: `ComposeStore` (Task 5), `ComposeRunner` via `request.app.state.compose_runner` (Task 6), `request.app.state.settings.packages_dir`.
- Produces (frontend Tasks 10-11 + e2e Task 16 rely on this wire):
  - `GET /games/{id}/game-definition` → `{id, gameId, definition, presentation, createdAt, updatedAt}` (seeds on first read)
  - `PUT /games/{id}/game-definition` body `{definition?, presentation?, source}` → same wire; store fires socket `game_definition_changed {gameId, updatedAt, source}` to room `gameId`
  - `POST /games/{id}/game-definition/validate` body `{definition?}` → `{ok, errors: [str]}` (request-supplied definition wins; else the stored one)
  - `POST /games/{id}/game-definition/build` → `{ok, errors: [str]|null, metrics: {rtp, hitRate, maxWinX, stateVisits}|null, packageId: <game_id>}`; writes `<repo>/var/packages/<game_id>.pkg`
  - Socket room join: the frontend reuses the existing `join_sim`/`leave_sim` handlers (room is the bare gameId) — no new socket handlers.

- [ ] **Step 1: Write failing tests** — `studio/backend/tests/test_compose_rest.py` (direct-handler style with `SimpleNamespace` fake request, as `test_math_rest.py`):

```python
from types import SimpleNamespace

import pytest

from app.compose import rest
from app.compose.runner import FakeComposeRunner
from app.compose.store import ComposeStore
from app.config import Settings


def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


def _settings() -> Settings:
    return Settings(provider_mode="replay", mongo_db="bloom_studio_test")


@pytest.mark.asyncio
async def test_get_seeds_and_put_updates(mongo_db):
    store = ComposeStore(mongo_db)
    req = _req(compose_store=store)
    got = await rest.get_game_definition("g1", req)
    assert got["gameId"] == "g1"
    assert got["definition"]["family"] == "composed@1"

    body = rest.PutGameDefinitionBody(
        definition={"family": "composed@1", "mechanics": []}, source="editor"
    )
    updated = await rest.put_game_definition("g1", body, req)
    assert updated["definition"]["mechanics"] == []


@pytest.mark.asyncio
async def test_put_fires_on_change_with_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = ComposeStore(mongo_db, on_change=on_change)
    req = _req(compose_store=store)
    await rest.put_game_definition(
        "g1", rest.PutGameDefinitionBody(presentation={"x": 1}, source="editor"), req
    )
    assert events == ["editor"]


@pytest.mark.asyncio
async def test_validate_prefers_request_definition(mongo_db):
    store = ComposeStore(mongo_db)
    fake = FakeComposeRunner({"ok": False, "errors": ['UnknownState { referenced: "x" }']})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    res = await rest.validate_game_definition(
        "g1", rest.ValidateGameDefinitionBody(definition={"family": "composed@1"}), req
    )
    assert res == {"ok": False, "errors": ['UnknownState { referenced: "x" }']}
    job = fake.jobs[0]
    assert job["validate_only"] is True
    assert job["definition"] == {"family": "composed@1"}
    assert "out_path" not in job


@pytest.mark.asyncio
async def test_validate_falls_back_to_stored_definition(mongo_db):
    store = ComposeStore(mongo_db)
    fake = FakeComposeRunner({"ok": True})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    res = await rest.validate_game_definition("g1", rest.ValidateGameDefinitionBody(), req)
    assert res["ok"] is True
    assert fake.jobs[0]["definition"]["family"] == "composed@1"


@pytest.mark.asyncio
async def test_build_shapes_job_and_response(mongo_db):
    store = ComposeStore(mongo_db)
    metrics = {"rtp": 0.93, "hitRate": 0.4, "maxWinX": 60, "stateVisits": {"base": 100}}
    fake = FakeComposeRunner({"ok": True, "metrics": metrics})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    res = await rest.build_game_definition("g1", req)
    assert res == {"ok": True, "errors": None, "metrics": metrics, "packageId": "g1"}
    job = fake.jobs[0]
    assert job["package_id"] == "g1"
    assert job["validate_only"] is False
    assert job["seed_count"] == 10000
    assert isinstance(job["master_seed"], int)
    assert job["out_path"].replace("\\", "/").endswith("var/packages/g1.pkg")
    assert job["presentation"] is not None
    # deterministic per game: rebuilds reproduce the same pool
    await rest.build_game_definition("g1", req)
    assert fake.jobs[1]["master_seed"] == job["master_seed"]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest tests/test_compose_rest.py -q`
Expected: FAIL — `app.compose.rest` missing.

- [ ] **Step 3: Implement** — `studio/backend/app/compose/rest.py`:

```python
import hashlib

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.compose.models import compose_wire
from app.compose.runner import _REPO_ROOT

router = APIRouter()

SEED_COUNT = 10_000


def _master_seed(game_id: str) -> int:
    # Deterministic per game so rebuilds reproduce the same pool (spec section 5).
    return int.from_bytes(hashlib.sha256(game_id.encode()).digest()[:8], "big")


class PutGameDefinitionBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    definition: dict | None = None
    presentation: dict | None = None
    source: str = "api"


class ValidateGameDefinitionBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    definition: dict | None = None


@router.get("/games/{game_id}/game-definition")
async def get_game_definition(game_id: str, request: Request) -> dict:
    doc = await request.app.state.compose_store.get_or_seed(game_id)
    return compose_wire(doc)


@router.put("/games/{game_id}/game-definition")
async def put_game_definition(game_id: str, body: PutGameDefinitionBody, request: Request) -> dict:
    doc = await request.app.state.compose_store.put(
        game_id, definition=body.definition, presentation=body.presentation, source=body.source
    )
    return compose_wire(doc)


@router.post("/games/{game_id}/game-definition/validate")
async def validate_game_definition(
    game_id: str, body: ValidateGameDefinitionBody, request: Request
) -> dict:
    definition = body.definition
    if definition is None:
        definition = (await request.app.state.compose_store.get_or_seed(game_id)).definition
    job = {
        "definition": definition,
        "package_id": game_id,
        "master_seed": _master_seed(game_id),
        "validate_only": True,
    }
    res = await request.app.state.compose_runner.run(job)
    return {"ok": bool(res.get("ok")), "errors": res.get("errors", [])}


@router.post("/games/{game_id}/game-definition/build")
async def build_game_definition(game_id: str, request: Request) -> dict:
    doc = await request.app.state.compose_store.get_or_seed(game_id)
    out_dir = _REPO_ROOT / request.app.state.settings.packages_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    job = {
        "definition": doc.definition,
        "presentation": doc.presentation,
        "package_id": game_id,
        "seed_count": SEED_COUNT,
        "master_seed": _master_seed(game_id),
        "out_path": str(out_dir / f"{game_id}.pkg"),
        "validate_only": False,
    }
    res = await request.app.state.compose_runner.run(job)
    return {
        "ok": bool(res.get("ok")),
        "errors": res.get("errors"),
        "metrics": res.get("metrics"),
        "packageId": game_id,
    }
```

Then wire `studio/backend/app/main.py` inside `build(settings)` — mirror the `slot_model_changed` block exactly (place it right after the math wiring):

```python
    async def _on_game_definition_change(doc, source: str) -> None:
        # Single choke point: every definition/presentation write reaches any
        # open Game Structure pane. Room join reuses the existing join_sim
        # handler (the room is the bare gameId). ponytail: no compose hub —
        # add one only when compose grows push flows beyond this one event.
        await sio.emit(
            "game_definition_changed",
            {"gameId": doc.game_id, "updatedAt": doc.updated_at, "source": source},
            room=doc.game_id,
        )

    compose_store = ComposeStore(mongo[settings.mongo_db], on_change=_on_game_definition_change)
    compose_runner = build_compose_runner(settings)
```

and with the other state registrations + router includes:

```python
    fastapi_app.state.compose_store = compose_store
    fastapi_app.state.compose_runner = compose_runner
    fastapi_app.include_router(compose_router)
```

with imports at the top of main.py:

```python
from app.compose.rest import router as compose_router
from app.compose.runner import build_compose_runner
from app.compose.store import ComposeStore
```

- [ ] **Step 4: Run to verify pass**

Run: `cd studio/backend && uv run pytest tests/test_compose_rest.py -q` → 6 PASS.
Then the whole backend: `uv run pytest -m "not e2e" -q` → no regressions (main.py `build()` is exercised by the `ctx` fixture).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/compose studio/backend/app/main.py studio/backend/tests/test_compose_rest.py
git commit -m "feat(compose): game-definition REST (get/put/validate/build) + socket emit"
```

---

### Task 8: Plugin domain model — `model.ts` + `vocab.ts`

**Files:**

- Create: `studio/frontend/src/plugins/game-structure/model.ts`
- Create: `studio/frontend/src/plugins/game-structure/vocab.ts`
- Test: `studio/frontend/src/plugins/game-structure/model.spec.ts`, `vocab.spec.ts`

**Interfaces:**

- Produces (all later frontend tasks use these):
  - Types (Rust serde wire shape, snake_case): `IMechanicDecl {id, type, config}`, `IBinding {mechanic, override?}`, `IStepsSpec {budget: number|'awarded', initial?}`, `IScriptEntry {invoke}`, `IStateDef {id, bindings, steps, script}`, `ITransitionRow {from, on, to?, effect?}`, `IGameDefinition {family, mechanics, states, start, transitions, caps: {max_steps}}`.
  - `emptyDefinition(): IGameDefinition` (family `composed@1`, empty lists, start `''`, `caps.max_steps: 1000`).
  - `normalizeDefinition(raw: unknown): IGameDefinition` — pure; malformed/missing top-level fields get defaults, well-formed input passes through untouched; mechanic `config` and binding `override` are opaque (never normalized deep).
  - `vocab.ts`: `MECHANIC_CATALOG: IMechanicCatalogEntry[]` (`{type, label, defaultConfig}` for `reels@1` and `meter@1`), `ACTIONS: Record<string, string[]>` (`{'reels@1': ['spin'], 'meter@1': ['accumulate']}`), `STEPS_EXHAUSTED = 'steps:exhausted'`, `emittableEvents(def: IGameDefinition): string[]`, `invokeOptions(def: IGameDefinition, state: IStateDef): string[]`.

- [ ] **Step 1: Write failing tests.**

`model.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyDefinition, normalizeDefinition, type IGameDefinition } from './model';

function full(): IGameDefinition {
  return {
    family: 'composed@1',
    mechanics: [
      { id: 'main_reels', type: 'reels@1', config: { rows: 3, strips: [[0]], symbols: [], paylines: [], paytable: { entries: [] }, events: [] } },
      { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } },
    ],
    states: [
      {
        id: 'base',
        bindings: [{ mechanic: 'main_reels' }, { mechanic: 'bonus_meter' }],
        steps: { budget: 1 },
        script: [{ invoke: 'main_reels.spin' }, { invoke: 'bonus_meter.accumulate' }],
      },
      {
        id: 'fs1',
        bindings: [{ mechanic: 'main_reels', override: { multiplier: 2 } }],
        steps: { budget: 'awarded', initial: 8 },
        script: [{ invoke: 'main_reels.spin' }],
      },
    ],
    start: 'base',
    transitions: [
      { from: 'base', on: 'scatters:3', to: 'fs1' },
      { from: 'fs1', on: 'scatters:3', effect: 'steps:add:8' },
    ],
    caps: { max_steps: 1000 },
  };
}

describe('normalizeDefinition', () => {
  it('passes a complete definition through untouched', () => {
    const def = full();
    expect(normalizeDefinition(def)).toEqual(def);
  });

  it('defaults null/undefined/garbage to emptyDefinition', () => {
    expect(normalizeDefinition(null)).toEqual(emptyDefinition());
    expect(normalizeDefinition(undefined)).toEqual(emptyDefinition());
    expect(normalizeDefinition(42)).toEqual(emptyDefinition());
  });

  it('repairs missing top-level fields but keeps good ones', () => {
    const got = normalizeDefinition({ family: 'composed@1', start: 'base' });
    expect(got.start).toBe('base');
    expect(got.mechanics).toEqual([]);
    expect(got.transitions).toEqual([]);
    expect(got.caps).toEqual({ max_steps: 1000 });
  });

  it('is pure', () => {
    const raw = full();
    const snapshot = JSON.stringify(raw);
    normalizeDefinition(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});
```

`vocab.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyDefinition } from './model';
import { ACTIONS, MECHANIC_CATALOG, STEPS_EXHAUSTED, emittableEvents, invokeOptions } from './vocab';

function def() {
  const d = emptyDefinition();
  d.mechanics = [
    { id: 'r', type: 'reels@1', config: { events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }] } },
    { id: 'm', type: 'meter@1', config: { target: 6 } },
  ];
  d.states = [{ id: 's', bindings: [{ mechanic: 'r' }, { mechanic: 'm' }], steps: { budget: 1 }, script: [] }];
  return d;
}

describe('vocab', () => {
  it('catalog covers the two shipped mechanics with default configs', () => {
    expect(MECHANIC_CATALOG.map((c) => c.type)).toEqual(['reels@1', 'meter@1']);
    for (const c of MECHANIC_CATALOG) expect(c.defaultConfig).toBeTruthy();
  });

  it('emittableEvents = reels emit strings + meter:full (when a meter exists) + steps:exhausted', () => {
    expect(emittableEvents(def())).toEqual(['scatters:3', 'meter:full', STEPS_EXHAUSTED]);
    const noMeter = def();
    noMeter.mechanics = noMeter.mechanics.filter((m) => m.type !== 'meter@1');
    expect(emittableEvents(noMeter)).toEqual(['scatters:3', STEPS_EXHAUSTED]);
  });

  it('emittableEvents dedupes and keeps first-seen order', () => {
    const d = def();
    d.mechanics.push({ id: 'r2', type: 'reels@1', config: { events: [{ symbol: 9, min_count: 4, emit: 'scatters:3' }] } });
    expect(emittableEvents(d)).toEqual(['scatters:3', 'meter:full', STEPS_EXHAUSTED]);
  });

  it('invokeOptions lists <bound instance>.<action> pairs only', () => {
    const d = def();
    expect(invokeOptions(d, d.states[0])).toEqual(['r.spin', 'm.accumulate']);
    expect(ACTIONS['reels@1']).toEqual(['spin']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/frontend && npx vitest run src/plugins/game-structure`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement.**

`model.ts`:

```ts
// composed@1 GameDefinition — Rust serde wire shape (snake_case), kept 1:1 with
// trusted/math/src/mechanics/composed/definition.rs. Mechanic config and binding
// override are opaque JSON here; the kernel is the only validator.

export interface IMechanicDecl {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface IBinding {
  mechanic: string;
  override?: Record<string, unknown>;
}

export interface IStepsSpec {
  budget: number | 'awarded';
  initial?: number;
}

export interface IScriptEntry {
  invoke: string; // "<instance_id>.<action>"
}

export interface IStateDef {
  id: string;
  bindings: IBinding[];
  steps: IStepsSpec;
  script: IScriptEntry[];
}

export interface ITransitionRow {
  from: string;
  on: string;
  to?: string;
  effect?: string; // "steps:add:<n>"
}

export interface IGameDefinition {
  family: string;
  mechanics: IMechanicDecl[];
  states: IStateDef[];
  start: string;
  transitions: ITransitionRow[];
  caps: { max_steps: number };
}

export function emptyDefinition(): IGameDefinition {
  return { family: 'composed@1', mechanics: [], states: [], start: '', transitions: [], caps: { max_steps: 1000 } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pure. Top-level shape repair only; deep mechanic config / overrides pass through. */
export function normalizeDefinition(raw: unknown): IGameDefinition {
  if (!isRecord(raw)) return emptyDefinition();
  const base = emptyDefinition();
  const caps = isRecord(raw.caps) && typeof raw.caps.max_steps === 'number' ? { max_steps: raw.caps.max_steps } : base.caps;
  return {
    family: typeof raw.family === 'string' ? raw.family : base.family,
    mechanics: Array.isArray(raw.mechanics) ? (raw.mechanics as IMechanicDecl[]) : [],
    states: Array.isArray(raw.states) ? (raw.states as IStateDef[]) : [],
    start: typeof raw.start === 'string' ? raw.start : '',
    transitions: Array.isArray(raw.transitions) ? (raw.transitions as ITransitionRow[]) : [],
    caps,
  };
}
```

`vocab.ts`:

```ts
import type { IGameDefinition, IStateDef } from './model';

export interface IMechanicCatalogEntry {
  type: string;
  label: string;
  defaultConfig: Record<string, unknown>;
}

// Hardcoded per shipped mechanic; a registry is YAGNI until mechanic #3 exists.
export const MECHANIC_CATALOG: IMechanicCatalogEntry[] = [
  {
    type: 'reels@1',
    label: 'Reels',
    defaultConfig: {
      strips: [
        [0, 1, 2, 0, 9, 1, 0, 2, 1, 0],
        [1, 0, 2, 9, 0, 1, 2, 0, 0, 1],
        [2, 1, 0, 0, 1, 9, 0, 2, 1, 0],
      ],
      rows: 3,
      symbols: [
        { id: 0, role: 'normal' },
        { id: 1, role: 'normal' },
        { id: 2, role: 'normal' },
        { id: 9, role: 'scatter' },
      ],
      paylines: [
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
      ],
      paytable: {
        entries: [
          { symbol: 0, count: 3, payout: 5 },
          { symbol: 1, count: 3, payout: 10 },
          { symbol: 2, count: 3, payout: 20 },
          { symbol: 9, count: 3, payout: 2 },
        ],
      },
      events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }],
    },
  },
  {
    type: 'meter@1',
    label: 'Meter',
    defaultConfig: { target: 6, count_symbol: 9, reset_on_full: true },
  },
];

export const ACTIONS: Record<string, string[]> = {
  'reels@1': ['spin'],
  'meter@1': ['accumulate'],
};

export const STEPS_EXHAUSTED = 'steps:exhausted';

interface IReelsEvent {
  emit?: unknown;
}

/** Events transitions may bind `on` to: every reels emit string, meter:full if
 *  any meter instance exists, plus the kernel-synthesized steps:exhausted. */
export function emittableEvents(def: IGameDefinition): string[] {
  const out: string[] = [];
  for (const m of def.mechanics) {
    if (m.type === 'reels@1') {
      const events = (m.config.events as IReelsEvent[] | undefined) ?? [];
      for (const e of events) {
        if (typeof e.emit === 'string' && !out.includes(e.emit)) out.push(e.emit);
      }
    }
  }
  if (def.mechanics.some((m) => m.type === 'meter@1') && !out.includes('meter:full')) out.push('meter:full');
  out.push(STEPS_EXHAUSTED);
  return out;
}

/** "<instance>.<action>" options for a state's script, from its bound instances. */
export function invokeOptions(def: IGameDefinition, state: IStateDef): string[] {
  const out: string[] = [];
  for (const b of state.bindings) {
    const decl = def.mechanics.find((m) => m.id === b.mechanic);
    if (!decl) continue;
    for (const action of ACTIONS[decl.type] ?? []) out.push(`${decl.id}.${action}`);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd studio/frontend && npx vitest run src/plugins/game-structure`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure
git commit -m "feat(game-structure): definition model + mechanic/event vocabulary"
```

---

### Task 9: Pure definition reducers

**Files:**

- Create: `studio/frontend/src/plugins/game-structure/reducers.ts`
- Test: `studio/frontend/src/plugins/game-structure/reducers.spec.ts`

**Interfaces:**

- Consumes: `IGameDefinition` etc. (Task 8), `MECHANIC_CATALOG` (Task 8).
- Produces (sections in Tasks 12-13 call these; every reducer is `(def, …) => IGameDefinition`, PURE):
  `addMechanic(def, type)`, `removeMechanic(def, index)`, `renameMechanic(def, index, newId)`, `setMechanicConfig(def, index, config)`,
  `addState(def)`, `removeState(def, index)`, `renameState(def, index, newId)`, `setStateBudget(def, index, budget, initial?)`,
  `toggleBinding(def, stateIndex, mechanicId)`, `setBindingOverride(def, stateIndex, bindingIndex, override | undefined)`,
  `addScriptStep(def, stateIndex, invoke)`, `removeScriptStep(def, stateIndex, stepIndex)`, `moveScriptStep(def, stateIndex, stepIndex, dir: -1|1)`,
  `addTransition(def)`, `removeTransition(def, index)`, `setTransition(def, index, row: ITransitionRow)`,
  `setStart(def, stateId)`, `setMaxSteps(def, n)`.

Reference semantics (test them explicitly):

- `renameMechanic` also rewrites every `bindings[].mechanic` and every `script[].invoke` prefix that referenced the old id.
- `renameState` also rewrites `start` and every `transitions[].from`/`.to` that referenced the old id.
- `removeMechanic` also drops bindings and script steps that referenced it (dangling references would otherwise need kernel errors to find).
- `removeState` also drops transitions from/to it and clears `start` if it pointed there.
- `addMechanic` generates a unique id from the type (`reels`, `reels_2`, `meter`, …) and copies `defaultConfig` (deep clone — never share the catalog object).
- `addState` generates `state_1`, `state_2`, … unique; budget `{budget: 1}`; if it is the first state, set `start` to it.
- `toggleBinding` adds `{mechanic}` if absent, else removes it (and its script steps).
- `setTransition` stores exactly one of `to`/`effect` (delete the other key).

- [ ] **Step 1: Write failing tests** — `reducers.spec.ts`. Use a `base()` factory built from `emptyDefinition()` + two mechanics + two states + one transition (same shape as model.spec's `full()`). Cover, at minimum:

```ts
import { describe, expect, it } from 'vitest';
import { emptyDefinition, type IGameDefinition } from './model';
import {
  addMechanic,
  addScriptStep,
  addState,
  addTransition,
  moveScriptStep,
  removeMechanic,
  removeScriptStep,
  removeState,
  removeTransition,
  renameMechanic,
  renameState,
  setBindingOverride,
  setMaxSteps,
  setMechanicConfig,
  setStart,
  setStateBudget,
  setTransition,
  toggleBinding,
} from './reducers';

function base(): IGameDefinition {
  return {
    family: 'composed@1',
    mechanics: [
      { id: 'r', type: 'reels@1', config: { rows: 3, events: [] } },
      { id: 'm', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } },
    ],
    states: [
      { id: 'base', bindings: [{ mechanic: 'r' }, { mechanic: 'm' }], steps: { budget: 1 }, script: [{ invoke: 'r.spin' }, { invoke: 'm.accumulate' }] },
      { id: 'fs1', bindings: [{ mechanic: 'r', override: { multiplier: 2 } }], steps: { budget: 'awarded', initial: 8 }, script: [{ invoke: 'r.spin' }] },
    ],
    start: 'base',
    transitions: [{ from: 'base', on: 'scatters:3', to: 'fs1' }],
    caps: { max_steps: 1000 },
  };
}

describe('purity', () => {
  it('reducers never mutate their input', () => {
    const d = base();
    const snapshot = JSON.stringify(d);
    addMechanic(d, 'meter@1');
    renameMechanic(d, 0, 'r2');
    removeState(d, 0);
    setTransition(d, 0, { from: 'fs1', on: 'meter:full', effect: 'steps:add:3' });
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('mechanics', () => {
  it('addMechanic clones the catalog default config and generates unique ids', () => {
    let d = addMechanic(base(), 'reels@1');
    expect(d.mechanics[2].id).toBe('reels');
    d = addMechanic(d, 'reels@1');
    expect(d.mechanics[3].id).toBe('reels_2');
    d.mechanics[2].config.rows = 99 as unknown as number;
    expect(addMechanic(base(), 'reels@1').mechanics[2].config.rows).toBe(3);
  });

  it('renameMechanic rewrites bindings and script invokes', () => {
    const d = renameMechanic(base(), 0, 'wheel');
    expect(d.states[0].bindings[0].mechanic).toBe('wheel');
    expect(d.states[0].script[0].invoke).toBe('wheel.spin');
    expect(d.states[1].script[0].invoke).toBe('wheel.spin');
  });

  it('removeMechanic drops dependent bindings and script steps', () => {
    const d = removeMechanic(base(), 0);
    expect(d.mechanics.map((m) => m.id)).toEqual(['m']);
    expect(d.states[0].bindings).toEqual([{ mechanic: 'm' }]);
    expect(d.states[0].script).toEqual([{ invoke: 'm.accumulate' }]);
    expect(d.states[1].bindings).toEqual([]);
  });
});

describe('states', () => {
  it('addState numbers uniquely and first state becomes start', () => {
    let d = emptyDefinition();
    d = addState(d);
    expect(d.states[0].id).toBe('state_1');
    expect(d.start).toBe('state_1');
    d = addState(d);
    expect(d.states[1].id).toBe('state_2');
    expect(d.start).toBe('state_1');
  });

  it('renameState rewrites start and transitions', () => {
    const d = renameState(base(), 0, 'main');
    expect(d.start).toBe('main');
    expect(d.transitions[0].from).toBe('main');
  });

  it('removeState drops its transitions and clears a dangling start', () => {
    const d = removeState(base(), 0);
    expect(d.states.map((s) => s.id)).toEqual(['fs1']);
    expect(d.transitions).toEqual([]);
    expect(d.start).toBe('');
  });

  it('setStateBudget switches fixed/awarded shapes', () => {
    let d = setStateBudget(base(), 0, 'awarded', 5);
    expect(d.states[0].steps).toEqual({ budget: 'awarded', initial: 5 });
    d = setStateBudget(d, 0, 3);
    expect(d.states[0].steps).toEqual({ budget: 3 });
  });

  it('toggleBinding removes the binding and its script steps', () => {
    const d = toggleBinding(base(), 0, 'm');
    expect(d.states[0].bindings).toEqual([{ mechanic: 'r' }]);
    expect(d.states[0].script).toEqual([{ invoke: 'r.spin' }]);
    const back = toggleBinding(d, 0, 'm');
    expect(back.states[0].bindings).toEqual([{ mechanic: 'r' }, { mechanic: 'm' }]);
  });

  it('setBindingOverride sets and clears', () => {
    let d = setBindingOverride(base(), 0, 0, { multiplier: 3 });
    expect(d.states[0].bindings[0].override).toEqual({ multiplier: 3 });
    d = setBindingOverride(d, 0, 0, undefined);
    expect(d.states[0].bindings[0]).toEqual({ mechanic: 'r' });
  });

  it('script add/remove/move', () => {
    let d = addScriptStep(base(), 1, 'r.spin');
    expect(d.states[1].script).toHaveLength(2);
    d = moveScriptStep(base(), 0, 1, -1);
    expect(d.states[0].script.map((s) => s.invoke)).toEqual(['m.accumulate', 'r.spin']);
    d = removeScriptStep(base(), 0, 0);
    expect(d.states[0].script).toEqual([{ invoke: 'm.accumulate' }]);
  });
});

describe('transitions + caps', () => {
  it('setTransition keeps exactly one of to/effect', () => {
    let d = setTransition(base(), 0, { from: 'base', on: 'meter:full', effect: 'steps:add:8' });
    expect(d.transitions[0]).toEqual({ from: 'base', on: 'meter:full', effect: 'steps:add:8' });
    d = setTransition(d, 0, { from: 'base', on: 'meter:full', to: 'fs1' });
    expect(d.transitions[0]).toEqual({ from: 'base', on: 'meter:full', to: 'fs1' });
  });

  it('add/removeTransition, setStart, setMaxSteps', () => {
    let d = addTransition(base());
    expect(d.transitions).toHaveLength(2);
    d = removeTransition(d, 0);
    expect(d.transitions).toHaveLength(1);
    d = setStart(d, 'fs1');
    expect(d.start).toBe('fs1');
    d = setMaxSteps(d, 200);
    expect(d.caps.max_steps).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/frontend && npx vitest run src/plugins/game-structure/reducers.spec.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `reducers.ts`.** All reducers rebuild via structured spread/`map`/`filter`; deep-clone only where an object crosses from shared constants (catalog `defaultConfig` via `structuredClone`). Representative implementations (write all of them in this style):

```ts
import type { IGameDefinition, IStateDef, ITransitionRow } from './model';
import { MECHANIC_CATALOG } from './vocab';

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function addMechanic(def: IGameDefinition, type: string): IGameDefinition {
  const entry = MECHANIC_CATALOG.find((c) => c.type === type);
  if (!entry) return def;
  const base = type.split('@')[0];
  const id = uniqueId(base, new Set(def.mechanics.map((m) => m.id)));
  return { ...def, mechanics: [...def.mechanics, { id, type, config: structuredClone(entry.defaultConfig) }] };
}

export function renameMechanic(def: IGameDefinition, index: number, newId: string): IGameDefinition {
  const old = def.mechanics[index]?.id;
  if (!old || !newId || def.mechanics.some((m, i) => i !== index && m.id === newId)) return def;
  return {
    ...def,
    mechanics: def.mechanics.map((m, i) => (i === index ? { ...m, id: newId } : m)),
    states: def.states.map((s) => ({
      ...s,
      bindings: s.bindings.map((b) => (b.mechanic === old ? { ...b, mechanic: newId } : b)),
      script: s.script.map((e) => (e.invoke.startsWith(`${old}.`) ? { invoke: `${newId}.${e.invoke.slice(old.length + 1)}` } : e)),
    })),
  };
}

export function removeMechanic(def: IGameDefinition, index: number): IGameDefinition {
  const gone = def.mechanics[index]?.id;
  if (gone === undefined) return def;
  return {
    ...def,
    mechanics: def.mechanics.filter((_, i) => i !== index),
    states: def.states.map((s) => ({
      ...s,
      bindings: s.bindings.filter((b) => b.mechanic !== gone),
      script: s.script.filter((e) => !e.invoke.startsWith(`${gone}.`)),
    })),
  };
}
```

…and the rest per the Interfaces block. `setTransition` sanitizes:

```ts
export function setTransition(def: IGameDefinition, index: number, row: ITransitionRow): IGameDefinition {
  const clean: ITransitionRow = { from: row.from, on: row.on };
  if (row.effect !== undefined) clean.effect = row.effect;
  else if (row.to !== undefined) clean.to = row.to;
  return { ...def, transitions: def.transitions.map((t, i) => (i === index ? clean : t)) };
}
```

`addTransition` appends `{from: def.start || (def.states[0]?.id ?? ''), on: '', to: def.states[0]?.id ?? ''}`. `addState` uses `uniqueId('state_1'…)` — number from 1 counting existing `state_*` ids via the same `uniqueId('state', taken)` scheme is fine as long as the test's expectations hold (`state_1`, `state_2`): implement as `uniqueId` over base `state_${states.length + 1}` then fall back — simplest correct: try `state_${n}` for n = 1.. until free.

- [ ] **Step 4: Run to verify pass**

Run: `cd studio/frontend && npx vitest run src/plugins/game-structure`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure/reducers.ts studio/frontend/src/plugins/game-structure/reducers.spec.ts
git commit -m "feat(game-structure): pure definition reducers with reference rewriting"
```

---

### Task 10: State slice + REST client + socket client

**Files:**

- Create: `studio/frontend/src/plugins/game-structure/config.ts`
- Create: `studio/frontend/src/plugins/game-structure/state.ts`
- Create: `studio/frontend/src/plugins/game-structure/restClient.ts`
- Create: `studio/frontend/src/plugins/game-structure/socketClient.ts`
- Test: `studio/frontend/src/plugins/game-structure/restClient.spec.ts`

**Interfaces:**

- Consumes: Task 7's wire; `makePluginHooks`/`rootStore` (existing host state utilities — same imports as game-config's `state.ts`).
- Produces (Tasks 11-14 rely on):
  - `GAME_STRUCTURE_PLUGIN_ID = 'game-structure'`, `gameStructureHooks`, `gameStructureSlice()`.
  - `GsTab = 'mechanics' | 'states' | 'transitions' | 'json'`; `GsSync = 'idle' | 'saving' | 'saved' | 'external' | 'error'`.
  - `IGameStructureState { activeGameId, definition: IGameDefinition | null, presentation: Record<string, unknown>, jsonDraft, jsonError, activeTab, sync, externalSource, watermark, loadStatus, validation: { status: 'idle'|'checking'|'ok'|'errors'; errors: string[] }, build: { status: 'idle'|'building'|'done'|'error'; metrics: IComposeMetrics | null; errors: string[] } }` + `makeInitialState()`.
  - `restClient.ts`: `IGameDefinitionWireDoc {id, gameId, definition, presentation, updatedAt}`, `IPutGameDefinitionPatch {definition?, presentation?, source}`, `IComposeMetrics {rtp, hitRate, maxWinX, stateVisits: Record<string, number>}`, `IBuildResponse {ok, errors, metrics, packageId}`, `getGameDefinition(gameId)`, `putGameDefinition(gameId, patch)`, `validateGameDefinition(gameId, definition)` → `{ok, errors}`, `buildGameDefinition(gameId)` → `IBuildResponse`.
  - `socketClient.ts`: `IDefinitionChangedEvent {gameId, updatedAt, source}`, `setDefinitionChangedHandler(h)`, `gameStructureSock()` with `connect/disconnect/join/leave` — join/leave emit the EXISTING `join_sim`/`leave_sim` events (room = gameId; no new backend handlers).

- [ ] **Step 1: Write failing test** — `restClient.spec.ts` (mirror game-config's `restClient.spec.ts` style: stub global `fetch`, assert URL/method/body and parsed result). Cover `getGameDefinition` URL, `putGameDefinition` PUT body passthrough, `validateGameDefinition` POST body `{definition}`, `buildGameDefinition` POST with empty body, and non-ok → throw.

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGameDefinition, getGameDefinition, putGameDefinition, validateGameDefinition } from './restClient';

function okResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('restClient', () => {
  it('GETs the game-definition doc', async () => {
    const fetchMock = vi.fn(async () => okResponse({ gameId: 'g1' }));
    vi.stubGlobal('fetch', fetchMock);
    const doc = await getGameDefinition('g1');
    expect(doc.gameId).toBe('g1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/games/g1/game-definition');
  });

  it('PUTs a partial patch with source', async () => {
    const fetchMock = vi.fn(async () => okResponse({ gameId: 'g1' }));
    vi.stubGlobal('fetch', fetchMock);
    await putGameDefinition('g1', { presentation: { x: 1 }, source: 'editor' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ presentation: { x: 1 }, source: 'editor' });
  });

  it('POSTs validate with the live definition', async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: false, errors: ['boom'] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await validateGameDefinition('g1', { family: 'composed@1' } as never);
    expect(res.errors).toEqual(['boom']);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/games/g1/game-definition/validate');
    expect(JSON.parse(String(init.body))).toEqual({ definition: { family: 'composed@1' } });
  });

  it('POSTs build and surfaces failures as thrown errors', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(buildGameDefinition('g1')).rejects.toThrow('500');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/plugins/game-structure/restClient.spec.ts` → FAIL.

- [ ] **Step 3: Implement.** `config.ts` is one line: `export { BACKEND_URL } from '../assets/config';`

`state.ts` — clone game-config's `state.ts` with the state shape from the Interfaces block (drop locks/lens/reelset; add `validation` + `build`). `makeInitialState()` returns `{ activeGameId: null, definition: null, presentation: {}, jsonDraft: '', jsonError: null, activeTab: 'mechanics', sync: 'idle', externalSource: null, watermark: '', loadStatus: 'idle', validation: { status: 'idle', errors: [] }, build: { status: 'idle', metrics: null, errors: [] } }`.

`restClient.ts` — clone game-config's `restClient.ts` `okJson` helper, endpoints per Interfaces:

```ts
export async function validateGameDefinition(gameId: string, definition: IGameDefinition): Promise<{ ok: boolean; errors: string[] }> {
  return okJson(
    await fetch(`${BACKEND_URL}/games/${gameId}/game-definition/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    }),
  );
}

export async function buildGameDefinition(gameId: string): Promise<IBuildResponse> {
  return okJson(
    await fetch(`${BACKEND_URL}/games/${gameId}/game-definition/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}
```

`socketClient.ts` — clone game-config's `socketClient.ts` verbatim with renames: event `game_definition_changed`, handler setter `setDefinitionChangedHandler`, auth displayName `game-structure`, socket accessor `gameStructureSock()`; `join`/`leave` still emit `join_sim`/`leave_sim` with a comment: `// Reuses the existing join_sim room (room == gameId); compose has no handlers of its own.`

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/plugins/game-structure` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure
git commit -m "feat(game-structure): plugin state slice, REST client, socket seam"
```

---

### Task 11: Actions — hydrate, debounced save, watermark, JSON apply, debounced validate, build

**Files:**

- Create: `studio/frontend/src/plugins/game-structure/actions.ts`
- Test: `studio/frontend/src/plugins/game-structure/actions.spec.ts`

**Interfaces:**

- Consumes: Tasks 8-10 (`normalizeDefinition`, slice, rest/socket clients).
- Produces (pane/sections in Tasks 12-14 call ONLY these):
  - `initGameStructure()` (socket connect + handler), `openGameStructure(gameId)`, `closeGameStructure()` (leave room, reset slice)
  - `applyDefinition(fn: (d: IGameDefinition) => IGameDefinition)` — writes slice, refreshes `jsonDraft`, schedules save AND debounced validate
  - `applyDocFromJson(text): boolean` — whole-doc `{definition, presentation}` parse/apply
  - `flushPendingSave()`, `SAVE_DEBOUNCE_MS = 600`, `VALIDATE_DEBOUNCE_MS = 800`, `EXTERNAL_FLASH_MS = 4000`
  - `handleDefinitionChanged(p: IDefinitionChangedEvent)` — watermark gate identical to game-config
  - `requestValidate()` (immediate), `buildPackage(): Promise<void>` — flushes pending save first, sets `build.status`, stores metrics/errors.

- [ ] **Step 1: Write failing tests** — `actions.spec.ts`, mirroring game-config's `actions.spec.ts` mocking style (`vi.mock('./restClient')`, `vi.mock('./socketClient')`, fake timers). Cover:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDefinition } from './model';
import { gameStructureSlice, makeInitialState } from './state';

vi.mock('./restClient', () => ({
  getGameDefinition: vi.fn(),
  putGameDefinition: vi.fn(),
  validateGameDefinition: vi.fn(),
  buildGameDefinition: vi.fn(),
}));
vi.mock('./socketClient', () => ({
  setDefinitionChangedHandler: vi.fn(),
  gameStructureSock: () => ({ connect: vi.fn(), disconnect: vi.fn(), join: vi.fn(), leave: vi.fn() }),
}));

import * as rest from './restClient';
import {
  SAVE_DEBOUNCE_MS,
  VALIDATE_DEBOUNCE_MS,
  applyDefinition,
  applyDocFromJson,
  buildPackage,
  flushPendingSave,
  handleDefinitionChanged,
  openGameStructure,
} from './actions';

const restMock = rest as unknown as Record<string, ReturnType<typeof vi.fn>>;

function wireDoc(over: Partial<Record<string, unknown>> = {}) {
  return { id: 'd1', gameId: 'g1', definition: emptyDefinition(), presentation: { p: 1 }, updatedAt: '2026-07-09T00:00:00Z', ...over };
}

beforeEach(() => {
  gameStructureSlice().set(makeInitialState());
  vi.useFakeTimers();
  restMock.getGameDefinition.mockResolvedValue(wireDoc());
  restMock.putGameDefinition.mockResolvedValue(wireDoc({ updatedAt: '2026-07-09T00:00:01Z' }));
  restMock.validateGameDefinition.mockResolvedValue({ ok: true, errors: [] });
  restMock.buildGameDefinition.mockResolvedValue({
    ok: true,
    errors: null,
    metrics: { rtp: 1, hitRate: 0.3, maxWinX: 9, stateVisits: { base: 10 } },
    packageId: 'g1',
  });
});
afterEach(() => vi.useRealTimers());

describe('openGameStructure', () => {
  it('hydrates doc + watermark', async () => {
    await openGameStructure('g1');
    const s = gameStructureSlice();
    expect(s.definition.get({ noproxy: true })).toEqual(emptyDefinition());
    expect(s.watermark.get()).toBe('2026-07-09T00:00:00Z');
    expect(s.loadStatus.get()).toBe('idle');
  });
});

describe('applyDefinition', () => {
  it('debounces a partial PUT with source editor and refreshes jsonDraft', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'base' }));
    expect(gameStructureSlice().sync.get()).toBe('saving');
    expect(gameStructureSlice().jsonDraft.get()).toContain('"start": "base"');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(restMock.putGameDefinition).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ source: 'editor', definition: expect.objectContaining({ start: 'base' }) }),
    );
    expect(gameStructureSlice().sync.get()).toBe('saved');
  });

  it('schedules a debounced kernel validate of the live definition', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'nope' }));
    restMock.validateGameDefinition.mockResolvedValue({ ok: false, errors: ['UnknownState'] });
    await vi.advanceTimersByTimeAsync(VALIDATE_DEBOUNCE_MS + 1);
    const v = gameStructureSlice().validation.get({ noproxy: true });
    expect(v.status).toBe('errors');
    expect(v.errors).toEqual(['UnknownState']);
  });
});

describe('watermark', () => {
  it('own editor echoes only advance the watermark; newer external writes rehydrate', async () => {
    await openGameStructure('g1');
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-09T00:00:05Z', source: 'editor' });
    expect(gameStructureSlice().watermark.get()).toBe('2026-07-09T00:00:05Z');
    expect(restMock.getGameDefinition).toHaveBeenCalledTimes(1);

    restMock.getGameDefinition.mockResolvedValue(wireDoc({ updatedAt: '2026-07-09T00:00:09Z' }));
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-09T00:00:09Z', source: 'api' });
    await vi.advanceTimersByTimeAsync(1);
    expect(restMock.getGameDefinition).toHaveBeenCalledTimes(2);
    expect(gameStructureSlice().sync.get()).toBe('external');
    expect(gameStructureSlice().externalSource.get()).toBe('api');
  });

  it('stale external events are ignored', async () => {
    await openGameStructure('g1');
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-08T00:00:00Z', source: 'api' });
    expect(restMock.getGameDefinition).toHaveBeenCalledTimes(1);
  });
});

describe('applyDocFromJson', () => {
  it('applies {definition, presentation} and rejects bad JSON', async () => {
    await openGameStructure('g1');
    expect(applyDocFromJson('{nope')).toBe(false);
    expect(gameStructureSlice().jsonError.get()).toBeTruthy();
    const ok = applyDocFromJson(JSON.stringify({ definition: { ...emptyDefinition(), start: 'x' }, presentation: { theme: 'y' } }));
    expect(ok).toBe(true);
    expect(gameStructureSlice().definition.start.get()).toBe('x');
    expect(gameStructureSlice().presentation.get({ noproxy: true })).toEqual({ theme: 'y' });
  });
});

describe('buildPackage', () => {
  it('flushes the pending save, then stores metrics', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'base' }));
    await buildPackage();
    expect(restMock.putGameDefinition).toHaveBeenCalled(); // flushed before build
    const b = gameStructureSlice().build.get({ noproxy: true });
    expect(b.status).toBe('done');
    expect(b.metrics?.rtp).toBe(1);
  });

  it('stores kernel errors on a failed build', async () => {
    restMock.buildGameDefinition.mockResolvedValue({ ok: false, errors: ['BadCaps'], metrics: null, packageId: 'g1' });
    await openGameStructure('g1');
    await buildPackage();
    const b = gameStructureSlice().build.get({ noproxy: true });
    expect(b.status).toBe('error');
    expect(b.errors).toEqual(['BadCaps']);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/plugins/game-structure/actions.spec.ts` → FAIL.

- [ ] **Step 3: Implement `actions.ts`.** Clone game-config's `actions.ts` structure wholesale (module-level timers + dirty flags, `hydrateDoc`, `openGameStructure`, `scheduleSave`, `flushPendingSave` with `{definition?, presentation?, source: 'editor'}` patch, `handleDefinitionChanged` + `rehydrateExternal` with the same watermark rules and `EXTERNAL_FLASH_MS` flash). New pieces:

```ts
export const VALIDATE_DEBOUNCE_MS = 800;
let validateTimer: ReturnType<typeof setTimeout> | null = null;
let validateEpoch = 0; // drop out-of-order responses

export function applyDefinition(fn: (d: IGameDefinition) => IGameDefinition): void {
  const s = gameStructureSlice();
  const current = s.definition.get({ noproxy: true }) as IGameDefinition | null;
  if (!current) return;
  const next = fn(current);
  s.definition.set(next);
  s.jsonDraft.set(draftFor(next, s.presentation.get({ noproxy: true }) as Record<string, unknown>));
  scheduleSave('definition');
  scheduleValidate();
}

function draftFor(definition: IGameDefinition, presentation: Record<string, unknown>): string {
  return JSON.stringify({ definition, presentation }, null, 2);
}

function scheduleValidate(): void {
  if (validateTimer) clearTimeout(validateTimer);
  gameStructureSlice().validation.status.set('checking');
  validateTimer = setTimeout(() => void requestValidate(), VALIDATE_DEBOUNCE_MS);
}

export async function requestValidate(): Promise<void> {
  const s = gameStructureSlice();
  const gameId = s.activeGameId.get();
  const definition = s.definition.get({ noproxy: true }) as IGameDefinition | null;
  if (!gameId || !definition) return;
  const epoch = ++validateEpoch;
  try {
    const res = await validateGameDefinition(gameId, definition);
    if (epoch !== validateEpoch) return;
    s.validation.set(res.ok ? { status: 'ok', errors: [] } : { status: 'errors', errors: res.errors });
  } catch {
    if (epoch === validateEpoch) s.validation.set({ status: 'idle', errors: [] }); // transient; don't scare the user
  }
}

export function applyDocFromJson(text: string): boolean {
  const s = gameStructureSlice();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    s.jsonError.set(e instanceof Error ? e.message : 'invalid JSON');
    return false;
  }
  s.jsonError.set(null);
  const obj = (parsed ?? {}) as { definition?: unknown; presentation?: unknown };
  const definition = normalizeDefinition(obj.definition);
  const presentation = (obj.presentation ?? {}) as Record<string, unknown>;
  s.presentation.set(presentation);
  scheduleSave('presentation');
  applyDefinition(() => definition);
  return true;
}

export async function buildPackage(): Promise<void> {
  const s = gameStructureSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  await flushPendingSave(); // build reads the STORED doc — persist edits first
  s.build.set({ status: 'building', metrics: null, errors: [] });
  try {
    const res = await buildGameDefinition(gameId);
    if (res.ok) s.build.set({ status: 'done', metrics: res.metrics, errors: [] });
    else s.build.set({ status: 'error', metrics: null, errors: res.errors ?? ['build failed'] });
  } catch (e) {
    s.build.set({ status: 'error', metrics: null, errors: [e instanceof Error ? e.message : 'build failed'] });
  }
}
```

`hydrateDoc` sets `definition` via `normalizeDefinition(doc.definition)`, `presentation`, `jsonDraft` via `draftFor`, watermark — clone the game-config version. `closeGameStructure()` leaves the socket room and resets the slice to `makeInitialState()`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/plugins/game-structure` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure/actions.ts studio/frontend/src/plugins/game-structure/actions.spec.ts
git commit -m "feat(game-structure): actions - debounced save/validate, watermark sync, build"
```

---

### Task 12: Pane shell + plugin registration + Mechanics section

**Files:**

- Create: `studio/frontend/src/plugins/game-structure/GameStructurePane.tsx` (+ `.spec.tsx`)
- Create: `studio/frontend/src/plugins/game-structure/sections/MechanicsSection.tsx` (+ `.spec.tsx`)
- Create: `studio/frontend/src/plugins/game-structure/index.ts`
- Modify: `studio/frontend/src/plugins/index.ts` (register `gameStructure`)
- Modify: `studio/frontend/src/app/routes/RoomRoute.tsx` (+ `void openGameStructure(found.gameId)` beside the existing `openGameConfig` call) and its `.spec.tsx` (add the same mock the other open-calls have)

**Interfaces:**

- Consumes: Tasks 8-11. Reuse `CommittedInput`/`Stepper` FROM game-config: `import { CommittedInput } from '../game-config/components/CommittedInput';` (cross-plugin import of shared atoms is established practice — game plugins already import `../assets/config`).
- Produces: pane `game-structure/editor` (auto menu item testid `view-open-game-structure/editor`); test-ids prefixed `gs-*` (Tasks 13-14 + e2e Task 16 depend on the ids listed below).

Test-id contract (e2e-load-bearing, keep exact):
`gs-no-game`, `gs-tab-mechanics|states|transitions|json`, `gs-sync-pill`, `gs-validation-pill`, `gs-build`, `gs-play`, `gs-metrics`, `gs-validation-errors`,
`gs-mech-card-<id>`, `gs-mech-id-<id>`, `gs-mech-remove-<id>`, `gs-add-reels@1`, `gs-add-meter@1`,
`gs-meter-target-<id>` (Stepper), `gs-meter-count-symbol-<id>` (Stepper), `gs-meter-reset-<id>` (checkbox),
`gs-reels-rows-<id>` (Stepper), `gs-reels-event-emit-<id>-<i>` (CommittedInput), `gs-reels-add-event-<id>`, `gs-reels-remove-event-<id>-<i>`,
`gs-mech-config-json-<id>` (textarea), `gs-mech-config-apply-<id>`, `gs-mech-config-error-<id>`.

- [ ] **Step 1: Write failing pane test** — `GameStructurePane.spec.tsx` (mirror `GameConfigPane.spec.tsx`: render with the slice pre-set, assert empty state, tab switching, sync pill text):

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { GameStructurePane } from './GameStructurePane';
import { gameStructureSlice, makeInitialState } from './state';
import { emptyDefinition } from './model';

function seed() {
  const s = gameStructureSlice();
  s.set(makeInitialState());
  s.activeGameId.set('g1');
  s.definition.set({
    ...emptyDefinition(),
    mechanics: [{ id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } }],
  });
}

describe('GameStructurePane', () => {
  beforeEach(() => gameStructureSlice().set(makeInitialState()));

  it('shows the empty state without a game', () => {
    render(<GameStructurePane {...({} as never)} />);
    expect(screen.getByTestId('gs-no-game')).toBeInTheDocument();
  });

  it('renders tabs and switches sections', () => {
    seed();
    render(<GameStructurePane {...({} as never)} />);
    expect(screen.getByTestId('gs-tab-mechanics')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('gs-tab-transitions'));
    expect(gameStructureSlice().activeTab.get()).toBe('transitions');
  });

  it('surfaces validation errors in the pill', () => {
    seed();
    gameStructureSlice().validation.set({ status: 'errors', errors: ['UnknownState { referenced: "x" }'] });
    render(<GameStructurePane {...({} as never)} />);
    expect(screen.getByTestId('gs-validation-pill').textContent).toContain('1');
    expect(screen.getByTestId('gs-validation-errors').textContent).toContain('UnknownState');
  });
});
```

And `MechanicsSection.spec.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MechanicsSection } from './MechanicsSection';
import { gameStructureSlice, makeInitialState } from '../state';
import { emptyDefinition } from '../model';

function seed() {
  const s = gameStructureSlice();
  s.set(makeInitialState());
  s.activeGameId.set('g1');
  s.definition.set({
    ...emptyDefinition(),
    mechanics: [
      { id: 'main_reels', type: 'reels@1', config: { rows: 3, events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }], strips: [[0]] } },
      { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } },
    ],
  });
}

describe('MechanicsSection', () => {
  beforeEach(seed);

  it('renders a card per instance with typed fields', () => {
    render(<MechanicsSection />);
    expect(screen.getByTestId('gs-mech-card-main_reels')).toBeInTheDocument();
    expect(screen.getByTestId('gs-meter-target-bonus_meter')).toBeInTheDocument();
    expect(screen.getByTestId('gs-reels-rows-main_reels')).toBeInTheDocument();
    expect((screen.getByTestId('gs-reels-event-emit-main_reels-0') as HTMLInputElement).value).toBe('scatters:3');
  });

  it('add buttons append catalog mechanics', () => {
    render(<MechanicsSection />);
    fireEvent.click(screen.getByTestId('gs-add-meter@1'));
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.mechanics).toHaveLength(3);
    expect(def.mechanics[2].type).toBe('meter@1');
  });

  it('config JSON apply replaces the config and flags parse errors', () => {
    render(<MechanicsSection />);
    const ta = screen.getByTestId('gs-mech-config-json-bonus_meter');
    fireEvent.change(ta, { target: { value: '{"target": 9}' } });
    fireEvent.click(screen.getByTestId('gs-mech-config-apply-bonus_meter'));
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.mechanics[1].config).toEqual({ target: 9 });

    fireEvent.change(ta, { target: { value: '{oops' } });
    fireEvent.click(screen.getByTestId('gs-mech-config-apply-bonus_meter'));
    expect(screen.getByTestId('gs-mech-config-error-bonus_meter')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/plugins/game-structure` → FAIL (components missing).

- [ ] **Step 3: Implement.**

`GameStructurePane.tsx` — clone `GameConfigPane.tsx`'s skeleton (empty-state guard, header row, tab strip, section mount) minus stats/locks/template. Header right side: validation pill + Build/Play cluster placeholder (Task 14 fills it) + sync pill:

```tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import type { ReactElement } from 'react';
import { gameStructureHooks, type GsTab } from './state';
import type { IGameDefinition } from './model';
import { MechanicsSection } from './sections/MechanicsSection';
import { StatesSection } from './sections/StatesSection';
import { TransitionsSection } from './sections/TransitionsSection';
import { JsonSection } from './sections/JsonSection';
import { StatusPill, type StatusTone } from '../../components/StatusPill';

const TABS: { key: GsTab; label: string }[] = [
  { key: 'mechanics', label: 'Mechanics' },
  { key: 'states', label: 'States' },
  { key: 'transitions', label: 'Transitions' },
  { key: 'json', label: 'JSON' },
];

const SECTIONS: Record<GsTab, () => ReactElement> = {
  mechanics: MechanicsSection,
  states: StatesSection,
  transitions: TransitionsSection,
  json: JsonSection,
};
```

(Adjust the `StatusPill` import to wherever game-config's pane actually imports it from — read `GameConfigPane.tsx` first and use identical imports.) Body mirrors game-config: `gs-no-game` guard, sync label/tone derivation copied verbatim (same `GsSync` union), tab strip with `gs-tab-${key}`, active section in a scrollable flex body. Validation pill:

```tsx
const validation = s.validation.get({ noproxy: true });
const vLabel =
  validation.status === 'checking'
    ? 'checking…'
    : validation.status === 'errors'
      ? `${validation.errors.length} issue${validation.errors.length === 1 ? '' : 's'}`
      : validation.status === 'ok'
        ? 'valid'
        : '—';
const vTone: StatusTone = validation.status === 'errors' ? 'danger' : validation.status === 'ok' ? 'success' : 'neutral';
```

Below the tab strip, when `validation.status === 'errors'`, render the inline strip:

```tsx
{
  validation.status === 'errors' && (
    <div data-testid="gs-validation-errors" className="border-b border-hairline bg-raised px-3 py-1.5">
      {validation.errors.map((e, i) => (
        <p key={i} className="font-mono text-[11px] text-danger">
          {e}
        </p>
      ))}
    </div>
  );
}
```

NOTE: Task 13 creates `StatesSection`/`TransitionsSection` and Task 14 `JsonSection`. To keep THIS task green, create all three files now as minimal placeholders that Tasks 13-14 replace:

```tsx
export function StatesSection() {
  return (
    <div data-testid="gs-section-states" className="p-3 text-xs text-text-3">
      States — Task 13
    </div>
  );
}
```

(same pattern for the other two, with their `gs-section-*` testids).

`sections/MechanicsSection.tsx`:

```tsx
import { useState } from 'react';
import { gameStructureHooks } from '../state';
import type { IGameDefinition, IMechanicDecl } from '../model';
import { applyDefinition } from '../actions';
import { addMechanic, removeMechanic, renameMechanic, setMechanicConfig } from '../reducers';
import { MECHANIC_CATALOG } from '../vocab';
import { CommittedInput } from '../../game-config/components/CommittedInput';
import { Stepper } from '../../game-config/components/Stepper';

interface IReelsEventRow {
  symbol: number;
  min_count: number;
  emit: string;
}

function MeterFields({ decl, index }: { decl: IMechanicDecl; index: number }) {
  const cfg = decl.config as { target?: number; count_symbol?: number; reset_on_full?: boolean };
  const patch = (p: Record<string, unknown>) => applyDefinition((d) => setMechanicConfig(d, index, { ...d.mechanics[index].config, ...p }));
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-text-2">
      <span className="flex items-center gap-1.5">
        target <Stepper value={cfg.target ?? 0} min={1} onChange={(v) => patch({ target: v })} testId={`gs-meter-target-${decl.id}`} />
      </span>
      <span className="flex items-center gap-1.5">
        count symbol <Stepper value={cfg.count_symbol ?? 0} onChange={(v) => patch({ count_symbol: v })} testId={`gs-meter-count-symbol-${decl.id}`} />
      </span>
      <label className="flex items-center gap-1.5">
        <input
          data-testid={`gs-meter-reset-${decl.id}`}
          type="checkbox"
          checked={cfg.reset_on_full ?? false}
          onChange={(e) => {
            const reset_on_full = e.target.checked; // capture eagerly (controlled checkbox)
            patch({ reset_on_full });
          }}
        />
        reset on full
      </label>
    </div>
  );
}

function ReelsFields({ decl, index }: { decl: IMechanicDecl; index: number }) {
  const cfg = decl.config as { rows?: number; events?: IReelsEventRow[] };
  const events = cfg.events ?? [];
  const patch = (p: Record<string, unknown>) => applyDefinition((d) => setMechanicConfig(d, index, { ...d.mechanics[index].config, ...p }));
  const patchEvent = (i: number, p: Partial<IReelsEventRow>) => patch({ events: events.map((e, k) => (k === i ? { ...e, ...p } : e)) });
  return (
    <div className="flex flex-col gap-2 text-xs text-text-2">
      <span className="flex items-center gap-1.5">
        rows <Stepper value={cfg.rows ?? 3} min={1} onChange={(v) => patch({ rows: v })} testId={`gs-reels-rows-${decl.id}`} />
      </span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Events (composition seam)</span>
      {events.map((e, i) => (
        <span key={i} className="flex items-center gap-2">
          symbol <Stepper value={e.symbol} onChange={(v) => patchEvent(i, { symbol: v })} testId={`gs-reels-event-symbol-${decl.id}-${i}`} />
          min <Stepper value={e.min_count} min={1} onChange={(v) => patchEvent(i, { min_count: v })} testId={`gs-reels-event-min-${decl.id}-${i}`} />
          emit <CommittedInput testId={`gs-reels-event-emit-${decl.id}-${i}`} value={e.emit} kind="text" onCommit={(v) => patchEvent(i, { emit: v })} />
          <button
            data-testid={`gs-reels-remove-event-${decl.id}-${i}`}
            onClick={() => patch({ events: events.filter((_, k) => k !== i) })}
            className="rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
          >
            ✕
          </button>
        </span>
      ))}
      <button
        data-testid={`gs-reels-add-event-${decl.id}`}
        onClick={() => patch({ events: [...events, { symbol: 9, min_count: 3, emit: 'scatters:3' }] })}
        className="self-start rounded border border-border px-2 py-0.5 text-xs text-text-1 hover:bg-raised-hover"
      >
        + event
      </button>
      <span className="text-[11px] text-text-3">
        Strips / symbols / paylines / paytable: edit via config JSON below (visual editing = game-config convergence follow-up).
      </span>
    </div>
  );
}

function ConfigJson({ decl, index }: { decl: IMechanicDecl; index: number }) {
  const [draft, setDraft] = useState(() => JSON.stringify(decl.config, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11px] text-text-3">config JSON</summary>
      {error && (
        <p data-testid={`gs-mech-config-error-${decl.id}`} className="text-xs text-danger">
          {error}
        </p>
      )}
      <textarea
        data-testid={`gs-mech-config-json-${decl.id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="mt-1 min-h-32 w-full resize-y rounded border border-border bg-canvas p-2 font-mono text-xs text-text-1"
      />
      <button
        data-testid={`gs-mech-config-apply-${decl.id}`}
        onClick={() => {
          try {
            const cfg = JSON.parse(draft) as Record<string, unknown>;
            setError(null);
            applyDefinition((d) => setMechanicConfig(d, index, cfg));
          } catch (e) {
            setError(e instanceof Error ? e.message : 'invalid JSON');
          }
        }}
        className="mt-1 rounded border border-border px-2 py-0.5 text-xs text-text-1 hover:bg-raised-hover"
      >
        Apply config
      </button>
    </details>
  );
}

export function MechanicsSection() {
  const s = gameStructureHooks.usePluginState();
  const def = s.definition.get({ noproxy: true }) as IGameDefinition;
  return (
    <div data-testid="gs-section-mechanics" className="flex flex-col gap-3 p-3">
      {def.mechanics.map((decl, i) => (
        <div key={decl.id} data-testid={`gs-mech-card-${decl.id}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{decl.type}</span>
            <CommittedInput testId={`gs-mech-id-${decl.id}`} value={decl.id} kind="text" onCommit={(v) => applyDefinition((d) => renameMechanic(d, i, v))} />
            <button
              data-testid={`gs-mech-remove-${decl.id}`}
              onClick={() => applyDefinition((d) => removeMechanic(d, i))}
              className="ml-auto rounded px-1.5 py-0.5 text-xs text-text-2 hover:bg-raised-hover hover:text-danger"
            >
              ✕
            </button>
          </div>
          {decl.type === 'meter@1' && <MeterFields decl={decl} index={i} />}
          {decl.type === 'reels@1' && <ReelsFields decl={decl} index={i} />}
          <ConfigJson decl={decl} index={i} />
        </div>
      ))}
      <div className="flex gap-2">
        {MECHANIC_CATALOG.map((c) => (
          <button
            key={c.type}
            data-testid={`gs-add-${c.type}`}
            onClick={() => applyDefinition((d) => addMechanic(d, c.type))}
            className="rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
          >
            + {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
```

`index.ts`:

```ts
import type { IPlugin } from '../../host/types';
import { GameStructurePane } from './GameStructurePane';
import { GAME_STRUCTURE_PLUGIN_ID, makeInitialState, type IGameStructureState } from './state';
import { initGameStructure } from './actions';

export const gameStructure: IPlugin<IGameStructureState> = {
  id: GAME_STRUCTURE_PLUGIN_ID,
  title: 'Game Structure',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'game-structure/editor', title: 'Game Structure', component: GameStructurePane as never }],
  commands: [{ id: 'game-structure/open-editor', title: 'Open Game Structure', run: (host) => host.openPane('game-structure/editor') }],
  init: () => initGameStructure(),
};
```

Register in `plugins/index.ts` (import + array entry after `gameConfig`). In `RoomRoute.tsx`, add `void openGameStructure(found.gameId);` beside `openGameConfig` (and mirror the mock in `RoomRoute.spec.tsx` exactly as the other plugin opens are mocked — read that spec first).

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/plugins/game-structure src/app/routes` → all PASS. Also run the design-language guard: `npx vitest run src/design-language.guard.spec.ts` (any hex literal would fail it).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src
git commit -m "feat(game-structure): pane shell, plugin registration, mechanics section"
```

---

### Task 13: States + Transitions sections

**Files:**

- Replace placeholder: `studio/frontend/src/plugins/game-structure/sections/StatesSection.tsx` (+ `.spec.tsx`)
- Replace placeholder: `studio/frontend/src/plugins/game-structure/sections/TransitionsSection.tsx` (+ `.spec.tsx`)

**Interfaces:**

- Consumes: reducers (Task 9), `emittableEvents`/`invokeOptions` (Task 8), `applyDefinition` (Task 11), shared atoms.
- Produces test-ids (Task 16 e2e): `gs-section-states`, `gs-state-card-<id>`, `gs-state-id-<id>`, `gs-state-remove-<id>`, `gs-add-state`, `gs-budget-mode-<id>` (select fixed/awarded), `gs-budget-fixed-<id>` (Stepper), `gs-budget-initial-<id>` (Stepper), `gs-binding-<stateId>-<mechId>` (checkbox), `gs-override-<stateId>-<i>` (textarea in details), `gs-override-apply-<stateId>-<i>`, `gs-script-add-<id>` (select), `gs-script-step-<id>-<i>`, `gs-script-remove-<id>-<i>`, `gs-script-up-<id>-<i>`, `gs-script-down-<id>-<i>`;
  `gs-section-transitions`, `gs-tr-row-<i>`, `gs-tr-from-<i>`, `gs-tr-on-<i>`, `gs-tr-kind-<i>` (select to/effect), `gs-tr-to-<i>`, `gs-tr-steps-<i>` (Stepper for the steps:add amount), `gs-tr-remove-<i>`, `gs-add-transition`, `gs-start-select`, `gs-max-steps` (Stepper).

- [ ] **Step 1: Write failing tests.** `StatesSection.spec.tsx` — seed the slice with the two-mechanic/two-state `base()`-like definition (copy the factory from `reducers.spec.ts`), then assert:
  - a card per state with its id input and budget controls (`gs-budget-mode-base` shows `fixed`, `gs-budget-mode-fs1` shows `awarded` and `gs-budget-initial-fs1` present);
  - toggling `gs-binding-base-bonus_meter` unbinds (definition loses the binding);
  - selecting a value in `gs-script-add-fs1` appends that invoke;
  - `gs-add-state` appends `state_1`-style state.

  `TransitionsSection.spec.tsx` — assert a row per transition; changing `gs-tr-on-0` writes the definition; switching `gs-tr-kind-0` to `effect` swaps `to` for `effect: 'steps:add:1'` (then `gs-tr-steps-0` edits the amount); `gs-start-select` change writes `start`; `gs-max-steps` writes caps. Write these in the exact style of the Task 12 section specs (render → fireEvent → assert `gameStructureSlice().definition`).

- [ ] **Step 2: Run to verify failure** — placeholders render nothing useful → FAIL.

- [ ] **Step 3: Implement.** `StatesSection.tsx` structure (uses only reducers + vocab — no new logic):

```tsx
export function StatesSection() {
  const s = gameStructureHooks.usePluginState();
  const def = s.definition.get({ noproxy: true }) as IGameDefinition;
  return (
    <div data-testid="gs-section-states" className="flex flex-col gap-3 p-3">
      {def.states.map((st, si) => (
        <div key={st.id} data-testid={`gs-state-card-${st.id}`} className="flex flex-col gap-2 rounded-lg border border-border bg-raised p-2.5">
          {/* header: CommittedInput id (renameState), ✕ (removeState) */}
          {/* budget row: select fixed/awarded; Stepper for the number (setStateBudget) */}
          {/* bindings: one checkbox per def.mechanics (toggleBinding); per-binding
              override micro-editor inside <details> — textarea + Apply that
              JSON.parses (empty string clears via setBindingOverride(..., undefined)) */}
          {/* script: ordered list with ↑ ↓ ✕ (moveScriptStep/removeScriptStep) and a
              <select data-testid={`gs-script-add-${st.id}`}> whose options are
              invokeOptions(def, st); onChange appends addScriptStep and resets to '' */}
        </div>
      ))}
      <button
        data-testid="gs-add-state"
        onClick={() => applyDefinition(addState)}
        className="self-start rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
      >
        + Add state
      </button>
    </div>
  );
}
```

Budget row concretely:

```tsx
<span className="flex items-center gap-1.5">
  budget
  <select
    data-testid={`gs-budget-mode-${st.id}`}
    value={st.steps.budget === 'awarded' ? 'awarded' : 'fixed'}
    onChange={(e) =>
      applyDefinition((d) =>
        e.target.value === 'awarded'
          ? setStateBudget(d, si, 'awarded', st.steps.initial ?? 1)
          : setStateBudget(d, si, typeof st.steps.budget === 'number' ? st.steps.budget : 1),
      )
    }
    className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
  >
    <option value="fixed">fixed</option>
    <option value="awarded">awarded</option>
  </select>
  {st.steps.budget === 'awarded' ? (
    <>
      initial{' '}
      <Stepper
        value={st.steps.initial ?? 1}
        min={0}
        onChange={(v) => applyDefinition((d) => setStateBudget(d, si, 'awarded', v))}
        testId={`gs-budget-initial-${st.id}`}
      />
    </>
  ) : (
    <Stepper value={st.steps.budget as number} min={1} onChange={(v) => applyDefinition((d) => setStateBudget(d, si, v))} testId={`gs-budget-fixed-${st.id}`} />
  )}
</span>
```

`TransitionsSection.tsx` — table-ish rows plus the game-level controls:

```tsx
export function TransitionsSection() {
  const s = gameStructureHooks.usePluginState();
  const def = s.definition.get({ noproxy: true }) as IGameDefinition;
  const events = emittableEvents(def);
  const stateIds = def.states.map((st) => st.id);
  return (
    <div data-testid="gs-section-transitions" className="flex flex-col gap-3 p-3 text-xs text-text-2">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          start
          <select
            data-testid="gs-start-select"
            value={def.start}
            onChange={(e) => applyDefinition((d) => setStart(d, e.target.value))}
            className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
          >
            {stateIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </span>
        <span className="flex items-center gap-1.5">
          max steps <Stepper value={def.caps.max_steps} min={1} onChange={(v) => applyDefinition((d) => setMaxSteps(d, v))} testId="gs-max-steps" />
        </span>
      </div>
      {def.transitions.map((t, i) => {
        const kind = t.effect !== undefined ? 'effect' : 'to';
        const stepsAmount = t.effect ? Number(t.effect.split(':')[2] ?? 1) : 1;
        return (
          <div key={i} data-testid={`gs-tr-row-${i}`} className="flex flex-wrap items-center gap-2 rounded border border-border bg-raised p-2">
            from
            <select
              data-testid={`gs-tr-from-${i}`}
              value={t.from}
              onChange={(e) => applyDefinition((d) => setTransition(d, i, { ...t, from: e.target.value }))}
              className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
            >
              {stateIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            on
            <select
              data-testid={`gs-tr-on-${i}`}
              value={t.on}
              onChange={(e) => applyDefinition((d) => setTransition(d, i, { ...t, on: e.target.value }))}
              className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
            >
              <option value="">—</option>
              {events.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
            <select
              data-testid={`gs-tr-kind-${i}`}
              value={kind}
              onChange={(e) =>
                applyDefinition((d) =>
                  e.target.value === 'effect'
                    ? setTransition(d, i, { from: t.from, on: t.on, effect: 'steps:add:1' })
                    : setTransition(d, i, { from: t.from, on: t.on, to: stateIds[0] ?? '' }),
                )
              }
              className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
            >
              <option value="to">go to</option>
              <option value="effect">add steps</option>
            </select>
            {kind === 'to' ? (
              <select
                data-testid={`gs-tr-to-${i}`}
                value={t.to ?? ''}
                onChange={(e) => applyDefinition((d) => setTransition(d, i, { from: t.from, on: t.on, to: e.target.value }))}
                className="h-6 rounded border border-border bg-canvas px-1 text-text-1"
              >
                {stateIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            ) : (
              <Stepper
                value={stepsAmount}
                min={1}
                onChange={(v) => applyDefinition((d) => setTransition(d, i, { from: t.from, on: t.on, effect: `steps:add:${v}` }))}
                testId={`gs-tr-steps-${i}`}
              />
            )}
            <button
              data-testid={`gs-tr-remove-${i}`}
              onClick={() => applyDefinition((d) => removeTransition(d, i))}
              className="ml-auto rounded px-1.5 py-0.5 text-text-2 hover:bg-raised-hover hover:text-danger"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        data-testid="gs-add-transition"
        onClick={() => applyDefinition(addTransition)}
        className="self-start rounded border border-border px-3 py-1 text-text-1 hover:bg-raised-hover"
      >
        + Add transition
      </button>
    </div>
  );
}
```

Fill the StatesSection comment blocks with real JSX in the same idiom (all mutations via `applyDefinition` + a reducer; no local state except override JSON drafts, which follow Task 12's `ConfigJson` useState pattern).

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/plugins/game-structure` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure/sections
git commit -m "feat(game-structure): states and transitions sections"
```

---

### Task 14: JSON section + Build & Play toolbar

**Files:**

- Replace placeholder: `studio/frontend/src/plugins/game-structure/sections/JsonSection.tsx` (+ `.spec.tsx`)
- Modify: `studio/frontend/src/plugins/game-structure/GameStructurePane.tsx` (toolbar cluster) + `.spec.tsx`

**Interfaces:**

- Consumes: `applyDocFromJson`, `buildPackage` (Task 11); `engineOrigin` from `../game/config` (existing — the runtime client dev server IS the play surface, port 4300+offset).
- Produces: test-ids `gs-json-textarea`, `gs-json-apply`, `gs-json-error`, `gs-build`, `gs-play`, `gs-metrics`, `gs-metric-rtp`, `gs-metric-hit-rate`, `gs-metric-max-win`, `gs-metric-visits`.

- [ ] **Step 1: Write failing tests.**
      `JsonSection.spec.tsx` — clone game-config's `JsonSection.spec.tsx` shape: textarea bound to `jsonDraft`, Apply calls through (assert definition changed via the slice), parse error shows `gs-json-error`.
      Pane spec additions:

```tsx
it('build button stores metrics and enables play', async () => {
  seed();
  (rest.buildGameDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    errors: null,
    metrics: { rtp: 0.9, hitRate: 0.31, maxWinX: 60, stateVisits: { base: 100, fs1: 4 } },
    packageId: 'g1',
  });
  render(<GameStructurePane {...({} as never)} />);
  fireEvent.click(screen.getByTestId('gs-build'));
  await screen.findByTestId('gs-metrics');
  expect(screen.getByTestId('gs-metric-rtp').textContent).toContain('0.9');
  const play = screen.getByTestId('gs-play') as HTMLAnchorElement;
  expect(play.href).toContain('?package=g1');
});
```

(This requires the pane spec to `vi.mock('./restClient')` the same way `actions.spec.ts` does — add the mock block at the top.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`JsonSection.tsx` — clone game-config's `JsonSection.tsx` verbatim with renames: state hooks → `gameStructureHooks`, apply → `applyDocFromJson`, test-ids `gs-json-*`, label `Definition + presentation JSON`.

Pane toolbar cluster (replaces the Task 12 placeholder in the header row, before the sync pill):

```tsx
const build = s.build.get({ noproxy: true });
const gameId = activeGameId; // non-null past the guard
```

```tsx
<button
  data-testid="gs-build"
  onClick={() => void buildPackage()}
  disabled={build.status === 'building'}
  className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
>
  {build.status === 'building' ? 'Building…' : 'Build'}
</button>;
{
  build.status === 'done' && build.metrics && (
    <span data-testid="gs-metrics" className="flex items-center gap-2 text-[11px] text-text-2">
      <span data-testid="gs-metric-rtp">rtp {build.metrics.rtp.toFixed(3)}</span>
      <span data-testid="gs-metric-hit-rate">hit {(build.metrics.hitRate * 100).toFixed(1)}%</span>
      <span data-testid="gs-metric-max-win">max {build.metrics.maxWinX}x</span>
      <span data-testid="gs-metric-visits">
        {Object.entries(build.metrics.stateVisits)
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')}
      </span>
    </span>
  );
}
{
  build.status === 'error' && (
    <span data-testid="gs-build-error" className="text-[11px] text-danger">
      {build.errors[0]}
    </span>
  );
}
{
  build.status === 'done' && (
    <a
      data-testid="gs-play"
      href={`${engineOrigin()}/?package=${encodeURIComponent(gameId)}`}
      target="_blank"
      rel="noreferrer"
      className="rounded border border-border px-3 py-1 text-xs text-text-1 hover:bg-raised-hover"
    >
      Play ↗
    </a>
  );
}
```

(`engineOrigin()` is called inside render here, which is safe — it reads `window.location`, not `getHost()`. The Play URL's server defaults to hostname:9000+offset inside the client; a dir-mode server must be running via `just runtime-serve-packages` — that is the documented dev flow, and the link is only enabled after a successful build.)

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/plugins/game-structure` → all PASS. Then the full frontend gate trio: `npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure
git commit -m "feat(game-structure): json escape hatch + build-and-play toolbar"
```

---

### Task 15: Runtime client — `?package=` plumbing + dir-mode play e2e

**Files:**

- Modify: `runtime/client/src/play/runtimeClient.ts` (+ `runtimeClient.spec.ts`)
- Modify: `runtime/client/src/main.ts`
- Modify: `runtime/client/playwright.config.ts` (4th webServer: dir-mode server on 9200+offset)
- Create: `runtime/client/e2e/playmode-dir.e2e.spec.ts`

**Interfaces:**

- Consumes: Task 4's server wire (`/handshake?package=`, spin body `package`).
- Produces: `createRuntimeClient(baseUrl, fetchImpl = fetch, packageId?: string)` — when `packageId` is set, handshake appends `?package=` and spin includes `package` in the body. `main.ts`: `?package=<id>` in the page URL enters play mode and threads the id.

- [ ] **Step 1: Write failing unit tests** — extend `runtime/client/src/play/runtimeClient.spec.ts` (read the existing tests and copy their fetch-stub idiom):

```ts
it('handshake and spin carry the package id when configured', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  const client = createRuntimeClient('http://s:9000', fetchImpl, 'g1');
  await client.handshake();
  await client.spin(2);
  expect(calls[0].url).toBe('http://s:9000/handshake?package=g1');
  expect(JSON.parse(calls[1].body!)).toEqual({ bet: 2, package: 'g1' });
});

it('omits the package field entirely when not configured', async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  const client = createRuntimeClient('http://s:9000', fetchImpl);
  await client.handshake();
  await client.spin();
  expect(calls[0].url).toBe('http://s:9000/handshake');
  expect(JSON.parse(calls[1].body!)).toEqual({ bet: 1 });
});
```

- [ ] **Step 2: Run to verify failure** — `cd runtime/client && npx vitest run src/play/runtimeClient.spec.ts` → FAIL.

- [ ] **Step 3: Implement.**

`runtimeClient.ts`:

```ts
export function createRuntimeClient(baseUrl: string, fetchImpl: typeof fetch = fetch, packageId?: string): IRuntimeClient {
  const base = baseUrl.replace(/\/+$/, '');
  const handshakeUrl = packageId ? `${base}/handshake?package=${encodeURIComponent(packageId)}` : `${base}/handshake`;
  return {
    async handshake(): Promise<IHandshakeResponse> {
      const r = await fetchImpl(handshakeUrl);
      if (!r.ok) throw new Error(`handshake failed: ${r.status}`);
      return (await r.json()) as IHandshakeResponse;
    },
    async spin(bet = 1): Promise<ISpinResponse> {
      const body: Record<string, unknown> = { bet };
      if (packageId) body.package = packageId;
      const r = await fetchImpl(`${base}/spin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`spin failed: ${r.status}`);
      return (await r.json()) as ISpinResponse;
    },
  };
}
```

`main.ts` — extend the play-mode gate and thread the id (read the file; the change is 2 lines):

```ts
const packageId = params.get('package') ?? undefined;
const isPlayMode = params.has('server') || params.has('play') || packageId !== undefined;
// ...
const client = createRuntimeClient(serverUrl, fetch, packageId);
```

- [ ] **Step 4: Unit tests green** — `npx vitest run` (in runtime/client) → PASS.

- [ ] **Step 5: Dir-mode e2e.** Add a 4th webServer to `runtime/client/playwright.config.ts`, mirroring the existing composed entry EXACTLY (same command wrapper — read how the 9100 entry launches the server via `e2e/start-server.cjs` or direct cargo — and keep that mechanism), with only these differences: port base **9200**, env `BLOOM_RUNTIME_PACKAGES=runtime/server/demo` (repo-relative; the working dir mechanism must match the existing entry so the path resolves) and NO `BLOOM_RUNTIME_PACKAGE`. Health URL `http://localhost:${9200 + offset}/health`.

Create `runtime/client/e2e/playmode-dir.e2e.spec.ts` — the demo dir already contains the checked-in `composed.pkg`, whose id in dir mode is its filename stem `composed`:

```ts
// Dir-mode play: the client selects a package by id against a
// BLOOM_RUNTIME_PACKAGES server and walks the served trace (SP4).
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const SERVER = `http://localhost:${9200 + offset}`;

test('play surface loads a dir-mode package via ?package= and completes a spin', async ({ page }) => {
  await page.goto(`/?server=${encodeURIComponent(SERVER)}&package=composed`);

  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes['main_reels:reel:2'] != null), { timeout: 15000 }).toBe(true);

  await expect(page.locator('#spin')).toBeVisible();
  await page.click('#spin');
  await expect(page.locator('#spin')).toBeEnabled({ timeout: 60000 });

  const state = await page.evaluate(() => (window as any).__engineModules.state());
  expect(state.phase).toBe('idle');
  await expect(page.locator('#play-error')).toBeHidden();
});
```

- [ ] **Step 6: Run the runtime-client e2e**

Run (from `runtime/client`, with the worktree offset exported): `npx playwright test e2e/playmode-dir.e2e.spec.ts`
Expected: PASS (server compiles on first run — allow the webServer timeout).

- [ ] **Step 7: Commit**

```bash
git add runtime/client
git commit -m "feat(runtime-client): package selection via ?package= + dir-mode play e2e"
```

---

### Task 16: Studio authoring e2e (Playwright)

**Files:**

- Create: `studio/frontend/e2e/game-structure.spec.ts`
- Modify: `studio/frontend/playwright.config.ts` (add a dir-mode runtime-server webServer on **9300**+offset reading `var/packages`)

**Interfaces:**

- Consumes: everything. The suite runs against the replay backend (`just backend-serve-replay` on :8002 in this worktree) exactly like the other studio specs; the build endpoint shells REAL Rust (as curate already does under e2e).

- [ ] **Step 1: playwright.config.ts** — add a second entry to `webServer` (turn the single object into an array; keep the existing frontend entry first):

```ts
  webServer: [
    {
      command: 'npx nx serve frontend',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Dir-mode runtime server over studio-built packages (SP4 build->play).
      // 9300 base (NOT 9000/9100/9200) so reuseExistingServer can never attach
      // to another suite's differently-configured server.
      command: 'cargo run --release -p bloom-runtime-server',
      cwd: '../..',
      env: { BLOOM_RUNTIME_PACKAGES: 'var/packages', BLOOM_RUNTIME_PORT: '9300' },
      url: `http://localhost:${9300 + offset}/health`,
      reuseExistingServer: true,
      timeout: 300_000, // first run compiles the server
    },
  ],
```

(Playwright merges `process.env` with `env`, so `BLOOM_PORT_OFFSET` still applies. The server boots fine with an empty/missing `var/packages` — dir mode reads lazily.)

- [ ] **Step 2: Write the spec** — `studio/frontend/e2e/game-structure.spec.ts`. Copy `setupGame` and the open-pane helper idiom from `game-config.spec.ts` (read it first; reuse its room/game creation exactly). The tests — every one asserts persisted end-state via REST, not just UI echo:

```ts
import { expect, test, type Page } from '@playwright/test';
import { BACKEND_URL } from './helpers';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const RUNTIME = `http://localhost:${9300 + offset}`;

// setupGame: clone from game-config.spec.ts (POST /rooms with a game, seed
// session, navigate) — same helper, no slot-model PUT needed (the
// game-definition doc seeds itself on first GET).

async function openGameStructure(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game-structure/editor')).toBeVisible();
  await page.getByTestId('view-open-game-structure/editor').click();
  await expect(page.getByTestId('gs-tab-mechanics')).toBeVisible();
}

test('edit meter target -> saved -> persisted in the game-definition doc', async ({ page }) => {
  const gameId = await setupGame(page);
  await openGameStructure(page);
  await page.getByTestId('gs-meter-target-bonus_meter-inc').click(); // 6 -> 7
  await expect(page.getByTestId('gs-sync-pill')).toContainText('saved');
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`);
  const doc = (await res.json()) as { definition: { mechanics: Array<{ id: string; config: { target?: number } }> } };
  expect(doc.definition.mechanics.find((m) => m.id === 'bonus_meter')?.config.target).toBe(7);
});

test('kernel validation surfaces inline and clears on fix', async ({ page }) => {
  await setupGame(page);
  await openGameStructure(page);
  // Break it: retarget a transition at a nonexistent state via the JSON tab.
  await page.getByTestId('gs-tab-json').click();
  const draft = await page.getByTestId('gs-json-textarea').inputValue();
  const doc = JSON.parse(draft);
  doc.definition.start = 'no-such-state';
  await page.getByTestId('gs-json-textarea').fill(JSON.stringify(doc));
  await page.getByTestId('gs-json-apply').click();
  await expect(page.getByTestId('gs-validation-pill')).toContainText('issue', { timeout: 120_000 }); // first cargo run may compile
  await expect(page.getByTestId('gs-validation-errors')).toContainText('UnknownState');
  // Fix it back.
  doc.definition.start = 'base';
  await page.getByTestId('gs-json-textarea').fill(JSON.stringify(doc));
  await page.getByTestId('gs-json-apply').click();
  await expect(page.getByTestId('gs-validation-pill')).toContainText('valid', { timeout: 120_000 });
});

test('build produces metrics and a package the runtime server plays', async ({ page }) => {
  const gameId = await setupGame(page);
  await openGameStructure(page);
  await page.getByTestId('gs-build').click();
  await expect(page.getByTestId('gs-metrics')).toBeVisible({ timeout: 300_000 }); // 10k-seed build + possible compile
  await expect(page.getByTestId('gs-metric-rtp')).toContainText('rtp');
  // Play link points at the play surface with the package id.
  const href = await page.getByTestId('gs-play').getAttribute('href');
  expect(href).toContain(`?package=${gameId}`);
  // Authoritative round-trip: the dir-mode server serves the authored package.
  const hs = await fetch(`${RUNTIME}/handshake?package=${gameId}`);
  expect(hs.status).toBe(200);
  const handshake = (await hs.json()) as { package_id: string; mechanic: string };
  expect(handshake.package_id).toBe(gameId);
  expect(handshake.mechanic).toBe('composed@1');
  const spin = await fetch(`${RUNTIME}/spin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bet: 1, package: gameId }),
  });
  expect(spin.status).toBe(200);
  const round = (await spin.json()) as { trace: Array<{ t: string }> };
  expect(round.trace.at(-1)?.t).toBe('round_end');
});

test('external write flags the pane and rehydrates', async ({ page }) => {
  const gameId = await setupGame(page);
  await openGameStructure(page);
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`);
  const doc = (await res.json()) as { definition: Record<string, unknown> };
  await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definition: { ...doc.definition, start: 'fs1' }, source: 'api' }),
  });
  await expect(page.getByTestId('gs-sync-pill')).toContainText('updated externally · api');
  await page.getByTestId('gs-tab-transitions').click();
  await expect(page.getByTestId('gs-start-select')).toHaveValue('fs1');
});
```

NOTE on `gs-meter-target-bonus_meter-inc`: the Stepper renders `-inc`/`-dec` suffixed buttons (see its props doc). NOTE on validation timeouts: the very first `cargo run --bin compose_json` inside the backend compiles the workspace — pre-warm before the suite with `cargo build --release -p bloom-simulator --bin compose_json` (add this to the e2e run notes in the PR description; the generous per-assert timeouts cover CI-less local runs regardless).

- [ ] **Step 3: Run the suite**

Preconditions (worktree, offset 2): replay backend up — `just backend-serve-replay` (serves :8002, db `bloom_studio_wt2`); pre-warm `cargo build --release -p bloom-simulator --bin compose_json -p bloom-runtime-server`.

Run: `cd studio/frontend && npx playwright test e2e/game-structure.spec.ts`
Expected: 4 PASS.

- [ ] **Step 4: Full studio e2e sweep** — `just e2e` (from the worktree root). Expected: entire suite green (the new webServer entry must not break the other specs — it only adds a lazily-used server).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e studio/frontend/playwright.config.ts
git commit -m "test(game-structure): authoring e2e - edit/validate/build/play round-trip"
```

---

### Task 17: Full gates, docs touch, PR

**Files:**

- Modify: `docs/superpowers/plans/2026-07-09-composed-sp4-studio-authoring.md` (tick boxes as you went — no other doc changes; AGENTS.md/worktrees docs are untouched by this feature)

- [ ] **Step 1: Rust gates**

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p bloom-simulator -p bloom-runtime-server -p bloom-math
```

Expected: all green.

- [ ] **Step 2: Backend gate**

```bash
cd studio/backend && uv run pytest -m "not e2e" -q
```

Expected: green.

- [ ] **Step 3: Frontend gates**

```bash
cd studio/frontend
cd ../.. && node_modules/.bin/prettier --check .   # pinned prettier from the repo root, never npx
npx nx typecheck frontend && npx nx test frontend && npx nx build frontend
npx nx typecheck client && npx nx test client && npx nx build client
```

Expected: green (modulo the 3 known pre-existing offset-worktree failures if running `run-many -t test`).

- [ ] **Step 4: e2e (both suites, replay stack)** — with the worktree's offset exported and `just backend-serve-replay` running: `just e2e`, then `cd runtime/client && npx playwright test`. Expected: green.

- [ ] **Step 5: Push + PR**

```bash
git push -u origin feat/composed-sp4
gh pr create --title "feat(composed): SP4 studio authoring - Game Structure plugin + build-to-play" --body "$(cat <<'EOF'
## Summary
- Game Structure plugin (game-structure): author composed@1 GameDefinitions per game (Mechanics/States/Transitions/JSON sections, kernel-validated inline)
- app/compose backend: game_definitions Mongo store, GET/PUT + validate + build endpoints, game_definition_changed socket, compose_json subprocess seam
- compose_json bin (bloom-simulator): validate / build signed pkg / informational pool metrics (rtp, hit rate, max win, state visits)
- Runtime server package-directory mode (BLOOM_RUNTIME_PACKAGES) with ?package= selection, mtime reload on handshake, lazy load + cache
- Runtime client ?package= plumbing; Play button opens the authored game
- Spec: docs/superpowers/specs/2026-07-09-composed-sp4-studio-authoring-design.md

## Test plan
- cargo test (simulator + runtime-server incl. new dir-mode integration tests)
- backend pytest (store/runner/rest with mocked runner)
- vitest (plugin model/vocab/reducers/actions/sections)
- Playwright: studio game-structure.spec.ts (edit->persist, inline kernel validation, build->metrics->authoritative play round-trip, external-write rehydrate); runtime/client playmode-dir.e2e.spec.ts

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: After merge** (via `/bloom:complete-work` or manually): `gh pr merge --squash --delete-branch`, then from `C:\code\bloom`: `git worktree remove C:/code/bloom.wt/composed-sp4`, `git worktree prune`, `git branch -D feat/composed-sp4`. File follow-up issues: visual reels editing on composed (game-config convergence), #172 stays open for verify/freeze gating.

---

## Deferred (explicitly NOT in this plan)

- #176 per-state presentation variants, #177 playback speed/turbo.
- Verify gates / targets / pool freeze for composed (#172, narrowed to gating).
- Tuner/GA/simulator/analytics on composed games; section locks on the definition doc.
- GDD/agent-driven composed authoring; scene-derived presentation; presentation forms.
- Visual strips/paylines/paytable editing inside composed (JSON subsection only).
