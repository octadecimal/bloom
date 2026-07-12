# SP-A — Simulator Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the curate/verify/freeze pipeline in `bloom-simulator` from `SlotModel`-only to a `MathArtifact { Slots, Composed }` family seam, so composed@1 packages ship a curated, verified, signed seed pool exactly like slots packages (closes #172).

**Architecture:** A new `MathArtifact` enum in `bloom-simulator` mirrors the runtime server's `LoadedGame` dispatch (`runtime/server/src/state.rs:35`). `RoundSample` gains per-state payout attribution (`state_payouts`), so RTP/volatility/hit-frequency/max-win metrics have ONE implementation for both families, plus composed-only per-state RTP share and state-visit frequency for free. The composed `.pkg` build switches from informational `measure_pool` to the full curate → verify → freeze → sign pipeline; `measure_pool` is retired and the verify verdict replaces its readout.

**Tech Stack:** Rust (crates `bloom-simulator`, `bloom-math`, `bloom-package`, `bloom-tuner`), Python FastAPI (`studio/backend/app/compose` — verdict passthrough only).

**Spec:** `docs/superpowers/specs/2026-07-11-tooling-convergence-composed-design.md` §3.1–§3.3, §7 (on PR #194's branch `docs/tooling-convergence-spec`; not yet on main — don't be surprised the file is absent in this worktree).

## Global Constraints

- Both families stay first-class; nothing slots@1 is migrated or retired (spec §8).
- Enum dispatch, not a trait framework: two families, a `match` at each seam point (spec §2 decision 2).
- **`bloom-tuner` must keep compiling and its tests passing at the end of every task**, but SP-A does not change its behavior. Keep these slots-typed public signatures untouched: `measure::simulate(&SlotModel, &[u64])`, `run::verify(&SlotModel, ...)`, `constraints::static_violations(&SlotModel, ...)`, `constraints::validate_constraints(&SlotModel, ...)` (tuner call sites: `studio/tuner/src/genetic.rs:292,298,392`, `fitness.rs:107`, `validate.rs:83`).
- Determinism: same inputs → bit-identical package bytes (existing `run_curation_is_reproducible` pattern).
- Feature-level tuner bands (bonus RTP share / trigger-frequency **targets**) stay issue #160 — this plan only produces the per-state **measurements** (spec §8).
- Dev signing key everywhere: `SigningKey::from_bytes(&[7u8; 32])`.
- Rust gates before every commit: `cargo test --workspace`, `cargo fmt --all` (CI runs `--check`), `cargo clippy --workspace --all-targets`. (A prior merge was caught by fmt in CI — run it locally.)
- Commits use Conventional Commits format.
- Worktree: `C:\code\bloom.wt\sim-convergence`, branch `feat/sim-convergence`, `BLOOM_PORT_OFFSET=1` (Rust tests don't use ports; only the Python task cares and it's pytest-only, no live stack).
- `just` recipes currently fail in this environment (`just could not find the shell 'sh'`) — run the underlying `cargo`/`uv` commands directly as written in each step.

## File Structure

| File                                                                        | Change                                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `studio/simulator/src/measure.rs`                                           | `RoundSample` gains `total_payout` (rename of `payout`) + `state_payouts`; `sample_slots` extracted; `measure` computes `max_win`, `state_rtp`, `state_visit_freq` |
| `studio/simulator/src/target.rs`                                            | `Metrics` derives `Default`, gains `max_win`, `state_rtp`, `state_visit_freq`                                                                                      |
| `studio/simulator/src/artifact.rs`                                          | **new** — `MathArtifact` enum: parse/family/payload/evaluate/simulate + constraint dispatch                                                                        |
| `studio/simulator/src/constraints.rs`                                       | extract shared `pay_violations`, `max_win_violation`, `validate_constraints_core`                                                                                  |
| `studio/simulator/src/run.rs`                                               | `verify_with` core; `verify_artifact`; `run_curation_streamed`/`run_curation` take `&MathArtifact`                                                                 |
| `studio/simulator/src/curate.rs`                                            | field rename only                                                                                                                                                  |
| `studio/simulator/src/profile.rs`                                           | field rename only                                                                                                                                                  |
| `studio/simulator/src/compose.rs`                                           | **rewritten** — `measure_pool`/`PoolMetrics` deleted; `self_target` + `build_composed` (curated pipeline)                                                          |
| `studio/simulator/src/bin/curate_json.rs`                                   | parses `MathArtifact`; result line gains `maxWin`/`stateRtp`/`stateVisitFreq`                                                                                      |
| `studio/simulator/src/bin/compose_json.rs`                                  | job gains optional `target`; result gains `verdict` + richer `metrics`                                                                                             |
| `studio/simulator/src/bin/compose.rs`                                       | routes through the curated build                                                                                                                                   |
| `studio/simulator/src/lib.rs`                                               | `pub mod artifact;`                                                                                                                                                |
| `studio/tuner/src/{fitness,report}.rs`, `studio/tuner/src/bin/tune_json.rs` | test-only `Metrics` literal fixes (`..Default::default()`)                                                                                                         |
| `studio/backend/app/compose/{rest,autobuild}.py`                            | `verdict` passthrough                                                                                                                                              |
| `studio/backend/tests/{test_compose_rest,test_compose_autobuild}.py`        | passthrough tests                                                                                                                                                  |
| `runtime/server/demo/composed.pkg`                                          | rebuilt with a curated pool                                                                                                                                        |

No `bloom-math` changes: `StateExit { state, payout }` trace entries already ARE the per-state attribution (invariant `total_payout == Σ StateExit.payout` is test-enforced at `trusted/math/src/mechanics/composed/eval.rs:537`). Composed internals are reached via the pub modules (`bloom_math::mechanics::composed::{reels::ReelsConfig, mechanic::MechanicConfig}`).

---

### Task 1: RoundSample per-state attribution + shared Metrics

**Files:**

- Modify: `studio/simulator/src/measure.rs`
- Modify: `studio/simulator/src/target.rs:52-66` (Metrics)
- Modify: `studio/simulator/src/curate.rs` (rename ripple)
- Modify: `studio/simulator/src/profile.rs` (rename ripple)
- Modify: `studio/simulator/src/run.rs` (test-fixture ripple)
- Modify: `studio/simulator/src/bin/curate_json.rs` (result keys + test fixtures)
- Modify: `studio/tuner/src/fitness.rs:148`, `studio/tuner/src/report.rs:79`, `studio/tuner/src/bin/tune_json.rs:280` (test fixtures)

**Interfaces:**

- Consumes: `bloom_math::mechanics::slots::evaluate` (unchanged).
- Produces (later tasks rely on these exact shapes):

  ```rust
  pub struct RoundSample {
      pub seed: u64,
      pub total_payout: u64,               // renamed from `payout`
      pub base_payout: u64,
      pub feature_payout: u64,
      pub feature_triggers: Vec<bool>,     // slots only; empty for composed
      pub state_payouts: Vec<(String, u64)>, // one entry per state visit, visit order
  }
  pub(crate) fn sample_slots(model: &SlotModel, seed: u64) -> RoundSample;
  // Metrics gains: pub max_win: u64, pub state_rtp: BTreeMap<String, f64>,
  //                pub state_visit_freq: BTreeMap<String, f64>  + #[derive(Default)]
  ```

- [ ] **Step 1: Write the failing tests** — append to `mod tests` in `studio/simulator/src/measure.rs`:

```rust
    // 1 reel, 1 row: strip [2, 0]. sym0@1 pays 2. Scatter sym2 min_count 1
    // triggers a 1-spin x1 free-spins bonus (~50% of spins).
    fn bonused() -> SlotModel {
        use bloom_math::mechanics::slots::{BonusFeature, FreeSpinsConfig, TriggerSpec};
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 2, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![2, 0]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 1, payout: 2 }],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec { symbol: 2, min_count: 1 },
                config: FreeSpinsConfig {
                    spins_awarded: 1,
                    retrigger: false,
                    multiplier: 1,
                    feature_reels: None,
                },
            }],
        }
    }

    #[test]
    fn slots_samples_map_onto_base_and_feature_pseudo_states() {
        let samples = simulate(&bonused(), &crate::seedgen::generate_seeds(7, 2_000));
        assert!(samples.iter().any(|s| s.feature_triggers[0]));
        assert!(samples.iter().any(|s| !s.feature_triggers[0]));
        for s in &samples {
            assert_eq!(s.state_payouts[0], ("base".to_string(), s.base_payout));
            if s.feature_triggers[0] {
                assert_eq!(s.state_payouts[1], ("feature".to_string(), s.feature_payout));
                assert_eq!(s.state_payouts.len(), 2);
            } else {
                assert_eq!(s.state_payouts.len(), 1);
                assert_eq!(s.feature_payout, 0);
            }
            assert_eq!(
                s.state_payouts.iter().map(|(_, p)| p).sum::<u64>(),
                s.total_payout
            );
        }
    }

    #[test]
    fn measure_reports_max_win_and_per_state_shares() {
        let samples = simulate(&bonused(), &crate::seedgen::generate_seeds(7, 2_000));
        let m = measure(&samples);
        assert_eq!(
            m.max_win,
            samples.iter().map(|s| s.total_payout).max().unwrap()
        );
        assert!((m.state_rtp["base"] - m.base_rtp).abs() < 1e-12);
        assert!((m.state_rtp["feature"] - m.feature_rtp).abs() < 1e-12);
        assert!((m.state_visit_freq["base"] - 1.0).abs() < 1e-12);
        // single bonus: "feature" visit frequency IS the bonus hit rate
        assert!((m.state_visit_freq["feature"] - m.bonus_hit_rates[0]).abs() < 1e-12);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from the worktree root): `cargo test -p bloom-simulator`
Expected: COMPILE FAIL — `no field state_payouts`, `no field total_payout`, `no field max_win`.

- [ ] **Step 3: Implement.** In `studio/simulator/src/measure.rs`, replace the struct and `simulate`:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct RoundSample {
    pub seed: u64,
    /// Total round payout in bet-multiples (spec §3.2).
    pub total_payout: u64,
    pub base_payout: u64,
    pub feature_payout: u64,
    /// Whether each model bonus (in order) triggered this round. Slots only;
    /// empty for composed (feature-level bands stay issue #160).
    pub feature_triggers: Vec<bool>,
    /// Per-state payout attribution, one entry per state visit in visit order.
    /// Slots maps onto two pseudo-states: ("base", base_payout) always, plus
    /// ("feature", feature_payout) on rounds where any bonus triggered.
    pub state_payouts: Vec<(String, u64)>,
}

/// One slots round → the family-agnostic sample. Shared by `simulate` and
/// `MathArtifact::evaluate_seed`.
pub(crate) fn sample_slots(model: &SlotModel, seed: u64) -> RoundSample {
    let o = evaluate(model, seed);
    let mut state_payouts = vec![("base".to_string(), o.base_payout)];
    if o.features.iter().any(|f| f.triggered) {
        state_payouts.push(("feature".to_string(), o.feature_payout));
    }
    RoundSample {
        seed,
        total_payout: o.total_payout,
        base_payout: o.base_payout,
        feature_payout: o.feature_payout,
        feature_triggers: o.features.iter().map(|f| f.triggered).collect(),
        state_payouts,
    }
}

/// Evaluate every seed through the math engine, in parallel. Output order
/// matches `seeds` (rayon `map` preserves order).
pub fn simulate(model: &SlotModel, seeds: &[u64]) -> Vec<RoundSample> {
    seeds.par_iter().map(|&seed| sample_slots(model, seed)).collect()
}
```

In `measure()`, rename `s.payout` → `s.total_payout` (3 places: `rtp`, `variance`, `hit_frequency`) and add before the final `Metrics { .. }`:

```rust
    let mut state_sum: std::collections::BTreeMap<String, u64> = Default::default();
    let mut state_visits: std::collections::BTreeMap<String, u64> = Default::default();
    for s in samples {
        for (state, payout) in &s.state_payouts {
            *state_sum.entry(state.clone()).or_insert(0) += payout;
            *state_visits.entry(state.clone()).or_insert(0) += 1;
        }
    }

    Metrics {
        rtp,
        volatility: variance.sqrt(),
        hit_frequency: samples.iter().filter(|s| s.total_payout > 0).count() as f64 / n,
        bonus_hit_rates,
        base_rtp,
        feature_rtp,
        max_win: samples.iter().map(|s| s.total_payout).max().unwrap_or(0),
        state_rtp: state_sum.into_iter().map(|(k, v)| (k, v as f64 / n)).collect(),
        state_visit_freq: state_visits.into_iter().map(|(k, v)| (k, v as f64 / n)).collect(),
    }
```

In `studio/simulator/src/target.rs`, extend `Metrics` (keep every existing field and doc):

```rust
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Metrics {
    // ... existing six fields unchanged ...
    /// Largest single-round payout observed (bet-multiples).
    pub max_win: u64,
    /// Per-state RTP share: state id → mean payout per round. Slots uses the
    /// two pseudo-states "base"/"feature"; composed uses real state ids.
    pub state_rtp: BTreeMap<String, f64>,
    /// State-visit frequency: state id → mean visits per round (composed
    /// feature trigger frequency; groundwork for #160).
    pub state_visit_freq: BTreeMap<String, f64>,
}
```

- [ ] **Step 4: Fix the rename ripple** (mechanical; `total_payout` for every `RoundSample` field access, `..Default::default()` for every literal `Metrics { ... }` fixture):
  - `studio/simulator/src/curate.rs`: `samples[i].payout` / `samples[pidx].payout` / `samples[ridx].payout` → `.total_payout` (lines 41, 81, 85, 91, 96, 103–104); test helper `sample()` becomes:
    ```rust
    fn sample(seed: u64, payout: u64) -> RoundSample {
        RoundSample {
            seed,
            total_payout: payout,
            base_payout: payout,
            feature_payout: 0,
            feature_triggers: vec![],
            state_payouts: vec![("base".to_string(), payout)],
        }
    }
    ```
  - `studio/simulator/src/profile.rs`: `smp.payout` (3 uses) and `samples[cursor].payout` → `.total_payout`; the test helper `s()` and the two inline `RoundSample { ... }` literals (lines ~207, ~223) gain the two new fields, e.g. `total_payout: payout, ... state_payouts: vec![("base".to_string(), payout - feature), ("feature".to_string(), feature)]` — for the helper `s()` only add the `("feature", ...)` entry when `trig` is true, mirroring `sample_slots`.
  - `Metrics { ... }` literal fixtures get `..Default::default()` appended: `studio/simulator/src/run.rs:334`, `studio/simulator/src/target.rs:144`, `studio/simulator/src/bin/curate_json.rs:181,200,227`, `studio/tuner/src/fitness.rs:148`, `studio/tuner/src/report.rs:79`, `studio/tuner/src/bin/tune_json.rs:280`.
  - `studio/simulator/src/measure.rs` existing tests: `s.payout == 1` → `s.total_payout == 1`.

- [ ] **Step 5: Surface the new metrics in the slots curate result line** (additive, backward-compatible for `app/math`): in `studio/simulator/src/bin/curate_json.rs` `result_line`, add three keys to the `json!` block:

```rust
        "maxWin": metrics.max_win,
        "stateRtp": metrics.state_rtp,
        "stateVisitFreq": metrics.state_visit_freq,
```

- [ ] **Step 6: Run the full gate**

Run: `cargo test --workspace`
Expected: PASS (including bloom-tuner and bloom-runtime-server, untouched behavior).
Run: `cargo fmt --all` then `cargo clippy --workspace --all-targets`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(simulator): RoundSample per-state attribution + shared max-win/state metrics"
```

---

### Task 2: MathArtifact family seam

**Files:**

- Create: `studio/simulator/src/artifact.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**

- Consumes: `RoundSample` + `sample_slots` from Task 1; `bloom_math::mechanics::composed::{compile, evaluate, GameDefinition, CompiledGame, TraceEntry, FAMILY, to_payload}`, `bloom_math::mechanics::composed::reels::ReelsConfig`, `bloom_math::mechanics::slots::{SlotModel, to_payload}`.
- Produces (Tasks 3–4 rely on these):

  ```rust
  pub enum MathArtifact {
      Slots(SlotModel),
      Composed { def: GameDefinition, compiled: Box<CompiledGame>, reels: Option<ReelsConfig> },
  }
  impl MathArtifact {
      pub fn from_json_value(v: serde_json::Value) -> Result<MathArtifact, String>;
      pub fn from_definition(def: GameDefinition) -> Result<MathArtifact, Vec<DefinitionError>>;
      pub fn family(&self) -> &'static str;      // "slots@1" | "composed@1"
      pub fn math_payload(&self) -> Vec<u8>;      // postcard | JSON
      pub fn evaluate_seed(&self, seed: u64) -> RoundSample;
  }
  pub fn simulate(artifact: &MathArtifact, seeds: &[u64]) -> Vec<RoundSample>;
  ```

- [ ] **Step 1: Write the failing tests.** Create `studio/simulator/src/artifact.rs` containing ONLY the test module first (plus `use` lines it needs), register `pub mod artifact;` in `studio/simulator/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::composed::{evaluate, TraceEntry};
    use serde_json::json;

    fn demo_def_value() -> serde_json::Value {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime/server/demo/composed.definition.json"
        ))
        .expect("read demo definition");
        serde_json::from_str(&json).expect("parse demo definition")
    }

    fn slots_model_value() -> serde_json::Value {
        // no top-level "family" key — the legacy slots wire shape
        json!({
            "symbols": [{"id": 0, "role": "normal"}],
            "reels": [[0]],
            "rows": 1,
            "paylines": [[0]],
            "paytable": {"entries": [{"symbol": 0, "count": 1, "payout": 1}]},
            "bonuses": []
        })
    }

    #[test]
    fn family_sniff_dispatches_slots_composed_and_rejects_unknown() {
        assert!(matches!(
            MathArtifact::from_json_value(slots_model_value()).unwrap(),
            MathArtifact::Slots(_)
        ));
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        assert!(matches!(art, MathArtifact::Composed { .. }));
        assert_eq!(art.family(), "composed@1");
        let err = MathArtifact::from_json_value(json!({"family": "tower@9"})).unwrap_err();
        assert!(err.contains("unknown family"));
    }

    #[test]
    fn composed_artifact_that_fails_compile_is_an_error() {
        let mut v = demo_def_value();
        v["start"] = json!("no-such-state");
        assert!(MathArtifact::from_json_value(v).is_err());
    }

    #[test]
    fn composed_artifact_captures_the_reels_constraint_surface() {
        let MathArtifact::Composed { reels, .. } =
            MathArtifact::from_json_value(demo_def_value()).unwrap()
        else {
            panic!("expected composed");
        };
        let r = reels.expect("demo has a reels@1 instance");
        assert_eq!(r.paytable.entries.len(), 4);
        assert_eq!(r.symbols.len(), 4);
    }

    #[test]
    fn composed_sample_attribution_matches_the_trace() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let MathArtifact::Composed { ref compiled, .. } = art else { panic!() };
        // seeds from the kernel golden scan: 0=LOSE, 292=FS1, 3395=RETRIGGER, 8=FS2
        for seed in [0u64, 8, 292, 3395] {
            let s = art.evaluate_seed(seed);
            let trace = evaluate(compiled, seed);
            assert_eq!(s.total_payout, trace.total_payout);
            let exits: Vec<(String, u64)> = trace
                .entries
                .iter()
                .filter_map(|e| match e {
                    TraceEntry::StateExit { state, payout } => Some((state.clone(), *payout)),
                    _ => None,
                })
                .collect();
            assert_eq!(s.state_payouts, exits);
            assert_eq!(
                s.state_payouts.iter().map(|(_, p)| p).sum::<u64>(),
                s.total_payout
            );
            assert_eq!(s.base_payout, s.state_payouts.first().map(|(_, p)| *p).unwrap_or(0));
            assert_eq!(s.feature_payout, s.total_payout - s.base_payout);
            assert!(s.feature_triggers.is_empty());
        }
        // a feature seed visits more than one state
        assert!(art.evaluate_seed(292).state_payouts.len() >= 2);
    }

    #[test]
    fn artifact_simulate_matches_the_slots_path_and_is_deterministic() {
        let model: bloom_math::mechanics::slots::SlotModel =
            serde_json::from_value(slots_model_value()).unwrap();
        let art = MathArtifact::Slots(model.clone());
        let seeds = crate::seedgen::generate_seeds(7, 50);
        assert_eq!(simulate(&art, &seeds), crate::measure::simulate(&model, &seeds));

        let composed = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let a = simulate(&composed, &seeds);
        let b = simulate(&composed, &seeds);
        assert_eq!(a, b);
        assert_eq!(a.iter().map(|s| s.seed).collect::<Vec<_>>(), seeds);
    }

    #[test]
    fn math_payload_round_trips_per_family() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let def = bloom_math::mechanics::composed::from_payload(&art.math_payload()).unwrap();
        assert_eq!(def.start, "base");
        let slots = MathArtifact::from_json_value(slots_model_value()).unwrap();
        assert!(bloom_math::mechanics::slots::from_payload(&slots.math_payload()).is_ok());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-simulator artifact`
Expected: COMPILE FAIL — `MathArtifact` not defined.

- [ ] **Step 3: Implement** — top of `studio/simulator/src/artifact.rs`, above the test module:

```rust
//! The family seam: one artifact type for everything upstream of the runtime
//! server, mirroring its `LoadedGame` dispatch (runtime/server/src/state.rs).
//! Enum dispatch, append-only — two families, a `match` at each seam point
//! (spec §2 decision 2). Composed is compiled ONCE at load; `evaluate` runs
//! per seed (spec §3.1).

use crate::measure::{sample_slots, RoundSample};
use bloom_math::mechanics::composed::reels::ReelsConfig;
use bloom_math::mechanics::composed::{
    self, compile, CompiledGame, DefinitionError, GameDefinition, TraceEntry,
};
use bloom_math::mechanics::slots::{self, SlotModel};
use rayon::prelude::*;

#[derive(Debug, Clone)]
pub enum MathArtifact {
    Slots(SlotModel),
    Composed {
        def: GameDefinition,
        compiled: Box<CompiledGame>,
        /// Base config of the first `reels@1` instance — the surface pay
        /// constraints bind to (spec §3.3). None when the definition has no
        /// reels instance (or its base config only becomes complete after
        /// per-state overrides).
        reels: Option<ReelsConfig>,
    },
}

impl MathArtifact {
    /// Parse from the artifact's JSON payload, dispatching on the explicit
    /// top-level `family` field. Absent → slots (legacy default, spec §4).
    pub fn from_json_value(v: serde_json::Value) -> Result<MathArtifact, String> {
        match v.get("family").and_then(|f| f.as_str()) {
            Some(composed::FAMILY) => {
                let def: GameDefinition =
                    serde_json::from_value(v).map_err(|e| format!("definition parse: {e}"))?;
                MathArtifact::from_definition(def)
                    .map_err(|errs| format!("definition invalid: {errs:?}"))
            }
            None | Some("slots@1") => serde_json::from_value(v)
                .map(MathArtifact::Slots)
                .map_err(|e| format!("model parse: {e}")),
            Some(other) => Err(format!("unknown family: {other}")),
        }
    }

    /// Compile-validate a definition into an artifact (nothing downstream runs
    /// on an invalid definition).
    pub fn from_definition(def: GameDefinition) -> Result<MathArtifact, Vec<DefinitionError>> {
        let compiled = compile(&def)?;
        let reels = def
            .mechanics
            .iter()
            .find(|m| m.kind == "reels@1")
            .and_then(|m| serde_json::from_value::<ReelsConfig>(m.config.clone()).ok());
        Ok(MathArtifact::Composed {
            def,
            compiled: Box::new(compiled),
            reels,
        })
    }

    pub fn family(&self) -> &'static str {
        match self {
            MathArtifact::Slots(_) => "slots@1",
            MathArtifact::Composed { .. } => composed::FAMILY,
        }
    }

    /// The signed package payload, in the family's wire encoding
    /// (slots: postcard; composed: JSON).
    pub fn math_payload(&self) -> Vec<u8> {
        match self {
            MathArtifact::Slots(m) => slots::to_payload(m),
            MathArtifact::Composed { def, .. } => composed::to_payload(def),
        }
    }

    /// Evaluate one seed to the family-agnostic sample. Composed walks the
    /// trace: `StateExit` entries ARE the per-state attribution; base is the
    /// first state visit (always the start state).
    pub fn evaluate_seed(&self, seed: u64) -> RoundSample {
        match self {
            MathArtifact::Slots(m) => sample_slots(m, seed),
            MathArtifact::Composed { compiled, .. } => {
                let trace = composed::evaluate(compiled, seed);
                let state_payouts: Vec<(String, u64)> = trace
                    .entries
                    .iter()
                    .filter_map(|e| match e {
                        TraceEntry::StateExit { state, payout } => {
                            Some((state.clone(), *payout))
                        }
                        _ => None,
                    })
                    .collect();
                let base_payout = state_payouts.first().map(|(_, p)| *p).unwrap_or(0);
                RoundSample {
                    seed,
                    total_payout: trace.total_payout,
                    base_payout,
                    feature_payout: trace.total_payout - base_payout,
                    feature_triggers: Vec::new(),
                    state_payouts,
                }
            }
        }
    }
}

/// Family-dispatched batch evaluation; order matches `seeds` (rayon `map`
/// preserves order), identical to `measure::simulate` on the slots arm.
pub fn simulate(artifact: &MathArtifact, seeds: &[u64]) -> Vec<RoundSample> {
    seeds.par_iter().map(|&s| artifact.evaluate_seed(s)).collect()
}
```

In `studio/simulator/src/lib.rs` add `pub mod artifact;` (alphabetical, before `compose`).

Note: `GameDefinition`'s type field is `kind` in Rust (serde-renamed from `"type"`) — see `trusted/math/src/mechanics/composed/definition.rs`. `CompiledGame`/`GameDefinition` derive `Clone`? If `#[derive(Clone)]` is missing on either (check `definition.rs:11` and `compile.rs:98`), drop `#[derive(Debug, Clone)]` down to `#[derive(Debug)]` on `MathArtifact` rather than touching bloom-math.

- [ ] **Step 4: Run tests**

Run: `cargo test -p bloom-simulator artifact`
Expected: PASS (6 tests).

- [ ] **Step 5: Full gate + commit**

Run: `cargo test --workspace`; `cargo fmt --all`; `cargo clippy --workspace --all-targets`

```bash
git add -A
git commit -m "feat(simulator): MathArtifact family seam (slots@1 | composed@1)"
```

---

### Task 3: family-aware constraints, verify, and curation pipeline

**Files:**

- Modify: `studio/simulator/src/constraints.rs`
- Modify: `studio/simulator/src/artifact.rs` (constraint dispatch methods)
- Modify: `studio/simulator/src/run.rs`
- Modify: `studio/simulator/src/bin/curate_json.rs`

**Interfaces:**

- Consumes: `MathArtifact` (Task 2), `Metrics`/`RoundSample` (Task 1).
- Produces (Task 4 relies on):

  ```rust
  // constraints.rs — slots-typed fns KEEP their signatures (tuner untouched):
  pub fn pay_violations(paytable: &Paytable, constraints: &[PayConstraint]) -> Vec<Violation>;
  pub fn max_win_violation(max_win: u64, band: &Option<Band>) -> Option<Violation>;
  pub fn validate_constraints_core(symbols: &[SymbolDef], paytable: &Paytable, target: &TargetSpec) -> Result<(), String>;
  // artifact.rs:
  impl MathArtifact {
      pub fn theoretical_max_win(&self) -> u64;
      pub fn static_violations(&self, target: &TargetSpec) -> Vec<Violation>;
      pub fn validate_constraints(&self, target: &TargetSpec) -> Result<(), String>;
  }
  // run.rs:
  pub fn verify_artifact(artifact: &MathArtifact, metrics: &Metrics, target: &TargetSpec, n: usize) -> Result<(), Metrics>;
  pub fn run_curation_streamed(artifact: &MathArtifact, target: &TargetSpec, master_seed: u64, package_id: &str, presentation: &[u8], signing_key: &SigningKey, on_progress: &mut dyn FnMut(CurationProgress)) -> StreamedOutcome;
  pub fn run_curation(artifact: &MathArtifact, target: &TargetSpec, master_seed: u64, package_id: &str, signing_key: &SigningKey) -> Result<CurationOutput, RunError>;
  ```

- [ ] **Step 1: Write the failing tests** — append to `mod tests` in `studio/simulator/src/artifact.rs`:

```rust
    use crate::target::{HitRateBand, PayConstraint, PayRelation, TargetSpec};

    #[test]
    fn composed_theoretical_max_win_is_top_pay_times_top_state_multiplier() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        // demo: top pay 20 (sym2@3); fs2 overrides multiplier to 3 → 60
        assert_eq!(art.theoretical_max_win(), 60);
    }

    #[test]
    fn composed_static_violations_check_max_win_and_the_reels_paytable() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let mut t = TargetSpec::default();
        t.max_win_band = Some(HitRateBand { min: 100.0, max: 200.0 }); // 60 < 100
        t.pay_constraints = vec![PayConstraint {
            symbol: 0,
            relation: PayRelation::Floor,
            count: Some(3),
            value: 50, // sym0@3 pays 5 → violated
        }];
        let v = art.static_violations(&t);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].metric, "max_win");
        assert_eq!(v[1].metric, "pay_floor[0@3]");
        assert!(art.static_violations(&TargetSpec::default()).is_empty());
    }

    #[test]
    fn composed_validate_rejects_bonus_bands_and_unknown_symbols() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let mut t = TargetSpec::default();
        t.bonus_hit_rate_bands = vec![HitRateBand { min: 0.0, max: 1.0 }];
        assert!(art.validate_constraints(&t).unwrap_err().contains("#160"));
        let mut t = TargetSpec::default();
        t.pay_constraints = vec![PayConstraint {
            symbol: 42,
            relation: PayRelation::Floor,
            count: None,
            value: 1,
        }];
        assert!(art
            .validate_constraints(&t)
            .unwrap_err()
            .contains("unknown model symbol"));
        assert!(art.validate_constraints(&TargetSpec::default()).is_ok());
    }
```

And append to `mod tests` in `studio/simulator/src/run.rs`:

```rust
    fn demo_composed_artifact() -> crate::artifact::MathArtifact {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime/server/demo/composed.definition.json"
        ))
        .unwrap();
        crate::artifact::MathArtifact::from_json_value(serde_json::from_str(&json).unwrap())
            .unwrap()
    }

    #[test]
    fn run_curation_builds_a_curated_composed_package() {
        let art = demo_composed_artifact();
        // center the target on a measurement over the SAME seed stream the
        // curation run will use, so the gate passes (Task 4 wraps this as
        // compose::self_target)
        let m = crate::measure::measure(&crate::artifact::simulate(
            &art,
            &crate::seedgen::generate_seeds(7, 2_000),
        ));
        let target = TargetSpec {
            rtp_target: m.rtp,
            rtp_tolerance: 0.01,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 1_000,
            candidate_count: 2_000,
            realized_correction_band: 0.05,
            ..Default::default()
        };
        let out = run_curation(&art, &target, 7, "pkg-composed", &key()).unwrap();
        let content = verify_and_load(&out.package_bytes, &key().verifying_key()).unwrap();
        assert_eq!(content.envelope.mechanic, "composed@1");
        assert_eq!(content.seeds.len(), 1_000);
        assert!(bloom_math::mechanics::composed::from_payload(&content.math_payload).is_ok());
        assert!((out.pool.realized_rtp - m.rtp).abs() <= 0.01);
        // per-state extras came along
        assert!(out.metrics.state_rtp.contains_key("base"));
        assert!((out.metrics.state_visit_freq["base"] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn composed_verify_fail_is_a_valid_failed_outcome() {
        let art = demo_composed_artifact();
        let target = TargetSpec {
            rtp_target: 50.0, // nowhere near the demo's RTP
            rtp_tolerance: 0.001,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 100,
            candidate_count: 200,
            realized_correction_band: 0.05,
            ..Default::default()
        };
        let err = run_curation(&art, &target, 7, "pkg-composed", &key()).unwrap_err();
        assert!(matches!(err, RunError::VerifyFailed(_)));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-simulator`
Expected: COMPILE FAIL — `theoretical_max_win`/`static_violations` methods missing; `run_curation` takes `&SlotModel` not `&MathArtifact`.

- [ ] **Step 3: Refactor `constraints.rs`** — extract the shared cores; the slots-typed fns become thin wrappers with UNCHANGED signatures:

```rust
/// A theoretical max win outside the target band. Shared by both families —
/// deterministic game facts get no SE allowance (spec 2026-07-09 §6).
pub fn max_win_violation(max_win: u64, band: &Option<crate::target::Band>) -> Option<Violation> {
    let band = band.as_ref()?;
    let mw = max_win as f64;
    (mw < band.min || mw > band.max).then(|| Violation {
        metric: "max_win".into(),
        measured: mw,
        band_lo: band.min,
        band_hi: band.max,
    })
}

/// Pay-constraint checks over a paytable — the shared core for both families
/// (spec §3.3: same math, different location in the artifact).
pub fn pay_violations(paytable: &Paytable, constraints: &[PayConstraint]) -> Vec<Violation> {
    // move the existing `for c in &target.pay_constraints { ... }` loop body
    // here verbatim, with `model.paytable` → `paytable` and
    // `&target.pay_constraints` → `constraints`
}

pub fn static_violations(model: &SlotModel, target: &TargetSpec) -> Vec<Violation> {
    let mut out = Vec::new();
    out.extend(max_win_violation(theoretical_max_win(model), &target.max_win_band));
    out.extend(pay_violations(&model.paytable, &target.pay_constraints));
    out
}

/// Up-front validation core over the constraint surface (symbols + paytable).
pub fn validate_constraints_core(
    symbols: &[SymbolDef],
    paytable: &Paytable,
    target: &TargetSpec,
) -> Result<(), String> {
    // move the existing validate_constraints body here verbatim, with
    // `model.symbols` → `symbols` and `model.paytable` → `paytable`
}

pub fn validate_constraints(model: &SlotModel, target: &TargetSpec) -> Result<(), String> {
    validate_constraints_core(&model.symbols, &model.paytable, target)
}
```

`use bloom_math::mechanics::slots::{Paytable, SymbolDef, ...}` as needed (`Paytable`/`SymbolDef` are the shared `components.rs` types re-exported by both families — composed's `ReelsConfig.paytable`/`symbols` are the same types).

- [ ] **Step 4: Add the dispatch methods to `artifact.rs`:**

```rust
use crate::constraints::{self, Violation};
use crate::target::TargetSpec;
use bloom_math::mechanics::composed::mechanic::MechanicConfig;

impl MathArtifact {
    /// Theoretical max win in bet-multiples. Composed: top pay of the reels
    /// instance's paytable × the largest multiplier across every compiled
    /// state's effective reels config (per-state overrides raise it).
    /// ponytail: single-spin bound × top multiplier, mirroring slots —
    /// ignores multi-step accumulation; tighten alongside #160/#161.
    pub fn theoretical_max_win(&self) -> u64 {
        match self {
            MathArtifact::Slots(m) => constraints::theoretical_max_win(m),
            MathArtifact::Composed { compiled, reels, .. } => {
                let top_pay = reels
                    .as_ref()
                    .and_then(|r| r.paytable.entries.iter().map(|e| e.payout).max())
                    .unwrap_or(0);
                let top_mult = compiled
                    .states
                    .iter()
                    .flat_map(|s| &s.configs)
                    .filter_map(|c| match c {
                        MechanicConfig::Reels(r) => Some(r.multiplier),
                        _ => None,
                    })
                    .max()
                    .unwrap_or(1)
                    .max(1);
                top_pay.saturating_mul(top_mult)
            }
        }
    }

    /// Deterministic constraint violations — same checks both families; for
    /// composed they bind to the reels@1 instance's paytable (spec §3.3).
    pub fn static_violations(&self, target: &TargetSpec) -> Vec<Violation> {
        match self {
            MathArtifact::Slots(m) => constraints::static_violations(m, target),
            MathArtifact::Composed { reels, .. } => {
                let mut out = Vec::new();
                out.extend(constraints::max_win_violation(
                    self.theoretical_max_win(),
                    &target.max_win_band,
                ));
                if let Some(r) = reels {
                    out.extend(constraints::pay_violations(
                        &r.paytable,
                        &target.pay_constraints,
                    ));
                }
                out
            }
        }
    }

    /// Up-front target/constraint validation, family-aware.
    pub fn validate_constraints(&self, target: &TargetSpec) -> Result<(), String> {
        match self {
            MathArtifact::Slots(m) => constraints::validate_constraints(m, target),
            MathArtifact::Composed { reels, .. } => {
                if !target.bonus_hit_rate_bands.is_empty() {
                    return Err(
                        "composed targets take no bonus_hit_rate_bands \
                         (feature-level bands are issue #160)"
                            .into(),
                    );
                }
                match reels {
                    Some(r) => {
                        constraints::validate_constraints_core(&r.symbols, &r.paytable, target)
                    }
                    None if target.pay_constraints.is_empty() => Ok(()),
                    None => Err(
                        "pay constraints given but the definition has no reels@1 instance"
                            .into(),
                    ),
                }
            }
        }
    }
}
```

- [ ] **Step 5: Generalize `run.rs`.** Extract the band-check core so the slots `verify` (tuner's entry point) and the artifact path share one rule:

```rust
fn verify_with(
    statics_ok: bool,
    metrics: &Metrics,
    target: &TargetSpec,
    n: usize,
) -> Result<(), Metrics> {
    // existing verify body verbatim, with the `static_violations` line
    // replaced by `let static_ok = statics_ok;`
}

/// Slots entry point — signature unchanged (the tuner's confirm gate).
pub fn verify(model: &SlotModel, metrics: &Metrics, target: &TargetSpec, n: usize) -> Result<(), Metrics> {
    verify_with(static_violations(model, target).is_empty(), metrics, target, n)
}

/// Family-aware entry point used by the curation pipeline.
pub fn verify_artifact(artifact: &MathArtifact, metrics: &Metrics, target: &TargetSpec, n: usize) -> Result<(), Metrics> {
    verify_with(artifact.static_violations(target).is_empty(), metrics, target, n)
}
```

Then change `run_curation_streamed` / `run_curation` first params from `model: &SlotModel` to `artifact: &MathArtifact` and inside:

- `simulate(model, part)` → `crate::artifact::simulate(artifact, part)`
- `verify(model, &metrics, target, samples.len())` → `verify_artifact(artifact, &metrics, target, samples.len())`
- `mechanic: "slots@1".to_string()` → `mechanic: artifact.family().to_string()`
- `math_payload: to_payload(model)` → `math_payload: artifact.math_payload()`
- report line `mechanic=slots@1` → `format!("... mechanic={} ...", artifact.family(), ...)` (make `mechanic` a format arg).
- drop the now-unused `use bloom_math::mechanics::slots::{to_payload, SlotModel}` items from the non-test imports that clippy flags (keep `SlotModel` for `verify`).

Existing run.rs tests: wrap the model at each `run_curation*` call site — `run_curation(&crate::artifact::MathArtifact::Slots(measurable_model()), &target_09(), 2026, "pkg-test", &key())` (7 call sites; `verify(...)` test calls stay as-is).

- [ ] **Step 6: `curate_json` parses an artifact.** In `studio/simulator/src/bin/curate_json.rs` `main`, replace the `SlotModel` parse block with:

```rust
    use bloom_simulator::artifact::MathArtifact;

    let artifact: MathArtifact = match fs::read_to_string(&args[1])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
        .and_then(MathArtifact::from_json_value)
    {
        Ok(a) => a,
        Err(e) => {
            eprintln!("bad model json: {e}");
            std::process::exit(2);
        }
    };
```

and swap the downstream calls: `validate_constraints(&model, &target)` → `artifact.validate_constraints(&target)` (drop the `bloom_simulator::validate_constraints` import), `run_curation_streamed(&model, ...)` → `run_curation_streamed(&artifact, ...)`, and in the `VerifyFailed` arm `bloom_simulator::static_violations(&model, &target)` → `artifact.static_violations(&target)`.

- [ ] **Step 7: Run the tests**

Run: `cargo test -p bloom-simulator`
Expected: PASS, including the two new run.rs tests and three new artifact.rs tests.

- [ ] **Step 8: Full gate + commit**

Run: `cargo test --workspace`; `cargo fmt --all`; `cargo clippy --workspace --all-targets`
Expected: PASS/clean — bloom-tuner compiles untouched (its `verify`/`static_violations`/`validate_constraints`/`simulate` imports kept their signatures).

```bash
git add -A
git commit -m "feat(simulator): family-aware constraints, verify, and curation pipeline"
```

---

### Task 4: composed .pkg builds go curate → verify → freeze (retire measure_pool)

**Files:**

- Rewrite: `studio/simulator/src/compose.rs`
- Modify: `studio/simulator/src/bin/compose_json.rs`
- Modify: `studio/simulator/src/bin/compose.rs`

**Interfaces:**

- Consumes: `MathArtifact::from_definition`, `artifact::simulate`, `measure`, `run_curation_streamed`, `StreamedOutcome`, `RunError` (Tasks 1–3).
- Produces:

  ```rust
  // compose.rs
  pub fn self_target(artifact: &MathArtifact, pool_size: usize, master_seed: u64) -> TargetSpec;
  pub fn build_composed(def: &GameDefinition, target: Option<TargetSpec>, package_id: &str,
      seed_count: usize, master_seed: u64, presentation: &[u8], signing_key: &SigningKey)
      -> Result<(TargetSpec, StreamedOutcome), Vec<DefinitionError>>;
  ```

  compose_json result wire (consumed by `app/compose` in Task 5):

  ```json
  {"type":"result","ok":true,
   "metrics":{"rtp":..,"hitRate":..,"maxWinX":..,"stateVisits":{"base":400},
              "volatility":..,"stateRtp":{..},"stateVisitFreq":{..}},
   "verdict":{"status":"pass","failure":null,"realizedRtp":..,"poolSize":..,
              "rtpTarget":..,"rtpTolerance":..,"selfDerived":true}}
  ```

  On verify/curate failure: `"ok": false`, `"errors": ["<failure>"]`, same `metrics` + `verdict` (status `"fail"`), **no** `.pkg` written. `validate_only` behavior unchanged. `TargetSpec` already derives `Deserialize`, so the job's optional `target` field parses the same snake_case keys as `target.json` (`rtp_target`, `pool_size`, `candidate_count`, ...).

- [ ] **Step 1: Rewrite `studio/simulator/src/compose.rs`** (tests below in step 2 — write both, then run):

```rust
//! Build a `composed@1` package through the SAME curate → verify → freeze →
//! sign pipeline as slots (spec §3.3; closes #172). `measure_pool` is retired —
//! the verify verdict replaces its readout. Pure (no I/O); bins do file
//! handling.

use crate::artifact::{self, MathArtifact};
use crate::measure::measure;
use crate::run::{run_curation_streamed, StreamedOutcome};
use crate::seedgen::generate_seeds;
use crate::target::TargetSpec;
use bloom_math::mechanics::composed::{DefinitionError, GameDefinition};
use ed25519_dalek::SigningKey;

/// A target centered on the artifact's own measurement over the exact seed
/// stream curation will use: verify passes by construction and freeze corrects
/// the pool toward the model's measured mean (honesty guardrail trivially
/// satisfied). The bridge until GDD-derived targets arrive through the job
/// (SP-C); a caller-supplied target replaces it entirely.
/// ponytail: simulates the candidates twice (once here, once inside the
/// curation run) — fold into a measure-first pipeline if builds feel slow.
pub fn self_target(artifact: &MathArtifact, pool_size: usize, master_seed: u64) -> TargetSpec {
    let candidate_count = pool_size.saturating_mul(2).max(2);
    let m = measure(&artifact::simulate(
        artifact,
        &generate_seeds(master_seed, candidate_count),
    ));
    TargetSpec {
        rtp_target: m.rtp,
        rtp_tolerance: 0.01,
        volatility_min: 0.0,
        volatility_max: 1e9,
        bonus_hit_rate_bands: vec![],
        pool_size,
        candidate_count,
        realized_correction_band: 0.05,
        hit_frequency_band: None,
        max_win_band: None,
        pay_constraints: vec![],
    }
}

/// Full curated build for a composed definition. `target: None` → self-centered
/// default sized off `seed_count` (a provided target carries its own
/// pool_size/candidate_count and `seed_count` is ignored). Err = the definition
/// failed kernel compile (nothing is signed). The returned TargetSpec is
/// whichever target the run actually used.
pub fn build_composed(
    def: &GameDefinition,
    target: Option<TargetSpec>,
    package_id: &str,
    seed_count: usize,
    master_seed: u64,
    presentation: &[u8],
    signing_key: &SigningKey,
) -> Result<(TargetSpec, StreamedOutcome), Vec<DefinitionError>> {
    let art = MathArtifact::from_definition(def.clone())?;
    let target = target.unwrap_or_else(|| self_target(&art, seed_count, master_seed));
    let outcome = run_curation_streamed(
        &art,
        &target,
        master_seed,
        package_id,
        presentation,
        signing_key,
        &mut |_| {},
    );
    Ok((target, outcome))
}
```

- [ ] **Step 2: Rewrite the compose.rs tests** (keep `key()`, `valid_def()`, `invalid_def()` helpers verbatim from the current file; `valid_def()` is a 1-state always-pay-5 game, so rtp = 5.0 and volatility = 0):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::composed::from_payload;
    use bloom_package::verify_and_load;
    use serde_json::json;

    // ... key(), valid_def(), invalid_def() unchanged ...

    #[test]
    fn self_target_centers_on_the_measured_rtp() {
        let art = MathArtifact::from_definition(valid_def()).unwrap();
        let t = self_target(&art, 100, 42);
        assert!((t.rtp_target - 5.0).abs() < 1e-9); // valid_def always pays 5
        assert_eq!(t.pool_size, 100);
        assert_eq!(t.candidate_count, 200);
        assert!(t.bonus_hit_rate_bands.is_empty());
    }

    #[test]
    fn curated_build_round_trips_through_verify_and_load() {
        let def = valid_def();
        let (target, s) =
            build_composed(&def, None, "pkg-composed", 100, 42, b"{\"p\":1}", &key()).unwrap();
        let out = s.outcome.expect("self-target verifies by construction");
        let content = verify_and_load(&out.package_bytes, &key().verifying_key()).unwrap();
        assert_eq!(content.envelope.mechanic, "composed@1");
        assert_eq!(content.envelope.package_id, "pkg-composed");
        assert_eq!(content.seeds.len(), 100); // curated pool, not raw candidates
        assert_eq!(content.presentation, b"{\"p\":1}");
        assert_eq!(from_payload(&content.math_payload).unwrap(), def);
        assert!((out.pool.realized_rtp - target.rtp_target).abs() <= target.rtp_tolerance);
    }

    #[test]
    fn invalid_definition_signs_nothing() {
        let err = build_composed(&invalid_def(), None, "pkg-bad", 100, 42, &[], &key());
        assert!(matches!(err, Err(ref e) if !e.is_empty()));
    }

    #[test]
    fn build_is_deterministic() {
        let def = valid_def();
        let a = build_composed(&def, None, "p", 50, 7, &[], &key()).unwrap();
        let b = build_composed(&def, None, "p", 50, 7, &[], &key()).unwrap();
        assert_eq!(
            a.1.outcome.unwrap().package_bytes,
            b.1.outcome.unwrap().package_bytes
        );
    }

    #[test]
    fn explicit_off_target_fails_verify_instead_of_signing() {
        let target = TargetSpec {
            rtp_target: 50.0, // valid_def pays exactly 5
            rtp_tolerance: 0.001,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 50,
            candidate_count: 100,
            realized_correction_band: 0.05,
            ..Default::default()
        };
        let (_, s) = build_composed(&valid_def(), Some(target), "p", 50, 7, &[], &key()).unwrap();
        assert!(matches!(
            s.outcome,
            Err(crate::run::RunError::VerifyFailed(_))
        ));
    }
}
```

- [ ] **Step 3: Run compose tests to see red→green**

Run: `cargo test -p bloom-simulator compose`
Expected: PASS after the rewrite compiles (the old `measure_pool` tests are gone with the function).

- [ ] **Step 4: Update `studio/simulator/src/bin/compose_json.rs`.** Job gains `target`; result gains `verdict`; metrics keep the legacy keys (the game-structure pane reads `rtp`/`hitRate`/`maxWinX`/`stateVisits` today — SP-C swaps its strip for the verdict) with `stateVisits` now integer visit counts over the measured candidate population:

```rust
use bloom_math::mechanics::composed::{compile, GameDefinition};
use bloom_simulator::compose::build_composed;
use bloom_simulator::run::RunError;
use bloom_simulator::target::{Metrics, TargetSpec};
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
    /// Full curation target (same snake_case keys as target.json). None →
    /// self-centered default (compose::self_target).
    #[serde(default)]
    target: Option<TargetSpec>,
}

fn metrics_json(m: &Metrics, n: usize) -> serde_json::Value {
    let visits: std::collections::BTreeMap<String, u64> = m
        .state_visit_freq
        .iter()
        .map(|(k, f)| (k.clone(), (f * n as f64).round() as u64))
        .collect();
    json!({
        "rtp": m.rtp,
        "hitRate": m.hit_frequency,
        "maxWinX": m.max_win,
        "stateVisits": visits,
        "volatility": m.volatility,
        "stateRtp": m.state_rtp,
        "stateVisitFreq": m.state_visit_freq,
    })
}

fn verdict_json(
    status: &str,
    failure: Option<&str>,
    realized_rtp: Option<f64>,
    target: &TargetSpec,
    self_derived: bool,
) -> serde_json::Value {
    json!({
        "status": status,
        "failure": failure,
        "realizedRtp": realized_rtp,
        "poolSize": target.pool_size,
        "rtpTarget": target.rtp_target,
        "rtpTolerance": target.rtp_tolerance,
        "selfDerived": self_derived,
    })
}
```

`result_ok` / `result_errors` stay. Replace `run_job`'s build branch (everything after the `validate_only` early-return and the `out_path` guard):

```rust
    let presentation: Vec<u8> = match &job.presentation {
        Some(v) => serde_json::to_vec(v).expect("presentation Value serializes"),
        None => Vec::new(),
    };
    let key = SigningKey::from_bytes(&[7u8; 32]); // dev-only, same as compose/curate
    let self_derived = job.target.is_none();
    let (target, s) = match build_composed(
        &def,
        job.target,
        &job.package_id,
        job.seed_count,
        job.master_seed,
        &presentation,
        &key,
    ) {
        Ok(pair) => pair,
        Err(errs) => {
            let msgs: Vec<String> = errs.iter().map(|e| format!("{e:?}")).collect();
            return (result_errors(&msgs), 0);
        }
    };
    let n = target.candidate_count;
    match s.outcome {
        Ok(out) => {
            if let Err(e) = std::fs::write(&out_path, &out.package_bytes) {
                eprintln!("write package failed: {e}");
                return (String::new(), 1);
            }
            let line = json!({
                "type": "result",
                "ok": true,
                "metrics": metrics_json(&s.metrics, n),
                "verdict": verdict_json(
                    "pass", None, Some(out.pool.realized_rtp), &target, self_derived
                ),
            });
            (line.to_string(), 0)
        }
        Err(e) => {
            let failure = match e {
                RunError::VerifyFailed(_) => {
                    "measured characteristics missed the target bands".to_string()
                }
                RunError::Curate(e) => {
                    format!("curation guardrail: {e:?} — retune the definition, not the pool")
                }
            };
            let line = json!({
                "type": "result",
                "ok": false,
                "errors": [failure],
                "metrics": metrics_json(&s.metrics, n),
                "verdict": verdict_json("fail", Some(&failure), None, &target, self_derived),
            });
            (line.to_string(), 0)
        }
    }
```

(Keep the `validate_only` branch and the `let Some(out_path) = job.out_path else { ... exit 2 }` guard exactly as they are, but hoist the guard ABOVE the build so a missing out_path still exits 2 before any simulation.)

Test updates in the same file:

- `job_defaults_apply`: add `assert!(j.target.is_none());`
- `build_writes_pkg_and_reports_metrics` (seed_count 200 → 400 candidates): change the stateVisits assertion to `assert!(m["stateVisits"]["base"].as_u64().unwrap() == 400);` and add:
  ```rust
        assert_eq!(v["verdict"]["status"], "pass");
        assert_eq!(v["verdict"]["selfDerived"], true);
        assert_eq!(v["verdict"]["poolSize"], 200);
        assert!(v["verdict"]["realizedRtp"].is_number());
        assert!(m["stateRtp"]["base"].is_number());
  ```
- New test:
  ```rust
    #[test]
    fn explicit_failing_target_reports_a_fail_verdict_and_writes_nothing() {
        let out =
            std::env::temp_dir().join(format!("compose-json-fail-{}.pkg", std::process::id()));
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "pkg-fail",
            "seed_count": 100,
            "master_seed": 42,
            "out_path": out.to_string_lossy(),
            "target": {
                "rtp_target": 50.0, "rtp_tolerance": 0.001,
                "volatility_min": 0.0, "volatility_max": 1e9,
                "bonus_hit_rate_bands": [],
                "pool_size": 50, "candidate_count": 100,
                "realized_correction_band": 0.05
            }
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["verdict"]["status"], "fail");
        assert_eq!(v["verdict"]["selfDerived"], false);
        assert!(!v["errors"].as_array().unwrap().is_empty());
        assert!(v["metrics"]["rtp"].is_number()); // metrics still measured
        assert!(!out.exists(), "a failed verify must not sign a package");
    }
  ```
- `validate_only` tests and `definition_parse_failure_is_an_ok_false_result` stay untouched and must still pass.

- [ ] **Step 5: Update `studio/simulator/src/bin/compose.rs`** to route through the curated build (same argv contract, so the `composed-demo-pkg` just recipe is untouched):

```rust
    let key = SigningKey::from_bytes(&[7u8; 32]);
    match build_composed(&def, None, &args[2], seed_count, master_seed, &presentation, &key) {
        Ok((target, s)) => match s.outcome {
            Ok(out) => {
                fs::write(&args[5], &out.package_bytes).expect("write package");
                println!(
                    "composed package written: {} ({} bytes, {} curated seeds, realized rtp {:.4}, target rtp {:.4}, master_seed {})",
                    args[5],
                    out.package_bytes.len(),
                    out.pool.seeds.len(),
                    out.pool.realized_rtp,
                    target.rtp_target,
                    master_seed
                );
            }
            Err(e) => {
                eprintln!("composed curation failed: {e:?}");
                std::process::exit(1);
            }
        },
        Err(errors) => {
            eprintln!("invalid definition — nothing signed:");
            for e in &errors {
                eprintln!("  {e:?}");
            }
            std::process::exit(2);
        }
    }
