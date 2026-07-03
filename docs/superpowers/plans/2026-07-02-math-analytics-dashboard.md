# Math Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a studio plugin that visualizes how the genetic tuner converged (GA evolution, live + post-hoc) and what the final math is (win-distribution volatility curve, tail risk), with a persisted per-game run history for cross-run comparison and an exportable report.

**Architecture:** Three layers. (1) Rust crates `bloom-simulator` and `bloom-tuner` emit richer *summary* telemetry — population fitness quantiles + gene agreement per generation, and a win-distribution histogram + tail metrics computed by an end-of-tune profiling simulation. (2) A Python backend appends one frozen doc per tune to an append-only `math_runs` collection and relays enriched live progress over a socket room. (3) A `math-analytics` frontend plugin renders four fill-to-pane tabs (Evolution, Math Profile, Compare, Report) via an `IChart` seam (uPlot for streaming time-series, hand-rolled SVG/CSS for bespoke marks).

**Tech Stack:** Rust (existing crates, `rayon`, `serde_json`, NDJSON CLIs), Python (FastAPI, `python-socketio`, Motor/MongoDB, pydantic), TypeScript/React (Vite, Dockview, uPlot, Vitest, Playwright).

## Global Constraints

- **TDD is mandatory** — failing test first, watch it fail, minimal code, refactor. Every task below is RED→GREEN→commit.
- **TypeScript interfaces use an `I` prefix** (`IChart`, `IMathRun`, `IAnalyticsState`). (`docs/coding-standards.md`)
- **Studio design language is authoritative** — 4 surfaces, 2 hairlines, 3 text tiers, 1 rationed accent, floating-card Dockview model. **Raw colors are only allowed in `studio/frontend/src/styles.css`** (a guard test blocks otherwise). All chart color roles are defined there as tokens. (`docs/design-language.md`)
- **Wire format is camelCase** across the Rust NDJSON, the Python pydantic models (`alias_generator=to_camel`, `populate_by_name=True`), and the TS types.
- **Telemetry is summaries, never raw** — per-generation quantiles + scalars (not the population), fixed-bin histogram (not per-round payouts), downsampled RTP-convergence series (not per-spin).
- **Determinism preserved** — telemetry additions must not change the tuner's or simulator's deterministic result. Existing "streamed == non-streamed" and "same seed → same outcome" tests must keep passing.
- **Playwright e2e is the authoritative behavioral contract**, run locally against the replay backend (`just e2e`), never in CI. Rust + Python unit tests are CI-affordable. Assert observable end-state (charts reflect persisted `math_runs`), never just that an event fired.
- **Read the merged source, not this plan's snippets, when mirroring an existing file** — the plan cites exact files to copy patterns from; those files are the source of truth if they have drifted.
- **Commit after every GREEN step** using Conventional Commits (`feat`, `test`, `refactor`, …).

---

## File Structure

**Rust — `bloom-simulator` (`studio/simulator/src/`)**
- Create `profile.rs` — `WinDistribution`, `TailMetrics`, `RtpConvergence`, and `profile()` / `rtp_convergence()` over `&[RoundSample]`. One responsibility: turn a sample population into presentation-ready distribution/tail/convergence summaries.
- Modify `lib.rs` — `pub mod profile;` and re-exports.

**Rust — `bloom-tuner` (`studio/tuner/src/`)**
- Create `telemetry.rs` — `PopulationStats` (fitness quantiles + diversity) and `gene_agreement()` over a scored population. One responsibility: summarize a generation's population.
- Modify `outcome.rs` — extend `GenSnapshot` with population fields; add `profile: RunProfile` to `TuneOutcome`.
- Modify `genetic.rs` — compute population stats per generation; run the end-of-tune profiling sim.
- Modify `src/bin/tune_json.rs` — emit the enriched `progress` and `result` NDJSON.

**Python — `studio/backend/app/analytics/`** (new package, mirrors `app/tuner/`)
- `__init__.py`, `models.py` (`MathRunDoc`, `WinDistributionWire`, `TailWire`, `RtpPointWire`, `PopulationStatsWire`), `store.py` (`MathRunStore`, append-only), `rest.py` (`GET /analytics/runs`, `GET /analytics/runs/{id}`), `hub.py` (`AnalyticsHub`), `sockets.py` (`join_analytics`/`leave_analytics`).
- Modify `app/tuner/models.py`, `app/tuner/runner.py`, `app/tuner/hub.py` — carry the enriched fields end-to-end and hand the finished run to `AnalyticsHub`.
- Modify the app composition root (wherever `TunerHub`/routers/sockets are constructed) to build and register the analytics store/hub/router/socket handlers.

**TypeScript — `studio/frontend/src/plugins/math-analytics/`** (new plugin, mirrors `plugins/tuner/`)
- `index.ts`, `state.ts`, `actions.ts`, `reducers.ts`, `restClient.ts`, `socketClient.ts`, `config.ts`, `MathAnalyticsPane.tsx`, plus tab components `tabs/EvolutionTab.tsx`, `tabs/MathProfileTab.tsx`, `tabs/CompareTab.tsx`, `tabs/ReportTab.tsx`, and `charts/` (the `IChart` seam + adapters). Each with a `.spec` sibling.
- Modify `plugins/index.ts` — register the plugin.
- Modify `styles.css` — chart color-role tokens.

---

## PHASE 1 — Backbone + post-hoc Math Profile

Delivers the enabling Rust telemetry, end-of-tune profiling, `math_runs` persistence, and a working **Math Profile** tab reading a persisted run.

### Task 1.1: `bloom-simulator` win-distribution + tail profiling

**Files:**
- Create: `studio/simulator/src/profile.rs`
- Modify: `studio/simulator/src/lib.rs`
- Test: inline `#[cfg(test)]` in `profile.rs`

