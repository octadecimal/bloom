# Math Tuner (layer-3, genetic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `studio/tuner` (`bloom-tuner`) — a genetic algorithm behind a swappable `Tuner` seam that mutates a `SlotModel`'s reels + paytable + bonus config until its measured RTP / volatility / per-feature hit-rates satisfy a `TargetSpec`, emitting an interpretable tuned model + an audit trace.

**Architecture:** A new headless Rust crate depending on `bloom-math` (certified kernel, read-only) and `bloom-simulator` (the fitness function: `simulate` / `measure` / `verify`). A custom, deterministic GA (reusing the kernel's `SplitMix64` PRNG) evolves a bounded-integer genome that always decodes — via a deterministic repair operator — to a valid `SlotModel`. Candidates are scored at low fidelity during search with common random numbers, then the winner is re-measured at full fidelity and run through the real `verify` before any PASS is reported. The tuner stops at a verified model; the existing `sim-curate` still does freeze + sign.

**Tech Stack:** Rust 2021, Cargo workspace; `bloom-math`, `bloom-simulator`; `serde` + `serde_json` (CLI I/O). No new third-party dependency (the GA is custom; "proven libraries behind thin seams" is satisfied by the `Tuner` trait, and `genevo` was set aside because its RNG/operator model fights our repair + common-random-numbers + `SplitMix64` determinism requirements).

**Reads first:** `docs/superpowers/specs/2026-06-24-math-tuner-design.md` (the spec this plan implements).

## Global Constraints

- **Integer-only outcome path.** The genome's tunable values are integers (`u64` payouts, `u32` reel counts / spins, `u64` multiplier, `u8` `min_count`). Floats appear only in studio-side measurement (`Metrics`, fitness), never in a `SlotModel`. (math-spec; `trusted/AGENTS.md`)
- **The tuner mutates model parameters, NEVER seed selection.** The genome decodes to a `SlotModel`; fitness is a function of `measure(simulate(model, seeds))`. There is no code path that selects/optimizes seeds. (spec §2.1)
- **`fitness == 0.0` ⟺ `verify(metrics, target)` is `Ok`.** The GA's optimum and the simulator's PASS criterion are identical by construction. (spec §4)
- **Determinism.** All GA randomness derives from `cfg.master_seed` via `bloom_math::rng::SplitMix64`. Same `seed_model + target + cfg` → identical `TuneOutcome`. (spec §6)
- **Game identity is fixed.** Symbol ids/roles, reel count, `rows`, `paylines`, and which `(symbol, count)` paytable rows exist are NOT genes — only their values move. (spec §3)
- **TDD, frequent commits.** Failing test first; `cargo test --workspace` is green before each commit. Conventional Commits. (`AGENTS.md`)
- **Branch:** all work on `feat/tuner` in the worktree `C:\code\bloom.wt\tuner`. Land via squash PR.

---

### Task 1: Crate scaffold + the `Tuner` seam and its types

Creates the crate, wires it into the workspace, and defines the public seam (`Tuner` trait) and every shared type later tasks consume. No algorithm yet — this task locks the interfaces.

**Files:**

- Create: `studio/tuner/Cargo.toml`
- Create: `studio/tuner/src/lib.rs`
- Create: `studio/tuner/src/config.rs`
- Create: `studio/tuner/src/outcome.rs`
- Modify: `Cargo.toml` (workspace `members`)

**Interfaces:**

- Consumes: `bloom_math::mechanics::slots::SlotModel`; `bloom_simulator::target::{Metrics, TargetSpec}`.
- Produces (every later task relies on these exact names/types):
  - `trait Tuner { fn tune(&self, seed_model: &SlotModel, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome; }`
  - `struct TunerConfig`, `struct GeneBounds`, `struct Weights` (fields below).
  - `struct TuneOutcome { model: SlotModel, metrics: Metrics, verdict: Verdict, trace: TuningTrace }`
  - `enum Verdict { Pass, NearMiss { missed: Vec<BandMiss> } }`
  - `struct BandMiss { metric: String, measured: f64, band_lo: f64, band_hi: f64 }`
  - `struct GenSnapshot { generation: usize, best_fitness: f64, best_rtp: f64, best_volatility: f64, best_bonus_hit_rates: Vec<f64> }`
  - `struct TuningTrace { master_seed: u64, generations_run: usize, snapshots: Vec<GenSnapshot>, population: usize, search_candidate_count: usize, final_candidate_count: usize }`

- [ ] **Step 1: Create the crate manifest**

`studio/tuner/Cargo.toml`:

```toml
[package]
name = "bloom-tuner"
version = "0.0.0"
edition = "2021"

[dependencies]
bloom-math = { path = "../../trusted/math" }
bloom-simulator = { path = "../simulator" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Add the crate to the workspace**

In the root `Cargo.toml`, extend `members` (currently `["trusted/math", "trusted/package", "studio/simulator"]`):

```toml
[workspace]
resolver = "2"
members = ["trusted/math", "trusted/package", "studio/simulator", "studio/tuner"]
```

- [ ] **Step 3: Define the config types**

`studio/tuner/src/config.rs`:

```rust
//! Tuner search configuration: gene bounds, GA hyperparameters, objective
//! weights, fidelity, and the master seed that makes a run reproducible.

/// Inclusive bounds for the scalar genes. Reel counts are bounded
/// `[0, strip_len]` (strip_len is fixed per reel from the seed model), so they
/// are not listed here.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneBounds {
    pub payout_min: u64,
    pub payout_max: u64,
    pub spins_min: u32,
    pub spins_max: u32,
    pub multiplier_min: u64,
    pub multiplier_max: u64,
    pub min_count_min: u8,
    pub min_count_max: u8,
}