```

(imports: swap `build_composed_package` for `build_composed`.)

- [ ] **Step 6: Confirm `measure_pool`/`PoolMetrics`/`build_composed_package` have no remaining references**

Run: `grep -rn "measure_pool\|PoolMetrics\|build_composed_package" --include=*.rs .` (or `rg`)
Expected: no hits outside this plan document.

- [ ] **Step 7: Full gate + commit**

Run: `cargo test --workspace`; `cargo fmt --all`; `cargo clippy --workspace --all-targets`
Expected: PASS/clean.

```bash
git add -A
git commit -m "feat(simulator): composed .pkg builds run curate->verify->freeze; retire measure_pool (#172)"
```

---

### Task 5: app/compose verdict passthrough (Python)

**Files:**

- Modify: `studio/backend/app/compose/rest.py:59-70` (build endpoint)
- Modify: `studio/backend/app/compose/autobuild.py:51-57` (`_run` emit)
- Test: `studio/backend/tests/test_compose_rest.py`, `studio/backend/tests/test_compose_autobuild.py`

**Interfaces:**

- Consumes: the compose_json result wire from Task 4 (`verdict` key). The runner (`runner.py`) needs NO change — it already returns the whole result object; `jobs.py` needs NO change — `target` is optional and absent means self-derived.
- Produces: build REST response and `game_build_status` socket event both carry `"verdict"`.

- [ ] **Step 1: Write the failing tests.** In `studio/backend/tests/test_compose_rest.py`, extend `test_build_shapes_job_and_response` — replace the fake result and response assertion:

```python
    metrics = {"rtp": 0.93, "hitRate": 0.4, "maxWinX": 60, "stateVisits": {"base": 100}}
    verdict = {"status": "pass", "realizedRtp": 0.93, "poolSize": 100, "selfDerived": True}
    fake = FakeComposeRunner({"ok": True, "metrics": metrics, "verdict": verdict})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    res = await rest.build_game_definition("g1", req)
    assert res == {
        "ok": True,
        "errors": None,
        "metrics": metrics,
        "verdict": verdict,
        "packageId": "g1",
    }
