# Simulator Studio Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a designer author an executable slot model in the studio, run a real `bloom-simulator` curation, and see measured RTP / volatility / per-feature hit-rates reconciled against the game's GDD design intent — live, with PASS/FAIL.

**Architecture:** A new Rust streaming binary (`curate_json`) wraps the existing curation pipeline and emits NDJSON progress + a final result on stdout. The Python backend invokes it as a subprocess behind a `CurationRunner` seam, persists the model/result in a Mongo `SlotModelStore`, derives the `TargetSpec` from the structured GDD `math-model`, and streams progress over Socket.IO via a `CurationHub`. A new React Dockview plugin authors the model (JSON), triggers curation, and renders the verdict.

**Tech Stack:** Rust (cargo workspace crate `bloom-simulator`, deps already present: `serde`, `serde_json`, `rayon`, `ed25519-dalek`, `bloom-math`, `bloom-package`); Python 3.12 / FastAPI / motor / pydantic / python-socketio (package `studio/backend/app/simulator/`); React 18 / Hookstate / Dockview / socket.io-client (plugin `studio/frontend/src/plugins/simulator/`).

## Global Constraints

- **Approach A is sacred:** the model defines the characteristics; curation never reshapes to hit a target. A model that misses targets **FAILS loudly**. (math-spec §2.)
- **The certified path is untouched:** do not change `bloom-package` format or the existing `run_curation` public signature / behavior. New Rust work is **additive**.
- **TDD mandatory:** failing test → run it red → minimal code → run it green → commit. (`AGENTS.md`.)
- **TypeScript interfaces use an `I` prefix** (`IPlugin`, `ISimulatorState`). (`docs/coding-standards.md`.)
- **Design language:** studio panes use only the token classes `bg-surface` / `bg-raised` / `bg-raised-hover`, `border-hairline` / `border-hairline-strong`, `text-text-1` / `text-text-2` / `text-text-3`, `text-accent-text`, and status tokens; **no raw hex / no raw `--accent` vars outside `styles.css`** (a guard test blocks it). (`docs/design-language.md`.)
- **Each feature package copies its own `_WireModel`, store, and hub** — do NOT try to DRY against `gdd`/`assets`; mirror the standalone pattern.
- **Commits:** Conventional Commits, imperative mood. Branch is `feat/sim-studio`.
- **Merge-order dependency:** Task 7 and Task 10's GDD read assume `feat/gdd-structured-content` (structured GDD `data` dict + `read_gdd_doc`) has merged to `main`. All other tasks are independent of it. See spec §2.1.
- **Run recipes:** Rust `just test` (= `cargo test --workspace`); backend unit `just backend-test` (= `cd studio/backend && uv run pytest -m "not e2e"`); frontend unit `just ts-test`; browser e2e `just e2e` (needs a backend on :8000 — start `just backend-serve-replay` first; never in CI).
- **Session hygiene:** before any `serve` / `e2e` / asset generation confirm no other session holds the singleton stack (:4200 / :8000 / :8188 / Mongo). Parallel edits + unit tests are safe.

---

## File Structure

**Rust (`studio/simulator/`):**

- `src/run.rs` (modify) — add `CurationProgress`, `StreamedOutcome`, `run_curation_streamed`; refactor `run_curation` to delegate.
- `src/bin/curate_json.rs` (create) — NDJSON streaming CLI.
- `justfile` (modify) — add `sim-build` recipe.

**Backend (`studio/backend/app/simulator/`, new package):**

- `__init__.py`, `models.py`, `targets.py`, `runner.py`, `store.py`, `hub.py`, `rest.py`, `sockets.py`.
- `studio/backend/app/main.py` (modify) — DI wiring.
- `studio/backend/app/config.py` (modify) — `simulator_bin` setting.
- `studio/backend/tests/` — `test_sim_targets.py`, `test_sim_store.py`, `test_sim_runner.py`, `test_sim_hub.py`, `test_sim_rest.py`, `test_sim_curate_binary.py` (e2e-marked).

**Frontend (`studio/frontend/src/plugins/simulator/`, new plugin):**

- `config.ts`, `state.ts`, `restClient.ts`, `reducers.ts`, `socketClient.ts`, `actions.ts`, `index.ts`, `SimulatorPane.tsx` + `.spec` files.
- `studio/frontend/src/plugins/index.ts` (modify) — register plugin.
- `studio/frontend/src/app/routes/RoomRoute.tsx` (modify) — open/close on game change.
- `studio/frontend/e2e/simulator.spec.ts` (create).

---

## Task 1: Rust — streaming curation pipeline (`run_curation_streamed`)

Add a progress-reporting orchestration in the library, with `run_curation` delegating to it (so existing behavior/tests are unchanged). Progress is cosmetic: chunked simulation preserves order and bit-reproducibility.

**Files:**

- Modify: `studio/simulator/src/run.rs`
- Test: `studio/simulator/src/run.rs` (`#[cfg(test)]` module — extend existing tests)

**Interfaces:**

- Consumes: `bloom_math::mechanics::slots::{SlotModel, to_payload}`, `crate::measure::{simulate, measure, RoundSample}`, `crate::seedgen::generate_seeds`, `crate::curate::freeze_pool`, `crate::target::{Metrics, TargetSpec}`, `bloom_package::{build, Envelope, PackageContent}`, `ed25519_dalek::SigningKey`.
- Produces:
  - `pub enum CurationProgress { Phase(&'static str), Simulating { done: usize, total: usize } }`
  - `pub struct StreamedOutcome { pub metrics: Metrics, pub outcome: Result<CurationOutput, RunError> }`
  - `pub fn run_curation_streamed(model: &SlotModel, target: &TargetSpec, master_seed: u64, package_id: &str, signing_key: &SigningKey, on_progress: &mut dyn FnMut(CurationProgress)) -> StreamedOutcome`
  - `run_curation(...)` keeps its existing signature `Result<CurationOutput, RunError>`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `studio/simulator/src/run.rs`:

```rust
    #[test]
    fn streamed_matches_run_curation_on_pass() {
        let mut seen: Vec<String> = Vec::new();
        let s = run_curation_streamed(
            &measurable_model(), &target_09(), 2026, "pkg-test", &key(),
            &mut |p| match p {
                CurationProgress::Phase(name) => seen.push(name.to_string()),
                CurationProgress::Simulating { done, total } => {
                    assert!(done <= total);
                    seen.push("simulating".to_string());
                }
            },
        );
        // metrics always present; outcome equals the legacy path's package bytes.
        let legacy = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let streamed = s.outcome.expect("passes");
        assert_eq!(streamed.package_bytes, legacy.package_bytes);
        assert!((s.metrics.rtp - 0.9).abs() < 0.02);
        assert!(seen.iter().any(|n| n == "simulating"));
        assert!(seen.iter().any(|n| n == "freeze"));
    }

    #[test]
    fn streamed_reports_metrics_even_on_verify_fail() {
        let mut t = target_09();
        t.rtp_target = 0.50; // model ~0.9 -> verify fails
        let s = run_curation_streamed(&measurable_model(), &t, 2026, "pkg-test", &key(), &mut |_| {});
        assert!(matches!(s.outcome, Err(RunError::VerifyFailed(_))));
        assert!((s.metrics.rtp - 0.9).abs() < 0.02); // metrics still measured
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bloom-simulator run::tests::streamed`
Expected: FAIL — `cannot find function run_curation_streamed` / `CurationProgress`.

- [ ] **Step 3: Implement the streaming orchestration**

In `studio/simulator/src/run.rs`, add the new types and function, and replace the body of `run_curation` to delegate. Keep all existing `use` lines; add nothing new beyond what's listed in Interfaces (all already imported at the top of the file).

```rust
/// Coarse progress signal for a curation run (cosmetic; never affects the result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurationProgress {
    Phase(&'static str),
    Simulating { done: usize, total: usize },
}

/// A streamed run always carries the measured metrics, plus the pass/fail outcome.
#[derive(Debug)]
pub struct StreamedOutcome {
    pub metrics: Metrics,
    pub outcome: Result<CurationOutput, RunError>,
}

/// Like `run_curation`, but reports progress and always returns the measured
/// metrics. `run_curation` delegates here with a no-op callback.
pub fn run_curation_streamed(
    model: &SlotModel,
    target: &TargetSpec,
    master_seed: u64,
    package_id: &str,
    signing_key: &SigningKey,
    on_progress: &mut dyn FnMut(CurationProgress),
) -> StreamedOutcome {
    on_progress(CurationProgress::Phase("generate"));
    let seeds = generate_seeds(master_seed, target.candidate_count);

    // Chunked simulation: identical results to a single `simulate` call (each seed
    // is evaluated the same way; order preserved by concatenation) but lets us
    // report sub-progress through the dominant step.
    let total = seeds.len();
    let chunk = (total / 100).max(1);
    let mut samples: Vec<RoundSample> = Vec::with_capacity(total);
    let mut done = 0usize;
    for part in seeds.chunks(chunk) {
        samples.extend(simulate(model, part));
        done += part.len();
        on_progress(CurationProgress::Simulating { done, total });
    }

    on_progress(CurationProgress::Phase("measure"));
    let metrics = measure(&samples);

    on_progress(CurationProgress::Phase("verify"));
    if let Err(m) = verify(&metrics, target) {
        return StreamedOutcome { metrics, outcome: Err(RunError::VerifyFailed(m)) };
    }

    on_progress(CurationProgress::Phase("freeze"));
    let pool = match freeze_pool(&samples, target, metrics.rtp) {
        Ok(p) => p,
        Err(e) => return StreamedOutcome { metrics, outcome: Err(RunError::Curate(e)) },
    };

    on_progress(CurationProgress::Phase("sign"));
    let content = PackageContent {
        envelope: Envelope {
            package_id: package_id.to_string(),
            package_version: 1,
            mechanic: "slots@1".to_string(),
        },
        math_payload: to_payload(model),
        seeds: pool.seeds.clone(),
        presentation: Vec::new(),
    };
    let package_bytes = build(&content, signing_key);

    let bonus_rates = metrics
        .bonus_hit_rates
        .iter()
        .enumerate()
        .map(|(i, r)| format!("bonus_hit_rate[{i}]={r:.5}"))
        .collect::<Vec<_>>()
        .join("\n");
    let report = format!(
        "package_id={package_id}\nmechanic=slots@1\nmaster_seed={master_seed}\n\
         candidate_count={}\npool_size={}\n\
         measured_rtp={:.5}\nrealized_rtp={:.5}\nvolatility={:.5}\n\
         hit_frequency={:.5}\nbase_rtp={:.5}\nfeature_rtp={:.5}\n{}\n",
        target.candidate_count, target.pool_size,
        metrics.rtp, pool.realized_rtp, metrics.volatility,
        metrics.hit_frequency, metrics.base_rtp, metrics.feature_rtp, bonus_rates,
    );

    StreamedOutcome {
        metrics: metrics.clone(),
        outcome: Ok(CurationOutput { package_bytes, metrics, pool, report }),
    }
}
```