**Interfaces:**
- Consumes: `crate::measure::RoundSample { seed:u64, payout:u64, base_payout:u64, feature_payout:u64, feature_triggers:Vec<bool> }` (existing).
- Produces:
  - `pub struct HistogramBin { pub bin_lo: f64, pub bin_hi: f64, pub base: u64, pub feature: u64 }` (counts of rounds whose total-payout multiplier falls in `[bin_lo, bin_hi)`, split by whether `feature_payout > 0`).
  - `pub struct WinDistribution { pub bins: Vec<HistogramBin>, pub zero_count: u64 }`
  - `pub struct TailMetrics { pub max_win: f64, pub p_ge_100x: f64, pub p_losing_spin: f64, pub longest_dead_streak: u32, pub bonus_trigger_rate: f64 }`
  - `pub fn profile(samples: &[RoundSample], bet: u64) -> (WinDistribution, TailMetrics)` — `bet` is the cost per round used to convert payout→multiplier (use `1` when the kernel's payout is already expressed per unit stake; see note).
  - Log-spaced bin edges via `pub fn log_bins() -> Vec<f64>` returning the fixed edges `[0,1,2,5,10,20,50,100,200,500,1000,2000, f64::INFINITY]`.

> **Note on `bet`:** `evaluate()` returns `total_payout` in the same unit the paytable pays; existing `measure()` treats mean(payout) directly as RTP, so a unit stake of `1` is the current convention. Pass `bet = 1`; keep the parameter so a future staked model can rescale without an API change.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::measure::RoundSample;

    fn s(payout: u64, feature: u64, trig: bool) -> RoundSample {
        RoundSample { seed: 0, payout, base_payout: payout - feature, feature_payout: feature,
                      feature_triggers: vec![trig] }
    }

    #[test]
    fn histogram_buckets_by_multiplier_and_splits_base_vs_feature() {
        // multipliers: 0 (loss), 1x base, 7x base, 150x feature
        let pop = vec![s(0,0,false), s(1,0,false), s(7,0,false), s(150,150,true)];
        let (dist, _) = profile(&pop, 1);
        assert_eq!(dist.zero_count, 1);
        // 1x -> [1,2), 7x -> [5,10), 150x -> [100,200) as feature
        let bin = |lo: f64| dist.bins.iter().find(|b| b.bin_lo == lo).unwrap();
        assert_eq!(bin(1.0).base, 1);
        assert_eq!(bin(5.0).base, 1);
        assert_eq!(bin(100.0).feature, 1);
        assert_eq!(bin(100.0).base, 0);
    }

    #[test]
    fn tail_metrics_capture_max_streak_and_probabilities() {
        // 5 rounds: L, W(1x), L, L, W(120x, bonus)
        let pop = vec![s(0,0,false), s(1,0,false), s(0,0,false), s(0,0,false), s(120,120,true)];
        let (_, tail) = profile(&pop, 1);
        assert_eq!(tail.max_win, 120.0);
        assert!((tail.p_losing_spin - 0.6).abs() < 1e-9);
        assert!((tail.p_ge_100x - 0.2).abs() < 1e-9);
        assert_eq!(tail.longest_dead_streak, 2); // L,L before the last win
        assert!((tail.bonus_trigger_rate - 0.2).abs() < 1e-9);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-simulator profile::tests -v`
Expected: FAIL — `profile`, `HistogramBin`, etc. not found.

- [ ] **Step 3: Write the minimal implementation**

```rust
//! Turn a simulated sample population into presentation-ready summaries:
//! a log-binned win-distribution histogram and tail-risk metrics. Read-only
//! over `RoundSample`; never affects curation or determinism.

use crate::measure::RoundSample;

#[derive(Debug, Clone, PartialEq)]
pub struct HistogramBin { pub bin_lo: f64, pub bin_hi: f64, pub base: u64, pub feature: u64 }

#[derive(Debug, Clone, PartialEq)]
pub struct WinDistribution { pub bins: Vec<HistogramBin>, pub zero_count: u64 }

#[derive(Debug, Clone, PartialEq)]
pub struct TailMetrics {
    pub max_win: f64, pub p_ge_100x: f64, pub p_losing_spin: f64,
    pub longest_dead_streak: u32, pub bonus_trigger_rate: f64,
}

pub fn log_bins() -> Vec<f64> {
    vec![0.0, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, f64::INFINITY]
}

pub fn profile(samples: &[RoundSample], bet: u64) -> (WinDistribution, TailMetrics) {
    assert!(!samples.is_empty(), "cannot profile an empty population");
    let n = samples.len() as f64;
    let bet = bet.max(1) as f64;
    let edges = log_bins();
    let mut bins: Vec<HistogramBin> = edges.windows(2)
        .map(|w| HistogramBin { bin_lo: w[0], bin_hi: w[1], base: 0, feature: 0 })
        .collect();

    let mut zero_count = 0u64;
    let mut max_win = 0.0f64;
    let mut ge_100 = 0u64;
    let mut losing = 0u64;
    let mut bonus = 0u64;
    let mut streak = 0u32;
    let mut longest = 0u32;

    for smp in samples {
        let mult = smp.payout as f64 / bet;
        if smp.payout == 0 {
            zero_count += 1;
            losing += 1;
            streak += 1;
            longest = longest.max(streak);
        } else {
            streak = 0;
            let idx = bins.iter().position(|b| mult >= b.bin_lo && mult < b.bin_hi)
                .unwrap_or(bins.len() - 1);
            if smp.feature_payout > 0 { bins[idx].feature += 1 } else { bins[idx].base += 1 }
        }
        max_win = max_win.max(mult);
        if mult >= 100.0 { ge_100 += 1 }
        if smp.feature_triggers.iter().any(|&t| t) { bonus += 1 }
    }

    (
        WinDistribution { bins, zero_count },
        TailMetrics {
            max_win,
            p_ge_100x: ge_100 as f64 / n,
            p_losing_spin: losing as f64 / n,
            longest_dead_streak: longest,
            bonus_trigger_rate: bonus as f64 / n,
        },
    )
}
```

Add to `studio/simulator/src/lib.rs` next to the other `pub mod` lines:

```rust
pub mod profile;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bloom-simulator profile::tests -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add studio/simulator/src/profile.rs studio/simulator/src/lib.rs
git commit -m "feat(simulator): win-distribution histogram + tail metrics over sample population"
```

---

### Task 1.2: `bloom-simulator` RTP-convergence series

**Files:**
- Modify: `studio/simulator/src/profile.rs`
- Test: inline `#[cfg(test)]` in `profile.rs`

**Interfaces:**
- Produces:
  - `pub struct RtpPoint { pub n: usize, pub realized_rtp: f64 }`
  - `pub fn rtp_convergence(samples: &[RoundSample], points: usize) -> Vec<RtpPoint>` — cumulative mean payout at `points` log-spaced sample sizes from `~100` to `samples.len()` (deduped, ascending, last point = full sample).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn rtp_convergence_is_ascending_log_spaced_and_ends_at_full_mean() {
    let pop: Vec<RoundSample> = (0..10_000)
        .map(|i| RoundSample { seed: i, payout: (i % 2), base_payout: (i % 2),
                               feature_payout: 0, feature_triggers: vec![] })
        .collect();
    let series = rtp_convergence(&pop, 8);
    assert!(series.len() >= 2 && series.len() <= 8);
    assert!(series.windows(2).all(|w| w[0].n < w[1].n));       // strictly ascending n
    assert_eq!(series.last().unwrap().n, 10_000);              // ends at full sample
    let full_mean = 0.5;                                       // half the payouts are 1
    assert!((series.last().unwrap().realized_rtp - full_mean).abs() < 1e-9);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-simulator profile::tests::rtp_convergence -v`
Expected: FAIL — `rtp_convergence` not found.

- [ ] **Step 3: Write the minimal implementation** (append to `profile.rs`)

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct RtpPoint { pub n: usize, pub realized_rtp: f64 }

pub fn rtp_convergence(samples: &[RoundSample], points: usize) -> Vec<RtpPoint> {
    let total = samples.len();
    assert!(total > 0, "cannot converge an empty population");
    let points = points.max(2);
    let lo = 100usize.min(total);
    // log-spaced sizes lo..=total, deduped and ascending.
    let mut sizes: Vec<usize> = (0..points)
        .map(|i| {
            let t = i as f64 / (points - 1) as f64;
            let v = (lo as f64).ln() + t * ((total as f64).ln() - (lo as f64).ln());
            v.exp().round() as usize
        })
        .map(|s| s.clamp(lo, total))
        .collect();
    sizes.dedup();
    if *sizes.last().unwrap() != total { sizes.push(total); }

    let mut running = 0f64;
    let mut cursor = 0usize;
    let mut out = Vec::with_capacity(sizes.len());
    for &size in &sizes {
        while cursor < size { running += samples[cursor].payout as f64; cursor += 1; }
        out.push(RtpPoint { n: size, realized_rtp: running / size as f64 });
    }
    out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bloom-simulator profile -v`
Expected: PASS (all `profile` tests).

- [ ] **Step 5: Commit**

```bash
git add studio/simulator/src/profile.rs
git commit -m "feat(simulator): realized-RTP convergence series for sampling-trust chart"
```

---

### Task 1.3: `bloom-tuner` per-generation population telemetry

**Files:**
- Create: `studio/tuner/src/telemetry.rs`
- Modify: `studio/tuner/src/lib.rs` (`pub mod telemetry;`)
- Test: inline `#[cfg(test)]` in `telemetry.rs`

**Interfaces:**
- Consumes: the per-generation scored population, expressed as fitness values `&[f64]` and decoded genomes for gene agreement.
- Produces:
  - `pub struct PopulationStats { pub min: f64, pub q1: f64, pub median: f64, pub q3: f64, pub max: f64, pub mean: f64, pub diversity: f64 }`
  - `pub fn population_stats(fitnesses: &[f64]) -> PopulationStats` — quantiles by the nearest-rank method on a sorted copy; `diversity` = population fitness std-dev divided by `(max−min).abs()+1e-9` (normalized spread in `[0,~1]`; `0` when fully converged).
  - `pub fn gene_agreement(values: &[Vec<f64>]) -> Vec<f64>` — given, per gene dimension, the population's values, return per-dimension agreement in `[0,1]` = `1 − normalized_stddev` (1 = full consensus). Caller supplies one inner `Vec<f64>` per gene dimension (payout mean, spins, multiplier, min_count), each of length = population size.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn population_stats_quantiles_and_zero_diversity_when_converged() {
        let same = vec![-0.5; 8];
        let st = population_stats(&same);
        assert_eq!(st.min, -0.5);
        assert_eq!(st.max, -0.5);
        assert!(st.diversity.abs() < 1e-9); // fully converged
    }

    #[test]
    fn population_stats_orders_quantiles() {
        let f = vec![-1.0, -0.8, -0.6, -0.4, -0.2, 0.0];
        let st = population_stats(&f);
        assert!(st.min <= st.q1 && st.q1 <= st.median && st.median <= st.q3 && st.q3 <= st.max);
        assert!((st.mean - (-0.5)).abs() < 1e-9);
        assert!(st.diversity > 0.0);
    }

    #[test]
    fn gene_agreement_is_one_when_all_equal_and_below_one_when_spread() {
        let converged = vec![vec![5.0, 5.0, 5.0]];      // one gene, all agree
        assert!((gene_agreement(&converged)[0] - 1.0).abs() < 1e-9);
        let spread = vec![vec![1.0, 5.0, 9.0]];
        assert!(gene_agreement(&spread)[0] < 1.0);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-tuner telemetry::tests -v`
Expected: FAIL — module/functions not found.

- [ ] **Step 3: Write the minimal implementation**

```rust
//! Per-generation population summaries for the analytics dashboard. Pure,
//! read-only over the GA's scored population; never affects the deterministic
//! search result (progress is cosmetic).

#[derive(Debug, Clone, PartialEq)]
pub struct PopulationStats {
    pub min: f64, pub q1: f64, pub median: f64, pub q3: f64,
    pub max: f64, pub mean: f64, pub diversity: f64,
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() { return 0.0; }
    let rank = (q * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

fn stddev(xs: &[f64], mean: f64) -> f64 {
    if xs.is_empty() { return 0.0; }
    (xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / xs.len() as f64).sqrt()
}

pub fn population_stats(fitnesses: &[f64]) -> PopulationStats {
    assert!(!fitnesses.is_empty(), "empty population");
    let mut s = fitnesses.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let mean = s.iter().sum::<f64>() / s.len() as f64;
    let (min, max) = (s[0], s[s.len() - 1]);
    PopulationStats {
        min, max, mean,
        q1: quantile(&s, 0.25), median: quantile(&s, 0.5), q3: quantile(&s, 0.75),
        diversity: stddev(&s, mean) / ((max - min).abs() + 1e-9),
    }
}

pub fn gene_agreement(values: &[Vec<f64>]) -> Vec<f64> {
    values.iter().map(|col| {
        if col.is_empty() { return 1.0; }
        let mean = col.iter().sum::<f64>() / col.len() as f64;
        let range = col.iter().cloned().fold(f64::MIN, f64::max)
                  - col.iter().cloned().fold(f64::MAX, f64::min);
        if range.abs() < 1e-12 { return 1.0; }
        (1.0 - stddev(col, mean) / (range.abs() + 1e-9)).clamp(0.0, 1.0)
    }).collect()
}
```

Add `pub mod telemetry;` to `studio/tuner/src/lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bloom-tuner telemetry::tests -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/tuner/src/telemetry.rs studio/tuner/src/lib.rs
git commit -m "feat(tuner): population fitness quantiles, diversity, and gene-agreement summaries"
```

---

### Task 1.4: Wire population telemetry + end-of-tune profiling into the GA

**Files:**
- Modify: `studio/tuner/src/outcome.rs`
- Modify: `studio/tuner/src/genetic.rs`
- Test: inline tests in `genetic.rs` (extend the existing test module)

**Interfaces:**
- Extend `GenSnapshot` with: `pub population: crate::telemetry::PopulationStats`, `pub gene_agreement: Vec<f64>`. (Keep existing fields.)
- Add to `TuneOutcome`: `pub profile: RunProfile`, where
  `pub struct RunProfile { pub distribution: bloom_simulator::profile::WinDistribution, pub tail: bloom_simulator::profile::TailMetrics, pub rtp_convergence: Vec<bloom_simulator::profile::RtpPoint> }`.
- `tune_with_progress` populates both from the existing `scored` population and the existing `final_seeds` samples — **without changing the search path or the decoded best model** (determinism constraint).

- [ ] **Step 1: Write the failing test** (append to `genetic.rs` tests)

```rust
#[test]
fn snapshots_carry_population_stats_and_profile_is_present() {
    let out = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
    // every generation snapshot has population stats + one agreement value per gene dim
    assert!(out.trace.snapshots.iter().all(|s| s.population.max >= s.population.min));
    assert!(out.trace.snapshots.iter().all(|s| !s.gene_agreement.is_empty()));
    // end-of-tune profile exists and its histogram covers the fixed bins
    assert_eq!(out.profile.distribution.bins.len(),
               bloom_simulator::profile::log_bins().len() - 1);
    assert!(out.profile.tail.p_losing_spin >= 0.0 && out.profile.tail.p_losing_spin <= 1.0);
    assert!(out.profile.rtp_convergence.last().is_some());
}

#[test]
fn telemetry_does_not_change_the_deterministic_result() {
    let a = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
    let b = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
    assert_eq!(a.model, b.model);
    assert_eq!(a.metrics.rtp, b.metrics.rtp);
    assert_eq!(a.profile.tail.max_win, b.profile.tail.max_win);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-tuner genetic::tests::snapshots_carry -v`
Expected: FAIL — `population`/`gene_agreement`/`profile` fields not found.

- [ ] **Step 3: Write the minimal implementation**

In `outcome.rs`, add the fields (imports at top: `use crate::telemetry::PopulationStats;`):

```rust
pub struct GenSnapshot {
    pub generation: usize,
    pub best_fitness: f64,
    pub best_rtp: f64,
    pub best_volatility: f64,
    pub best_bonus_hit_rates: Vec<f64>,
    pub population: PopulationStats,   // NEW
    pub gene_agreement: Vec<f64>,      // NEW
}

pub struct RunProfile {                // NEW
    pub distribution: bloom_simulator::profile::WinDistribution,
    pub tail: bloom_simulator::profile::TailMetrics,
    pub rtp_convergence: Vec<bloom_simulator::profile::RtpPoint>,
}
```

Add `pub profile: RunProfile,` to `TuneOutcome`.

In `genetic.rs`:
- Add imports: `use crate::telemetry::{population_stats, gene_agreement}; use bloom_simulator::profile::profile; use crate::outcome::RunProfile;`
- Where the snapshot is built (after `scored.sort_by(...)`), compute stats from the scored population and gene agreement from decoded genomes:

```rust
let fitnesses: Vec<f64> = scored.iter().map(|(_, f)| *f).collect();
let decoded: Vec<SlotModel> = scored.iter().map(|(g, _)| decode(g, seed_model)).collect();
// one column per tunable gene dimension: mean payout, and (if present) the first
// bonus's spins / multiplier / min_count. Guarded for models without bonuses.
let col_payout: Vec<f64> = decoded.iter()
    .map(|m| m.paytable.entries.iter().map(|e| e.payout as f64).sum::<f64>()
             / m.paytable.entries.len().max(1) as f64).collect();
let mut cols = vec![col_payout];
if decoded.iter().all(|m| !m.bonuses.is_empty()) {
    cols.push(decoded.iter().map(|m| m.bonuses[0].spins_awarded as f64).collect());
    cols.push(decoded.iter().map(|m| m.bonuses[0].multiplier as f64).collect());
    cols.push(decoded.iter().map(|m| m.bonuses[0].min_count as f64).collect());
}
let snap = GenSnapshot {
    generation: g,
    best_fitness: scored[0].1,
    best_rtp: bm.rtp,
    best_volatility: bm.volatility,
    best_bonus_hit_rates: bm.bonus_hit_rates.clone(),
    population: population_stats(&fitnesses),
    gene_agreement: gene_agreement(&cols),
};
```

- After the final metrics block (where `final_seeds` and `metrics` are computed), profile the same final samples. Reuse the samples rather than re-simulating:

```rust
let final_samples = simulate(&model, &final_seeds);
let metrics = measure(&final_samples);
let (distribution, tail) = profile(&final_samples, 1);
let rtp_convergence = bloom_simulator::profile::rtp_convergence(&final_samples, 24);
```

(Replace the existing `let metrics = measure(&simulate(&model, &final_seeds));` line.)

- Add `profile: RunProfile { distribution, tail, rtp_convergence },` to the returned `TuneOutcome`.
- Update the test helper `outcome(...)` in `tune_json.rs`'s test module and any other `TuneOutcome`/`GenSnapshot` literals to include the new fields (compiler will point them out).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-tuner -v`
Expected: PASS — new tests pass; existing determinism/convergence tests still pass.

- [ ] **Step 5: Commit**

```bash
git add studio/tuner/src/outcome.rs studio/tuner/src/genetic.rs studio/tuner/src/bin/tune_json.rs
git commit -m "feat(tuner): attach population telemetry per generation and end-of-tune math profile"
```

---

### Task 1.5: `tune_json` emits enriched progress + result NDJSON

**Files:**
- Modify: `studio/tuner/src/bin/tune_json.rs`
- Test: inline `#[cfg(test)]` in `tune_json.rs` (extend existing shape tests)

**Interfaces:**
- `progress` line gains: `population: { min, q1, median, q3, max, mean, diversity }`, `geneAgreement: [f64]`.
- `result` line gains: `trace[i]` entries with the same `population`/`geneAgreement`, and a top-level
  `profile: { distribution: { bins: [{binLo, binHi, base, feature}], zeroCount }, tail: { maxWin, pGE100x, pLosingSpin, longestDeadStreak, bonusTriggerRate }, rtpConvergence: [{n, realizedRtp}] }`.

- [ ] **Step 1: Write the failing test** (extend `tune_json.rs` tests; update the `outcome()` helper to populate the new fields with small literals first)

```rust
#[test]
fn progress_line_carries_population_stats() {
    let snap = GenSnapshot {
        generation: 3, best_fitness: -0.25, best_rtp: 0.85, best_volatility: 2.1,
        best_bonus_hit_rates: vec![],
        population: bloom_tuner::telemetry::PopulationStats {
            min: -0.9, q1: -0.7, median: -0.5, q3: -0.3, max: -0.1, mean: -0.5, diversity: 0.4 },
        gene_agreement: vec![0.8, 0.6],
    };
    let v: serde_json::Value = serde_json::from_str(&progress_line(&snap, 40)).unwrap();
    assert_eq!(v["population"]["diversity"], 0.4);
    assert_eq!(v["geneAgreement"][0], 0.8);
}

#[test]
fn result_line_carries_profile_block() {
    let v: serde_json::Value =
        serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
    assert!(v["profile"]["distribution"]["bins"].is_array());
    assert!(v["profile"]["tail"]["maxWin"].is_number());
    assert!(v["profile"]["rtpConvergence"].is_array());
    assert!(v["trace"][0]["population"].is_object());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-tuner --bin tune_json -v`
Expected: FAIL — keys absent.

- [ ] **Step 3: Write the minimal implementation**

Extend `progress_line` and `result_line` in `tune_json.rs` to serialize the new fields. Add a helper `fn pop_json(p: &PopulationStats) -> serde_json::Value` and `fn profile_json(p: &RunProfile) -> serde_json::Value` emitting the camelCase shapes above, and include `"population": pop_json(&snap.population), "geneAgreement": snap.gene_agreement` in the progress object and each trace entry, plus `"profile": profile_json(&out.profile)` in the result object. (Mirror the existing `json!({...})` style already in the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bloom-tuner --bin tune_json -v`
Expected: PASS. Then full crate: `cargo test -p bloom-tuner -v`.

- [ ] **Step 5: Commit**

```bash
git add studio/tuner/src/bin/tune_json.rs
git commit -m "feat(tuner): emit enriched population + profile telemetry over NDJSON"
```

---

### Task 1.6: Backend wire models for enriched telemetry + `math_runs`

**Files:**
- Modify: `studio/backend/app/tuner/models.py` (extend `GenSnapshotWire`, `TuneResult`)
- Create: `studio/backend/app/analytics/__init__.py`, `studio/backend/app/analytics/models.py`
- Test: `studio/backend/tests/test_analytics_models.py`

**Interfaces (pydantic, `_WireModel` base = `alias_generator=to_camel, populate_by_name=True`):**
- `PopulationStatsWire(min, q1, median, q3, max, mean, diversity: float)`
- `HistogramBinWire(bin_lo, bin_hi: float; base, feature: int)`
- `WinDistributionWire(bins: list[HistogramBinWire]; zero_count: int)`
- `TailWire(max_win, p_ge100x, p_losing_spin: float; longest_dead_streak: int; bonus_trigger_rate: float)` — note alias `pGE100x` requires explicit `alias="pGE100x"` on the `p_ge100x` field.
- `RtpPointWire(n: int; realized_rtp: float)`
- `RunProfileWire(distribution: WinDistributionWire; tail: TailWire; rtp_convergence: list[RtpPointWire])`
- Extend `GenSnapshotWire` with `population: PopulationStatsWire`, `gene_agreement: list[float]`.
- Extend `TuneResult` with `profile: RunProfileWire | None = None`.
- `MathRunDoc(_WireModel)`: `id, game_id: str; params: TuningParams; verdict: str | None; metrics: MetricsWire | None; trace: list[GenSnapshotWire]; profile: RunProfileWire | None; created_at: str; duration_ms: int | None`. Plus `math_run_wire(doc) -> dict` (`by_alias`, `mode="json"`).

- [ ] **Step 1: Write the failing test**

```python
from app.analytics.models import MathRunDoc, RunProfileWire, math_run_wire

def test_math_run_round_trips_camelcase():
    doc = MathRunDoc(
        id="r1", game_id="g1", params=_params(), verdict="pass", metrics=_metrics(),
        trace=[], profile=_profile(), created_at="2026-07-02T00:00:00Z", duration_ms=1234,
    )
    wire = math_run_wire(doc)
    assert wire["gameId"] == "g1"
    assert wire["profile"]["tail"]["pGE100x"] == 0.28
    assert wire["durationMs"] == 1234
    # populate_by_name: validating the camelCase wire back yields an equal doc
    assert MathRunDoc.model_validate(wire).game_id == "g1"
```

(Provide `_params/_metrics/_profile` builders in the test using the wire models.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_analytics_models.py -v`
Expected: FAIL — `app.analytics.models` missing.

- [ ] **Step 3: Write the minimal implementation** — add the models above to `app/analytics/models.py` (mirror the `_WireModel` pattern from `app/tuner/models.py`) and extend `app/tuner/models.py`'s `GenSnapshotWire`/`TuneResult`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_analytics_models.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/analytics/__init__.py studio/backend/app/analytics/models.py studio/backend/app/tuner/models.py studio/backend/tests/test_analytics_models.py
git commit -m "feat(backend): wire models for enriched tuner telemetry and math_runs"
```

---

### Task 1.7: Backend tuner runner parses the enriched result

**Files:**
- Modify: `studio/backend/app/tuner/runner.py` (`parse_tune_result_line`, `TuneProgress`, `_drain_stdout`)
- Test: `studio/backend/tests/test_tuner_runner_parse.py`

**Interfaces:**
- `TuneProgress` gains `population: PopulationStatsWire`, `gene_agreement: list[float]`.
- `parse_tune_result_line` maps the `profile` block → `RunProfileWire` and per-trace `population`/`geneAgreement` → `GenSnapshotWire`.

- [ ] **Step 1: Write the failing test** — feed a hand-authored NDJSON `result` line (with `profile` + enriched `trace`) into `parse_tune_result_line` and assert `result.profile.tail.p_ge100x` and `result.trace[0].population.diversity` are populated. (RED.)
- [ ] **Step 2: Run** `cd studio/backend && uv run pytest tests/test_tuner_runner_parse.py -v` → FAIL.
- [ ] **Step 3: Implement** the mapping in `parse_tune_result_line` (mirror the existing `MetricsWire`/`GenSnapshotWire` construction) and enrich the `progress` branch of `_drain_stdout` to build the new `TuneProgress` fields.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(backend): parse enriched population + profile telemetry from tuner stream`.

---

### Task 1.8: `MathRunStore` (append-only) + REST

**Files:**
- Create: `studio/backend/app/analytics/store.py`, `studio/backend/app/analytics/rest.py`
- Test: `studio/backend/tests/test_analytics_store.py`, `studio/backend/tests/test_analytics_rest.py`

**Interfaces:**
- `MathRunStore(db)` over collection `math_runs`:
  - `async append(self, run: MathRunDoc) -> MathRunDoc` — inserts (never updates); `_id` from `id`.
  - `async list_for_game(self, game_id: str, limit: int = 50) -> list[MathRunDoc]` — newest first by `created_at`.
  - `async get(self, run_id: str) -> MathRunDoc | None`.
  - Ensures an index on `(game_id, created_at desc)` on first use.
- `rest.py`: `router` with `GET /analytics/runs?game_id=…&limit=…` → `[math_run_wire(...)]`, `GET /analytics/runs/{run_id}` → `math_run_wire(...)` or 404. Mirror `app/tuner/rest.py` DI (`Depends` on the store from app state).

- [ ] **Step 1: Write the failing tests** — store: append two runs for a game, `list_for_game` returns them newest-first and `append` never overwrites (two docs, not one). rest: seed the store, `GET /analytics/runs?game_id=g1` returns 2 camelCase docs; `GET /analytics/runs/missing` → 404. Use the existing async-Mongo test fixture (see `tests/` for the pattern, e.g. how `test`s spin up Motor or a fake).
- [ ] **Step 2: Run** the two files → FAIL.
- [ ] **Step 3: Implement** `store.py` (mirror `app/tuner/store.py` `_to_doc`/`_from_doc`) and `rest.py` (mirror `app/tuner/rest.py`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(backend): append-only math_runs store + analytics REST endpoints`.

---

### Task 1.9: `AnalyticsHub` — write a run on tune completion

**Files:**
- Create: `studio/backend/app/analytics/hub.py`, `studio/backend/app/analytics/sockets.py`
- Modify: `studio/backend/app/tuner/hub.py` (hand the finished result to the analytics hub), and the app composition root (construct + register store/hub/router/sockets)
- Test: `studio/backend/tests/test_analytics_hub.py`

**Interfaces:**
- `AnalyticsHub(sio, math_run_store)`:
  - `async record_run(self, game_id: str, params: TuningParams, result: TuneResult, duration_ms: int) -> MathRunDoc` — builds a `MathRunDoc` (new uuid, `created_at` from an injected clock, `profile`/`trace` copied from `result`), `append`s it, and emits `run_complete` `{gameId, run: math_run_wire(doc)}` to room `game_id`. Only records `pass`/`near_miss` (skip `error`).
  - `async attach_subscriber(self, game_id, sid)` — join room; if a latest run exists, emit it to `sid` (mirrors `TunerHub.attach_subscriber`).
- `sockets.py`: `register_analytics_handlers(sio, hub)` with `join_analytics`/`leave_analytics` (mirror `app/tuner/sockets.py`).
- `TunerHub.request_tune`: after `save_result`, if `result.status in ("pass","near_miss")`, call `self._analytics.record_run(game_id, tuner_doc.params, result, duration_ms)` (measure duration around `self._runner.run`). Inject `AnalyticsHub` into `TunerHub.__init__` (extend the constructor + its construction site — see [[avoid-merge-conflicts]]: `TunerHub.__init__` is a hot file, keep the diff minimal).

- [ ] **Step 1: Write the failing test** — construct `AnalyticsHub` with a fake `sio` (records emits) and an in-memory store; call `record_run` with a `pass` `TuneResult` carrying a `profile`; assert a doc was appended and a `run_complete` emit went to the room with camelCase `run.profile`. Assert `error` status records nothing.
- [ ] **Step 2: Run** `tests/test_analytics_hub.py` → FAIL.
- [ ] **Step 3: Implement** `hub.py`, `sockets.py`, wire into `tuner/hub.py` + composition root.
- [ ] **Step 4: Run** the whole backend suite `cd studio/backend && uv run pytest -q` → PASS (no regressions in tuner tests).
- [ ] **Step 5: Commit** `feat(backend): record each tune into math_runs and broadcast run_complete`.

---

### Task 1.10: Frontend `math-analytics` plugin scaffold + `IChart` seam + Math Profile tab

**Files:**
- Create: `studio/frontend/src/plugins/math-analytics/{index.ts,state.ts,actions.ts,reducers.ts,restClient.ts,config.ts}` and `.spec` siblings; `charts/IChart.ts`, `charts/UPlotChart.tsx`, `charts/Histogram.tsx`, `charts/StatTiles.tsx`; `tabs/MathProfileTab.tsx`; `MathAnalyticsPane.tsx`.
- Modify: `studio/frontend/src/plugins/index.ts` (register), `studio/frontend/src/styles.css` (chart color tokens), `studio/frontend/package.json` (add `uplot`).
- Test: `.spec.tsx`/`.spec.ts` for reducers, restClient, MathProfileTab, and the chart adapters.

**Interfaces:**
- `IMathRun` TS type mirrors `MathRunDoc` wire (camelCase).
- `restClient.fetchRuns(gameId): Promise<IMathRun[]>`, `fetchRun(id): Promise<IMathRun>`.
- `IChart` seam: `interface IChart { mount(el: HTMLElement, data: IChartData): void; update(data: IChartData): void; destroy(): void }` with a uPlot-backed impl for line/band series and hand-rolled SVG components (`Histogram`, `StatTiles`, gene heatmap) for bespoke marks. Keep uPlot construction behind the seam so tests target `IChart`, not uPlot.
- Plugin registration mirrors `plugins/tuner/index.ts` exactly (`IPlugin<IAnalyticsState>`, one pane `math-analytics/viewer`, one command `math-analytics/open-viewer`).

- [ ] **Step 1: Write the failing tests** — (a) reducer test: `runLoaded` action stores an `IMathRun`; (b) restClient test: `fetchRuns` calls `GET /analytics/runs?gameId=…` (mock fetch) and returns typed runs; (c) MathProfileTab test (React Testing Library): given an `IMathRun` with a `profile`, it renders the win-distribution histogram bars, the tail stat tiles (max win, P(≥100×)), and the RTP-composition bar; assert on `data-testid`s (`win-distribution`, `tail-tiles`, `rtp-composition`, `rtp-convergence`, `hit-by-band`). Fill-to-pane: assert the root has the no-scroll container class.
- [ ] **Step 2: Run** `cd studio/frontend && npx vitest run src/plugins/math-analytics` → FAIL.
- [ ] **Step 3: Implement** the scaffold (mirror `plugins/tuner` file-for-file), the `IChart` seam + adapters, and `MathProfileTab` composing the five Math Profile charts from the mockup (hero win-distribution histogram with base/feature/tail color roles, tail tiles, composition, hit-by-band, RTP convergence). Register the plugin in `plugins/index.ts`. Add color tokens to `styles.css`.
- [ ] **Step 4: Run** vitest → PASS. Then the four frontend gates ([[frontend-ci-gates]]): `node_modules/.bin/prettier --check .`, `nx typecheck`, `vitest run`, `nx build` (use the pinned prettier, not npx — [[pinned-prettier-not-npx]]).
- [ ] **Step 5: Commit** `feat(studio): math-analytics plugin scaffold + Math Profile tab`.

---

### Task 1.11: e2e — Math Profile renders from a seeded run

**Files:**
- Create: `studio/frontend/e2e/math-analytics-profile.spec.ts`
- Create/modify: replay fixture seeding a `math_runs` doc for the e2e game (mirror how other panes seed replay state; see [[e2e-scene-seeding-and-board-gotchas]] and `tests/fixtures`).

**Interfaces:** drive the real pane end-to-end against the replay backend.

- [ ] **Step 1: Write the failing e2e** — open the studio, open the Math Analytics pane for a game with a seeded run, switch to Math Profile, assert the win-distribution histogram, tail tiles, and RTP-convergence are visible and reflect the seeded numbers (assert observable end-state, not an event — [[assert-end-state-not-dispatch]]). Assert the tab does not scroll (content height ≤ pane height).
- [ ] **Step 2: Run** against replay: start `just backend-serve-replay` (in this worktree use its `BLOOM_PORT_OFFSET` ports — [[worktree-independent-ports]]), then `just e2e` filtered to the new spec → FAIL.
- [ ] **Step 3: Implement** the fixture seeding + any missing `data-testid`s.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `test(studio): e2e math profile renders from seeded math_runs`.

**Phase 1 gate:** run `cargo test` (workspace), the backend suite, the four frontend gates, and the new e2e. Request a task review, then a phase review.

---

## PHASE 2 — Live Evolution

Delivers the enriched live progress relay and the **Evolution** tab (live + scrubber).

### Task 2.1: Analytics live progress relay

**Files:**
- Modify: `studio/backend/app/tuner/hub.py` (also emit enriched progress on the analytics room) or add a thin relay in `AnalyticsHub`
- Test: `studio/backend/tests/test_analytics_live.py`

**Interfaces:** during a tune, emit `analytics_progress` `{gameId, generation, maxGenerations, best:{fitness,rtp,volatility}, population:{…}, geneAgreement:[…]}` to room `game_id` on each generation (source: the enriched `TuneProgress`). Ephemeral; not persisted.

- [ ] **Step 1: Write the failing test** — a fake `sio` + a `FakeTunerRunner` (see `app/tuner/runner.py`) emitting two enriched `TuneProgress` frames; assert two `analytics_progress` emits with `population.diversity` present, then a final `run_complete`. RED.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the relay (reuse the existing `on_progress` callback in `TunerHub.request_tune`; add an analytics emit alongside `tuning_progress`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(backend): relay enriched GA progress on the analytics socket`.

### Task 2.2: Evolution tab (live) — fitness landscape, homing, gene heatmap, scrubber

**Files:**
- Create: `studio/frontend/src/plugins/math-analytics/tabs/EvolutionTab.tsx`, `charts/FitnessLandscape.tsx` (uPlot band+line), `charts/GeneHeatmap.tsx` (SVG/CSS), `charts/Scrubber.tsx`; `socketClient.ts` (+ `.spec`).
- Modify: `state.ts`/`reducers.ts`/`actions.ts` (append live frames; `selectedGeneration` for the scrubber).
- Test: `.spec` for the reducer (append frame, scrub selects a generation), FitnessLandscape adapter, EvolutionTab render.

**Interfaces:**
- `socketClient` subscribes `join_analytics`, listens `analytics_progress` → dispatch `progressFrame`, `run_complete` → dispatch `runLoaded`.
- Reducer keeps `frames: IGenFrame[]` and `selectedGeneration: number | 'live'`; the scrubber sets `selectedGeneration`; charts render the selected frame (or the latest when live).

- [ ] **Step 1: Write the failing tests** — reducer: `progressFrame` appends and, in live mode, advances the playhead; `scrubTo(n)` pins the selected generation. EvolutionTab: given frames, renders `fitness-landscape`, `rtp-homing`, `vol-homing`, `gene-heatmap`, `scrubber` testids; the gene heatmap has one row per `geneAgreement` entry. Fill-to-pane no-scroll assertion.
- [ ] **Step 2: Run** vitest filtered → FAIL.
- [ ] **Step 3: Implement** the tab + charts (mirror the approved mockup: hero fitness landscape with population band + best line + playhead; RTP/vol homing with target bands; gene heatmap warming with agreement; scrubber). Wire `socketClient`.
- [ ] **Step 4: Run** vitest + four frontend gates → PASS.
- [ ] **Step 5: Commit** `feat(studio): live Evolution tab with fitness landscape, gene heatmap, scrubber`.

### Task 2.3: e2e — live Evolution during a replay tune

**Files:** Create `studio/frontend/e2e/math-analytics-evolution.spec.ts`; replay cassette for an enriched tune stream (hand-authored from static analysis if no live session — [[tuner-agent-status]]).

- [ ] **Step 1: Write the failing e2e** — trigger a tune (or replay a recorded enriched stream), assert the Evolution tab shows progressing generations (fitness landscape updates, gene heatmap warms), then freezes into a `run_complete` state; scrub back to an earlier generation and assert the charts change. Assert observable end-state.
- [ ] **Step 2: Run** replay e2e → FAIL.
- [ ] **Step 3: Implement** the cassette + testids.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `test(studio): e2e live Evolution tab over replay tune`.

**Phase 2 gate:** full test sweep + task/phase review.

---

## PHASE 3 — Compare + Report

Delivers cross-run comparison and the exportable report.

### Task 3.1: Run selector over history

**Files:** Modify `state.ts`/`actions.ts`/`reducers.ts`/`restClient.ts`; create `components/RunSelector.tsx` (+spec).

**Interfaces:** `fetchRuns(gameId)` populates a history list; `selectedRunIds: string[]` (multi-select for Compare, single for the header selector). Reducer actions `historyLoaded`, `toggleRunSelected`, `selectRun`.

- [ ] **Step 1** Write failing reducer + RunSelector tests (load history, toggle multi-select cap at e.g. 5, single-select for header). → RED.
- [ ] **Step 2** Run vitest → FAIL.
- [ ] **Step 3** Implement selector + reducers.
- [ ] **Step 4** vitest + gates → PASS.
- [ ] **Step 5** Commit `feat(studio): math-analytics run history selector`.

### Task 3.2: Compare tab

**Files:** Create `tabs/CompareTab.tsx`, `charts/OverlayLines.tsx` (uPlot multi-series), `components/DeltaTable.tsx` (+specs).

**Interfaces:** given N selected `IMathRun`, render overlaid RTP-convergence and overlaid volatility curves (one color-role per run) + a delta table (RTP, volatility, hit freq, max win, generations-to-converge, verdict).

- [ ] **Step 1** Write failing CompareTab test (2 runs → two series in each overlay, table has one column per run with the six rows). Fill-to-pane assertion. → RED.
- [ ] **Step 2** vitest → FAIL.
- [ ] **Step 3** Implement (mirror the approved Compare mockup).
- [ ] **Step 4** vitest + gates → PASS.
- [ ] **Step 5** Commit `feat(studio): Compare tab with overlaid curves + delta table`.

### Task 3.3: Report tab + export

**Files:** Create `tabs/ReportTab.tsx` (+spec); add an export util `lib/exportReport.ts` (+spec). Add the export library to `package.json` behind a thin seam (proven-library principle — [[prefer-proven-libraries]]); choose a self-contained client-side HTML→PDF/PNG approach.

**Interfaces:** `ReportTab` is the one scrollable tab: summary tiles + every chart stacked + the config used. `exportReport(el): Promise<Blob>` renders the report DOM to PDF/PNG.

- [ ] **Step 1** Write failing tests — ReportTab renders all sections (`summary`, `evolution`, `gene-convergence`, `win-distribution`, `tail`, `rtp-convergence`, `config`) and IS scrollable (root has the scroll container class, unlike other tabs); `exportReport` returns a non-empty Blob for a simple element (mock the lib at the seam). → RED.
- [ ] **Step 2** vitest → FAIL.
- [ ] **Step 3** Implement ReportTab + export seam.
- [ ] **Step 4** vitest + gates → PASS.
- [ ] **Step 5** Commit `feat(studio): scrollable Report tab with PDF/PNG export`.

### Task 3.4: e2e — Compare + Report

**Files:** Create `studio/frontend/e2e/math-analytics-compare-report.spec.ts`; seed ≥2 `math_runs` for the game.

- [ ] **Step 1** Write failing e2e — select two runs, assert Compare shows two overlaid series + a two-column delta table; open Report, assert it scrolls and the Export button triggers a download (assert the download event / blob). Observable end-state. → RED.
- [ ] **Step 2** Run replay e2e → FAIL.
- [ ] **Step 3** Implement fixtures + testids.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `test(studio): e2e Compare overlays + Report export`.

**Phase 3 gate:** full sweep (`cargo test`, backend suite, four frontend gates, all math-analytics e2e) + whole-branch review, then finish the branch (PR).

---

## Self-Review (author checklist — completed)

**Spec coverage:** Evolution tab → 2.2/2.3; Math Profile (win distribution, tail, composition, hit-by-band, RTP convergence) → 1.1/1.2/1.10/1.11; Compare + history → 3.1/3.2; Report + export → 3.3; append-only `math_runs` → 1.8/1.9; live streaming → 2.1/2.2; Rust telemetry (population + gene agreement + profile) → 1.1–1.5; charting seam (uPlot + SVG) → 1.10; design-language/token discipline → 1.10; summaries-not-raw → enforced by the histogram/quantile/downsample APIs; determinism preserved → explicit test in 1.4. The two flagged open items are pinned: **diversity** = normalized population fitness std-dev (Task 1.3, golden test); **histogram binning** = fixed log edges in `log_bins()` (Task 1.1, golden test).

**Placeholder scan:** No TBD/TODO. Backend/frontend tasks that mirror an existing file cite the exact file to copy and give real interfaces + real test assertions; the Rust core tasks carry complete code. The export library is deliberately chosen at Task 3.3 behind a seam (phasing decision, not a gap).

**Type consistency:** `RoundSample` fields match `measure.rs`; `WinDistribution`/`TailMetrics`/`RtpPoint` names are identical across Rust (1.1/1.2), the `RunProfile`/`GenSnapshot` extensions (1.4), the NDJSON (1.5), the pydantic `*Wire` models (1.6), and the TS `IMathRun` (1.10). camelCase alias `pGE100x` is called out explicitly where Python's auto-camel would mangle it.