```

In `studio/backend/tests/test_compose_autobuild.py`, find the test that asserts the `"done"` emit payload (it checks `status`/`metrics`/`packageId` fields on the `game_build_status` event) and extend its fake-runner result with `"verdict": {"status": "pass"}` plus an assertion that the emitted payload carries `verdict == {"status": "pass"}`. Follow the file's existing fake-sio capture pattern exactly.

- [ ] **Step 2: Run to verify failure**

Run: `uv --directory studio/backend run pytest tests/test_compose_rest.py tests/test_compose_autobuild.py -q`
(If `uv` complains about a missing venv in this fresh worktree, first run `uv --directory studio/backend sync`.)
Expected: the two extended tests FAIL (`verdict` missing from the response/event).

- [ ] **Step 3: Implement.** `rest.py` `build_game_definition` return:

```python
    return {
        "ok": bool(res.get("ok")),
        "errors": res.get("errors"),
        "metrics": res.get("metrics"),
        "verdict": res.get("verdict"),
        "packageId": game_id,
    }
```

`autobuild.py` `_run` final emit:

```python
            await self._emit(game_id, {
                "status": "done" if ok else "error",
                "errors": res.get("errors") or [],
                "metrics": res.get("metrics"),
                "verdict": res.get("verdict"),
                "packageId": game_id,
            })