/// Per-metric weights for the distance-to-band objective.
#[derive(Debug, Clone, PartialEq)]
pub struct Weights {
    pub rtp: f64,
    pub volatility: f64,
    pub hit_rate: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TunerConfig {
    pub master_seed: u64,
    pub population: usize,
    pub max_generations: usize,
    pub elitism: usize,
    /// Per-gene mutation probability in [0, 1].
    pub mutation_rate: f64,
    /// Probability that a child is a crossover (else a clone of parent 1).
    pub crossover_rate: f64,
    /// Stop if the global best fitness does not improve for this many gens.
    pub stagnation_window: usize,
    /// Rounds simulated per candidate DURING the search (cheap).
    pub search_candidate_count: usize,
    /// Rounds simulated to re-measure the winner (full fidelity).
    pub final_candidate_count: usize,
    pub bounds: GeneBounds,
    pub weights: Weights,
}
```

- [ ] **Step 4: Define the outcome types**

`studio/tuner/src/outcome.rs`:

```rust
//! What a tuning run returns: the tuned model, its full-fidelity metrics, a
//! PASS/near-miss verdict, and the search trace (for the audit report).

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::Metrics;

#[derive(Debug, Clone, PartialEq)]
pub struct BandMiss {
    /// "rtp" | "volatility" | "bonus_hit_rate[i]".
    pub metric: String,
    pub measured: f64,
    pub band_lo: f64,
    pub band_hi: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Pass,
    NearMiss { missed: Vec<BandMiss> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct GenSnapshot {
    pub generation: usize,
    pub best_fitness: f64,
    pub best_rtp: f64,
    pub best_volatility: f64,
    pub best_bonus_hit_rates: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TuningTrace {
    pub master_seed: u64,
    pub generations_run: usize,
    pub snapshots: Vec<GenSnapshot>,
    pub population: usize,
    pub search_candidate_count: usize,
    pub final_candidate_count: usize,
}

#[derive(Debug, Clone)]
pub struct TuneOutcome {
    pub model: SlotModel,
    pub metrics: Metrics,
    pub verdict: Verdict,
    pub trace: TuningTrace,
}
```

- [ ] **Step 5: Define the seam in lib.rs**

`studio/tuner/src/lib.rs`:

```rust
//! Bloom layer-3 math tuner: a genetic algorithm behind a swappable `Tuner`
//! seam that adjusts a `SlotModel`'s parameters until it satisfies a
//! `TargetSpec`. AI-designed, never AI-decided — the output is an interpretable
//! model a human reviews and signs. See the design spec.

pub mod config;
pub mod outcome;

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::TargetSpec;
use config::TunerConfig;
use outcome::TuneOutcome;

/// The layer-3 seam (math-spec §8). One implementor this slice: `GeneticTuner`.
/// A future hill-climb / CMA-ES / AI-designer is a new `impl Tuner` with no
/// change to callers.
pub trait Tuner {
    fn tune(
        &self,
        seed_model: &SlotModel,
        target: &TargetSpec,
        cfg: &TunerConfig,
    ) -> TuneOutcome;
}
```

- [ ] **Step 6: Verify the crate compiles**

Run: `cargo build -p bloom-tuner`
Expected: PASS (compiles; unused-import warnings are acceptable at this stage).

- [ ] **Step 7: Commit**

```bash
git add studio/tuner/Cargo.toml studio/tuner/src/lib.rs studio/tuner/src/config.rs studio/tuner/src/outcome.rs Cargo.toml
git commit -m "feat(tuner): scaffold bloom-tuner crate + Tuner seam and types"
```

---

### Task 2: The genome — encode / decode / repair

The bounded-integer genome and its lossless mapping to/from a `SlotModel`. `decode` overlays genes onto the seed model (the template) for everything fixed; `repair` guarantees every genome decodes to a valid model.

**Files:**

- Create: `studio/tuner/src/genome.rs`
- Modify: `studio/tuner/src/lib.rs` (add `pub mod genome;`)

**Interfaces:**

- Consumes: `SlotModel`, `BonusFeature`, `TriggerSpec`, `FreeSpinsConfig`, `PaytableEntry` from `bloom_math::mechanics::slots`; `GeneBounds` from `config`.
- Produces:
  - `struct Genome { reel_counts: Vec<Vec<u32>>, payouts: Vec<u64>, bonuses: Vec<BonusGenes> }`
  - `struct BonusGenes { spins_awarded: u32, multiplier: u64, min_count: u8 }`
  - `fn encode(model: &SlotModel) -> Genome`
  - `fn decode(genome: &Genome, template: &SlotModel) -> SlotModel`
  - `fn repair(genome: &mut Genome, template: &SlotModel, bounds: &GeneBounds)`

- [ ] **Step 1: Write the failing round-trip + repair tests**

`studio/tuner/src/genome.rs` (test module first; the types it references are written in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{
        BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, SymbolDef,
        SymbolRole, TriggerSpec,
    };

    fn model() -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Normal },
                SymbolDef { id: 9, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![0, 0, 1, 9, 0], vec![0, 1, 1, 9, 0]],
            rows: 1,
            paylines: vec![vec![0, 0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 0, count: 2, payout: 3 },
                    PaytableEntry { symbol: 1, count: 2, payout: 5 },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec { symbol: 9, min_count: 2 },
                config: FreeSpinsConfig {
                    spins_awarded: 5, retrigger: true, multiplier: 2, feature_reels: None,
                },
            }],
        }
    }

    fn bounds() -> GeneBounds {
        GeneBounds {
            payout_min: 0, payout_max: 100,
            spins_min: 1, spins_max: 50,
            multiplier_min: 1, multiplier_max: 10,
            min_count_min: 1, min_count_max: 5,
        }
    }

    #[test]
    fn genome_round_trips_through_model() {
        // encode -> decode -> encode is identity on the genome.
        let m = model();
        let g = encode(&m);
        let back = encode(&decode(&g, &m));
        assert_eq!(g, back);
    }

    #[test]
    fn decode_preserves_fixed_fields() {
        let m = model();
        let g = encode(&m);
        let d = decode(&g, &m);
        assert_eq!(d.symbols, m.symbols);
        assert_eq!(d.rows, m.rows);
        assert_eq!(d.paylines, m.paylines);
        // each reel keeps its length (composition only is tuned)
        assert_eq!(
            d.reels.iter().map(|r| r.len()).collect::<Vec<_>>(),
            m.reels.iter().map(|r| r.len()).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn decode_preserves_reel_composition() {
        // round-robin layout keeps the multiset of symbols per reel.
        let m = model();
        let d = decode(&encode(&m), &m);
        for (orig, got) in m.reels.iter().zip(&d.reels) {
            let mut a = orig.clone(); a.sort();
            let mut b = got.clone(); b.sort();
            assert_eq!(a, b);
        }
    }

    #[test]
    fn repair_forces_valid_genome() {
        let m = model();
        let mut g = encode(&m);
        // corrupt: counts that do not sum to strip length, out-of-range scalars.
        g.reel_counts[0] = vec![999, 999, 999];
        g.payouts[0] = u64::MAX;
        g.bonuses[0].min_count = 250;
        g.bonuses[0].spins_awarded = 0;
        repair(&mut g, &m, &bounds());
        // every reel's counts sum to its fixed strip length:
        for (reel, counts) in m.reels.iter().zip(&g.reel_counts) {
            assert_eq!(counts.iter().sum::<u32>() as usize, reel.len());
        }
        // scalars are back inside bounds:
        assert!(g.payouts[0] <= 100);
        assert!(g.bonuses[0].min_count >= 1 && g.bonuses[0].min_count <= 5);
        assert!(g.bonuses[0].spins_awarded >= 1);
        // and it still decodes to a structurally valid model:
        let d = decode(&g, &m);
        assert_eq!(d.reels[0].len(), m.reels[0].len());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bloom-tuner genome`
Expected: FAIL — `Genome`, `encode`, `decode`, `repair` not defined.

- [ ] **Step 3: Implement the genome**

Prepend to `studio/tuner/src/genome.rs` (above the test module):

```rust
//! The tunable genome and its lossless mapping to/from a `SlotModel`. Only the
//! tunable levers are genes (reel composition, paytable payouts, bonus config);
//! everything else comes from the seed model (the template) at decode time.

use crate::config::GeneBounds;
use bloom_math::mechanics::slots::{
    BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, Symbol, TriggerSpec,
};

#[derive(Debug, Clone, PartialEq)]
pub struct BonusGenes {
    pub spins_awarded: u32,
    pub multiplier: u64,
    pub min_count: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Genome {
    /// Per reel, the count of each distinct symbol id (in the reel's
    /// ascending-id order). Sums to the reel's fixed strip length.
    pub reel_counts: Vec<Vec<u32>>,
    /// Payout per paytable entry, in entry order.
    pub payouts: Vec<u64>,
    /// One entry per `FreeSpins` bonus, in order.
    pub bonuses: Vec<BonusGenes>,
}

/// The distinct symbol ids present on a reel, ascending. The canonical key for
/// that reel's count vector (encode + decode must agree on this order).
fn reel_symbols(reel: &[Symbol]) -> Vec<Symbol> {
    let mut s: Vec<Symbol> = reel.to_vec();
    s.sort_unstable();
    s.dedup();
    s
}

pub fn encode(model: &SlotModel) -> Genome {
    let reel_counts = model
        .reels
        .iter()
        .map(|reel| {
            reel_symbols(reel)
                .iter()
                .map(|&sym| reel.iter().filter(|&&c| c == sym).count() as u32)
                .collect()
        })
        .collect();

    let payouts = model.paytable.entries.iter().map(|e| e.payout).collect();

    let bonuses = model
        .bonuses
        .iter()
        .map(|b| match b {
            BonusFeature::FreeSpins { trigger, config } => BonusGenes {
                spins_awarded: config.spins_awarded,
                multiplier: config.multiplier,
                min_count: trigger.min_count,
            },
        })
        .collect();

    Genome { reel_counts, payouts, bonuses }
}

/// Lay out a reel's per-symbol counts in a deterministic round-robin order:
/// cycle through the symbols (ascending id) emitting one of each with remaining
/// count, until all are placed. Spreads symbols (faithful for rows > 1).
fn layout(symbols: &[Symbol], counts: &[u32]) -> Vec<Symbol> {
    let mut remaining: Vec<u32> = counts.to_vec();
    let total: u32 = remaining.iter().sum();
    let mut out = Vec::with_capacity(total as usize);
    while out.len() < total as usize {
        for (i, &sym) in symbols.iter().enumerate() {
            if remaining[i] > 0 {
                out.push(sym);
                remaining[i] -= 1;
            }
        }
    }
    out
}

pub fn decode(genome: &Genome, template: &SlotModel) -> SlotModel {
    let reels = template
        .reels
        .iter()
        .zip(&genome.reel_counts)
        .map(|(reel, counts)| layout(&reel_symbols(reel), counts))
        .collect();

    let entries = template
        .paytable
        .entries
        .iter()
        .zip(&genome.payouts)
        .map(|(e, &payout)| PaytableEntry { symbol: e.symbol, count: e.count, payout })
        .collect();

    let bonuses = template
        .bonuses
        .iter()
        .zip(&genome.bonuses)
        .map(|(b, g)| match b {
            BonusFeature::FreeSpins { trigger, config } => BonusFeature::FreeSpins {
                trigger: TriggerSpec { symbol: trigger.symbol, min_count: g.min_count },
                config: FreeSpinsConfig {
                    spins_awarded: g.spins_awarded,
                    retrigger: config.retrigger,
                    multiplier: g.multiplier,
                    feature_reels: config.feature_reels.clone(),
                },
            },
        })
        .collect();

    SlotModel {
        symbols: template.symbols.clone(),
        reels,
        rows: template.rows,
        paylines: template.paylines.clone(),
        paytable: Paytable { entries },
        bonuses,
    }
}

fn clamp_u64(v: u64, lo: u64, hi: u64) -> u64 { v.max(lo).min(hi) }
fn clamp_u32(v: u32, lo: u32, hi: u32) -> u32 { v.max(lo).min(hi) }
fn clamp_u8(v: u8, lo: u8, hi: u8) -> u8 { v.max(lo).min(hi) }

/// Force every gene back into the feasible set. Deterministic. After repair,
/// `decode` always yields a structurally valid `SlotModel`.
pub fn repair(genome: &mut Genome, template: &SlotModel, bounds: &GeneBounds) {
    // Reel counts: rescale (deterministically) so each reel sums to its fixed
    // strip length, keeping at least the original number of distinct symbols.
    for (reel, counts) in template.reels.iter().zip(&mut genome.reel_counts) {
        let target = reel.len() as u32;
        let sum: u32 = counts.iter().sum();
        if sum == 0 {
            // degenerate: distribute evenly, remainder to the first symbol.
            let n = counts.len() as u32;
            for (i, c) in counts.iter_mut().enumerate() {
                *c = target / n + if (i as u32) < target % n { 1 } else { 0 };
            }
        } else if sum != target {
            // scale to target, then fix the rounding drift on the last bucket.
            let mut acc = 0u32;
            let last = counts.len() - 1;
            for c in counts.iter_mut().take(last) {
                *c = ((*c as u64 * target as u64) / sum as u64) as u32;
                acc += *c;
            }
            counts[last] = target.saturating_sub(acc);
        }
    }

    for p in &mut genome.payouts {
        *p = clamp_u64(*p, bounds.payout_min, bounds.payout_max);
    }

    for b in &mut genome.bonuses {
        b.spins_awarded = clamp_u32(b.spins_awarded, bounds.spins_min, bounds.spins_max);
        b.multiplier = clamp_u64(b.multiplier, bounds.multiplier_min, bounds.multiplier_max);
        b.min_count = clamp_u8(b.min_count, bounds.min_count_min.max(1), bounds.min_count_max);
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-tuner genome`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the module**

Add to `studio/tuner/src/lib.rs` after `pub mod outcome;`:

```rust
pub mod genome;
```

- [ ] **Step 6: Commit**

```bash
git add studio/tuner/src/genome.rs studio/tuner/src/lib.rs
git commit -m "feat(tuner): bounded-integer genome with encode/decode/repair"
```

---

### Task 3: The objective — weighted distance-to-band fitness

A pure function over `Metrics` + `TargetSpec` bands. Its defining property: `fitness == 0.0` exactly when `verify` passes.

**Files:**

- Create: `studio/tuner/src/fitness.rs`
- Modify: `studio/tuner/src/lib.rs` (add `pub mod fitness;`)

**Interfaces:**

- Consumes: `Metrics`, `TargetSpec` from `bloom_simulator::target`; `Weights` from `config`.
- Produces:
  - `fn fitness(m: &Metrics, t: &TargetSpec, w: &Weights) -> f64` (≤ 0; 0 is best).
  - `fn band_misses(m: &Metrics, t: &TargetSpec) -> Vec<BandMiss>` (which bands the measured metrics miss; empty ⟺ all inside).

- [ ] **Step 1: Write the failing tests**

`studio/tuner/src/fitness.rs` (test module first):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Weights;
    use bloom_simulator::target::{HitRateBand, Metrics, TargetSpec};

    fn weights() -> Weights { Weights { rtp: 1.0, volatility: 1.0, hit_rate: 1.0 } }

    fn target(bands: Vec<HitRateBand>) -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 1.0,
            volatility_max: 10.0,
            bonus_hit_rate_bands: bands,
            pool_size: 100,
            candidate_count: 1000,
            realized_correction_band: 0.05,
        }
    }