Now replace the existing `run_curation` body so it delegates (keeps the public signature and all existing tests passing):

```rust
/// Generate → simulate → measure → verify → freeze → build+sign.
pub fn run_curation(
    model: &SlotModel,
    target: &TargetSpec,
    master_seed: u64,
    package_id: &str,
    signing_key: &SigningKey,
) -> Result<CurationOutput, RunError> {
    run_curation_streamed(model, target, master_seed, package_id, signing_key, &mut |_| {}).outcome
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-simulator`
Expected: PASS — all existing `run::tests::*` plus the two new ones. (The legacy tests `run_curation_builds_a_loadable_package`, `run_curation_is_reproducible`, `freeze_boundary_determinism_holds`, `missing_target_fails_loudly` must remain green.)

- [ ] **Step 5: Commit**

```bash
git add studio/simulator/src/run.rs
git commit -m "feat(sim): streaming curation pipeline with progress callback"
```

---

## Task 2: Rust — `curate_json` NDJSON streaming binary

A thin binary that reads model + target JSON, runs `run_curation_streamed`, and prints newline-delimited JSON progress lines then a final result line to stdout. The signed package is written to a file path. Verify-fail and correction-band-fail are **valid outcomes** (exit 0, `status:"fail"`); only bad input / IO error exits non-zero.

**Files:**

- Create: `studio/simulator/src/bin/curate_json.rs`
- Modify: `justfile` (add `sim-build`)
- Test: `studio/simulator/src/bin/curate_json.rs` (`#[cfg(test)]` for the pure JSON-line helpers)

**Interfaces:**

- Consumes: `bloom_simulator::run::{run_curation_streamed, CurationProgress, RunError}`, `bloom_simulator::target::{HitRateBand, TargetSpec}`, `bloom_math::mechanics::slots::SlotModel`, `ed25519_dalek::SigningKey`, `serde`, `serde_json`.
- Produces (stdout NDJSON contract the backend parses):
  - progress: `{"type":"progress","phase":"simulate","done":N,"total":M}` (phase ∈ generate|simulate|measure|verify|freeze|sign; `done`/`total` only for simulate)
  - final: `{"type":"result","status":"pass"|"fail","rtp":f,"volatility":f,"hitFrequency":f,"baseRtp":f,"featureRtp":f,"bonusHitRates":[f,...],"realizedRtp":f|null,"poolSize":N|null,"failure":string|null}`

- [ ] **Step 1: Write the failing test (pure line serialization)**

Create `studio/simulator/src/bin/curate_json.rs` with the helpers + a test first:

```rust
//! Streaming curation CLI: emit NDJSON progress + a final result line on stdout.
//! Usage: curate_json <model.json> <target.json> <package_id> <out.pkg>
//! Verify/correction failures are valid results (exit 0, status="fail"); only
//! bad input or IO errors exit non-zero.

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::run::{run_curation_streamed, CurationProgress, RunError};
use bloom_simulator::target::{HitRateBand, TargetSpec};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::json;
use std::fs;

#[derive(Deserialize)]
struct BandJson { min: f64, max: f64 }

#[derive(Deserialize)]
struct TargetJson {
    rtp_target: f64,
    rtp_tolerance: f64,
    volatility_min: f64,
    volatility_max: f64,
    bonus_hit_rate_bands: Vec<BandJson>,
    pool_size: usize,
    candidate_count: usize,
    realized_correction_band: f64,
    master_seed: u64,
}

fn progress_line(p: &CurationProgress) -> String {
    match p {
        CurationProgress::Phase(name) => {
            json!({ "type": "progress", "phase": name }).to_string()
        }
        CurationProgress::Simulating { done, total } => {
            json!({ "type": "progress", "phase": "simulate", "done": done, "total": total })
                .to_string()
        }
    }
}

fn main() { /* filled in Step 3 */ }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_line_is_ndjson() {
        let s = progress_line(&CurationProgress::Phase("freeze"));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "progress");
        assert_eq!(v["phase"], "freeze");
    }

    #[test]
    fn simulate_line_carries_done_total() {
        let s = progress_line(&CurationProgress::Simulating { done: 5, total: 10 });
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["phase"], "simulate");
        assert_eq!(v["done"], 5);
        assert_eq!(v["total"], 10);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bloom-simulator --bin curate_json`
Expected: FAIL to compile/pass until `main` is implemented and the bin is wired — initially fails on the empty `main()` having unused imports. (If the compiler errors on unused imports, that is the expected red.)

- [ ] **Step 3: Implement `main`**

Replace `fn main() { ... }` in `studio/simulator/src/bin/curate_json.rs`:

```rust
fn emit(line: String) {
    println!("{line}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        eprintln!("usage: curate_json <model.json> <target.json> <package_id> <out.pkg>");
        std::process::exit(2);
    }

    let model: SlotModel = match fs::read_to_string(&args[1]).map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(m) => m,
        Err(e) => { eprintln!("bad model json: {e}"); std::process::exit(2); }
    };
    let tj: TargetJson = match fs::read_to_string(&args[2]).map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(t) => t,
        Err(e) => { eprintln!("bad target json: {e}"); std::process::exit(2); }
    };

    let target = TargetSpec {
        rtp_target: tj.rtp_target,
        rtp_tolerance: tj.rtp_tolerance,
        volatility_min: tj.volatility_min,
        volatility_max: tj.volatility_max,
        bonus_hit_rate_bands: tj.bonus_hit_rate_bands.iter()
            .map(|b| HitRateBand { min: b.min, max: b.max }).collect(),
        pool_size: tj.pool_size,
        candidate_count: tj.candidate_count,
        realized_correction_band: tj.realized_correction_band,
    };

    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only (umbrella §9)
    let mut on_progress = |p: CurationProgress| emit(progress_line(&p));
    let s = run_curation_streamed(&model, &target, tj.master_seed, &args[3], &signing_key, &mut on_progress);

    let m = &s.metrics;
    let (status, realized, pool_size, failure) = match &s.outcome {
        Ok(out) => {
            if let Err(e) = fs::write(&args[4], &out.package_bytes) {
                eprintln!("write package failed: {e}"); std::process::exit(1);
            }
            ("pass", Some(out.pool.realized_rtp), Some(out.pool.seeds.len()), None)
        }
        Err(RunError::VerifyFailed(_)) => (
            "fail", None, None,
            Some("measured characteristics missed the target bands".to_string()),
        ),
        Err(RunError::Curate(e)) => (
            "fail", None, None,
            Some(format!("curation guardrail: {e:?} — retune the model, not the pool")),
        ),
    };

    let result = json!({
        "type": "result",
        "status": status,
        "rtp": m.rtp,
        "volatility": m.volatility,
        "hitFrequency": m.hit_frequency,
        "baseRtp": m.base_rtp,
        "featureRtp": m.feature_rtp,
        "bonusHitRates": m.bonus_hit_rates,
        "realizedRtp": realized,
        "poolSize": pool_size,
        "failure": failure,
    });
    emit(result.to_string());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-simulator --bin curate_json`
Expected: PASS (both `progress_line` tests; binary compiles).

- [ ] **Step 5: Smoke-run the binary end to end**

Create a tiny model + target in a scratch dir and run it:

```bash
mkdir -p /c/Users/dheye/AppData/Local/Temp/claude/sim && cd /c/code/bloom.wt/sim-studio
cat > /tmp/m.json <<'JSON'
{"symbols":[{"id":0,"role":"normal"},{"id":1,"role":"normal"},{"id":2,"role":"normal"}],
 "reels":[[0,0,0,0,0,1,1,1,1,2]],"rows":1,"paylines":[[0]],
 "paytable":{"entries":[{"symbol":1,"count":1,"payout":1},{"symbol":2,"count":1,"payout":5}]},
 "bonuses":[]}
JSON
cat > /tmp/t.json <<'JSON'
{"rtp_target":0.9,"rtp_tolerance":0.02,"volatility_min":0.0,"volatility_max":1000000000.0,
 "bonus_hit_rate_bands":[],"pool_size":1000,"candidate_count":20000,
 "realized_correction_band":0.05,"master_seed":2026}
JSON
cargo run --release -p bloom-simulator --bin curate_json -- /tmp/m.json /tmp/t.json smoke /tmp/out.pkg
```

