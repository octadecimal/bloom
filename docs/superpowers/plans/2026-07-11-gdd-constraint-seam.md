# GDD Constraint Seam (Plan 2 of GDD/SlotModel SoT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GDD's `hit_frequency`, `max_win`, and `pay_constraints` intents real: compiled by `derive_target`, enforced in the GA's `repair()`, and asserted by the noise-aware `verify` gate — with the four duplicated Rust `TargetJson` parsers collapsed into one serde contract.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-09-gdd-slotmodel-source-of-truth-design.md` §5–§6 (Plan 1, the ownership rework, is merged — PR #171). `TargetSpec` (simulator) grows three fields. `hit_frequency` is a **statistical** gate (binomial SE, exactly the `bonus_hit_rate` pattern) that joins `verify`, `fitness`, and `band_misses`. `max_win` and `pay_constraints` are **static** invariants on the model itself, checked deterministically (no SE) in a new `constraints.rs`; pay constraints are additionally **enforced in GA `repair()`** (clamps + a deterministic top-paying fix-up), so enforcement is repair, not rejection. Python `derive_target` compiles the GDD intent into the new JSON keys, resolving GDD symbol slots to model symbol ids through the Plan-1 `model_id` join key.

**Tech Stack:** Rust (bloom-simulator, bloom-tuner — cargo workspace at repo root), Python (FastAPI backend, pytest), React/TS (vitest), Playwright e2e (replay cassettes).

## Global Constraints