    fn metrics(rtp: f64, vol: f64, bonus: Vec<f64>) -> Metrics {
        Metrics { rtp, volatility: vol, hit_frequency: 0.3, bonus_hit_rates: bonus, base_rtp: rtp, feature_rtp: 0.0 }
    }

    #[test]
    fn inside_all_bands_scores_zero() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert_eq!(fitness(&metrics(0.955, 3.0, vec![0.02]), &t, &weights()), 0.0);
    }

    #[test]
    fn zero_fitness_iff_verify_passes() {
        // fitness 0 must coincide with the simulator's own verify Ok.
        use bloom_simulator::run::verify;
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        let pass = metrics(0.955, 3.0, vec![0.02]);
        let fail = metrics(0.80, 3.0, vec![0.02]);
        assert_eq!(fitness(&pass, &t, &weights()) == 0.0, verify(&pass, &t).is_ok());
        assert_eq!(fitness(&fail, &t, &weights()) == 0.0, verify(&fail, &t).is_ok());
    }

    #[test]
    fn closer_to_band_scores_higher() {
        let t = target(vec![]);
        let near = fitness(&metrics(0.94, 3.0, vec![]), &t, &weights()); // 0.01 outside
        let far = fitness(&metrics(0.80, 3.0, vec![]), &t, &weights());  // 0.15 outside
        assert!(near > far); // both negative; nearer is larger (closer to 0)
    }