Expected: several `{"type":"progress",...}` lines, then one `{"type":"result","status":"pass",...}` line with `rtp` ≈ 0.9. (Cargo's own "Compiling/Finished" text goes to **stderr**, so stdout stays clean NDJSON.)

- [ ] **Step 6: Add the build recipe and commit**

Add to `justfile` near the other Rust recipes:

```just
# Build the release curation binary the studio backend shells out to.
sim-build:
    cargo build --release -p bloom-simulator
```

```bash
git add studio/simulator/src/bin/curate_json.rs justfile
git commit -m "feat(sim): curate_json streaming NDJSON binary + sim-build recipe"
```

---

## Task 3: Backend — wire models (`app/simulator/models.py`)

**Files:**

- Create: `studio/backend/app/simulator/__init__.py` (empty)
- Create: `studio/backend/app/simulator/models.py`
- Test: `studio/backend/tests/test_sim_models.py`

**Interfaces:**

- Produces:
  - `class CurationParams(_WireModel)`: `pool_size:int, candidate_count:int, master_seed:int, rtp_tolerance:float, realized_correction_band:float, bonus_rate_tolerance:float`
  - `class MetricsWire(_WireModel)`: `rtp, volatility, hit_frequency, base_rtp, feature_rtp: float; bonus_hit_rates: list[float]`
  - `class CurationResult(_WireModel)`: `status:Literal["pass","fail","error"]; metrics:MetricsWire; realized_rtp:float|None; pool_size:int|None; failure:str|None; ran_at:str`
  - `class SlotModelDoc(_WireModel)`: `id, game_id:str; model:dict; params:CurationParams; result:CurationResult|None; created_at,updated_at:str`
  - `def default_params() -> CurationParams`
  - `def sim_wire(doc: SlotModelDoc) -> dict`

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_sim_models.py
from app.simulator.models import (
    CurationParams, SlotModelDoc, default_params, sim_wire,
)

def test_default_params_are_sane():
    p = default_params()
    assert p.pool_size > 0 and p.candidate_count >= p.pool_size
    assert 0 < p.rtp_tolerance < 1

def test_sim_wire_is_camel_cased():
    doc = SlotModelDoc(
        id="d1", game_id="g1", model={"reels": []}, params=default_params(),
        result=None, created_at="t", updated_at="t",
    )
    wire = sim_wire(doc)
    assert wire["gameId"] == "g1"
    assert wire["params"]["candidateCount"] == default_params().candidate_count
    assert "model" in wire
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_sim_models.py -v`
Expected: FAIL — `ModuleNotFoundError: app.simulator`.

- [ ] **Step 3: Implement the models**

```python
# studio/backend/app/simulator/models.py
from typing import Literal
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

class CurationParams(_WireModel):
    pool_size: int
    candidate_count: int
    master_seed: int
    rtp_tolerance: float
    realized_correction_band: float
    bonus_rate_tolerance: float  # relative ± band around the GDD bonus rate

class MetricsWire(_WireModel):
    rtp: float
    volatility: float
    hit_frequency: float
    base_rtp: float
    feature_rtp: float
    bonus_hit_rates: list[float]

class CurationResult(_WireModel):
    status: Literal["pass", "fail", "error"]
    metrics: MetricsWire
    realized_rtp: float | None = None
    pool_size: int | None = None
    failure: str | None = None
    ran_at: str

class SlotModelDoc(_WireModel):
    id: str
    game_id: str
    model: dict
    params: CurationParams
    result: CurationResult | None = None
    created_at: str
    updated_at: str

def default_params() -> CurationParams:
    return CurationParams(
        pool_size=1_000,
        candidate_count=50_000,
        master_seed=2026,
        rtp_tolerance=0.01,
        realized_correction_band=0.05,
        bonus_rate_tolerance=0.25,
    )

def sim_wire(doc: SlotModelDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_sim_models.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/__init__.py studio/backend/app/simulator/models.py studio/backend/tests/test_sim_models.py
git commit -m "feat(sim): backend wire models for slot model + curation result"
```

---

## Task 4: Backend — derive `TargetSpec` from GDD intent (`app/simulator/targets.py`)

Pure functions mapping the structured GDD `math-model` `data` dict → the Rust target JSON. No store/IO here (decoupled from the unmerged GDD branch); the hub feeds the dict in Task 7.

**Files:**

- Create: `studio/backend/app/simulator/targets.py`
- Test: `studio/backend/tests/test_sim_targets.py`

**Interfaces:**

- Consumes: `CurationParams` (Task 3).
- Produces:
  - `VOLATILITY_BANDS: dict[str, tuple[float, float]]`
  - `def parse_ratio(raw) -> float` (e.g. `"1:200"` → 0.005; `0.005`/`"0.005"` pass through)
  - `def normalize_percent(raw) -> float` (`96`/`"96%"`/`0.96` → 0.96)
  - `class TargetGap(Exception)` with `.message: str`
  - `def derive_target(math_model: dict, params: CurationParams, num_bonuses: int) -> dict` — returns the JSON object the `curate_json` binary expects (`rtp_target, rtp_tolerance, volatility_min, volatility_max, bonus_hit_rate_bands:[{min,max}], pool_size, candidate_count, realized_correction_band, master_seed`). Raises `TargetGap` if a required intent field is missing.

- [ ] **Step 1: Write the failing tests**

```python
# studio/backend/tests/test_sim_targets.py
import pytest
from app.simulator.models import default_params
from app.simulator.targets import (
    parse_ratio, normalize_percent, derive_target, TargetGap,
)

def test_parse_ratio_forms():
    assert parse_ratio("1:200") == pytest.approx(0.005)
    assert parse_ratio(0.005) == pytest.approx(0.005)
    assert parse_ratio("0.005") == pytest.approx(0.005)

def test_normalize_percent_forms():
    assert normalize_percent(96) == pytest.approx(0.96)
    assert normalize_percent("96%") == pytest.approx(0.96)
    assert normalize_percent(0.96) == pytest.approx(0.96)

def test_derive_target_maps_intent():
    md = {"rtp": "96%", "volatility": "high", "bonus_hit_rate": "1:200"}
    t = derive_target(md, default_params(), num_bonuses=1)
    assert t["rtp_target"] == pytest.approx(0.96)
    assert t["volatility_min"] < t["volatility_max"]
    assert len(t["bonus_hit_rate_bands"]) == 1
    band = t["bonus_hit_rate_bands"][0]
    assert band["min"] < 0.005 < band["max"]
    assert t["candidate_count"] == default_params().candidate_count
    assert t["master_seed"] == default_params().master_seed

def test_derive_target_zero_bonuses_has_no_bands():
    md = {"rtp": 0.96, "volatility": "medium"}
    t = derive_target(md, default_params(), num_bonuses=0)
    assert t["bonus_hit_rate_bands"] == []

def test_missing_rtp_is_a_gap():
    with pytest.raises(TargetGap):
        derive_target({"volatility": "high"}, default_params(), num_bonuses=0)

def test_missing_bonus_rate_with_bonus_is_a_gap():
    with pytest.raises(TargetGap):
        derive_target({"rtp": 0.96, "volatility": "high"}, default_params(), num_bonuses=1)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_sim_targets.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the mappings**

```python
# studio/backend/app/simulator/targets.py
"""Derive a simulator TargetSpec (as the curate_json JSON contract) from the
structured GDD math-model intent. Pure; no IO. The enum->band table is a starting
contract (spec §3.3), tunable per game later."""
from app.simulator.models import CurationParams

# Volatility index = std-dev of per-spin payout in bet-multiples. Starting bands.
VOLATILITY_BANDS: dict[str, tuple[float, float]] = {
    "low": (0.0, 3.0),
    "medium": (3.0, 6.0),
    "medium-high": (6.0, 10.0),
    "high": (10.0, 1e9),
}

class TargetGap(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message

def normalize_percent(raw) -> float:
    if isinstance(raw, str):
        raw = float(raw.strip().rstrip("%"))
        # "96" (as string) means 96%, "0.96" means 0.96
        return raw / 100.0 if raw > 1.0 else raw
    raw = float(raw)
    return raw / 100.0 if raw > 1.0 else raw

def parse_ratio(raw) -> float:
    if isinstance(raw, str) and ":" in raw:
        num, denom = raw.split(":", 1)
        return float(num) / float(denom)
    return float(raw)

def _require(math_model: dict, key: str):
    val = math_model.get(key)
    if val is None or (isinstance(val, str) and not val.strip()):
        raise TargetGap(f"GDD math-model is missing required intent: {key}")
    return val

def derive_target(math_model: dict, params: CurationParams, num_bonuses: int) -> dict:
    rtp_target = normalize_percent(_require(math_model, "rtp"))

    vol_key = str(_require(math_model, "volatility")).strip().lower()
    if vol_key not in VOLATILITY_BANDS:
        raise TargetGap(f"unknown volatility '{vol_key}'")
    vmin, vmax = VOLATILITY_BANDS[vol_key]

    bands: list[dict] = []
    if num_bonuses > 0:
        center = parse_ratio(_require(math_model, "bonus_hit_rate"))
        tol = params.bonus_rate_tolerance
        band = {"min": center * (1.0 - tol), "max": center * (1.0 + tol)}
        bands = [dict(band) for _ in range(num_bonuses)]

    return {
        "rtp_target": rtp_target,
        "rtp_tolerance": params.rtp_tolerance,
        "volatility_min": vmin,
        "volatility_max": vmax,
        "bonus_hit_rate_bands": bands,
        "pool_size": params.pool_size,
        "candidate_count": params.candidate_count,
        "realized_correction_band": params.realized_correction_band,
        "master_seed": params.master_seed,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_sim_targets.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/targets.py studio/backend/tests/test_sim_targets.py
git commit -m "feat(sim): derive simulator TargetSpec from GDD math-model intent"
```

---

## Task 5: Backend — `CurationRunner` seam + subprocess impl (`app/simulator/runner.py`)

**Files:**

- Create: `studio/backend/app/simulator/runner.py`
- Test: `studio/backend/tests/test_sim_runner.py` (unit, Fake) and `studio/backend/tests/test_sim_curate_binary.py` (real subprocess, `@pytest.mark.e2e`).

**Interfaces:**

- Consumes: `CurationResult`, `MetricsWire` (Task 3); `app.config.Settings`.
- Produces:
  - `@dataclass class CurationProgress: phase:str; done:int|None=None; total:int|None=None`
  - `class CurationRunner(Protocol): async def run(self, model:dict, target:dict, on_progress:Callable[[CurationProgress],None]) -> CurationResult`
  - `class SubprocessCurationRunner` with `__init__(self, settings)` and the streaming parse.
  - `class FakeCurationRunner` with `__init__(self, *, progress:list[CurationProgress], result:CurationResult)`.
  - `def build_curation_runner(settings) -> CurationRunner`.

- [ ] **Step 1: Write the failing unit test (Fake + the result-line parser)**

```python
# studio/backend/tests/test_sim_runner.py
import pytest
from app.simulator.models import MetricsWire, CurationResult
from app.simulator.runner import (
    CurationProgress, FakeCurationRunner, parse_result_line,
)

def test_parse_result_line_pass():
    line = (
        '{"type":"result","status":"pass","rtp":0.96,"volatility":4.0,'
        '"hitFrequency":0.3,"baseRtp":0.9,"featureRtp":0.06,'
        '"bonusHitRates":[0.005],"realizedRtp":0.961,"poolSize":1000,"failure":null}'
    )
    r = parse_result_line(line, ran_at="t")
    assert r.status == "pass"
    assert r.metrics.rtp == pytest.approx(0.96)
    assert r.realized_rtp == pytest.approx(0.961)
    assert r.pool_size == 1000

@pytest.mark.asyncio
async def test_fake_runner_streams_then_returns():
    seen = []
    res = CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.9, feature_rtp=0.06, bonus_hit_rates=[0.005]),
        realized_rtp=0.96, pool_size=10, failure=None, ran_at="t",
    )
    runner = FakeCurationRunner(
        progress=[CurationProgress("simulate", 5, 10), CurationProgress("freeze")],
        result=res,
    )
    out = await runner.run({"reels": []}, {"rtp_target": 0.96}, on_progress=seen.append)
    assert [p.phase for p in seen] == ["simulate", "freeze"]
    assert out.status == "pass"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_sim_runner.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the runner**

```python
# studio/backend/app/simulator/runner.py
"""Invoke bloom-simulator's curate_json binary as a subprocess, parsing its NDJSON
progress + result stream. A FakeCurationRunner backs unit tests."""
import asyncio
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

from app.simulator.models import CurationResult, MetricsWire

@dataclass
class CurationProgress:
    phase: str
    done: int | None = None
    total: int | None = None

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def parse_result_line(line: str, *, ran_at: str) -> CurationResult:
    d = json.loads(line)
    metrics = MetricsWire(
        rtp=d["rtp"], volatility=d["volatility"], hit_frequency=d["hitFrequency"],
        base_rtp=d["baseRtp"], feature_rtp=d["featureRtp"],
        bonus_hit_rates=d.get("bonusHitRates", []),
    )
    return CurationResult(
        status=d["status"], metrics=metrics,
        realized_rtp=d.get("realizedRtp"), pool_size=d.get("poolSize"),
        failure=d.get("failure"), ran_at=ran_at,
    )

class CurationRunner(Protocol):
    async def run(self, model: dict, target: dict,
                  on_progress: Callable[[CurationProgress], None]) -> CurationResult: ...

# Repo root = .../app/simulator/runner.py -> parents[4]. Verify on first run.
_REPO_ROOT = Path(__file__).resolve().parents[4]

class SubprocessCurationRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "simulator_bin", "") or ""

    def _command(self, model_path: str, target_path: str, pkg_path: str) -> list[str]:
        if self._bin:
            return [self._bin, model_path, target_path, "studio-curation", pkg_path]
        # Dev/e2e default: cargo resolves+builds; its own logs go to stderr.
        return ["cargo", "run", "--release", "-p", "bloom-simulator",
                "--bin", "curate_json", "--", model_path, target_path,
                "studio-curation", pkg_path]

    async def run(self, model, target, on_progress) -> CurationResult:
        ran_at = _now_iso()
        tmp = Path(os.environ.get("TEMP", "/tmp")) / f"bloom-curation-{os.getpid()}-{id(model)}"
        tmp.mkdir(parents=True, exist_ok=True)
        model_path = str(tmp / "model.json")
        target_path = str(tmp / "target.json")
        pkg_path = str(tmp / "out.pkg")
        Path(model_path).write_text(json.dumps(model))
        Path(target_path).write_text(json.dumps(target))

        proc = await asyncio.create_subprocess_exec(
            *self._command(model_path, target_path, pkg_path),
            cwd=str(_REPO_ROOT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        result: CurationResult | None = None
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode().strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # ignore any non-JSON noise
            if obj.get("type") == "progress":
                on_progress(CurationProgress(
                    phase=obj["phase"], done=obj.get("done"), total=obj.get("total")))
            elif obj.get("type") == "result":
                result = parse_result_line(line, ran_at=ran_at)
        await proc.wait()

        if result is None:
            stderr = (await proc.stderr.read()).decode() if proc.stderr else ""
            return CurationResult(
                status="error",
                metrics=MetricsWire(rtp=0, volatility=0, hit_frequency=0,
                                    base_rtp=0, feature_rtp=0, bonus_hit_rates=[]),
                realized_rtp=None, pool_size=None,
                failure=f"simulator produced no result (exit {proc.returncode}): {stderr[:500]}",
                ran_at=ran_at,
            )
        return result

class FakeCurationRunner:
    def __init__(self, *, progress: list[CurationProgress], result: CurationResult):
        self._progress = progress
        self._result = result

    async def run(self, model, target, on_progress) -> CurationResult:
        for p in self._progress:
            on_progress(p)
        return self._result

def build_curation_runner(settings) -> CurationRunner:
    return SubprocessCurationRunner(settings)
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_sim_runner.py -v`
Expected: PASS.

- [ ] **Step 5: Write the real-subprocess integration test (e2e-marked)**

```python
# studio/backend/tests/test_sim_curate_binary.py
"""Shells out to the real Rust binary. Marked e2e so it stays out of the unit gate
(needs the cargo toolchain). Deterministic + offline — no cassettes."""
import pytest
from app.config import get_settings
from app.simulator.runner import SubprocessCurationRunner, CurationProgress

@pytest.mark.e2e
@pytest.mark.asyncio
async def test_real_curation_passes_for_known_model():
    model = {
        "symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
                    {"id": 2, "role": "normal"}],
        "reels": [[0, 0, 0, 0, 0, 1, 1, 1, 1, 2]], "rows": 1, "paylines": [[0]],
        "paytable": {"entries": [{"symbol": 1, "count": 1, "payout": 1},
                                 {"symbol": 2, "count": 1, "payout": 5}]},
        "bonuses": [],
    }
    target = {
        "rtp_target": 0.9, "rtp_tolerance": 0.02, "volatility_min": 0.0,
        "volatility_max": 1e9, "bonus_hit_rate_bands": [], "pool_size": 1000,
        "candidate_count": 20000, "realized_correction_band": 0.05, "master_seed": 2026,
    }
    seen: list[CurationProgress] = []
    runner = SubprocessCurationRunner(get_settings())
    res = await runner.run(model, target, on_progress=seen.append)
    assert res.status == "pass", res.failure
    assert abs(res.metrics.rtp - 0.9) < 0.02
    assert any(p.phase == "simulate" for p in seen)
```

- [ ] **Step 6: Run the integration test (local, with cargo available)**

Run: `cd studio/backend && uv run pytest tests/test_sim_curate_binary.py -m e2e -v`
Expected: PASS (first run compiles the binary; subsequent runs are fast).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/simulator/runner.py studio/backend/tests/test_sim_runner.py studio/backend/tests/test_sim_curate_binary.py
git commit -m "feat(sim): CurationRunner seam + subprocess impl over curate_json"
```

---

## Task 6: Backend — `SlotModelStore` (`app/simulator/store.py`)

**Files:**

- Create: `studio/backend/app/simulator/store.py`
- Test: `studio/backend/tests/test_sim_store.py`

**Interfaces:**

- Consumes: `SlotModelDoc`, `CurationParams`, `CurationResult`, `default_params` (Task 3).
- Produces `class SlotModelStore`:
  - `__init__(self, db)` — collection `slot_models`.
  - `async def get(self, game_id) -> SlotModelDoc | None`
  - `async def get_or_seed(self, game_id) -> SlotModelDoc` (creates an empty model + default params if absent)
  - `async def put(self, game_id, *, model:dict|None=None, params:CurationParams|None=None) -> SlotModelDoc`
  - `async def save_result(self, game_id, result:CurationResult) -> SlotModelDoc`

- [ ] **Step 1: Write the failing test (note the per-file collection cleanup)**

```python
# studio/backend/tests/test_sim_store.py
import pytest
import pytest_asyncio
from app.simulator.models import default_params, MetricsWire, CurationResult
from app.simulator.store import SlotModelStore

@pytest_asyncio.fixture(autouse=True)
async def _clear_slot_models(mongo_db):
    # conftest's mongo_db fixture does NOT wipe new collections — do it here.
    await mongo_db["slot_models"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})

@pytest.mark.asyncio
async def test_get_or_seed_creates_empty(mongo_db):
    store = SlotModelStore(mongo_db)
    doc = await store.get_or_seed("g1")
    assert doc.game_id == "g1"
    assert doc.params.candidate_count == default_params().candidate_count
    assert doc.result is None

@pytest.mark.asyncio
async def test_put_patches_model_and_params(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.get_or_seed("g1")
    doc = await store.put("g1", model={"reels": [[0, 1]]})
    assert doc.model == {"reels": [[0, 1]]}
    p = default_params(); p.pool_size = 500
    doc = await store.put("g1", params=p)
    assert doc.params.pool_size == 500
    assert doc.model == {"reels": [[0, 1]]}  # untouched

@pytest.mark.asyncio
async def test_save_result_persists(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.get_or_seed("g1")
    res = CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.9, feature_rtp=0.06, bonus_hit_rates=[]),
        realized_rtp=0.96, pool_size=1000, failure=None, ran_at="t",
    )
    doc = await store.save_result("g1", res)
    assert doc.result is not None and doc.result.status == "pass"
    again = await store.get("g1")
    assert again.result.realized_rtp == pytest.approx(0.96)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_sim_store.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the store**

```python
# studio/backend/app/simulator/store.py
import uuid
from datetime import datetime, timezone
from app.simulator.models import (
    SlotModelDoc, CurationParams, CurationResult, default_params,
)

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _to_doc(doc: SlotModelDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw

def _from_doc(raw: dict) -> SlotModelDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return SlotModelDoc.model_validate(data)

class SlotModelStore:
    def __init__(self, db):
        self._docs = db["slot_models"]

    async def get(self, game_id: str) -> SlotModelDoc | None:
        raw = await self._docs.find_one({"game_id": game_id})
        return _from_doc(raw) if raw else None

    async def get_or_seed(self, game_id: str) -> SlotModelDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = SlotModelDoc(
            id=str(uuid.uuid4()), game_id=game_id, model={}, params=default_params(),
            result=None, created_at=now, updated_at=now,
        )
        await self._docs.insert_one(_to_doc(doc))
        return doc

    async def put(self, game_id: str, *, model: dict | None = None,
                  params: CurationParams | None = None) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if model is not None:
            fields["model"] = model
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        return await self.get(game_id)

    async def save_result(self, game_id: str, result: CurationResult) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"result": result.model_dump(mode="json"), "updated_at": _now()}},
        )
        return await self.get(game_id)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_sim_store.py -v`
Expected: PASS. (Requires local MongoDB — `just mongo-up` if needed.)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/store.py studio/backend/tests/test_sim_store.py
git commit -m "feat(sim): SlotModelStore persisting model+params+result per game"
```