- Semantic (Conventional Commits) format for every commit; imperative mood.
- TDD: write the failing test, watch it fail, minimal code to pass.
- TypeScript interfaces use the `I` prefix (`docs/coding-standards.md`).
- Rust gates before any push: `cargo fmt --check`, `cargo clippy --workspace`, `cargo test --workspace` (CI runs all three; fmt failures have broken merges before).
- Backend tests: `uv --directory studio/backend run pytest` (native MongoDB on :27017 for store tests; the tests in this plan are pure-unit unless marked e2e).
- Frontend gates (all four, in order): `node_modules/.bin/prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend` — vitest green does NOT imply types valid.
- Browser e2e is local-only (never CI): `just e2e` against a replay backend on this worktree's `BLOOM_PORT_OFFSET` ports — never the default :8000/:4200 (another session may hold them).
- Work happens in a fresh worktree (`just wt-new gdd-constraint-seam`), branch `feat/gdd-constraint-seam`. NOTE: `wt-new` does not copy `studio/backend/.env` — copy `OPENROUTER_API_KEY` if a live backend is ever needed (replay flows in this plan don't need it).
- Wire-contract rule: the target JSON is snake_case end-to-end (`derive_target` emits a plain dict; Rust field names match exactly). Pay-constraint `relation` values are kebab-case strings: `"top-paying"`, `"floor"`, `"ceiling"` — identical to the GDD schema enum.

## File Structure

| File                                                                                                                                 | Responsibility                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio/simulator/src/target.rs` (modify)                                                                                            | `TargetSpec` + new fields, serde `Deserialize`/`Default`, `PayConstraint`/`PayRelation`/`Band`, `TargetFile` (the one shared JSON contract), `MetricSE.hit_frequency` |
| `studio/simulator/src/constraints.rs` (create)                                                                                       | Static checks: `theoretical_max_win`, `static_violations`, `validate_constraints`                                                                                     |
| `studio/simulator/src/run.rs` (modify)                                                                                               | `verify` gains the model param, the hit-frequency statistical gate, and the static gate                                                                               |
| `studio/simulator/src/lib.rs` (modify)                                                                                               | export `constraints`                                                                                                                                                  |
| `studio/simulator/src/bin/curate_json.rs`, `src/bin/curate.rs` (modify)                                                              | parse via `TargetFile`; call `validate_constraints`; enriched failure text; SE wire                                                                                   |
| `studio/tuner/src/config.rs` (modify)                                                                                                | `Weights.hit_frequency`                                                                                                                                               |
| `studio/tuner/src/fitness.rs` (modify)                                                                                               | hit-frequency terms in `fitness`; `band_misses` gains the model + static misses                                                                                       |
| `studio/tuner/src/genome.rs` (modify)                                                                                                | `repair()` enforces pay constraints                                                                                                                                   |
| `studio/tuner/src/genetic.rs` (modify)                                                                                               | threads constraints + new `verify`/`band_misses` signatures                                                                                                           |
| `studio/tuner/src/validate.rs` (modify)                                                                                              | calls `validate_constraints`                                                                                                                                          |
| `studio/tuner/src/bin/tune_json.rs`, `src/bin/tune.rs` (modify)                                                                      | parse `TargetSpec` directly; `WeightsJson.hit_frequency` default                                                                                                      |
| `studio/backend/app/math/models.py` (modify)                                                                                         | `CurationParams.max_win_tolerance`, `TuneWeights.hit_frequency`, `MetricSEWire.hit_frequency`                                                                         |
| `studio/backend/app/math/targets.py` (modify)                                                                                        | compile the two new bands + `pay_constraints` (join key)                                                                                                              |
| `studio/backend/app/math/target_flow.py` (create)                                                                                    | store-wired `derive_target_for` (collapses 4 duplicated call sites)                                                                                                   |
| `studio/backend/app/math/hub.py`, `app/math/rest.py`, `app/agent_tools.py` (modify)                                                  | use `derive_target_for`                                                                                                                                               |
| `studio/backend/app/math/bounds.py`, `app/math/restart.py`, `app/math/runners/{curate,tune}.py` (modify)                             | weights wire, miss-score gate, SE parse                                                                                                                               |
| `studio/backend/app/gdd/router.py` (modify)                                                                                          | branch-1 pay-relation instruction                                                                                                                                     |
| `studio/frontend/src/plugins/math/{state.ts,reducers.ts,components/paramFields.ts,tabs/ReportTab.tsx}` (modify)                      | surface the new gate + weight                                                                                                                                         |
| `studio/frontend/e2e/pay-constraints.spec.ts` (create) + `studio/backend/tests/fixtures/replay/run/pay-constraint-set.json` (create) | constraint-flow e2e                                                                                                                                                   |

---

### Task 1: TargetSpec extension + one shared target-JSON contract (Rust)

**Files:**

- Modify: `studio/simulator/src/target.rs`
- Modify: `studio/simulator/src/bin/curate_json.rs`, `studio/simulator/src/bin/curate.rs`
- Modify: `studio/tuner/src/bin/tune_json.rs`, `studio/tuner/src/bin/tune.rs`
- Modify (mechanical compile fixes): every `TargetSpec` test fixture in `studio/simulator/src/{run.rs,validate.rs}` and `studio/tuner/src/{fitness.rs,validate.rs,genetic.rs}`

**Interfaces:**

- Produces: `TargetSpec` with `#[derive(Deserialize, Default)]` and new fields `hit_frequency_band: Option<HitRateBand>`, `max_win_band: Option<Band>`, `pay_constraints: Vec<PayConstraint>`; `pub type Band = HitRateBand`; `pub enum PayRelation { TopPaying, Floor, Ceiling }` (serde kebab-case); `pub struct PayConstraint { symbol: u8, relation: PayRelation, count: Option<u8>, value: u64 }`; `pub struct TargetFile { spec: TargetSpec, master_seed: u64 }`; `MetricSE.hit_frequency: f64`.
- Consumed by every later Rust task and (as the JSON contract) by Task 6's Python emitter.

- [ ] **Step 1: Write the failing tests** — append to `mod tests` in `studio/simulator/src/target.rs`:

```rust
    #[test]
    fn se_hit_frequency_is_binomial() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![]), 10_000);
        // fixture hit_frequency is 0.3
        assert!((se.hit_frequency - (0.3f64 * 0.7 / 10_000.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn target_json_contract_parses_the_python_emission() {
        // Locked wire contract with app/math/targets.py::derive_target — if a key
        // or casing changes on either side, this test or its Python twin fails.
        let json = r#"{
            "rtp_target": 0.96, "rtp_tolerance": 0.01,
            "volatility_min": 3.0, "volatility_max": 6.0,
            "bonus_hit_rate_bands": [{"min": 0.004, "max": 0.006}],
            "pool_size": 1000, "candidate_count": 50000,
            "realized_correction_band": 0.05, "master_seed": 2026,
            "hit_frequency_band": {"min": 0.225, "max": 0.375},
            "max_win_band": {"min": 2500.0, "max": 7500.0},
            "pay_constraints": [
                {"symbol": 2, "relation": "top-paying"},
                {"symbol": 0, "relation": "floor", "count": 3, "value": 5},
                {"symbol": 1, "relation": "ceiling", "value": 100}
            ]
        }"#;
        let t: TargetSpec = serde_json::from_str(json).unwrap(); // master_seed ignored
        assert_eq!(t.rtp_target, 0.96);
        assert_eq!(t.hit_frequency_band.unwrap().min, 0.225);
        assert_eq!(t.max_win_band.unwrap().max, 7500.0);
        assert_eq!(t.pay_constraints.len(), 3);
        assert!(matches!(t.pay_constraints[0].relation, PayRelation::TopPaying));
        assert_eq!(t.pay_constraints[1].count, Some(3));
        assert_eq!(t.pay_constraints[1].value, 5);
        assert_eq!(t.pay_constraints[2].count, None);
        let tf: TargetFile = serde_json::from_str(json).unwrap();
        assert_eq!(tf.master_seed, 2026);
        assert_eq!(tf.spec.pay_constraints.len(), 3);
    }

    #[test]
    fn legacy_target_json_without_new_fields_still_parses() {
        let json = r#"{
            "rtp_target": 0.9, "rtp_tolerance": 0.02,
            "volatility_min": 0.0, "volatility_max": 1e9,
            "bonus_hit_rate_bands": [],
            "pool_size": 100, "candidate_count": 1000,
            "realized_correction_band": 0.05, "master_seed": 7
        }"#;
        let t: TargetSpec = serde_json::from_str(json).unwrap();
        assert!(t.hit_frequency_band.is_none());
        assert!(t.max_win_band.is_none());
        assert!(t.pay_constraints.is_empty());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-simulator target::`
Expected: FAIL to compile — `Deserialize` not derived, `PayRelation`/`TargetFile`/`hit_frequency` unknown.

- [ ] **Step 3: Implement in `target.rs`**

Add `use serde::Deserialize;` at the top. Change/add types:

```rust
/// An acceptable inclusive range for one feature's hit-rate.
#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
pub struct HitRateBand {
    pub min: f64,
    pub max: f64,
}

/// Same {min, max} shape; named for deterministic quantities (max win).
pub type Band = HitRateBand;

/// How a pay constraint binds a symbol's paytable entries. Serialized
/// kebab-case, matching the GDD schema enum verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PayRelation {
    TopPaying,
    Floor,
    Ceiling,
}

/// One GDD pay constraint, compiled by Python `derive_target` through the
/// GDD↔model join key: `symbol` is the MODEL symbol id (spec §6).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct PayConstraint {
    pub symbol: u8,
    pub relation: PayRelation,
    /// None = every paytable entry of `symbol`; Some(c) = only the c-of-a-kind entry.
    #[serde(default)]
    pub count: Option<u8>,
    /// x-bet payout bound (unused for TopPaying).
    #[serde(default)]
    pub value: u64,
}
```

Extend `MetricSE` + `standard_errors`:

```rust
    /// SE of the base-game hit-frequency estimate: √(p(1−p)/n) (binomial).
    pub hit_frequency: f64,
```

```rust
        hit_frequency: (m.hit_frequency * (1.0 - m.hit_frequency) / nf).sqrt(),
```

Extend `TargetSpec` (add derives `Default, Deserialize` to the existing derive list, and append fields):

```rust
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct TargetSpec {
    // ... existing fields unchanged ...
    /// Base-game hit-frequency band. Statistical gate (binomial SE), exactly
    /// the bonus_hit_rate pattern. None = no gate (intent absent from the GDD).
    #[serde(default)]
    pub hit_frequency_band: Option<HitRateBand>,
    /// Band for the model's THEORETICAL max win — a static pass/fail check
    /// (observed max is a noisy tail statistic; no SE term). None = no gate.
    #[serde(default)]
    pub max_win_band: Option<Band>,
    /// GDD pay constraints: enforced in GA repair(), asserted in verify.
    #[serde(default)]
    pub pay_constraints: Vec<PayConstraint>,
}

/// The on-disk target-file contract shared by every CLI: the spec fields plus
/// the curation master seed. Replaces the four duplicated `TargetJson` parsers.
#[derive(Deserialize)]
pub struct TargetFile {
    #[serde(flatten)]
    pub spec: TargetSpec,
    pub master_seed: u64,
}
```

- [ ] **Step 4: Fix every `TargetSpec` struct-literal fixture to compile** — append `..Default::default()` as the last line of each literal (they set all pre-existing fields explicitly, so semantics are unchanged). Locations: `studio/simulator/src/run.rs` (`target_09`, `target`, `the_live_contradiction_case_now_passes`), `studio/simulator/src/validate.rs` (`target`), `studio/tuner/src/fitness.rs` (`target`), `studio/tuner/src/validate.rs` (`target`), `studio/tuner/src/genetic.rs` (`target_09`). Example:

```rust
    fn target_09() -> TargetSpec {
        TargetSpec {
            rtp_target: 0.9,
            rtp_tolerance: 0.02,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 10_000,
            candidate_count: 200_000,
            realized_correction_band: 0.05,
            ..Default::default()
        }
    }
```

- [ ] **Step 5: Run the new tests**

Run: `cargo test -p bloom-simulator target::`
Expected: PASS. Then `cargo test --workspace` — expected: PASS (fixtures compile; behavior unchanged).

- [ ] **Step 6: Collapse the four bin parsers.**

`studio/tuner/src/bin/tune_json.rs`: delete `struct BandJson` and `struct TargetJson`; delete `HitRateBand` from the `use bloom_simulator::target::...` import (keep `TargetSpec`). In `main`, replace the `let tj: TargetJson = read_json(...)` line and the whole `let target = TargetSpec { ... };` block with:

```rust
    let target: TargetSpec = read_json(&args[2], "target"); // master_seed key ignored by serde
```

Add to `WeightsJson`:

```rust
#[derive(Deserialize)]
struct WeightsJson {
    rtp: f64,
    volatility: f64,
    hit_rate: f64,
    #[serde(default = "default_weight")]
    hit_frequency: f64,
}

fn default_weight() -> f64 {
    1.0
}
```

and in the `Weights { ... }` construction add `hit_frequency: cj.weights.hit_frequency,`. (This field lands in `Weights` in Task 4 — to keep THIS task compiling, add the `hit_frequency: f64` field to `pub struct Weights` in `studio/tuner/src/config.rs` now, with doc comment `/// Weight of the base-game hit-frequency band (Plan 2).`, and add `hit_frequency: 1.0,` to every `Weights` literal: `studio/tuner/src/fitness.rs` `weights()`, `studio/tuner/src/validate.rs` `cfg()`, `studio/tuner/src/genetic.rs` `cfg()`, and the mapping in both tune bins.)

`studio/tuner/src/bin/tune.rs`: same deletions; replace lines 89–110 (the `tj` parse + `TargetSpec` mapping) with:

```rust
    let target: TargetSpec =
        serde_json::from_str(&fs::read_to_string(&args[2]).expect("read target"))
            .expect("parse target");
```

and apply the same `WeightsJson` change.

`studio/simulator/src/bin/curate_json.rs`: delete `BandJson`/`TargetJson`; import `TargetFile` from `bloom_simulator::target`; replace the parse + mapping (lines 93–120) with:

```rust
    let tf: TargetFile = match fs::read_to_string(&args[2])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("bad target json: {e}");
            std::process::exit(2);
        }
    };
    let target = tf.spec;
```

and replace the later `tj.master_seed` with `tf.master_seed`. Also add `"hitFrequency": se.hit_frequency,` inside the `"se"` object of `result_line` (both the wire and its `result_line_carries_se` test — assert `v["se"]["hitFrequency"].is_number()`).

`studio/simulator/src/bin/curate.rs`: same `TargetFile` replacement for lines 52–71 (`let target = tf.spec;`, `tf.master_seed` at the `run_curation_streamed` call).

`studio/tuner/src/bin/tune_json.rs` `result_line`: add `"hitFrequency": se.hit_frequency,` to its `"se"` object too, and extend `result_line_metrics_carry_se` with `assert!(v["metrics"]["se"]["hitFrequency"].is_number());`.

- [ ] **Step 7: Full workspace gates**

Run: `cargo fmt --check` (run `cargo fmt` first if needed), `cargo clippy --workspace`, `cargo test --workspace`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add studio/simulator studio/tuner
git commit -m "feat(target): extend TargetSpec with constraint fields + one shared target-JSON contract"
```

---

### Task 2: Static constraints module (simulator)

**Files:**

- Create: `studio/simulator/src/constraints.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**

- Consumes: `PayConstraint`, `PayRelation`, `TargetSpec` from Task 1; `SlotModel` from bloom-math.
- Produces: `pub fn theoretical_max_win(model: &SlotModel) -> u64`; `pub struct Violation { pub metric: String, pub measured: f64, pub band_lo: f64, pub band_hi: f64 }`; `pub fn static_violations(model: &SlotModel, target: &TargetSpec) -> Vec<Violation>`; `pub fn validate_constraints(model: &SlotModel, target: &TargetSpec) -> Result<(), String>`; open upper bounds use the finite sentinel `OPEN_HI = 1e18` (the volatility-`1e9` precedent — keeps every wire float finite and plays well with `restart.py`'s open-band normalization).

- [ ] **Step 1: Write the module with failing tests first** — create `studio/simulator/src/constraints.rs`:

```rust
//! Static (statistics-free) constraint checks on a SlotModel. The GDD's
//! pay_constraints and max-win band are properties of the game itself, so a
//! Verify-only run on a hand-edited model reports violations too (spec
//! 2026-07-09 §6). Enforcement during tuning lives in the tuner's repair();
//! this module is the assertion side.

use crate::target::{PayConstraint, PayRelation, TargetSpec};
use bloom_math::mechanics::slots::{BonusFeature, SlotModel};

/// Finite stand-in for an open upper bound (floors have no ceiling). Follows
/// the volatility-"high" precedent (hi = 1e9): keeps wire floats finite.
pub const OPEN_HI: f64 = 1e18;

/// A deterministic constraint violation; field names mirror the BandMiss wire.
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    pub metric: String,
    pub measured: f64,
    pub band_lo: f64,
    pub band_hi: f64,
}

/// Theoretical max win in bet-multiples: top paytable payout × the largest
/// bonus multiplier.
/// ponytail: single-line bound — ignores multi-line stacking; refine when
/// line/shape constraints land (spec §11).
pub fn theoretical_max_win(model: &SlotModel) -> u64 {
    let top_pay = model
        .paytable
        .entries
        .iter()
        .map(|e| e.payout)
        .max()
        .unwrap_or(0);
    let top_mult = model
        .bonuses
        .iter()
        .map(|b| match b {
            BonusFeature::FreeSpins { config, .. } => config.multiplier,
        })
        .max()
        .unwrap_or(1)
        .max(1);
    top_pay.saturating_mul(top_mult)
}

fn scoped(c: &PayConstraint, symbol: u8, count: u8) -> bool {
    c.symbol == symbol && c.count.is_none_or(|cc| cc == count)
}

/// Violations of the target's static invariants by `model`. Empty ⟺ the model
/// satisfies every deterministic constraint.
pub fn static_violations(model: &SlotModel, target: &TargetSpec) -> Vec<Violation> {
    let mut out = Vec::new();
    if let Some(band) = &target.max_win_band {
        let mw = theoretical_max_win(model) as f64;
        if mw < band.min || mw > band.max {
            out.push(Violation {
                metric: "max_win".into(),
                measured: mw,
                band_lo: band.min,
                band_hi: band.max,
            });
        }
    }
    for c in &target.pay_constraints {
        match c.relation {
            PayRelation::Floor => {
                for e in &model.paytable.entries {
                    if scoped(c, e.symbol, e.count) && e.payout < c.value {
                        out.push(Violation {
                            metric: format!("pay_floor[{}@{}]", e.symbol, e.count),
                            measured: e.payout as f64,
                            band_lo: c.value as f64,
                            band_hi: OPEN_HI,
                        });
                    }
                }
            }
            PayRelation::Ceiling => {
                for e in &model.paytable.entries {
                    if scoped(c, e.symbol, e.count) && e.payout > c.value {
                        out.push(Violation {
                            metric: format!("pay_ceiling[{}@{}]", e.symbol, e.count),
                            measured: e.payout as f64,
                            band_lo: 0.0,
                            band_hi: c.value as f64,
                        });
                    }
                }
            }
            PayRelation::TopPaying => {
                let top = model
                    .paytable
                    .entries
                    .iter()
                    .filter(|e| e.symbol == c.symbol)
                    .map(|e| e.payout)
                    .max()
                    .unwrap_or(0);
                for e in &model.paytable.entries {
                    if e.symbol != c.symbol && e.payout > top {
                        out.push(Violation {
                            metric: format!("top_paying[{}]", c.symbol),
                            measured: e.payout as f64,
                            band_lo: 0.0,
                            band_hi: top as f64,
                        });
                    }
                }
            }
        }
    }
    out
}

/// `Err(message)` for nonsensical constraint/band inputs, BEFORE a search or
/// curation runs on them: unknown symbol id, floor above ceiling, more than
/// one top-paying, inverted bands (spec §6 "up-front validation").
pub fn validate_constraints(model: &SlotModel, target: &TargetSpec) -> Result<(), String> {
    if let Some(b) = &target.hit_frequency_band {
        if b.min > b.max {
            return Err(format!("hit_frequency_band inverted ({} > {})", b.min, b.max));
        }
    }
    if let Some(b) = &target.max_win_band {
        if b.min > b.max {
            return Err(format!("max_win_band inverted ({} > {})", b.min, b.max));
        }
    }
    let mut top_paying = 0usize;
    for c in &target.pay_constraints {
        if !model.symbols.iter().any(|s| s.id == c.symbol) {
            return Err(format!(
                "pay constraint references unknown model symbol id {}",
                c.symbol
            ));
        }
        if matches!(c.relation, PayRelation::TopPaying) {
            top_paying += 1;
        }
    }
    if top_paying > 1 {
        return Err(format!(
            "{top_paying} top-paying constraints; at most one symbol can pay the most"
        ));
    }
    for f in target
        .pay_constraints
        .iter()
        .filter(|c| matches!(c.relation, PayRelation::Floor))
    {
        for cl in target
            .pay_constraints
            .iter()
            .filter(|c| matches!(c.relation, PayRelation::Ceiling))
        {
            let overlap = f.symbol == cl.symbol
                && match (f.count, cl.count) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                };
            if overlap && f.value > cl.value {
                return Err(format!(
                    "floor {} exceeds ceiling {} for symbol {}",
                    f.value, cl.value, f.symbol
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::{HitRateBand, PayConstraint, PayRelation, TargetSpec};
    use bloom_math::mechanics::slots::{
        BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
        TriggerSpec,
    };

    // sym0 pays 10@3, sym1 pays 50@3, sym2 (scatter) triggers a x3 bonus.
    fn model() -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Normal },
                SymbolDef { id: 2, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![0, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 0, count: 3, payout: 10 },
                    PaytableEntry { symbol: 1, count: 3, payout: 50 },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec { symbol: 2, min_count: 3 },
                config: FreeSpinsConfig {
                    spins_awarded: 5,
                    retrigger: false,
                    multiplier: 3,
                    feature_reels: None,
                },
            }],
        }
    }

    fn target_with(constraints: Vec<PayConstraint>) -> TargetSpec {
        TargetSpec {
            pay_constraints: constraints,
            ..Default::default()
        }
    }

    #[test]
    fn theoretical_max_win_is_top_pay_times_top_multiplier() {
        assert_eq!(theoretical_max_win(&model()), 150); // 50 × 3
        let mut m = model();
        m.bonuses.clear();
        assert_eq!(theoretical_max_win(&m), 50); // multiplier defaults to 1
    }

    #[test]
    fn max_win_band_violation_is_reported() {
        let mut t = target_with(vec![]);
        t.max_win_band = Some(HitRateBand { min: 500.0, max: 1000.0 });
        let v = static_violations(&model(), &t);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].metric, "max_win");
        assert_eq!(v[0].measured, 150.0);
        t.max_win_band = Some(HitRateBand { min: 100.0, max: 1000.0 });
        assert!(static_violations(&model(), &t).is_empty());
    }

    #[test]
    fn floor_and_ceiling_violations_respect_the_count_scope() {
        // floor 20 on sym0@3 (pays 10) → violated; scoped to a count that
        // doesn't exist → no violation.
        let t = target_with(vec![PayConstraint {
            symbol: 0,
            relation: PayRelation::Floor,
            count: Some(3),
            value: 20,
        }]);
        let v = static_violations(&model(), &t);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].metric, "pay_floor[0@3]");
        assert_eq!(v[0].band_hi, OPEN_HI);

        let t = target_with(vec![PayConstraint {
            symbol: 0,
            relation: PayRelation::Floor,
            count: Some(4),
            value: 20,
        }]);
        assert!(static_violations(&model(), &t).is_empty());

        let t = target_with(vec![PayConstraint {
            symbol: 1,
            relation: PayRelation::Ceiling,
            count: None,
            value: 30,
        }]);
        assert_eq!(static_violations(&model(), &t)[0].metric, "pay_ceiling[1@3]");
    }

    #[test]
    fn top_paying_flags_any_competitor_above_the_designated_symbol() {
        // sym0 designated top but sym1 pays 50 > 10 → violation.
        let t = target_with(vec![PayConstraint {
            symbol: 0,
            relation: PayRelation::TopPaying,
            count: None,
            value: 0,
        }]);
        let v = static_violations(&model(), &t);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].metric, "top_paying[0]");
        // sym1 designated top → already true → clean.
        let t = target_with(vec![PayConstraint {
            symbol: 1,
            relation: PayRelation::TopPaying,
            count: None,
            value: 0,
        }]);
        assert!(static_violations(&model(), &t).is_empty());
    }

    #[test]
    fn validate_rejects_unknown_symbol_two_tops_inverted_bands_and_floor_over_ceiling() {
        let unknown = target_with(vec![PayConstraint {
            symbol: 9,
            relation: PayRelation::Floor,
            count: None,
            value: 1,
        }]);
        assert!(validate_constraints(&model(), &unknown)
            .unwrap_err()
            .contains("unknown model symbol"));

        let two_tops = target_with(vec![
            PayConstraint { symbol: 0, relation: PayRelation::TopPaying, count: None, value: 0 },
            PayConstraint { symbol: 1, relation: PayRelation::TopPaying, count: None, value: 0 },
        ]);
        assert!(validate_constraints(&model(), &two_tops)
            .unwrap_err()
            .contains("at most one"));

        let mut inverted = target_with(vec![]);
        inverted.hit_frequency_band = Some(HitRateBand { min: 0.4, max: 0.2 });
        assert!(validate_constraints(&model(), &inverted)
            .unwrap_err()
            .contains("hit_frequency_band"));

        let clash = target_with(vec![
            PayConstraint { symbol: 0, relation: PayRelation::Floor, count: None, value: 100 },
            PayConstraint { symbol: 0, relation: PayRelation::Ceiling, count: None, value: 50 },
        ]);
        assert!(validate_constraints(&model(), &clash)
            .unwrap_err()
            .contains("floor"));

        assert!(validate_constraints(&model(), &target_with(vec![])).is_ok());
    }
}
```

- [ ] **Step 2: Register the module** — in `studio/simulator/src/lib.rs` add `pub mod constraints;` alongside the existing modules and `pub use constraints::{static_violations, theoretical_max_win, validate_constraints};` next to the existing `pub use validate::validate_target;`.

- [ ] **Step 3: Run**

Run: `cargo test -p bloom-simulator constraints::`
Expected: PASS (write tests first mentally, but this module is new — run once written; if any test fails, fix the logic, not the test).

- [ ] **Step 4: Gates + commit**

Run: `cargo fmt --check && cargo clippy --workspace && cargo test --workspace`

```bash
git add studio/simulator/src/constraints.rs studio/simulator/src/lib.rs
git commit -m "feat(simulator): static constraint checks (max-win band + pay constraints)"
```

---

### Task 3: verify gains the model, the hit-frequency gate, and the static gate

**Files:**

- Modify: `studio/simulator/src/run.rs`
- Modify: `studio/simulator/src/bin/curate_json.rs`, `studio/simulator/src/bin/curate.rs`
- Modify (call-site compile fixes): `studio/tuner/src/genetic.rs`, `studio/tuner/src/fitness.rs` (test `band_misses_agrees_with_verify` only)

**Interfaces:**

- Produces: `pub fn verify(model: &SlotModel, metrics: &Metrics, target: &TargetSpec, n: usize) -> Result<(), Metrics>` — the ONE gate, now covering: RTP, volatility, per-bonus hit-rates, base hit-frequency (all 2·SE noise-aware), plus `static_violations` as hard pass/fail.
- Consumes: `standard_errors(...).hit_frequency` (Task 1), `static_violations` (Task 2).

- [ ] **Step 1: Write the failing tests** — in `studio/simulator/src/run.rs` `mod tests` add (note every existing `verify(...)` call in this file gains `&measurable_model()` as its new first argument in Step 3):

```rust
    #[test]
    fn hit_frequency_out_of_band_fails_and_2_se_noise_passes() {
        // fixture hit_frequency is 0.3. Band 0.35–0.45: miss 0.05.
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand { min: 0.35, max: 0.45 });
        // n=1_000_000 → SE ≈ 0.00046 → allowance ≈ 0.0009 → FAIL.
        assert!(verify(&measurable_model(), &metrics(0.955, 3.0, vec![]), &t, 1_000_000).is_err());
        // n=300 → SE ≈ 0.0265 → allowance ≈ 0.053 ≥ 0.05 → PASS (noise).
        assert!(verify(&measurable_model(), &metrics(0.955, 3.0, vec![]), &t, 300).is_ok());
        // No band → no gate.
        assert!(verify(&measurable_model(), &metrics(0.955, 3.0, vec![]), &target(vec![]), 100).is_ok());
    }

    #[test]
    fn static_violations_fail_verify_regardless_of_metrics() {
        // measurable_model(): top pay 5, no bonuses → theoretical max win 5.
        let mut t = target(vec![]);
        t.max_win_band = Some(HitRateBand { min: 100.0, max: 1000.0 });
        assert!(verify(&measurable_model(), &metrics(0.955, 3.0, vec![]), &t, 1_000_000).is_err());

        let mut t = target(vec![]);
        t.pay_constraints = vec![crate::target::PayConstraint {
            symbol: 1,
            relation: crate::target::PayRelation::TopPaying,
            count: None,
            value: 0,
        }];
        // sym2 pays 5 > sym1's 1 → top-paying violated → hard fail.
        assert!(verify(&measurable_model(), &metrics(0.955, 3.0, vec![]), &t, 1_000_000).is_err());
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-simulator run::`
Expected: FAIL to compile (verify has no model param).

- [ ] **Step 3: Implement.** In `run.rs`:

```rust
use crate::constraints::static_violations;
```

```rust
pub fn verify(
    model: &SlotModel,
    metrics: &Metrics,
    target: &TargetSpec,
    n: usize,
) -> Result<(), Metrics> {
    // ... existing assert + se/rtp_ok/vol_ok/bonuses_ok unchanged ...
    let hf_ok = match &target.hit_frequency_band {
        Some(band) => {
            outside(metrics.hit_frequency, band.min, band.max) <= K_SIGMA * se.hit_frequency
        }
        None => true,
    };
    // Constraints are properties of the game, not of tuning: deterministic
    // model facts get no SE allowance (spec §6).
    let static_ok = static_violations(model, target).is_empty();

    if rtp_ok && vol_ok && hf_ok && bonuses_ok && static_ok {
        Ok(())
    } else {
        Err(metrics.clone())
    }
}
```

Update the internal call: `verify(model, &metrics, target, samples.len())`. Update the doc comment to mention the two new gates. Mechanically add the model argument to every existing verify test call (`&measurable_model()`).

- [ ] **Step 4: Fix the tuner call sites (compile only — behavior identical because these targets carry no constraints yet).** In `studio/tuner/src/genetic.rs`:
  - prefilter (`stagnation >= cfg.stagnation_window` branch): `verify(&best_model, &bm, target, cfg.search_candidate_count)`
  - confirmation: `verify(&candidate, &measure(&conf_samples), target, cfg.final_candidate_count)`
  - final verdict: `verify(&model, &metrics, target, final_samples.len())`

  In `studio/tuner/src/fitness.rs` test `band_misses_agrees_with_verify`: the loop needs a model — use the 1-reel toy from `genetic.rs` tests (copy the small `toy(1)` fixture into this test module as `fn toy_model() -> SlotModel`) and call `verify(&toy_model(), &m, &t, n)`.

- [ ] **Step 5: Wire up-front validation + a real failure message in the curate bins.** In `curate_json.rs`, after the existing `validate_target` check add:

```rust
    if let Err(e) = bloom_simulator::validate_constraints(&model, &target) {
        eprintln!("invalid target: {e}");
        std::process::exit(2);
    }
```

and enrich the verify-failure arm so constraint violations are named:

```rust
        Err(RunError::VerifyFailed(_)) => {
            let sv = bloom_simulator::static_violations(&model, &target);
            let msg = if sv.is_empty() {
                "measured characteristics missed the target bands".to_string()
            } else {
                format!(
                    "constraint violations: {}",
                    sv.iter().map(|v| v.metric.clone()).collect::<Vec<_>>().join(", ")
                )
            };
            ("fail", None, None, Some(msg))
        }
```

Same `validate_constraints` guard in `curate.rs` (after its `validate_target` call).

- [ ] **Step 6: Gates + commit**

Run: `cargo fmt --check && cargo clippy --workspace && cargo test --workspace`
Expected: all green (the long GA tests in bloom-tuner take a few minutes).

```bash
git add studio/simulator studio/tuner
git commit -m "feat(simulator): verify gates on hit-frequency band + static constraints"
```

---

### Task 4: GA objective — hit-frequency weight in fitness, static misses in band_misses

**Files:**

- Modify: `studio/tuner/src/fitness.rs`
- Modify: `studio/tuner/src/genetic.rs` (band_misses call site)

**Interfaces:**

- Consumes: `Weights.hit_frequency` (added in Task 1), `se.hit_frequency`, `static_violations`.
- Produces: `pub fn band_misses(model: &SlotModel, m: &Metrics, t: &TargetSpec, n: usize) -> Vec<BandMiss>` — now also reporting `hit_frequency` misses and static violations (metric names `max_win`, `pay_floor[s@c]`, `pay_ceiling[s@c]`, `top_paying[s]`), preserving the `band_misses`-empty ⟺ `verify`-Ok invariant (the PR #156 pattern).

- [ ] **Step 1: Write the failing tests** in `studio/tuner/src/fitness.rs` `mod tests` (uses the `toy_model()` fixture added in Task 3):

```rust
    #[test]
    fn hit_frequency_band_pulls_fitness_when_out_of_band() {
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand { min: 0.35, max: 0.45 });
        // fixture hit_frequency 0.3 → out of band → below -1.
        let out = fitness(&metrics(0.96, 3.0, vec![]), &t, &weights());
        assert!(out < -1.0, "out-of-band hit frequency must be infeasible: {out}");
        // In band (0.25–0.35) → in-band, centered scoring applies.
        t.hit_frequency_band = Some(HitRateBand { min: 0.25, max: 0.35 });
        let centered = fitness(&metrics(0.96, 3.0, vec![]), &t, &weights());
        assert!(centered <= 0.0 && centered > -1.0);
    }

    #[test]
    fn zero_weight_disables_the_hit_frequency_pull() {
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand { min: 0.35, max: 0.45 });
        let mut w = weights();
        w.hit_frequency = 0.0;
        assert_eq!(fitness(&metrics(0.96, 3.0, vec![]), &t, &w), 0.0);
    }

    #[test]
    fn band_misses_reports_hit_frequency_and_static_violations() {
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand { min: 0.35, max: 0.45 });
        t.pay_constraints = vec![bloom_simulator::target::PayConstraint {
            symbol: 1,
            relation: bloom_simulator::target::PayRelation::TopPaying,
            count: None,
            value: 0,
        }];
        // toy_model(): sym2 pays 5 > sym1's 1 → top_paying violated.
        let misses = band_misses(&toy_model(), &metrics(0.96, 3.0, vec![]), &t, 4_000_000);
        let names: Vec<&str> = misses.iter().map(|m| m.metric.as_str()).collect();
        assert!(names.contains(&"hit_frequency"));
        assert!(names.iter().any(|n| n.starts_with("top_paying[")));
    }
```

Also extend the fixture-table in `band_misses_agrees_with_verify` with one static-violation case:

```rust
        // static violation: any n, agreement must hold
        {
            let mut t2 = t.clone();
            t2.pay_constraints = vec![bloom_simulator::target::PayConstraint {
                symbol: 1,
                relation: bloom_simulator::target::PayRelation::TopPaying,
                count: None,
                value: 0,
            }];
            let m = metrics(0.955, 3.0, vec![0.02]);
            assert_eq!(
                band_misses(&toy_model(), &m, &t2, 1_000_000).is_empty(),
                verify(&toy_model(), &m, &t2, 1_000_000).is_ok(),
            );
        }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-tuner fitness::`
Expected: FAIL to compile (`band_misses` has no model param; fitness ignores the band).

- [ ] **Step 3: Implement in `fitness.rs`.** Out-of-band term (after the volatility term):

```rust
    if let Some(band) = &t.hit_frequency_band {
        let width = (band.max - band.min).abs().max(1e-9);
        d += w.hit_frequency * outside(m.hit_frequency, band.min, band.max) / width;
    }
```

Centering term (after the bonus-rate centering loop, before the return):

```rust
    if let Some(band) = &t.hit_frequency_band {
        let mid = (band.min + band.max) / 2.0;
        let half = ((band.max - band.min) / 2.0).abs().max(1e-9);
        center += w.hit_frequency * (m.hit_frequency - mid).abs() / half;
        total_w += w.hit_frequency;
    }
```

`band_misses` — new signature and two additions:

```rust
use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::constraints::static_violations;

pub fn band_misses(model: &SlotModel, m: &Metrics, t: &TargetSpec, n: usize) -> Vec<BandMiss> {
    // ... existing rtp/volatility/bonus blocks unchanged ...
    if let Some(band) = &t.hit_frequency_band {
        if outside(m.hit_frequency, band.min, band.max) > K_SIGMA * se.hit_frequency {
            out.push(BandMiss {
                metric: "hit_frequency".into(),
                measured: m.hit_frequency,
                band_lo: band.min,
                band_hi: band.max,
            });
        }
    }
    for v in static_violations(model, t) {
        out.push(BandMiss {
            metric: v.metric,
            measured: v.measured,
            band_lo: v.band_lo,
            band_hi: v.band_hi,
        });
    }
    out
}
```

Update the one production call site in `genetic.rs` (final verdict): `band_misses(&model, &metrics, target, final_samples.len())`, and every test call in `fitness.rs` gains `&toy_model()`.

- [ ] **Step 4: Gates + commit**

Run: `cargo fmt --check && cargo clippy --workspace && cargo test --workspace`

```bash
git add studio/tuner
git commit -m "feat(tuner): hit-frequency band joins fitness and band_misses; static misses reported"
```

---

### Task 5: repair() enforces pay constraints; up-front validation in the tuner

**Files:**

- Modify: `studio/tuner/src/genome.rs`
- Modify: `studio/tuner/src/genetic.rs`
- Modify: `studio/tuner/src/validate.rs`

**Interfaces:**

- Produces: `pub fn repair(genome: &mut Genome, template: &SlotModel, bounds: &GeneBounds, constraints: &[PayConstraint])`. Deterministic order: GeneBounds clamp → floor/ceiling clamps (constraints win over bounds) → top-paying fix-up (competitors capped AT the designated symbol's top pay; ties allowed), applied in fixed paytable-entry order — common-random-numbers determinism preserved.
- Consumes: `PayConstraint`/`PayRelation` (Task 1), `validate_constraints` (Task 2).
- `mutate`/`crossover` in `genetic.rs` gain a `constraints: &[PayConstraint]` parameter and pass `&target.pay_constraints` through.

- [ ] **Step 1: Write the failing tests** in `studio/tuner/src/genome.rs` `mod tests` (the fixture `model()` there has paytable entries `sym0@2→3`, `sym1@2→5`; every existing `repair(...)` call gains `&[]` as the new last argument in Step 3):

```rust
    use bloom_simulator::target::{PayConstraint, PayRelation};

    fn floor(symbol: u8, count: Option<u8>, value: u64) -> PayConstraint {
        PayConstraint { symbol, relation: PayRelation::Floor, count, value }
    }

    #[test]
    fn repair_applies_floor_and_ceiling_clamps() {
        let m = model();
        let mut g = encode(&m);
        g.payouts = vec![1, 90];
        repair(&mut g, &m, &bounds(), &[
            floor(0, None, 10),
            PayConstraint { symbol: 1, relation: PayRelation::Ceiling, count: Some(2), value: 40 },
        ]);
        assert_eq!(g.payouts[0], 10); // floored up
        assert_eq!(g.payouts[1], 40); // ceilinged down
    }

    #[test]
    fn constraint_floor_wins_over_gene_bounds_ceiling() {
        // bounds().payout_max is 100; a floor of 200 must still hold — the
        // designed floor is the stronger intent (deterministic resolution).
        let m = model();
        let mut g = encode(&m);
        g.payouts = vec![1, 5];
        repair(&mut g, &m, &bounds(), &[floor(0, None, 200)]);
        assert_eq!(g.payouts[0], 200);
    }

    #[test]
    fn repair_caps_competitors_at_the_top_paying_symbol() {
        let m = model();
        let mut g = encode(&m);
        g.payouts = vec![80, 30]; // sym0 outpays sym1
        repair(&mut g, &m, &bounds(), &[PayConstraint {
            symbol: 1,
            relation: PayRelation::TopPaying,
            count: None,
            value: 0,
        }]);
        assert_eq!(g.payouts[1], 30); // designated symbol untouched
        assert_eq!(g.payouts[0], 30); // competitor capped AT its top pay (tie ok)
    }

    #[test]
    fn repair_with_constraints_is_deterministic() {
        let m = model();
        let cs = [floor(0, None, 10), PayConstraint {
            symbol: 1,
            relation: PayRelation::TopPaying,
            count: None,
            value: 0,
        }];
        let mut a = encode(&m);
        a.payouts = vec![97, 13];
        let mut b = a.clone();
        repair(&mut a, &m, &bounds(), &cs);
        repair(&mut b, &m, &bounds(), &cs);
        assert_eq!(a, b);
    }

    #[test]
    fn locked_paytable_skips_constraint_enforcement() {
        // payouts omitted from the genome → nothing to clamp; verify still
        // reports violations on the decoded model (Task 3), repair must not panic.
        let m = model();
        let l = SectionLocks { paytable: true, ..Default::default() };
        let mut g = encode_with_locks(&m, &l);
        repair(&mut g, &m, &bounds(), &[floor(0, None, 10)]);
        assert!(g.payouts.is_empty());
    }
```

And the GA-level integration test in `studio/tuner/src/genetic.rs` `mod tests`:

```rust
    #[test]
    fn tuned_model_honors_a_top_paying_constraint() {
        // toy(1): sym1@1→1, sym2@1→1 (detuned, RTP ~0.5; target 0.9).
        // Constrain sym2 to be top-paying: every candidate the GA ever
        // evaluates is repaired to sym1 ≤ sym2, and the winner must both
        // PASS and honor the constraint.
        let mut t = target_09();
        t.pay_constraints = vec![bloom_simulator::target::PayConstraint {
            symbol: 2,
            relation: bloom_simulator::target::PayRelation::TopPaying,
            count: None,
            value: 0,
        }];
        let out = GeneticTuner.tune(&toy(1), &t, &cfg(7));
        let pay = |sym: u8| {
            out.model.paytable.entries.iter().find(|e| e.symbol == sym).unwrap().payout
        };
        assert!(pay(2) >= pay(1), "constraint violated: sym1 {} > sym2 {}", pay(1), pay(2));
        assert!(matches!(out.verdict, Verdict::Pass), "verdict {:?}", out.verdict);
    }

    #[test]
    fn constrained_tune_is_deterministic() {
        let mut t = target_09();
        t.pay_constraints = vec![bloom_simulator::target::PayConstraint {
            symbol: 2,
            relation: bloom_simulator::target::PayRelation::TopPaying,
            count: None,
            value: 0,
        }];
        let a = GeneticTuner.tune(&toy(1), &t, &cfg(2026));
        let b = GeneticTuner.tune(&toy(1), &t, &cfg(2026));
        assert_eq!(a.model, b.model);
        assert_eq!(a.metrics.rtp, b.metrics.rtp);
    }
```

And the validation test in `studio/tuner/src/validate.rs` `mod tests`:

```rust
    #[test]
    fn rejects_constraints_referencing_unknown_symbols() {
        let mut t = target(1);
        t.pay_constraints = vec![bloom_simulator::target::PayConstraint {
            symbol: 99,
            relation: bloom_simulator::target::PayRelation::Floor,
            count: None,
            value: 5,
        }];
        assert!(validate(&model(1), &t, &cfg())
            .unwrap_err()
            .contains("unknown model symbol"));
    }
```

(NOTE: `validate.rs`'s `model(n)` fixture has `symbols: vec![]` — any constraint symbol is unknown there, which is exactly what this test needs.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p bloom-tuner genome::`
Expected: FAIL to compile (repair has no constraints param).

- [ ] **Step 3: Implement.** In `genome.rs` add the import and extend `repair`:

```rust
use bloom_simulator::target::{PayConstraint, PayRelation};
```

```rust
pub fn repair(
    genome: &mut Genome,
    template: &SlotModel,
    bounds: &GeneBounds,
    constraints: &[PayConstraint],
) {
    // ... existing reel-count rescale unchanged ...

    for p in &mut genome.payouts {
        *p = clamp_u64(*p, bounds.payout_min, bounds.payout_max);
    }

    // GDD pay constraints (spec §6): floors/ceilings are per-gene clamps
    // layered ON TOP of GeneBounds (the designed constraint wins); TopPaying
    // is a deterministic post-clamp fix-up in fixed entry order. A locked
    // paytable has no payout genes — nothing to enforce here; verify still
    // reports violations on the stored paytable.
    if !genome.payouts.is_empty() {
        for (e, p) in template.paytable.entries.iter().zip(&mut genome.payouts) {
            for c in constraints {
                if c.symbol != e.symbol || c.count.is_some_and(|cc| cc != e.count) {
                    continue;
                }
                match c.relation {
                    PayRelation::Floor => *p = (*p).max(c.value),
                    PayRelation::Ceiling => *p = (*p).min(c.value),
                    PayRelation::TopPaying => {}
                }
            }
        }
        if let Some(top_sym) = constraints
            .iter()
            .find(|c| matches!(c.relation, PayRelation::TopPaying))
            .map(|c| c.symbol)
        {
            let top = template
                .paytable
                .entries
                .iter()
                .zip(&genome.payouts)
                .filter(|(e, _)| e.symbol == top_sym)
                .map(|(_, &p)| p)
                .max()
                .unwrap_or(0);
            for (e, p) in template.paytable.entries.iter().zip(&mut genome.payouts) {
                if e.symbol != top_sym && *p > top {
                    *p = top;
                }
            }
        }
    }

    // ... existing bonuses clamp unchanged ...
}
```

In `genetic.rs`: `mutate` and `crossover` gain `constraints: &[PayConstraint]` (import from `bloom_simulator::target`) and pass it to their `repair` calls; `tune_with_progress` passes `&target.pay_constraints` at the three call sites (initial population `mutate`, and the `crossover` + `mutate` pair in the next-generation loop).

In `validate.rs` (tuner), after the existing checks, before `Ok(())`:

```rust
    bloom_simulator::validate_constraints(seed_model, target)?;
```

- [ ] **Step 4: Run**

Run: `cargo test -p bloom-tuner`
Expected: PASS, including the two new GA integration tests (slow — minutes).

- [ ] **Step 5: Gates + commit**

Run: `cargo fmt --check && cargo clippy --workspace && cargo test --workspace`

```bash
git add studio/tuner
git commit -m "feat(tuner): enforce GDD pay constraints in GA repair + up-front validation"
```

---

### Task 6: Python compile — new bands + pay constraints in derive_target

**Files:**

- Modify: `studio/backend/app/math/models.py`
- Modify: `studio/backend/app/math/targets.py`
- Modify: `studio/backend/app/math/bounds.py`
- Modify: `studio/backend/app/math/restart.py`
- Modify: `studio/backend/app/math/runners/curate.py`, `studio/backend/app/math/runners/tune.py`
- Test: `studio/backend/tests/test_targets.py`, `studio/backend/tests/test_restart.py` (append), `studio/backend/tests/test_bounds.py` (append if it exists, else assert in test_targets)

**Interfaces:**

- Produces: `derive_target(math_model, params, num_bonuses, paytable_data=None, symbols_data=None) -> dict` — emits (only when the intent exists) `"hit_frequency_band": {"min","max"}`, `"max_win_band": {"min","max"}`, `"pay_constraints": [{"symbol": <model id int>, "relation": "top-paying"|"floor"|"ceiling", "count"?: int, "value"?: int}]`. Tolerances: hit-frequency reuses `params.bonus_rate_tolerance` (same kind of statistic); max-win uses new `params.max_win_tolerance` (default 0.5, relative). Raises `TargetGap` when a constraint references a symbol without a `model_id` join key or has a bad relation/missing value.
- Produces: `CurationParams.max_win_tolerance: float = 0.5`; `TuneWeights.hit_frequency: float = 1.0`; `MetricSEWire.hit_frequency: float | None = None`.
- Consumed by Task 7 (target_flow) and by the Rust binaries (contract locked by Task 1's Rust test).

- [ ] **Step 1: Write the failing tests** — append to `studio/backend/tests/test_targets.py`:

```python
from app.math.models import default_params
from app.math.targets import derive_target

_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high", "model_id": 0},
    {"slot": "wild", "name": "Rune", "kind": "wild", "model_id": 2},
]}


def _math_model(**extra):
    return {"rtp": 0.96, "volatility": "medium", **extra}


def test_new_bands_are_omitted_when_intent_is_absent():
    t = derive_target(_math_model(), default_params(), 0)
    assert "hit_frequency_band" not in t
    assert "max_win_band" not in t
    assert "pay_constraints" not in t


def test_hit_frequency_compiles_to_a_relative_band():
    p = default_params()  # bonus_rate_tolerance 0.25
    t = derive_target(_math_model(hit_frequency=0.3), p, 0)
    band = t["hit_frequency_band"]
    assert abs(band["min"] - 0.225) < 1e-9
    assert abs(band["max"] - 0.375) < 1e-9


def test_max_win_compiles_to_a_relative_band():
    p = default_params()  # max_win_tolerance 0.5
    t = derive_target(_math_model(max_win=5000), p, 0)
    assert t["max_win_band"] == {"min": 2500.0, "max": 7500.0}


def test_pay_constraints_compile_through_the_join_key():
    rows = {"pay_constraints": [
        {"symbol": "wild", "relation": "top-paying"},
        {"symbol": "Dragon", "relation": "floor", "count": "3", "value": "5"},
    ]}
    t = derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)
    assert t["pay_constraints"] == [
        {"symbol": 2, "relation": "top-paying"},
        {"symbol": 0, "relation": "floor", "count": 3, "value": 5},
    ]


def test_pay_constraint_without_join_key_raises_target_gap():
    rows = {"pay_constraints": [{"symbol": "kraken", "relation": "floor", "value": "5"}]}
    with pytest.raises(TargetGap, match="re-realize"):
        derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)


def test_floor_without_value_raises_target_gap():
    rows = {"pay_constraints": [{"symbol": "wild", "relation": "floor"}]}
    with pytest.raises(TargetGap, match="value"):
        derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)
```

- [ ] **Step 2: Run to verify failure**

Run: `uv --directory studio/backend run pytest tests/test_targets.py -q`
Expected: FAIL (`max_win_tolerance` missing / new keys not emitted).

- [ ] **Step 3: Implement.**

`models.py` — `CurationParams` gains:

```python
    max_win_tolerance: float = 0.5  # relative ± band around the GDD max-win intent
```

`TuneWeights` gains:

```python
    hit_frequency: float = 1.0  # base-game hit-frequency band (Plan 2)
```

`MetricSEWire` gains:

```python
    hit_frequency: float | None = None
```

`targets.py` — add the compiler and extend `derive_target`:

```python
_RELATIONS = ("top-paying", "floor", "ceiling")


def _compile_pay_constraints(paytable_data: dict, symbols_data: dict) -> list[dict]:
    """GDD pay_constraints rows -> the Rust PayConstraint JSON, resolving each
    row's symbol (slot or name) to the model symbol id via the model_id join
    key (spec §5-§6). TargetGap on an unresolvable symbol: the join key is
    written by realization, so a miss means the model needs re-realizing."""
    rows = (paytable_data or {}).get("pay_constraints") or []
    if not rows:
        return []
    ids: dict[str, int] = {}
    for srow in (symbols_data or {}).get("symbols") or []:
        mid = srow.get("model_id")
        if not isinstance(mid, (int, float)) or isinstance(mid, bool):
            continue
        for key in (srow.get("slot"), srow.get("name")):
            k = str(key or "").strip().lower()
            if k:
                ids.setdefault(k, int(mid))
    out: list[dict] = []
    for row in rows:
        name = str(row.get("symbol", "")).strip().lower()
        relation = str(row.get("relation", "")).strip().lower()
        if relation not in _RELATIONS:
            raise TargetGap(f"unknown pay-constraint relation '{row.get('relation')}'")
        if name not in ids:
            raise TargetGap(
                f"pay constraint references symbol '{row.get('symbol')}' with no "
                f"model_id join key; re-realize the model (shape is stale).")
        c: dict = {"symbol": ids[name], "relation": relation}
        raw_count = row.get("count")
        if raw_count not in (None, ""):
            c["count"] = int(float(str(raw_count)))
        if relation != "top-paying":
            raw_value = row.get("value")
            if raw_value in (None, ""):
                raise TargetGap(
                    f"pay constraint '{relation}' for '{row.get('symbol')}' needs a value")
            c["value"] = int(float(str(raw_value)))
        out.append(c)
    return out
```

```python
def derive_target(math_model: dict, params: CurationParams, num_bonuses: int,
                  paytable_data: dict | None = None,
                  symbols_data: dict | None = None) -> dict:
    # ... existing body unchanged, but build the return dict into `target` ...
    target = {
        # ... the existing keys verbatim ...
    }

    hf = math_model.get("hit_frequency")
    if hf not in (None, ""):
        center = normalize_percent(hf)
        tol = params.bonus_rate_tolerance  # same statistic kind as bonus rates
        target["hit_frequency_band"] = {"min": center * (1.0 - tol),
                                        "max": center * (1.0 + tol)}

    mw = math_model.get("max_win")
    if mw not in (None, ""):
        val = float(str(mw).strip().lower().rstrip("x"))
        tol = params.max_win_tolerance
        target["max_win_band"] = {"min": val * (1.0 - tol), "max": val * (1.0 + tol)}

    constraints = _compile_pay_constraints(paytable_data or {}, symbols_data or {})
    if constraints:
        target["pay_constraints"] = constraints
    return target
```

`bounds.py` `build_config` weights dict gains:

```python
            "hit_frequency": params.weights.hit_frequency,
```

`restart.py` `miss_score`, after the volatility gate:

```python
    hf = target.get("hit_frequency_band")
    if hf:
        score += _gate(metrics.hit_frequency, hf["min"], hf["max"])
```

`runners/curate.py` and `runners/tune.py`: where `MetricSEWire(...)` is constructed from `se_d`, add `hit_frequency=se_d.get("hitFrequency"),`.

- [ ] **Step 4: Run**

Run: `uv --directory studio/backend run pytest tests/test_targets.py tests/test_restart.py tests/test_bounds.py -q` (drop any of those paths that don't exist)
Expected: PASS. Add a one-line miss-score test to the restart test file:

```python
def test_miss_score_gates_hit_frequency_band():
    from app.math.models import MetricsWire
    m = MetricsWire(rtp=0.96, volatility=3.0, hit_frequency=0.2,
                    base_rtp=0.96, feature_rtp=0.0, bonus_hit_rates=[])
    target = {"rtp_target": 0.96, "rtp_tolerance": 0.01,
              "volatility_min": 0.0, "volatility_max": 1e9,
              "bonus_hit_rate_bands": [],
              "hit_frequency_band": {"min": 0.3, "max": 0.4}}
    assert miss_score(m, target) > 0.0
```

- [ ] **Step 5: Full backend suite + commit**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS (the derive_target signature change is backward-compatible — new params default to None).

```bash
git add studio/backend
git commit -m "feat(math): derive_target compiles hit-frequency/max-win bands + pay constraints"
```

---

### Task 7: target_flow extraction — one store-wired derivation for all four call sites

**Files:**

- Create: `studio/backend/app/math/target_flow.py`
- Modify: `studio/backend/app/math/hub.py` (`_derive_target`), `studio/backend/app/math/rest.py` (`get_tuner_target`), `studio/backend/app/agent_tools.py` (two `derive_target` call sites, ~lines 1329 and 1455)
- Modify: `studio/backend/tests/e2e/test_realize_parity.py` (`_TARGET`)
- Test: `studio/backend/tests/test_target_flow.py`

**Interfaces:**

- Produces: `async def derive_target_for(gdd_store, game_id: str, doc) -> dict` — fetches `math-model`, `bonus-features`, `paytable`, `symbols-reels` and calls `derive_num_bonuses` + `derive_target`. `doc` is a `SlotModelDoc` (uses `.model` and `.params`). Raises `TargetGap` exactly as before.
- Consumes: Task 6's `derive_target` signature.

- [ ] **Step 1: Write the failing test** — `studio/backend/tests/test_target_flow.py`:

```python
"""derive_target_for fetches all four GDD aspects and passes them through to
the pure compiler — proven by a pay constraint appearing in the output (it can
only get there via the paytable + symbols-reels docs)."""
import pytest

from app.math.models import default_params
from app.math.target_flow import derive_target_for


class _Doc:
    def __init__(self, data):
        self.data = data


class _GddStore:
    def __init__(self, docs: dict):
        self._docs = docs

    async def get_doc(self, game_id, aspect):
        data = self._docs.get(aspect)
        return _Doc(data) if data is not None else None


class _MathDoc:
    model = {"bonuses": []}
    params = default_params()


@pytest.mark.asyncio
async def test_derive_target_for_compiles_constraints_from_the_stores():
    store = _GddStore({
        "math-model": {"rtp": 0.96, "volatility": "medium", "hit_frequency": 0.3},
        "bonus-features": {},
        "paytable": {"pay_constraints": [{"symbol": "wild", "relation": "top-paying"}]},
        "symbols-reels": {"symbols": [{"slot": "wild", "name": "Rune", "model_id": 2}]},
    })
    target = await derive_target_for(store, "g1", _MathDoc())
    assert target["pay_constraints"] == [{"symbol": 2, "relation": "top-paying"}]
    assert "hit_frequency_band" in target


@pytest.mark.asyncio
async def test_derive_target_for_survives_missing_aspects():
    store = _GddStore({"math-model": {"rtp": 0.96, "volatility": "medium"}})
    target = await derive_target_for(store, "g1", _MathDoc())
    assert "pay_constraints" not in target
```

- [ ] **Step 2: Run to verify failure**

Run: `uv --directory studio/backend run pytest tests/test_target_flow.py -q`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `studio/backend/app/math/target_flow.py`:

```python
"""Store-wired target derivation (spec 2026-07-09 §5-§6). Pure compilation
lives in targets.py; this module fetches the GDD aspects every caller needs.
Extracted from four duplicated call sites (hub, rest, two agent tools)."""
from app.math.targets import derive_num_bonuses, derive_target


async def derive_target_for(gdd_store, game_id: str, doc) -> dict:
    """Compile the curation/tuning target dict for a game from its GDD intent
    plus the math doc's params. Raises TargetGap on missing/contradictory
    intent, exactly like derive_target."""
    model = doc.model or {}

    async def data(aspect: str) -> dict:
        d = await gdd_store.get_doc(game_id, aspect)
        return getattr(d, "data", {}) if d is not None else {}

    math_model = await data("math-model")
    num_bonuses = derive_num_bonuses(await data("bonus-features"), model)
    return derive_target(math_model, doc.params, num_bonuses,
                         paytable_data=await data("paytable"),
                         symbols_data=await data("symbols-reels"))
```

- [ ] **Step 4: Collapse the four call sites.**

`hub.py` — replace the body of `_derive_target` (keep the method; other hub code calls it):

```python
    async def _derive_target(self, game_id: str, doc) -> dict:
        return await derive_target_for(self._gdd, game_id, doc)
```

(import `from app.math.target_flow import derive_target_for`; drop the now-unused `derive_target`/`derive_num_bonuses` imports if nothing else in the file uses them).

`rest.py` `get_tuner_target` — replace the fetch + derive block:

```python
    doc = await request.app.state.math_store.get_or_seed(game_id)
    try:
        return {"target": await derive_target_for(
            request.app.state.gdd_store, game_id, doc)}
    except TargetGap as gap:
        return {"gap": gap.message}
```

`agent_tools.py` `read_tuner_setup` (~line 1329): keep the existing `derive_num_bonuses` call (its result feeds the summary text), replace only the `derive_target(...)` call with `target = await derive_target_for(ctx.gdd_store, ctx.game_id, sim_doc)`. The gap pre-check site (~line 1455): replace both lines with `await derive_target_for(ctx.gdd_store, ctx.game_id, sim_doc)  # gap pre-check`.

- [ ] **Step 5: Extend the kernel parity oracle** — in `studio/backend/tests/e2e/test_realize_parity.py` add the new keys to `_TARGET` so the REAL binary proves it parses the full contract (symbol id 0 exists in any realized roster):

```python
    "hit_frequency_band": {"min": 0.0, "max": 1.0},
    "max_win_band": {"min": 0.0, "max": 1e12},
    "pay_constraints": [{"symbol": 0, "relation": "floor", "value": 0}],
```

- [ ] **Step 6: Run**

Run: `uv --directory studio/backend run pytest -q` (unit suite) and, with the cargo toolchain available, `uv --directory studio/backend run pytest tests/e2e/test_realize_parity.py -q -m e2e`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add studio/backend
git commit -m "refactor(math): extract derive_target_for; wire constraint compile into all call sites"
```

---

### Task 8: Design-router pay-relation branch

**Files:**

- Modify: `studio/backend/app/gdd/router.py` (`_BODY_TEMPLATE`, branch 1)
- Test: `studio/backend/tests/test_design_router.py` (append)

- [ ] **Step 1: Write the failing test:**

```python
def test_branch1_routes_pay_relations_to_pay_constraints():
    low = build_design_router_spec().body.lower()
    assert "pay_constraints" in low
    assert "top-paying" in low
```

- [ ] **Step 2: Run to verify failure**

Run: `uv --directory studio/backend run pytest tests/test_design_router.py -q`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `_BODY_TEMPLATE` branch 1, directly after the sentence ending "…the studio will ask the human to approve first.", add:

```
   A pay-RELATION intent — which symbol should pay the most, or a minimum or
   maximum pay for a symbol (e.g. "the wild should pay the most", "the dragon
   pays at least 500x") — is a `paytable.pay_constraints` edit: call
   `set_gdd_fields` on "paytable" with the FULL pay_constraints row list
   (symbol = that symbol's slot or name from the symbols table; relation one of
   top-paying / floor / ceiling; value in x-bet for floor/ceiling; count only
   when the user names an N-of-a-kind). Exact payout NUMBERS are realized by
   the math tuner — never invent a payouts table.
```

- [ ] **Step 4: Run + commit**

Run: `uv --directory studio/backend run pytest tests/test_design_router.py tests/test_gdd_router.py -q`
Expected: PASS.

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_design_router.py
git commit -m "feat(gdd): design-router routes pay-relation intents to pay_constraints"
```

---

### Task 9: Math pane surfaces the new gate + weight

**Files:**

- Modify: `studio/frontend/src/plugins/math/state.ts`, `studio/frontend/src/plugins/math/reducers.ts`, `studio/frontend/src/plugins/math/components/paramFields.ts`, `studio/frontend/src/plugins/math/tabs/ReportTab.tsx`
- Test: `studio/frontend/src/plugins/math/reducers.spec.ts`, `studio/frontend/src/plugins/math/components/paramFields.spec.ts` (append)

**Interfaces:**

- Consumes: the wire now carries `weights.hitFrequency` (always, via the pydantic default) and the target dict may carry `hit_frequency_band` / `max_win_band` / `pay_constraints` (snake_case — `derive_target` output is not camel-aliased).
- Note: `missed` BandMiss rows (incl. the new `max_win` / `top_paying[...]` metrics) already render generically — no work needed there.

- [ ] **Step 1: Write the failing tests.** In `reducers.spec.ts` (mirror the existing `worstMiss` tests' fixture style):

```ts
it('worstMiss reports an out-of-band hit frequency when the target carries the band', () => {
  const target: ITargetSpec = {
    rtp_target: 0.96,
    rtp_tolerance: 0.1,
    volatility_min: 0,
    volatility_max: 1e9,
    bonus_hit_rate_bands: [],
    hit_frequency_band: { min: 0.3, max: 0.4 },
  };
  const metrics = { rtp: 0.96, volatility: 3, hitFrequency: 0.2, baseRtp: 0.96, featureRtp: 0, bonusHitRates: [] } as IMetrics;
  expect(worstMiss(metrics, target)).toEqual({ metric: 'hit_frequency', distance: expect.closeTo(0.1, 6), side: 'below' });
});
```

In `paramFields.spec.ts`, extend the fixture weights with `hitFrequency: 1` and assert the new field exists (mirror how `weight-hit-rate` is asserted):

```ts
it('exposes the hit-frequency weight', () => {
  const f = PARAM_FIELDS.find((x) => x.key === 'weight-hit-frequency')!;
  expect(f.group).toBe('weights');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx nx test frontend -- --run reducers` (and the paramFields spec)
Expected: FAIL (type error / missing field).

- [ ] **Step 3: Implement.**

`state.ts`:

```ts
export interface ITuneWeights {
  rtp: number;
  volatility: number;
  hitRate: number;
  /** Base-game hit-frequency weight (constraint seam); absent on pre-Plan-2 payloads. */
  hitFrequency?: number;
}
```

```ts
export interface IMetricSE {
  rtp: number;
  volatility: number;
  hitFrequency?: number | null;
  bonusHitRates: number[];
}
```

```ts
/** Snake_case on the wire — `derive_target` returns a plain dict (no camel aliasing). */
export interface ITargetSpec {
  rtp_target: number;
  rtp_tolerance: number;
  volatility_min: number;
  volatility_max: number;
  bonus_hit_rate_bands: { min: number; max: number }[];
  hit_frequency_band?: { min: number; max: number } | null;
  max_win_band?: { min: number; max: number } | null;
  pay_constraints?: { symbol: number; relation: string; count?: number | null; value?: number }[];
}
```

`reducers.ts` `worstMiss` gates array gains:

```ts
    ...(target.hit_frequency_band
      ? [{ metric: 'hit_frequency', measured: metrics.hitFrequency, lo: target.hit_frequency_band.min, hi: target.hit_frequency_band.max }]
      : []),
```

`paramFields.ts` — insert after the `weight-hit-rate` entry:

```ts
  {
    key: 'weight-hit-frequency',
    label: 'Hit frequency',
    group: 'weights',
    tooltip: {
      title: 'Hit-frequency weight',
      body: 'Relative importance of base-game hit-frequency error in the fitness score.',
      effect: 'Higher = the GA prioritizes matching hit frequency.',
    },
    min: 0,
    step: 0.1,
    integer: false,
    defaultValue: 1.0,
    get: (s) => s.tunerParams.ornull?.weights.hitFrequency?.get() ?? 1.0,
    set: (s, v) => s.tunerParams.ornull?.weights.merge({ hitFrequency: v }),
  },
```

(If `get`'s optional chain trips the hookstate proxy on payloads missing the key, fall back to reading via `.get({ noproxy: true })` on `weights` — the established hookstate-noproxy pattern from the analytics work.)

`ReportTab.tsx` — after the `config-weight-hit-rate` row:

```ts
  { testId: 'config-weight-hit-frequency', label: 'Weight · Hit frequency', value: (p) => `${p.weights.hitFrequency ?? 1}` },
```

- [ ] **Step 4: Run all four frontend gates**

Run: `node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
Expected: all green (fix any fixture that now needs `hitFrequency` — the field is optional, so most won't).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend
git commit -m "feat(math-pane): surface hit-frequency gate + weight"
```

---

### Task 10: Playwright e2e — the constraint flow

**Files:**

- Create: `studio/frontend/e2e/pay-constraints.spec.ts`
- Create: `studio/backend/tests/fixtures/replay/run/pay-constraint-set.json`

**Interfaces:**

- Consumes: the merged tuner-chat plumbing. Cassette ground rules (hard-won, from the tuner-chat work): prompt keys are the BARE PROSE (lower/whitespace-normalized; any `/skill ` prefix stripped); plain game-room chat routes to the design-router (binds `set_gdd_fields` — right for the constraint turn); `/tune-math` binds the tuner tools (reuse the EXISTING `tuner-chat-tune.json` cassette, key `"tune the slot math"`); tool RESULTS never render in the chat feed (assert names + streamed finals only); verify verdicts in the Math pane (`result-verdict`), not the feed.
- Before writing the cassette, check an existing `set_gdd_fields` cassette for the exact arg names: `grep -l set_gdd_fields studio/backend/tests/fixtures/replay/run/*.json` — mirror its `args` shape exactly.

- [ ] **Step 1: Write the cassette** — `studio/backend/tests/fixtures/replay/run/pay-constraint-set.json`:

```json
{
  "prompt": "the gold coin should pay the most",
  "tool_calls": [
    {
      "name": "set_gdd_fields",
      "args": {
        "aspect": "paytable",
        "fields": {
          "pay_constraints": [{ "symbol": "sym2", "relation": "top-paying" }]
        }
      }
    }
  ],
  "final": ["Set Paytable → pay constraints: sym2 is top-paying."]
}
```

- [ ] **Step 2: Write the spec** — `studio/frontend/e2e/pay-constraints.spec.ts`, mirroring `tuner-chat.spec.ts`'s helpers (same DETUNED model + FAST params; copy its `setupGame`/`composerSend` and adjust):

```ts
// Constraint-flow e2e (spec 2026-07-09 §6, Plan 2): chat sets a pay-relation
// constraint → derive_target compiles it through the model_id join key → the
// GA repairs every candidate to honor it → tuned paytable proves it.
//
// Cassettes (studio/backend/tests/fixtures/replay/run/):
//   pay-constraint-set.json — key "the gold coin should pay the most" (plain chat → design-router)
//   tuner-chat-tune.json    — key "tune the slot math" (existing; /tune-math)
//
// Seeding ORDER matters: PUT slot-model FIRST (marks the doc touched), THEN the
// GDD aspects — a GDD shape write against an untouched template doc would
// silently re-realize and overwrite the seeded DETUNED model. On a touched doc
// it only sets shape_stale (a pill; harmless here).

import { test, expect } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

const DETUNED = {
  /* copy verbatim from tuner-chat.spec.ts */
};
const FAST_SIM_PARAMS = {
  /* copy verbatim */
};
const FAST_TUNER_PARAMS = {
  /* copy verbatim */
};

test('pay constraint: chat → GDD → tune honors top-paying', async ({ page, request }) => {
  test.setTimeout(300_000);

  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: `PayCon ${Date.now()}` } });
  const room = (await resp.json()) as { id: string; gameId: string };

  // 1. Slot model first (touched=true), then GDD intent + the join-keyed roster.
  await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
    data: { model: DETUNED, params: FAST_SIM_PARAMS },
  });
  await request.put(`${BACKEND}/games/${room.gameId}/tuner`, { data: { params: FAST_TUNER_PARAMS } });
  await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, {
    data: { fields: { rtp: '90%', volatility: 'low' } },
  });
  await request.put(`${BACKEND}/games/${room.gameId}/gdd/symbols-reels`, {
    data: {
      fields: {
        symbols: [
          { slot: 'sym1', name: 'Anchor', kind: 'low', model_id: 1 },
          { slot: 'sym2', name: 'Gold Coin', kind: 'high', model_id: 2 },
        ],
      },
    },
  });

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'alice' } }));
  await page.goto('/');
  await page
    .getByTestId('room-picker')
    .getByText(/PayCon/, { exact: false })
    .click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();

  // 2. Plain chat → design-router → set_gdd_fields on paytable.pay_constraints.
  const composer = page.getByTestId('chat-composer');
  await composer.fill('the gold coin should pay the most');
  await composer.press('Enter');
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('set_gdd_fields', { timeout: 30_000 });
  await expect(feed).toContainText(/top-paying/i, { timeout: 30_000 });

  // Persisted end-state, not just dispatch:
  const gdd = await request.get(`${BACKEND}/games/${room.gameId}/gdd/paytable`);
  const doc = (await gdd.json()) as { data: { pay_constraints: { symbol: string; relation: string }[] } };
  expect(doc.data.pay_constraints).toEqual([{ symbol: 'sym2', relation: 'top-paying' }]);

  // 3. Tune (existing cassette; real GA — offline + deterministic).
  await composer.fill('/tune-math tune the slot math');
  await composer.press('Enter');
  await expect(feed).toContainText('tune_slot_model', { timeout: 30_000 });
  await expect(feed).toContainText(/verdict is above/i, { timeout: 120_000 });

  // 4. PASS in the Math pane; the tuned paytable honors the constraint.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('result-verdict')).toContainText('PASS', { timeout: 10_000 });

  const tuner = await request.get(`${BACKEND}/games/${room.gameId}/tuner`);
  const t = (await tuner.json()) as {
    result: { tunedModel: { paytable: { entries: { symbol: number; payout: number }[] } } };
  };
  const pay = (sym: number) => t.result.tunedModel.paytable.entries.find((e) => e.symbol === sym)!.payout;
  expect(pay(2)).toBeGreaterThanOrEqual(pay(1)); // sym2 top-paying (ties allowed by repair)
  expect(pay(2)).toBeGreaterThan(1); // and the tune actually moved off the all-1s seed
});
```

(Adjust the two REST response shapes — GDD doc and tuner wire — to what the endpoints actually return; check `tuner_view` in `models.py` and the GDD GET handler rather than trusting this sketch. If the paytable GDD PUT is rejected because `pay_constraints` rows fail normalization, consult `app/gdd/normalize.py` for the table row contract.)

- [ ] **Step 3: Run the spec against a replay backend on THIS worktree's ports**

```bash
export BLOOM_PORT_OFFSET=<this worktree's offset>   # NEVER 0/defaults
just backend-serve-replay &   # or start in a second terminal
just e2e -- pay-constraints.spec.ts
```

Expected: `1 passed`. Iterate on cassette key normalization first if the agent turn stalls (the classic failure is a prompt-key mismatch).

- [ ] **Step 4: Run the full e2e suite** (pre-PR requirement)

Run: `just e2e`
Expected: green (or only the documented pre-existing offset-port reds — investigate anything new).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/pay-constraints.spec.ts studio/backend/tests/fixtures/replay/run/pay-constraint-set.json
git commit -m "test(e2e): pay-constraint chat -> GDD -> constrained tune flow"
```

---

### Task 11: Whole-branch verification + PR

- [ ] **Step 1: Full gates, all layers**

```bash
cargo fmt --check && cargo clippy --workspace && cargo test --workspace
uv --directory studio/backend run pytest -q
cd studio/frontend && node ../../node_modules/.bin/prettier --check . && cd ../..
npx nx typecheck frontend && npx nx test frontend && npx nx build frontend
just e2e   # replay backend on this worktree's offset ports
```

Expected: everything green. (Known pre-existing: 3 port-hardcoded game-plugin tests fail under `nx run-many -t test` in offset≠0 worktrees — not this branch's problem; verify they're the same 3.)

- [ ] **Step 2: Spec-coverage sweep** — re-read spec §5–§6 and confirm: `derive_target` emits the two new bands + compiled constraints ✓ (Tasks 6–7); repair-not-rejection enforcement ✓ (Task 5); verify asserts statics on Verify-only runs ✓ (Task 3); shared `TargetJson` extraction ✓ (Task 1); up-front validation ✓ (Tasks 2, 3, 5); router branch ✓ (Task 8); e2e constraint flow ✓ (Task 10). Deferred per spec §11 (do NOT build): feature-level bands, payline geometry constraints, bet_range, prose constraints beyond the typed table. Also deferred, file as `todo` issues: `set_tuner_params` agent tool doesn't yet accept the hit-frequency weight; Math pane doesn't render `pay_constraints`/`max_win` as target chips (misses still surface via the generic BandMiss list).

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/gdd-constraint-seam
gh pr create --title "feat(math): GDD constraint seam — hit-frequency/max-win bands + pay constraints (Plan 2)" --body "..."
```

Then run `/bloom:complete-work` after review/CI.