```

- [ ] **Step 4: Run the backend compose suite**

Run: `uv --directory studio/backend run pytest tests/test_compose_rest.py tests/test_compose_autobuild.py tests/test_compose_runner.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend
git commit -m "feat(compose): pass the build verify verdict through REST + autobuild"
```

---

### Task 6: rebuild the demo package + whole-branch verification

**Files:**

- Regenerate: `runtime/server/demo/composed.pkg` (build artifact, checked in)

- [ ] **Step 1: Rebuild the composed demo package with a curated pool** (this is `just composed-demo-pkg`, run directly because `just` can't find `sh` here):

Run from the worktree root:

```bash
cargo run --release -p bloom-simulator --bin compose -- \
  runtime/server/demo/composed.definition.json \
  bloom-demo-composed 10000 20260709 \
  runtime/server/demo/composed.pkg \
  runtime/server/demo/composed.presentation.json
```

Expected: `composed package written: ... (N bytes, 10000 curated seeds, realized rtp ..., target rtp ..., master_seed 20260709)`.

- [ ] **Step 2: Verify the runtime server still loads and serves it**

Run: `cargo test -p bloom-runtime-server`
Expected: PASS — in particular `checked_in_composed_pkg_loads_and_is_composed` (asserts 10 000 seeds) and `composed_demo_spin_trace_replays_bit_for_bit`.

- [ ] **Step 3: Full workspace + backend gates**

Run: `cargo test --workspace` → PASS
Run: `cargo fmt --all` then `git diff --stat` → no formatting drift; `cargo clippy --workspace --all-targets` → clean
Run: `uv --directory studio/backend run pytest -q` → PASS (full backend suite; pre-existing failures unrelated to compose are out of scope — note them, don't chase them)

- [ ] **Step 4: Commit the rebuilt package**

```bash
git add runtime/server/demo/composed.pkg
git commit -m "chore(runtime): rebuild composed demo pkg with a curated seed pool"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/sim-convergence
gh pr create --title "feat(simulator): SP-A simulator convergence — MathArtifact seam + curated composed packages" --body "..."
```

PR body must include: `Closes #172`, a pointer to the umbrella spec (PR #194, §3.1–§3.3, §7 SP-A), and the note that SP-B (tuner genome) is the next sub-project. Do NOT merge — hand back for review per subagent-driven-development's finish flow.