---

## Task 7: Backend — `CurationHub` (orchestrate + stream) (`app/simulator/hub.py`)

Loads the stored model + params, reads the GDD `math-model` `data`, derives the target, runs the runner, streams `curation_progress`, persists + emits `curation_complete`/`curation_failed`. **Depends on the merged structured GDD** for the `math-model` `data` dict.

**Files:**

- Create: `studio/backend/app/simulator/hub.py`
- Test: `studio/backend/tests/test_sim_hub.py`

**Interfaces:**

- Consumes: `SlotModelStore` (Task 6), `CurationRunner` + `CurationProgress` (Task 5), `derive_target` + `TargetGap` (Task 4), `sim_wire` (Task 3); a GDD reader with `async def get_doc(game_id, aspect) -> doc|None` where `doc.data` is the structured dict (the merged `GddStore`).
- Produces `class CurationHub`:
  - `__init__(self, sio, store, runner, gdd_store)`
  - `async def attach_subscriber(self, game_id, sid)` — `enter_room` + replay last result via `to=sid`.
  - `async def request_curation(self, game_id)` — the full pipeline + emits.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_sim_hub.py
import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.models import MetricsWire, CurationResult
from app.simulator.store import SlotModelStore
from app.simulator.runner import FakeCurationRunner, CurationProgress
from app.simulator.hub import CurationHub