    #[test]
    fn band_misses_names_the_missed_metrics() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        let misses = band_misses(&metrics(0.80, 0.5, vec![0.20]), &t);
        let names: Vec<&str> = misses.iter().map(|m| m.metric.as_str()).collect();
        assert!(names.contains(&"rtp"));
        assert!(names.contains(&"volatility"));
        assert!(names.contains(&"bonus_hit_rate[0]"));
    }

    #[test]
    fn band_misses_empty_when_all_inside() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(band_misses(&metrics(0.955, 3.0, vec![0.02]), &t).is_empty());
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bloom-tuner fitness`
Expected: FAIL — `fitness`, `band_misses` not defined.

- [ ] **Step 3: Implement the objective**

Prepend to `studio/tuner/src/fitness.rs`:

```rust
//! The GA objective: a weighted sum of each metric's normalized distance
//! OUTSIDE its target band. Zero exactly when every metric is in-band — i.e.
//! exactly when `bloom_simulator::run::verify` would pass.

use crate::config::Weights;
use crate::outcome::BandMiss;
use bloom_simulator::target::{Metrics, TargetSpec};

/// Distance of `x` outside `[lo, hi]` (0 if inside).
fn outside(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo { lo - x } else if x > hi { x - hi } else { 0.0 }
}

/// `fitness <= 0`; `0.0` is the feasible optimum (all metrics in-band).
pub fn fitness(m: &Metrics, t: &TargetSpec, w: &Weights) -> f64 {
    let rtp_lo = t.rtp_target - t.rtp_tolerance;
    let rtp_hi = t.rtp_target + t.rtp_tolerance;
    let mut d = w.rtp * outside(m.rtp, rtp_lo, rtp_hi) / t.rtp_target.abs().max(1e-9);

    let vol_norm = (t.volatility_max - t.volatility_min).abs().max(1e-9);
    d += w.volatility * outside(m.volatility, t.volatility_min, t.volatility_max) / vol_norm;

    for (band, &rate) in t.bonus_hit_rate_bands.iter().zip(&m.bonus_hit_rates) {
        let width = (band.max - band.min).abs().max(1e-9);
        d += w.hit_rate * outside(rate, band.min, band.max) / width;
    }

    -d
}