---

## Self-Review (completed during planning)

- **Spec coverage:** §3.1 family seam → Task 2 (+ job `family` field: the composed definition's own top-level `family` key IS the explicit discriminator; bare SlotModel JSON defaults to slots per spec §4 "defaulting slots for legacy" — the backend keeps writing unwrapped model.json until SP-C). §3.2 RoundSample + shared metrics + per-state extras → Task 1. §3.3 verify bands both families / pay constraints on the reels@1 instance / freeze on samples / curated composed builds / measure_pool retired → Tasks 3–4. §7 SP-A "app/compose build hook" → Task 5. Demo/golden verification → Task 6.
- **Out of scope honored:** no tuner genome work (SP-B), no backend math descriptor (SP-C), no GDD realizer (SP-D), no feature-level bands (#160).
- **Type consistency:** `RoundSample.total_payout`/`state_payouts` names match across Tasks 1–4; `verify_artifact`/`run_curation_streamed(&MathArtifact, ...)` signatures match between Task 3's definition and Task 4's call sites; `build_composed` returns `(TargetSpec, StreamedOutcome)` in both its definition and the two bin call sites.
- **Known judgment calls:** (1) self-centered default target — without stored GDD targets a fixed default (e.g. 0.96) would fail verify on nearly every mid-edit definition the AutoBuilder builds; centering on the measured RTP keeps every build a _curated, frozen, verified_ pool (what #172 asks) while staying honest (`realized_correction_band` binds freeze to the measured mean). (2) `stateVisits` stays integer counts (over the candidate population) so the current game-structure pane readout keeps rendering until SP-C replaces it. (3) slots-typed `verify`/`simulate`/`static_violations` keep their signatures so bloom-tuner is untouched — SP-B owns that migration.