@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})

class FakeSio:
    def __init__(self): self.events = []; self.rooms = []
    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))
    async def enter_room(self, sid, room): self.rooms.append((sid, room))

class FakeGdd:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data) if aspect == "math-model" else None

def _pass_result():
    return CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.9, feature_rtp=0.06, bonus_hit_rates=[]),
        realized_rtp=0.96, pool_size=1000, failure=None, ran_at="t")

@pytest.mark.asyncio
async def test_request_curation_emits_progress_then_complete(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    runner = FakeCurationRunner(
        progress=[CurationProgress("simulate", 1, 2)], result=_pass_result())
    sio = FakeSio()
    hub = CurationHub(sio, store, runner, FakeGdd({"rtp": 0.96, "volatility": "high"}))

    await hub.request_curation("g1")

    names = [e[0] for e in sio.events]
    assert "curation_progress" in names
    assert "curation_complete" in names
    saved = await store.get("g1")
    assert saved.result.status == "pass"

@pytest.mark.asyncio
async def test_request_curation_emits_failed_on_gdd_gap(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    runner = FakeCurationRunner(progress=[], result=_pass_result())
    sio = FakeSio()
    hub = CurationHub(sio, store, runner, FakeGdd({"volatility": "high"}))  # no rtp

    await hub.request_curation("g1")

    names = [e[0] for e in sio.events]
    assert "curation_failed" in names
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_sim_hub.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the hub**

```python
# studio/backend/app/simulator/hub.py
from app.simulator.models import sim_wire
from app.simulator.targets import derive_target, TargetGap

class CurationHub:
    def __init__(self, sio, store, runner, gdd_store):
        self._sio = sio
        self._store = store
        self._runner = runner
        self._gdd = gdd_store

    async def attach_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get(game_id)
        if doc is not None and doc.result is not None:
            await self._sio.emit(
                "curation_complete",
                {"gameId": game_id, "doc": sim_wire(doc)},
                to=sid,
            )

    async def request_curation(self, game_id: str) -> None:
        doc = await self._store.get_or_seed(game_id)
        model = doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])

        gdd = await self._gdd.get_doc(game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            target = derive_target(math_model, doc.params, num_bonuses)
        except TargetGap as gap:
            await self._sio.emit(
                "curation_failed",
                {"gameId": game_id, "failure": gap.message},
                room=game_id,
            )
            return

        async def on_progress(p):
            await self._sio.emit(
                "curation_progress",
                {"gameId": game_id, "phase": p.phase, "done": p.done, "total": p.total},
                room=game_id,
            )

        # The runner's callback is sync; bridge to async emit by collecting then
        # emitting is undesirable for live progress, so emit inline via a queue.
        import asyncio
        loop = asyncio.get_running_loop()
        def sync_progress(p):
            loop.create_task(on_progress(p))

        result = await self._runner.run(model, target, on_progress=sync_progress)
        saved = await self._store.save_result(game_id, result)

        event = "curation_complete" if result.status in ("pass", "fail") else "curation_failed"
        await self._sio.emit(
            event,
            {"gameId": game_id, "doc": sim_wire(saved)},
            room=game_id,
        )
```

> Note: `pass` and `fail` are both **completed** curations (a FAIL is a valid Approach-A verdict, surfaced in `doc.result`); only `status=="error"` (subprocess failure) emits `curation_failed`. The GDD-gap case emits `curation_failed` before running.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_sim_hub.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/hub.py studio/backend/tests/test_sim_hub.py
git commit -m "feat(sim): CurationHub derives target, runs curation, streams events"
```

---

## Task 8: Backend — REST router (`app/simulator/rest.py`)

**Files:**

- Create: `studio/backend/app/simulator/rest.py`
- Test: `studio/backend/tests/test_sim_rest.py`

**Interfaces:**

- Consumes: `request.app.state.sim_store` (`SlotModelStore`), `request.app.state.sim_hub` (`CurationHub`); `CurationParams`, `sim_wire`.
- Produces `router = APIRouter()` with:
  - `GET  /games/{game_id}/slot-model` → `sim_wire(get_or_seed)`
  - `PUT  /games/{game_id}/slot-model` (body `{model?:dict, params?:CurationParams}`) → `sim_wire`
  - `POST /games/{game_id}/slot-model/curate` (202) → kicks `sim_hub.request_curation` as a task
  - `GET  /games/{game_id}/slot-model/result` → `result | null`

- [ ] **Step 1: Write the failing test (handlers called directly with a stub request)**

```python
# studio/backend/tests/test_sim_rest.py
import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.store import SlotModelStore
from app.simulator import rest

@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})

def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))

@pytest.mark.asyncio
async def test_get_seeds_and_put_updates(mongo_db):
    store = SlotModelStore(mongo_db)
    req = _req(sim_store=store)
    got = await rest.get_slot_model("g1", req)
    assert got["gameId"] == "g1"
    updated = await rest.put_slot_model("g1", rest.PutSlotModelBody(model={"reels": [[0]]}), req)
    assert updated["model"] == {"reels": [[0]]}