/// The bands the measured metrics miss (empty ⟺ all in-band). Used to explain a
/// near-miss verdict in the report.
pub fn band_misses(m: &Metrics, t: &TargetSpec) -> Vec<BandMiss> {
    let mut out = Vec::new();
    let rtp_lo = t.rtp_target - t.rtp_tolerance;
    let rtp_hi = t.rtp_target + t.rtp_tolerance;
    if outside(m.rtp, rtp_lo, rtp_hi) > 0.0 {
        out.push(BandMiss { metric: "rtp".into(), measured: m.rtp, band_lo: rtp_lo, band_hi: rtp_hi });
    }
    if outside(m.volatility, t.volatility_min, t.volatility_max) > 0.0 {
        out.push(BandMiss {
            metric: "volatility".into(),
            measured: m.volatility,
            band_lo: t.volatility_min,
            band_hi: t.volatility_max,
        });
    }
    for (i, (band, &rate)) in t.bonus_hit_rate_bands.iter().zip(&m.bonus_hit_rates).enumerate() {
        if outside(rate, band.min, band.max) > 0.0 {
            out.push(BandMiss {
                metric: format!("bonus_hit_rate[{i}]"),
                measured: rate,
                band_lo: band.min,
                band_hi: band.max,
            });
        }
    }
    out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-tuner fitness`
Expected: PASS (5 tests).

- [ ] **Step 5: Register the module**

Add to `studio/tuner/src/lib.rs`:

```rust
pub mod fitness;
```

- [ ] **Step 6: Commit**

```bash
git add studio/tuner/src/fitness.rs studio/tuner/src/lib.rs
git commit -m "feat(tuner): weighted distance-to-band fitness (0 iff verify passes)"
```

---

### Task 4: `GeneticTuner` — the evolve loop (two-tier eval, common random numbers)

The custom deterministic GA: initialize from the seed model, evolve at low fidelity with common random numbers, then re-measure the winner at full fidelity and run the real `verify`.

**Files:**

- Create: `studio/tuner/src/genetic.rs`
- Modify: `studio/tuner/src/lib.rs` (add `pub mod genetic;` and re-export `GeneticTuner`)

**Interfaces:**

- Consumes: `Tuner` (lib), `TunerConfig`/`GeneBounds` (config), `TuneOutcome`/`Verdict`/`GenSnapshot`/`TuningTrace` (outcome), `Genome`/`encode`/`decode`/`repair` (genome), `fitness`/`band_misses` (fitness); `bloom_simulator::measure::{simulate, measure}`, `bloom_simulator::run::verify`, `bloom_simulator::seedgen::generate_seeds`; `bloom_math::rng::SplitMix64`.
- Produces: `struct GeneticTuner;` implementing `Tuner`.

- [ ] **Step 1: Write the failing behavior tests**

`studio/tuner/src/genetic.rs` (test module first):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GeneBounds, TunerConfig, Weights};
    use crate::outcome::Verdict;
    use crate::Tuner;
    use bloom_math::mechanics::slots::{Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole};
    use bloom_simulator::target::TargetSpec;

    // 1 reel, 1 row, 1 line. strip = 5x sym0, 4x sym1, 1x sym2 (10 cells).
    // paytable: sym1@1 -> 1, sym2@1 -> 5. Closed-form base RTP = 0.9.
    fn toy(payout_sym2: u64) -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Normal },
                SymbolDef { id: 2, role: SymbolRole::Normal },
            ],
            reels: vec![vec![0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 1, count: 1, payout: 1 },
                    PaytableEntry { symbol: 2, count: 1, payout: payout_sym2 },
                ],
            },
            bonuses: vec![],
        }
    }

    fn target_09() -> TargetSpec {
        TargetSpec {
            rtp_target: 0.9,
            rtp_tolerance: 0.02,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 0,
            candidate_count: 0,
            realized_correction_band: 0.05,
        }
    }

    fn cfg(master_seed: u64) -> TunerConfig {
        TunerConfig {
            master_seed,
            population: 24,
            max_generations: 40,
            elitism: 2,
            mutation_rate: 0.25,
            crossover_rate: 0.9,
            stagnation_window: 12,
            search_candidate_count: 20_000,
            final_candidate_count: 200_000,
            bounds: GeneBounds {
                payout_min: 0, payout_max: 20,
                spins_min: 1, spins_max: 50,
                multiplier_min: 1, multiplier_max: 10,
                min_count_min: 1, min_count_max: 5,
            },
            weights: Weights { rtp: 1.0, volatility: 1.0, hit_rate: 1.0 },
        }
    }

    #[test]
    fn reproducible_same_seed_same_outcome() {
        let seed = toy(1); // detuned: sym2 pays 1 -> RTP ~0.5
        let a = GeneticTuner.tune(&seed, &target_09(), &cfg(2026));
        let b = GeneticTuner.tune(&seed, &target_09(), &cfg(2026));
        assert_eq!(a.model, b.model);
        assert_eq!(a.metrics.rtp, b.metrics.rtp);
        assert_eq!(a.trace.generations_run, b.trace.generations_run);
    }

    #[test]
    fn converges_a_detuned_model_back_into_band() {
        // start far from target (sym2 pays 1 -> RTP ~0.5); tuner must reach 0.9 ± 0.02.
        let out = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
        assert!(matches!(out.verdict, Verdict::Pass), "verdict was {:?}", out.verdict);
        assert!((out.metrics.rtp - 0.9).abs() <= 0.02, "rtp = {}", out.metrics.rtp);
    }

    #[test]
    fn unreachable_target_reports_near_miss_not_pass() {
        // payout_max is 20, but an RTP of 50.0 is unreachable -> NearMiss, never Pass.
        let mut t = target_09();
        t.rtp_target = 50.0;
        t.rtp_tolerance = 0.1;
        let out = GeneticTuner.tune(&toy(1), &t, &cfg(3));
        match out.verdict {
            Verdict::NearMiss { missed } => assert!(missed.iter().any(|m| m.metric == "rtp")),
            Verdict::Pass => panic!("must not report PASS for an unreachable target"),
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bloom-tuner genetic`
Expected: FAIL — `GeneticTuner` not defined.

- [ ] **Step 3: Implement the GA**

Prepend to `studio/tuner/src/genetic.rs`:

```rust
//! `GeneticTuner`: a deterministic custom GA. Initialize from the seed model,
//! evolve at low fidelity with common random numbers (all candidates in a
//! generation share one seed set), stop on feasibility / stagnation / budget,
//! then re-measure the best at full fidelity and run the real `verify`.

use crate::config::TunerConfig;
use crate::fitness::{band_misses, fitness};
use crate::genome::{decode, encode, repair, Genome};
use crate::outcome::{GenSnapshot, TuneOutcome, TuningTrace, Verdict};
use crate::Tuner;
use bloom_math::mechanics::slots::SlotModel;
use bloom_math::rng::SplitMix64;
use bloom_simulator::measure::{measure, simulate};
use bloom_simulator::run::verify;
use bloom_simulator::seedgen::generate_seeds;
use bloom_simulator::target::TargetSpec;

const FINAL_SALT: u64 = 0xF1A1_5EED_C0DE_0001;

pub struct GeneticTuner;

/// A uniform f64 in [0, 1) from one u64 draw.
fn unit(rng: &mut SplitMix64) -> f64 {
    (rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

/// Deterministic per-generation seed set (common random numbers).
fn generation_seeds(master_seed: u64, generation: usize, count: usize) -> Vec<u64> {
    let mixed = SplitMix64::new(master_seed ^ (generation as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
        .next_u64();
    generate_seeds(mixed, count)
}

/// Mutate a genome in place, then repair. Each gene mutates with probability
/// `cfg.mutation_rate`; numeric genes step within their bounds.
fn mutate(g: &mut Genome, template: &SlotModel, cfg: &TunerConfig, rng: &mut SplitMix64) {
    let b = &cfg.bounds;
    for counts in &mut g.reel_counts {
        // move one unit between two buckets (preserves sum; repair re-normalizes).
        if counts.len() >= 2 && unit(rng) < cfg.mutation_rate {
            let from = (rng.next_u64() as usize) % counts.len();
            let to = (rng.next_u64() as usize) % counts.len();
            if from != to && counts[from] > 0 {
                counts[from] -= 1;
                counts[to] += 1;
            }
        }
    }
    for p in &mut g.payouts {
        if unit(rng) < cfg.mutation_rate {
            *p = b.payout_min + (rng.next_u64() % (b.payout_max - b.payout_min + 1));
        }
    }
    for bonus in &mut g.bonuses {
        if unit(rng) < cfg.mutation_rate {
            bonus.spins_awarded = b.spins_min + (rng.next_u64() as u32 % (b.spins_max - b.spins_min + 1));
        }
        if unit(rng) < cfg.mutation_rate {
            bonus.multiplier = b.multiplier_min + (rng.next_u64() % (b.multiplier_max - b.multiplier_min + 1));
        }
        if unit(rng) < cfg.mutation_rate {
            bonus.min_count = b.min_count_min.max(1)
                + (rng.next_u64() as u8 % (b.min_count_max - b.min_count_min.max(1) + 1));
        }
    }
    repair(g, template, &cfg.bounds);
}

/// Uniform crossover of two parents (gene-wise coin flip), then repair.
fn crossover(p1: &Genome, p2: &Genome, template: &SlotModel, cfg: &TunerConfig, rng: &mut SplitMix64) -> Genome {
    if unit(rng) >= cfg.crossover_rate {
        return p1.clone();
    }
    let mut child = p1.clone();
    for (r, src) in child.reel_counts.iter_mut().zip(&p2.reel_counts) {
        if unit(rng) < 0.5 { *r = src.clone(); }
    }
    for (i, c) in child.payouts.iter_mut().enumerate() {
        if unit(rng) < 0.5 { *c = p2.payouts[i]; }
    }
    for (i, c) in child.bonuses.iter_mut().enumerate() {
        if unit(rng) < 0.5 { *c = p2.bonuses[i].clone(); }
    }
    repair(&mut child, template, &cfg.bounds);
    child
}

/// Binary tournament: pick the fitter of two random candidates.
fn tournament<'a>(scored: &'a [(Genome, f64)], rng: &mut SplitMix64) -> &'a Genome {
    let i = (rng.next_u64() as usize) % scored.len();
    let j = (rng.next_u64() as usize) % scored.len();
    if scored[i].1 >= scored[j].1 { &scored[i].0 } else { &scored[j].0 }
}

impl Tuner for GeneticTuner {
    fn tune(&self, seed_model: &SlotModel, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome {
        let mut rng = SplitMix64::new(cfg.master_seed);
        let base = encode(seed_model);

        // Initial population: the seed model + mutated variants.
        let mut pop: Vec<Genome> = (0..cfg.population)
            .map(|i| {
                if i == 0 {
                    base.clone()
                } else {
                    let mut g = base.clone();
                    mutate(&mut g, seed_model, cfg, &mut rng);
                    g
                }
            })
            .collect();

        let mut snapshots: Vec<GenSnapshot> = Vec::new();
        let mut best: Option<(Genome, f64)> = None;
        let mut stagnation = 0usize;
        let mut generations_run = 0usize;

        for g in 0..cfg.max_generations {
            generations_run = g + 1;
            let seeds = generation_seeds(cfg.master_seed, g, cfg.search_candidate_count);

            // Score every candidate on the SAME seed set (common random numbers).
            let mut scored: Vec<(Genome, f64)> = pop
                .iter()
                .map(|genome| {
                    let model = decode(genome, seed_model);
                    let f = fitness(&measure(&simulate(&model, &seeds)), target, &cfg.weights);
                    (genome.clone(), f)
                })
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

            // Snapshot the generation's best (re-derive its metrics for the trace).
            let best_model = decode(&scored[0].0, seed_model);
            let bm = measure(&simulate(&best_model, &seeds));
            snapshots.push(GenSnapshot {
                generation: g,
                best_fitness: scored[0].1,
                best_rtp: bm.rtp,
                best_volatility: bm.volatility,
                best_bonus_hit_rates: bm.bonus_hit_rates.clone(),
            });

            let improved = match &best {
                Some((_, pf)) => scored[0].1 > *pf + 1e-12,
                None => true,
            };
            if improved {
                best = Some((scored[0].0.clone(), scored[0].1));
                stagnation = 0;
            } else {
                stagnation += 1;
            }

            if scored[0].1 >= 0.0 { break; }              // feasible in the search tier
            if stagnation >= cfg.stagnation_window { break; }
            if g + 1 == cfg.max_generations { break; }

            // Next generation: elitism + tournament selection + crossover + mutation.
            let mut next: Vec<Genome> =
                scored.iter().take(cfg.elitism).map(|s| s.0.clone()).collect();
            while next.len() < cfg.population {
                let p1 = tournament(&scored, &mut rng).clone();
                let p2 = tournament(&scored, &mut rng).clone();
                let mut child = crossover(&p1, &p2, seed_model, cfg, &mut rng);
                mutate(&mut child, seed_model, cfg, &mut rng);
                next.push(child);
            }
            pop = next;
        }

        // Final tier: re-measure the best at full fidelity, then the REAL verify.
        let (best_genome, _) = best.expect("at least one generation always runs");
        let model = decode(&best_genome, seed_model);
        let final_seeds = generate_seeds(cfg.master_seed ^ FINAL_SALT, cfg.final_candidate_count);
        let metrics = measure(&simulate(&model, &final_seeds));
        let verdict = match verify(&metrics, target) {
            Ok(()) => Verdict::Pass,
            Err(_) => Verdict::NearMiss { missed: band_misses(&metrics, target) },
        };

        TuneOutcome {
            model,
            metrics,
            verdict,
            trace: TuningTrace {
                master_seed: cfg.master_seed,
                generations_run,
                snapshots,
                population: cfg.population,
                search_candidate_count: cfg.search_candidate_count,
                final_candidate_count: cfg.final_candidate_count,
            },
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-tuner genetic`
Expected: PASS (3 tests). The convergence test runs a real (small) search; it should complete in a few seconds.

- [ ] **Step 5: Register and re-export**

Add to `studio/tuner/src/lib.rs`:

```rust
pub mod genetic;

pub use genetic::GeneticTuner;
```

- [ ] **Step 6: Run the whole crate's tests**

Run: `cargo test -p bloom-tuner`
Expected: PASS (all tests from Tasks 2–4).

- [ ] **Step 7: Commit**

```bash
git add studio/tuner/src/genetic.rs studio/tuner/src/lib.rs
git commit -m "feat(tuner): GeneticTuner evolve loop (two-tier eval, common random numbers)"
```

---

### Task 5: The audit report, the CLI, and the `just` recipes

Render the trace into the human-readable audit report, expose a `tune` CLI mirroring `curate`, and wire `just` recipes.

**Files:**

- Create: `studio/tuner/src/report.rs`
- Create: `studio/tuner/src/bin/tune.rs`
- Modify: `studio/tuner/src/lib.rs` (add `pub mod report;`)
- Modify: `justfile` (add `tune` + `tuner-build` recipes)

**Interfaces:**

- Consumes: `TuneOutcome`, `Verdict`, `TuningTrace` (outcome); `SlotModel` (math); `TargetSpec`, `HitRateBand` (simulator target); `TunerConfig`, `GeneBounds`, `Weights` (config).
- Produces: `fn render_report(out: &TuneOutcome) -> String`.

- [ ] **Step 1: Write the failing report test**

`studio/tuner/src/report.rs` (test module first):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::outcome::{GenSnapshot, TuneOutcome, TuningTrace, Verdict};
    use bloom_math::mechanics::slots::{Paytable, SlotModel};
    use bloom_simulator::target::Metrics;

    fn outcome(verdict: Verdict) -> TuneOutcome {
        TuneOutcome {
            model: SlotModel {
                symbols: vec![], reels: vec![], rows: 1, paylines: vec![],
                paytable: Paytable { entries: vec![] }, bonuses: vec![],
            },
            metrics: Metrics {
                rtp: 0.901, volatility: 3.2, hit_frequency: 0.41,
                bonus_hit_rates: vec![], base_rtp: 0.901, feature_rtp: 0.0,
            },
            verdict,
            trace: TuningTrace {
                master_seed: 2026, generations_run: 7,
                snapshots: vec![GenSnapshot {
                    generation: 0, best_fitness: -0.5, best_rtp: 0.5,
                    best_volatility: 2.0, best_bonus_hit_rates: vec![],
                }],
                population: 24, search_candidate_count: 20_000, final_candidate_count: 200_000,
            },
        }
    }

    #[test]
    fn report_shows_pass_verdict_and_provenance() {
        let r = render_report(&outcome(Verdict::Pass));
        assert!(r.contains("verdict=PASS"));
        assert!(r.contains("master_seed=2026"));
        assert!(r.contains("generations_run=7"));
        assert!(r.contains("measured_rtp=0.901"));
    }

    #[test]
    fn report_shows_near_miss_with_missed_bands() {
        use crate::outcome::BandMiss;
        let r = render_report(&outcome(Verdict::NearMiss {
            missed: vec![BandMiss { metric: "rtp".into(), measured: 0.80, band_lo: 0.89, band_hi: 0.91 }],
        }));
        assert!(r.contains("verdict=NEAR_MISS"));
        assert!(r.contains("rtp"));
        assert!(r.contains("0.8")); // the missed measured value
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bloom-tuner report`
Expected: FAIL — `render_report` not defined.

- [ ] **Step 3: Implement the report**

Prepend to `studio/tuner/src/report.rs`:

```rust
//! Render a `TuneOutcome` into the human-readable audit report — the
//! "AI-designed, never AI-decided" evidence trail (provenance + search trace +
//! final verdict). The tuned model itself is written separately as JSON.

use crate::outcome::{TuneOutcome, Verdict};
use std::fmt::Write;

pub fn render_report(out: &TuneOutcome) -> String {
    let t = &out.trace;
    let mut s = String::new();
    let verdict = match &out.verdict {
        Verdict::Pass => "PASS".to_string(),
        Verdict::NearMiss { .. } => "NEAR_MISS".to_string(),
    };

    writeln!(s, "verdict={verdict}").unwrap();
    writeln!(s, "master_seed={}", t.master_seed).unwrap();
    writeln!(s, "generations_run={}", t.generations_run).unwrap();
    writeln!(s, "population={}", t.population).unwrap();
    writeln!(
        s,
        "search_candidate_count={}\nfinal_candidate_count={}",
        t.search_candidate_count, t.final_candidate_count
    )
    .unwrap();
    writeln!(
        s,
        "measured_rtp={:.5}\nmeasured_volatility={:.5}\nhit_frequency={:.5}",
        out.metrics.rtp, out.metrics.volatility, out.metrics.hit_frequency
    )
    .unwrap();
    for (i, r) in out.metrics.bonus_hit_rates.iter().enumerate() {
        writeln!(s, "bonus_hit_rate[{i}]={r:.5}").unwrap();
    }

    if let Verdict::NearMiss { missed } = &out.verdict {
        writeln!(s, "-- missed bands --").unwrap();
        for m in missed {
            writeln!(
                s,
                "{}: measured={:.5} band=[{:.5}, {:.5}]",
                m.metric, m.measured, m.band_lo, m.band_hi
            )
            .unwrap();
        }
    }

    writeln!(s, "-- search trace (best per generation) --").unwrap();
    for snap in &t.snapshots {
        writeln!(
            s,
            "gen {:>4}: fitness={:.5} rtp={:.5} volatility={:.5}",
            snap.generation, snap.best_fitness, snap.best_rtp, snap.best_volatility
        )
        .unwrap();
    }
    s
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p bloom-tuner report`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the module**

Add to `studio/tuner/src/lib.rs`:

```rust
pub mod report;
```

- [ ] **Step 6: Implement the CLI**

`studio/tuner/src/bin/tune.rs` (mirrors `studio/simulator/src/bin/curate.rs`):

```rust
//! CLI: read a seed model JSON + a target JSON + a tuner-config JSON, run a
//! genetic tuning, write the tuned model JSON + the audit report. Exits non-zero
//! on a near-miss (so it is scriptable).
//!
//! Usage: tune <seed_model.json> <target.json> <tuner_config.json> <out_model.json> <out_report.txt>

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::{HitRateBand, TargetSpec};
use bloom_tuner::config::{GeneBounds, TunerConfig, Weights};
use bloom_tuner::outcome::Verdict;
use bloom_tuner::report::render_report;
use bloom_tuner::{GeneticTuner, Tuner};
use serde::Deserialize;
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
}

#[derive(Deserialize)]
struct BoundsJson {
    payout_min: u64, payout_max: u64,
    spins_min: u32, spins_max: u32,
    multiplier_min: u64, multiplier_max: u64,
    min_count_min: u8, min_count_max: u8,
}

#[derive(Deserialize)]
struct WeightsJson { rtp: f64, volatility: f64, hit_rate: f64 }

#[derive(Deserialize)]
struct ConfigJson {
    master_seed: u64,
    population: usize,
    max_generations: usize,
    elitism: usize,
    mutation_rate: f64,
    crossover_rate: f64,
    stagnation_window: usize,
    search_candidate_count: usize,
    final_candidate_count: usize,
    bounds: BoundsJson,
    weights: WeightsJson,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        eprintln!("usage: tune <seed_model.json> <target.json> <tuner_config.json> <out_model.json> <out_report.txt>");
        std::process::exit(2);
    }

    let model: SlotModel = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read model"))
        .expect("parse model");
    let tj: TargetJson = serde_json::from_str(&fs::read_to_string(&args[2]).expect("read target"))
        .expect("parse target");
    let cj: ConfigJson = serde_json::from_str(&fs::read_to_string(&args[3]).expect("read config"))
        .expect("parse config");

    let target = TargetSpec {
        rtp_target: tj.rtp_target,
        rtp_tolerance: tj.rtp_tolerance,
        volatility_min: tj.volatility_min,
        volatility_max: tj.volatility_max,
        bonus_hit_rate_bands: tj
            .bonus_hit_rate_bands
            .iter()
            .map(|b| HitRateBand { min: b.min, max: b.max })
            .collect(),
        pool_size: tj.pool_size,
        candidate_count: tj.candidate_count,
        realized_correction_band: tj.realized_correction_band,
    };

    let cfg = TunerConfig {
        master_seed: cj.master_seed,
        population: cj.population,
        max_generations: cj.max_generations,
        elitism: cj.elitism,
        mutation_rate: cj.mutation_rate,
        crossover_rate: cj.crossover_rate,
        stagnation_window: cj.stagnation_window,
        search_candidate_count: cj.search_candidate_count,
        final_candidate_count: cj.final_candidate_count,
        bounds: GeneBounds {
            payout_min: cj.bounds.payout_min, payout_max: cj.bounds.payout_max,
            spins_min: cj.bounds.spins_min, spins_max: cj.bounds.spins_max,
            multiplier_min: cj.bounds.multiplier_min, multiplier_max: cj.bounds.multiplier_max,
            min_count_min: cj.bounds.min_count_min, min_count_max: cj.bounds.min_count_max,
        },
        weights: Weights { rtp: cj.weights.rtp, volatility: cj.weights.volatility, hit_rate: cj.weights.hit_rate },
    };

    let out = GeneticTuner.tune(&model, &target, &cfg);
    let report = render_report(&out);
    let model_json = serde_json::to_string_pretty(&out.model).expect("serialize tuned model");

    fs::write(&args[4], model_json).expect("write tuned model");
    fs::write(&args[5], &report).expect("write report");
    println!("{report}");
    println!("wrote tuned model -> {}\nwrote report      -> {}", args[4], args[5]);

    if matches!(out.verdict, Verdict::NearMiss { .. }) {
        std::process::exit(1);
    }
}
```

- [ ] **Step 7: Verify the binary builds**

Run: `cargo build -p bloom-tuner --bin tune`
Expected: PASS.

- [ ] **Step 8: Add the `just` recipes**

In `justfile`, after the `sim-build` recipe (line ~26):

```just
# Tune a slot model toward a target: seed model + target + tuner config ->
# tuned model JSON + audit report. Exits non-zero on a near-miss.
# Usage: just tune game/model.json game/target.json game/tuner.json out.model.json out.report.txt
tune model target config out_model out_report:
    cargo run -p bloom-tuner --bin tune -- {{model}} {{target}} {{config}} {{out_model}} {{out_report}}

# Build the release tuning binary (for later studio-backend shelling out).
tuner-build:
    cargo build --release -p bloom-tuner
```

- [ ] **Step 9: Run the full workspace test suite**

Run: `cargo test --workspace`
Expected: PASS (existing math/simulator/package tests + all bloom-tuner tests).

- [ ] **Step 10: Format and lint**

Run: `cargo fmt --all` then `cargo clippy --workspace --all-targets`
Expected: no diff after fmt; clippy clean (fix any warnings before committing).

- [ ] **Step 11: Commit**

```bash
git add studio/tuner/src/report.rs studio/tuner/src/bin/tune.rs studio/tuner/src/lib.rs justfile
git commit -m "feat(tuner): audit report, tune CLI, and just recipes"
```

---

## Final verification (before the PR)

- [ ] `cargo test --workspace` is green.
- [ ] `cargo fmt --all` produces no diff; `cargo clippy --workspace --all-targets` is clean.
- [ ] A manual smoke run: author a tiny detuned `model.json` + `target.json` + `tuner.json`, run `just tune ...`, confirm `verdict=PASS` and the tuned model's `measured_rtp` is in-band.
- [ ] Whole-branch review (subagent-driven-development's final review) before opening the squash PR.

## Self-review notes (coverage check vs. spec)

- Spec §2.1 (params not seeds): genome decodes to a `SlotModel`; fitness reads `measure(simulate(...))`; no seed-selection path. ✓ (Task 2, 4)
- Spec §2.2 (interpretable output): tuned model written as JSON + audit report. ✓ (Task 5)
- Spec §3 (genome: reels + paytable + bonus config; identity fixed; canonical layout; repair). ✓ (Task 2)
- Spec §4 (distance-to-band; fitness 0 ⟺ verify). ✓ (Task 3)
- Spec §5 (two-tier fidelity; common random numbers; termination). ✓ (Task 4)
- Spec §6 (determinism; two artifacts). ✓ (Task 4 reproducibility test, Task 5)
- Spec §7 (`Tuner` seam; custom GA documented; freeze/sign stays in simulator). ✓ (Task 1, 4; no freeze/sign added)
- Spec §8 (tests: round-trip, repair, fitness⟺verify, reproducibility, convergence, near-miss, CRN). ✓ (Tasks 2–4)
- Spec §9 (module list) and §10 (build order) map 1:1 to Tasks 1–5. ✓