@pytest.mark.asyncio
async def test_curate_kicks_off(mongo_db):
    store = SlotModelStore(mongo_db)
    calls = []
    hub = SimpleNamespace(request_curation=lambda gid: calls.append(gid))
    # request_curation must be awaitable in prod; here wrap to a coroutine:
    async def _req_cur(gid): calls.append(gid)
    hub.request_curation = _req_cur
    req = _req(sim_store=store, sim_hub=hub)
    resp = await rest.curate_slot_model("g1", req)
    # allow the scheduled task to run
    import asyncio; await asyncio.sleep(0)
    assert calls == ["g1"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_sim_rest.py -v`
Expected: FAIL — `ModuleNotFoundError` / missing attrs.

- [ ] **Step 3: Implement the router**

```python
# studio/backend/app/simulator/rest.py
import asyncio
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel
from app.simulator.models import CurationParams, sim_wire

router = APIRouter()

class PutSlotModelBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    model: dict | None = None
    params: CurationParams | None = None

@router.get("/games/{game_id}/slot-model")
async def get_slot_model(game_id: str, request: Request) -> dict:
    doc = await request.app.state.sim_store.get_or_seed(game_id)
    return sim_wire(doc)

@router.put("/games/{game_id}/slot-model")
async def put_slot_model(game_id: str, body: PutSlotModelBody, request: Request) -> dict:
    doc = await request.app.state.sim_store.put(
        game_id, model=body.model, params=body.params)
    return sim_wire(doc)

@router.post("/games/{game_id}/slot-model/curate", status_code=202)
async def curate_slot_model(game_id: str, request: Request) -> Response:
    asyncio.create_task(request.app.state.sim_hub.request_curation(game_id))
    return Response(status_code=202)

@router.get("/games/{game_id}/slot-model/result")
async def get_slot_model_result(game_id: str, request: Request) -> dict | None:
    doc = await request.app.state.sim_store.get(game_id)
    if doc is None or doc.result is None:
        return None
    return doc.result.model_dump(by_alias=True, mode="json")
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_sim_rest.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/rest.py studio/backend/tests/test_sim_rest.py
git commit -m "feat(sim): REST endpoints for slot model + curation"
```

---

## Task 9: Backend — Socket handlers (`app/simulator/sockets.py`)

**Files:**

- Create: `studio/backend/app/simulator/sockets.py`
- Test: `studio/backend/tests/test_sim_sockets.py`

**Interfaces:**

- Consumes: `CurationHub` (Task 7).
- Produces: `def register_sim_handlers(sio, hub)` registering `join_sim` (→ `hub.attach_subscriber`) and `leave_sim` (→ `sio.leave_room`).

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_sim_sockets.py
import pytest
from app.simulator.sockets import register_sim_handlers

class FakeSio:
    def __init__(self): self.handlers = {}; self.left = []
    def on(self, event):
        def deco(fn): self.handlers[event] = fn; return fn
        return deco
    async def leave_room(self, sid, room): self.left.append((sid, room))

class FakeHub:
    def __init__(self): self.attached = []
    async def attach_subscriber(self, game_id, sid): self.attached.append((game_id, sid))

@pytest.mark.asyncio
async def test_join_and_leave():
    sio, hub = FakeSio(), FakeHub()
    register_sim_handlers(sio, hub)
    await sio.handlers["join_sim"]("sid1", {"gameId": "g1"})
    await sio.handlers["leave_sim"]("sid1", {"gameId": "g1"})
    assert hub.attached == [("g1", "sid1")]
    assert sio.left == [("sid1", "g1")]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_sim_sockets.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement the handlers**

```python
# studio/backend/app/simulator/sockets.py
def register_sim_handlers(sio, hub):
    @sio.on("join_sim")
    async def join_sim(sid, data):
        await hub.attach_subscriber(data["gameId"], sid)

    @sio.on("leave_sim")
    async def leave_sim(sid, data):
        await sio.leave_room(sid, data["gameId"])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_sim_sockets.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/simulator/sockets.py studio/backend/tests/test_sim_sockets.py
git commit -m "feat(sim): socket handlers for curation subscription"
```

---

## Task 10: Backend — DI wiring + settings (`main.py`, `config.py`)

**Files:**

- Modify: `studio/backend/app/config.py` (add `simulator_bin`)
- Modify: `studio/backend/app/main.py` (construct store+hub, app.state, include_router, register handlers)
- Test: `studio/backend/tests/test_sim_wiring.py`

**Interfaces:**

- Consumes: `SlotModelStore`, `CurationHub`, `build_curation_runner`, `register_sim_handlers`, `router as sim_router`, and the existing `gdd_store` (from main's gdd wiring).

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_sim_wiring.py
from app.config import Settings
from app.main import build

def test_build_wires_simulator_routes_and_state():
    ctx = build(Settings())
    app = ctx.fastapi_app
    paths = {r.path for r in app.routes}
    assert "/games/{game_id}/slot-model" in paths
    assert "/games/{game_id}/slot-model/curate" in paths
    assert hasattr(app.state, "sim_store")

def test_settings_has_simulator_bin():
    assert hasattr(Settings(), "simulator_bin")
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_sim_wiring.py -v`
Expected: FAIL — no `simulator_bin`, routes/state missing.

- [ ] **Step 3: Add the setting**

In `studio/backend/app/config.py`, add to the `Settings` class (next to `comfyui_url`/`media_dir`):

```python
    simulator_bin: str = ""  # optional path to a prebuilt curate_json; "" => cargo run
```

- [ ] **Step 4: Wire `build()` in `main.py`**

Add imports near the other feature imports:

```python
from app.simulator.store import SlotModelStore
from app.simulator.hub import CurationHub
from app.simulator.runner import build_curation_runner
from app.simulator.sockets import register_sim_handlers
from app.simulator.rest import router as sim_router
```

In `build(settings)`, right after the `gdd_store` / `gdd_hub` construction block:

```python
    sim_store = SlotModelStore(mongo[settings.mongo_db])
    sim_hub = CurationHub(sio, sim_store, build_curation_runner(settings), gdd_store)
```

In the app.state + include_router block (next to `fastapi_app.state.gdd_store = ...`):

```python
    fastapi_app.state.sim_store = sim_store
    fastapi_app.state.sim_hub = sim_hub
    fastapi_app.include_router(sim_router)
```

In the handler-registration block (next to `register_gdd_handlers(sio, gdd_hub)`):

```python
    register_sim_handlers(sio, sim_hub)
```

If `AppContext` is a dataclass you want to surface them on, add `sim_store` / `sim_hub` fields and set them where the other ctx fields are assigned (optional; the tests only require `app.state`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_sim_wiring.py -v`
Expected: PASS.

- [ ] **Step 6: Run the whole backend unit suite (no regressions)**

Run: `just backend-test`
Expected: PASS (all `not e2e` tests, including the new simulator ones except the e2e-marked binary test).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/config.py studio/backend/app/main.py studio/backend/tests/test_sim_wiring.py
git commit -m "feat(sim): wire SlotModelStore + CurationHub + routes into the app"
```

---

## Task 11: Frontend — config, state, restClient

**Files:**

- Create: `studio/frontend/src/plugins/simulator/config.ts`, `state.ts`, `restClient.ts`
- Test: `studio/frontend/src/plugins/simulator/restClient.spec.ts`

**Interfaces:**

- Produces:
  - `SIMULATOR_PLUGIN_ID = 'simulator'`
  - `interface ISimulatorState { connection; activeGameId:string|null; modelText:string; params:ICurationParams|null; derivedTargetError:string|null; status:'idle'|'running'|'pass'|'fail'|'error'; progress:{phase:string;done:number|null;total:number|null}|null; result:ICurationResult|null; loadStatus:'idle'|'loading'|'error' }`
  - `makeInitialState()`, `simulatorHooks`, `simulatorSlice()`
  - restClient: `getSlotModel(gameId)`, `putSlotModel(gameId, patch)`, `curate(gameId)`, `getResult(gameId)`

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/simulator/restClient.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSlotModel, putSlotModel, curate } from './restClient';

describe('simulator restClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GETs the slot model', async () => {
    const doc = { id: 'd1', gameId: 'g1', model: {}, params: {}, result: null };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(doc), { status: 200 })),
    );
    const got = await getSlotModel('g1');
    expect(got.gameId).toBe('g1');
  });

  it('PUTs a model patch', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ gameId: 'g1', model: { reels: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await putSlotModel('g1', { model: { reels: [] } });
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe('PUT');
  });

  it('POSTs curate (202)', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', spy);
    await curate('g1');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain('/games/g1/slot-model/curate');
    expect(init.method).toBe('POST');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx nx test frontend --testFile=src/plugins/simulator/restClient.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config, state, restClient**

```ts
// studio/frontend/src/plugins/simulator/config.ts
export { BACKEND_URL } from '../assets/config';
```

```ts
// studio/frontend/src/plugins/simulator/state.ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const SIMULATOR_PLUGIN_ID = 'simulator';

export interface ICurationParams {
  poolSize: number;
  candidateCount: number;
  masterSeed: number;
  rtpTolerance: number;
  realizedCorrectionBand: number;
  bonusRateTolerance: number;
}

export interface IMetrics {
  rtp: number;
  volatility: number;
  hitFrequency: number;
  baseRtp: number;
  featureRtp: number;
  bonusHitRates: number[];
}

export interface ICurationResult {
  status: 'pass' | 'fail' | 'error';
  metrics: IMetrics;
  realizedRtp: number | null;
  poolSize: number | null;
  failure: string | null;
  ranAt: string;
}

export interface ISlotModelDoc {
  id: string;
  gameId: string;
  model: unknown;
  params: ICurationParams;
  result: ICurationResult | null;
}

export interface ISimulatorState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  modelText: string;
  params: ICurationParams | null;
  status: 'idle' | 'running' | 'pass' | 'fail' | 'error';
  progress: { phase: string; done: number | null; total: number | null } | null;
  result: ICurationResult | null;
  loadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): ISimulatorState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    modelText: '',
    params: null,
    status: 'idle',
    progress: null,
    result: null,
    loadStatus: 'idle',
  };
}

export const simulatorHooks = makePluginHooks<ISimulatorState>(SIMULATOR_PLUGIN_ID);

export function simulatorSlice(): State<ISimulatorState> {
  return rootStore.plugins.nested(SIMULATOR_PLUGIN_ID) as unknown as State<ISimulatorState>;
}
```

```ts
// studio/frontend/src/plugins/simulator/restClient.ts
import { BACKEND_URL } from './config';
import type { ISlotModelDoc, ICurationResult, ICurationParams } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getSlotModel(gameId: string): Promise<ISlotModelDoc> {
  return okJson<ISlotModelDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`));
}

export async function putSlotModel(gameId: string, patch: { model?: unknown; params?: ICurationParams }): Promise<ISlotModelDoc> {
  return okJson<ISlotModelDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/slot-model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function curate(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/curate`, { method: 'POST' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function getResult(gameId: string): Promise<ICurationResult | null> {
  return okJson<ICurationResult | null>(await fetch(`${BACKEND_URL}/games/${gameId}/slot-model/result`));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx nx test frontend --testFile=src/plugins/simulator/restClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/simulator/config.ts studio/frontend/src/plugins/simulator/state.ts studio/frontend/src/plugins/simulator/restClient.ts studio/frontend/src/plugins/simulator/restClient.spec.ts
git commit -m "feat(sim): frontend state slice + rest client"
```

---

## Task 12: Frontend — reducers, socket client, actions

**Files:**

- Create: `studio/frontend/src/plugins/simulator/reducers.ts`, `socketClient.ts`, `actions.ts`
- Test: `studio/frontend/src/plugins/simulator/reducers.spec.ts`

**Interfaces:**

- Produces:
  - reducers: `applyProgress(state, p)`, `applyResultDoc(state, doc)` returning partial updates / pure transforms used by the socket client.
  - `simSock()` singleton: `connect`, `disconnect`, `joinSim(gameId)`, `leaveSim(gameId)`.
  - actions: `initSim()`, `openGameSim(gameId)`, `closeGameSim()`.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/simulator/reducers.spec.ts
import { describe, it, expect } from 'vitest';
import { statusFromResult } from './reducers';

describe('simulator reducers', () => {
  it('maps a pass result to status pass', () => {
    expect(statusFromResult({ status: 'pass' } as never)).toBe('pass');
  });
  it('maps a fail result to status fail', () => {
    expect(statusFromResult({ status: 'fail' } as never)).toBe('fail');
  });
  it('maps an error result to status error', () => {
    expect(statusFromResult({ status: 'error' } as never)).toBe('error');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx nx test frontend --testFile=src/plugins/simulator/reducers.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement reducers, socket client, actions**

```ts
// studio/frontend/src/plugins/simulator/reducers.ts
import type { ICurationResult, ISimulatorState } from './state';

export function statusFromResult(r: ICurationResult): ISimulatorState['status'] {
  return r.status; // 'pass' | 'fail' | 'error'
}
```

```ts
// studio/frontend/src/plugins/simulator/socketClient.ts
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { simulatorSlice, type ISlotModelDoc } from './state';
import { statusFromResult } from './reducers';

let sock: Socket | null = null;
function isActive(gameId: string): boolean {
  return simulatorSlice().activeGameId.get() === gameId;
}

export function createSimSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'simulator' } });
    sock.on('curation_progress', (p: { gameId: string; phase: string; done: number | null; total: number | null }) => {
      if (!isActive(p.gameId)) return;
      simulatorSlice().progress.set({ phase: p.phase, done: p.done, total: p.total });
      simulatorSlice().status.set('running');
    });
    const onDoc = (p: { gameId: string; doc: ISlotModelDoc }) => {
      if (!isActive(p.gameId)) return;
      const result = p.doc.result;
      simulatorSlice().result.set(result);
      simulatorSlice().progress.set(null);
      simulatorSlice().status.set(result ? statusFromResult(result) : 'idle');
    };
    sock.on('curation_complete', onDoc);
    sock.on('curation_failed', (p: { gameId: string; failure?: string }) => {
      if (!isActive(p.gameId)) return;
      simulatorSlice().status.set('error');
      simulatorSlice().progress.set(null);
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinSim: (gameId: string) => sock?.emit('join_sim', { gameId }),
    leaveSim: (gameId: string) => sock?.emit('leave_sim', { gameId }),
  };
}

let client: ReturnType<typeof createSimSocket> | null = null;
export function simSock() {
  if (!client) client = createSimSocket();
  return client;
}
```

```ts
// studio/frontend/src/plugins/simulator/actions.ts
import { simSock } from './socketClient';
import { simulatorSlice } from './state';
import { getSlotModel } from './restClient';

export function initSim(): void {
  simSock().connect();
}

export async function openGameSim(gameId: string): Promise<void> {
  const s = simulatorSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  simSock().joinSim(gameId);
  try {
    const doc = await getSlotModel(gameId);
    s.modelText.set(JSON.stringify(doc.model ?? {}, null, 2));
    s.params.set(doc.params);
    s.result.set(doc.result);
    s.status.set(doc.result ? doc.result.status : 'idle');
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameSim(): void {
  const s = simulatorSlice();
  const prev = s.activeGameId.get();
  if (prev) simSock().leaveSim(prev);
  s.activeGameId.set(null);
  s.modelText.set('');
  s.params.set(null);
  s.result.set(null);
  s.progress.set(null);
  s.status.set('idle');
  s.loadStatus.set('idle');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx nx test frontend --testFile=src/plugins/simulator/reducers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/simulator/reducers.ts studio/frontend/src/plugins/simulator/socketClient.ts studio/frontend/src/plugins/simulator/actions.ts studio/frontend/src/plugins/simulator/reducers.spec.ts
git commit -m "feat(sim): frontend socket client + actions + reducers"
```

---

## Task 13: Frontend — pane, plugin registration, RoomRoute wiring

**Files:**

- Create: `studio/frontend/src/plugins/simulator/SimulatorPane.tsx`, `index.ts`
- Modify: `studio/frontend/src/plugins/index.ts` (register)
- Modify: `studio/frontend/src/app/routes/RoomRoute.tsx` (open/close on game)
- Test: `studio/frontend/src/plugins/simulator/SimulatorPane.spec.tsx`

**Interfaces:**

- Consumes: `simulatorHooks`, `simulatorSlice` (Task 11); `putSlotModel`, `curate` (Task 11); `openGameSim`, `closeGameSim`, `initSim` (Task 12).
- Produces: `export const simulator: IPlugin<ISimulatorState>` with pane id `simulator/viewer`.

- [ ] **Step 1: Write the failing component test**

```tsx
// studio/frontend/src/plugins/simulator/SimulatorPane.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { SIMULATOR_PLUGIN_ID, makeInitialState, simulatorSlice } from './state';
import { SimulatorPane } from './SimulatorPane';

vi.mock('./actions', () => ({ openGameSim: vi.fn(), closeGameSim: vi.fn(), initSim: vi.fn() }));
vi.mock('./restClient', () => ({ putSlotModel: vi.fn(), curate: vi.fn(), getSlotModel: vi.fn(), getResult: vi.fn() }));

describe('SimulatorPane', () => {
  beforeEach(() => {
    rootStore.plugins.nested(SIMULATOR_PLUGIN_ID).set(makeInitialState() as never);
  });

  it('shows empty state with no active game', () => {
    render(<SimulatorPane {...({} as never)} />);
    expect(screen.getByTestId('simulator-no-game')).toBeTruthy();
  });

  it('shows a PASS badge when the result passed', () => {
    act(() => {
      simulatorSlice().activeGameId.set('g1');
      simulatorSlice().status.set('pass');
      simulatorSlice().result.set({
        status: 'pass',
        metrics: { rtp: 0.96, volatility: 4, hitFrequency: 0.3, baseRtp: 0.9, featureRtp: 0.06, bonusHitRates: [] },
        realizedRtp: 0.96,
        poolSize: 1000,
        failure: null,
        ranAt: 't',
      });
    });
    render(<SimulatorPane {...({} as never)} />);
    expect(screen.getByTestId('curation-status').textContent).toContain('PASS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx nx test frontend --testFile=src/plugins/simulator/SimulatorPane.spec.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pane**

```tsx
// studio/frontend/src/plugins/simulator/SimulatorPane.tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { simulatorHooks, simulatorSlice } from './state';
import { putSlotModel, curate } from './restClient';

export function SimulatorPane(_props: IDockviewPanelProps) {
  const s = simulatorHooks.usePluginState();
  const activeGameId = s.activeGameId.get();

  if (!activeGameId) {
    return (
      <div data-testid="simulator-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to author and curate its slot model.
      </div>
    );
  }

  const status = s.status.get();
  const result = s.result.get();
  const progress = s.progress.get();
  const modelText = s.modelText.get();

  async function onCurate() {
    try {
      const parsed = JSON.parse(simulatorSlice().modelText.get());
      await putSlotModel(activeGameId!, { model: parsed });
      simulatorSlice().status.set('running');
      simulatorSlice().progress.set({ phase: 'starting', done: null, total: null });
      await curate(activeGameId!);
    } catch (e) {
      simulatorSlice().status.set('error');
      simulatorSlice().progress.set(null);
    }
  }

  const badge = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status === 'error' ? 'ERROR' : '';
  const badgeClass = status === 'pass' ? 'text-success' : status === 'fail' || status === 'error' ? 'text-danger' : 'text-text-3';

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-hairline p-2">
        <span className="text-sm text-text-1">Slot model</span>
        <button
          data-testid="curate-button"
          onClick={onCurate}
          disabled={status === 'running'}
          className="rounded px-3 py-1 text-sm text-text-1 hover:bg-raised-hover disabled:text-text-3"
        >
          {status === 'running' ? 'Curating…' : 'Curate'}
        </button>
      </div>

      <textarea
        data-testid="simulator-model-json"
        value={modelText}
        onChange={(e) => simulatorSlice().modelText.set(e.target.value)}
        spellCheck={false}
        className="h-48 flex-none resize-none bg-canvas p-2 font-mono text-xs text-text-1 outline-none"
      />

      {progress && (
        <div data-testid="curation-progress" className="border-t border-hairline p-2 text-xs text-text-2">
          {progress.phase}
          {progress.total ? ` ${progress.done}/${progress.total}` : ''}
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm text-text-2">Verdict</span>
          <span data-testid="curation-status" className={`text-sm font-semibold ${badgeClass}`}>
            {badge}
          </span>
        </div>
        {result && (
          <table className="text-xs text-text-1">
            <tbody>
              <tr>
                <td className="pr-4 text-text-2">Measured RTP</td>
                <td data-testid="metric-rtp">{result.metrics.rtp.toFixed(4)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Realized RTP</td>
                <td>{result.realizedRtp?.toFixed(4) ?? '—'}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Volatility</td>
                <td>{result.metrics.volatility.toFixed(3)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Hit frequency</td>
                <td>{result.metrics.hitFrequency.toFixed(4)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Pool size</td>
                <td>{result.poolSize ?? '—'}</td>
              </tr>
            </tbody>
          </table>
        )}
        {result?.failure && <p className="mt-2 text-xs text-danger">{result.failure}</p>}
      </div>
    </div>
  );
}
```

> Status token note: this uses `text-success` / `text-danger` / `bg-canvas`. If the guard test reports these aren't defined Tailwind tokens, substitute the project's actual status/surface token names (check `studio/frontend/src/styles.css` + the design-language doc) — do NOT introduce raw hex.

```ts
// studio/frontend/src/plugins/simulator/index.ts
import type { IPlugin } from '../../host/types';
import { SimulatorPane } from './SimulatorPane';
import { SIMULATOR_PLUGIN_ID, makeInitialState, type ISimulatorState } from './state';
import { initSim } from './actions';

export const simulator: IPlugin<ISimulatorState> = {
  id: SIMULATOR_PLUGIN_ID,
  title: 'Simulator',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'simulator/viewer', title: 'Simulator', component: SimulatorPane as never }],
  commands: [{ id: 'simulator/open-viewer', title: 'Open Simulator', run: (host) => host.openPane('simulator/viewer') }],
  init: () => initSim(),
};
```

- [ ] **Step 4: Register the plugin**

In `studio/frontend/src/plugins/index.ts` add the import and append to `PLUGINS`:

```ts
import { simulator } from './simulator';
// ...
export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets, gdd, simulator];
```

- [ ] **Step 5: Wire RoomRoute open/close**

In `studio/frontend/src/app/routes/RoomRoute.tsx`, add the import:

```ts
import { openGameSim, closeGameSim } from '../../plugins/simulator/actions';
```

next to the other `if (found.gameId) void openGame...` calls add:

```ts
if (found.gameId) void openGameSim(found.gameId);
```

and in the unmount cleanup (next to `closeGame(); closeGameDocs();`) add:

```ts
closeGameSim();
```

- [ ] **Step 6: Run the component test to verify it passes**

Run: `npx nx test frontend --testFile=src/plugins/simulator/SimulatorPane.spec.tsx`
Expected: PASS.

- [ ] **Step 7: Run the frontend gate (types + unit + build)**

Run: `npx nx typecheck frontend && just ts-test && npx nx build frontend`
Expected: all PASS. Then `npx prettier --check .` (fix with `npx prettier --write .` if needed — a known CI gate).

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/simulator/SimulatorPane.tsx studio/frontend/src/plugins/simulator/index.ts studio/frontend/src/plugins/index.ts studio/frontend/src/app/routes/RoomRoute.tsx studio/frontend/src/plugins/simulator/SimulatorPane.spec.tsx
git commit -m "feat(sim): simulator pane + plugin registration + room wiring"
```

---

## Task 14: End-to-end (Playwright) — author → curate → PASS, and FAIL

**Files:**

- Create: `studio/frontend/e2e/simulator.spec.ts`

**Interfaces:**

- Consumes: `seedLocalStorage` from `./helpers`; the running stack (backend :8000 + frontend). Real curation (small `candidateCount`), deterministic, offline — no cassettes.

- [ ] **Step 1: Write the e2e spec**

```ts
// studio/frontend/e2e/simulator.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

const BACKEND = process.env.VITE_BLOOM_BACKEND_URL ?? 'http://localhost:8000';

// A 1-reel model with closed-form RTP 0.9 (5x sym0, 4x sym1->1, 1x sym2->5).
const MODEL_09 = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 1, role: 'normal' },
    { id: 2, role: 'normal' },
  ],
  reels: [[0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
  rows: 1,
  paylines: [[0]],
  paytable: {
    entries: [
      { symbol: 1, count: 1, payout: 1 },
      { symbol: 2, count: 1, payout: 5 },
    ],
  },
  bonuses: [],
};

async function openGame(page: Page, username: string): Promise<string> {
  const res = await page.request.post(`${BACKEND}/rooms`, { data: { name: `sim ${Date.now()}` } });
  const room = await res.json();
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByTestId('room-picker').waitFor();
  await page.getByText(room.name).click();
  await page.getByTestId('chat-room-pane').waitFor();
  return room.gameId as string;
}

async function setGddMathIntent(page: Page, gameId: string, rtp: string, volatility: string) {
  // Make the GDD the source of truth for intent. Uses the structured set_fields path.
  await page.request.put(`${BACKEND}/games/${gameId}/gdd/math-model`, {
    data: { fields: { rtp, volatility } },
  });
}

async function openSimulator(page: Page) {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-simulator/viewer').click();
  await page.getByTestId('simulator-model-json').waitFor();
}

test('author a model and curate to PASS against GDD intent', async ({ page }) => {
  const gameId = await openGame(page, 'alice');
  await setGddMathIntent(page, gameId, '90%', 'high');
  // Use a small candidate count for a fast deterministic run.
  await page.request.put(`${BACKEND}/games/${gameId}/slot-model`, {
    data: { params: { poolSize: 500, candidateCount: 20000, masterSeed: 2026, rtpTolerance: 0.02, realizedCorrectionBand: 0.05, bonusRateTolerance: 0.25 } },
  });
  await openSimulator(page);
  await page.getByTestId('simulator-model-json').fill(JSON.stringify(MODEL_09, null, 2));
  await page.getByTestId('curate-button').click();
  await expect(page.getByTestId('curation-status')).toContainText('PASS', { timeout: 60_000 });
  await expect(page.getByTestId('metric-rtp')).toContainText('0.9');
});

test('a mismatched intent curates to FAIL', async ({ page }) => {
  const gameId = await openGame(page, 'bob');
  await setGddMathIntent(page, gameId, '50%', 'high'); // model is ~0.9 -> misses 0.5
  await page.request.put(`${BACKEND}/games/${gameId}/slot-model`, {
    data: { params: { poolSize: 500, candidateCount: 20000, masterSeed: 2026, rtpTolerance: 0.02, realizedCorrectionBand: 0.05, bonusRateTolerance: 0.25 } },
  });
  await openSimulator(page);
  await page.getByTestId('simulator-model-json').fill(JSON.stringify(MODEL_09, null, 2));
  await page.getByTestId('curate-button').click();
  await expect(page.getByTestId('curation-status')).toContainText('FAIL', { timeout: 60_000 });
});
```

> The GDD intent-setting endpoint (`PUT /games/:id/gdd/math-model` with `{fields}`) is the structured-GDD write path from `feat/gdd-structured-content`. Confirm its exact route/shape after that branch merges; adjust this helper to match (it is the one place this spec touches their surface).

- [ ] **Step 2: Start the stack (confirm no other session holds it)**

Run (separate terminals): `just mongo-up`, then `just backend-serve-replay`, then `just serve-frontend`.
First build the Rust binary so the first curation isn't slow: `just sim-build`.

- [ ] **Step 3: Run the e2e and watch it pass**

Run: `just e2e -- simulator.spec.ts`
Expected: both tests PASS (real curation, ~seconds each at `candidateCount: 20000`).

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/simulator.spec.ts
git commit -m "test(sim): e2e author-model -> curate -> PASS/FAIL against GDD intent"
```

---

## Final verification (whole-branch)

- [ ] `cargo test --workspace` — all Rust green (Tasks 1–2 + existing).
- [ ] `just backend-test` — backend unit suite green (Tasks 3–10).
- [ ] `cd studio/backend && uv run pytest -m e2e tests/test_sim_curate_binary.py` — real binary green (Task 5).
- [ ] `npx nx typecheck frontend && just ts-test && npx nx build frontend && npx prettier --check .` — frontend gate green (Tasks 11–13).
- [ ] `just e2e -- simulator.spec.ts` — browser e2e green (Task 14).
- [ ] Request a whole-branch code review (superpowers:requesting-code-review) before opening the PR.

---

## Self-review notes (coverage against the spec)

- Spec §1 (persisted model, Rust seam, GDD-derived targets, UI) → Tasks 6, 5/2, 4/7, 11–13. ✅
- Spec §2 (intent vs realization vs reconciliation; merge-order) → Task 7 (GDD read) + Global Constraints. ✅
- Spec §3.2 (SlotModelDoc/params/result) → Task 3. §3.3 (target derivation table) → Task 4. ✅
- Spec §4 (subprocess seam, additive JSON binary, streaming, CurationHub) → Tasks 1, 2, 5, 7, 9. ✅
- Spec §5 (REST + socket surface) → Tasks 8, 9. ✅
- Spec §6 (plugin pane) → Tasks 11–13. ✅
- Spec §7 (fail-loud, gaps) → Task 2 (status fail), Task 7 (TargetGap → curation_failed), Task 13 (verdict UI). ✅
- Spec §8 (deterministic offline testing, no cassettes) → Tasks 5 (e2e-marked binary test), 14. ✅
- Spec §9 (module list) → matches Tasks 1–13 file map. ✅
- Spec §10 (build order) → Task order 1→14. ✅
- Deferred seams (tuner, agent tools, GDD write-back, forms) → explicitly NOT in any task. ✅
