# Noise-Aware Math Verdicts + GA Re-Centering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both math gates (tuner confirm + simulator verify) statistically consistent — pass iff the measurement misses the target band by ≤ 2·SE — and give the GA a centering objective so borderline in-band seeds no longer stop at gen 0 untouched.

**Architecture:** SE formulas + a `K_SIGMA = 2.0` constant live in `bloom-simulator` (`target.rs`); `verify` gains an `n` parameter and applies the allowance; the tuner's fitness ranks in-band candidates by distance-to-center (strictly above all out-of-band candidates) and its feasible stop moves to a stagnation-gated fresh-panel confirm. SE rides the wire additively (`se` object) from both binaries through pydantic to the ResultStrip, which renders `±2·SE` and a "within noise" chip.

**Tech Stack:** Rust (bloom-simulator, bloom-tuner), Python/FastAPI + pydantic (studio/backend), React/TypeScript + vitest (studio/frontend), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-05-noise-aware-verdicts-design.md` (approved). Read it first.

## Global Constraints

- **Worktree only:** all work in `C:\code\bloom.wt\noise-aware-verdicts` (branch `feat/noise-aware-verdicts`, `BLOOM_PORT_OFFSET=1` → backend :8001, frontend :4201). NEVER touch `C:\code\bloom` or default ports :8000/:4200/:4300 — another session may hold them.
- **Worktree setup (once, before Task 1):** `npm install` at the worktree root (fresh worktrees have no `node_modules`), and `uv sync --directory studio/backend` if backend deps aren't materialized. E2e (Task 9) additionally needs `cargo build --release -p bloom-simulator -p bloom-tuner`.
- `K_SIGMA = 2.0` — a `const` in `bloom-simulator`, no config knob.
- Verdict strings on every wire stay exactly `pass` / `near_miss` / `fail` / `error`; `StopReason` strings stay exactly `feasible` / `stagnated` / `budget`.
- The `se` wire field is **additive and optional** everywhere — old persisted runs/cassettes without it must still parse and render.
- Semantic commits (`feat(math): …`, `test(math): …`). TDD: write the failing test, watch it fail, minimal code, watch it pass, commit.
- Rust gates before any Rust commit: `cargo fmt --check` and `cargo clippy --workspace --all-targets` (a previous merge was burned by fmt-only CI failure).
- Frontend gates before any frontend commit: `node_modules/.bin/prettier --check .` (pinned — NEVER `npx prettier`), `npx nx run studio-frontend:typecheck`, `:test`, `:build` (vitest green alone is NOT enough).
- Seed-pinned determinism: tuner tests use fixed master seeds. If a specific pinned seed stops with the wrong reason after a behavior change, re-pin the seed or the test-local cfg (that is expected maintenance, noted per task) — never loosen an assertion to "any stop reason".

---

### Task 1: `MetricSE` + `standard_errors` + `K_SIGMA` + `outside` (simulator)

**Files:**

- Modify: `studio/simulator/src/target.rs`
- Test: same file (`#[cfg(test)] mod tests` — the file has none yet; add it)

**Interfaces:**

- Consumes: existing `Metrics` struct (`target.rs:6`).
- Produces (used by Tasks 2–6):
  - `pub const K_SIGMA: f64 = 2.0;`
  - `pub struct MetricSE { pub rtp: f64, pub volatility: f64, pub bonus_hit_rates: Vec<f64> }`
  - `pub fn standard_errors(m: &Metrics, n: usize) -> MetricSE`
  - `pub fn outside(x: f64, lo: f64, hi: f64) -> f64` (distance outside `[lo, hi]`, 0 inside)

- [ ] **Step 1: Write the failing tests** — append to `studio/simulator/src/target.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn metrics(rtp: f64, vol: f64, bonus: Vec<f64>) -> Metrics {
        Metrics {
            rtp,
            volatility: vol,
            hit_frequency: 0.3,
            bonus_hit_rates: bonus,
            base_rtp: rtp,
            feature_rtp: 0.0,
        }
    }

    #[test]
    fn se_rtp_is_volatility_over_sqrt_n() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![]), 200_000);
        assert!((se.rtp - 2.8 / (200_000f64).sqrt()).abs() < 1e-12);
        // the live-diagnosis number from the spec: ≈ 0.00626
        assert!((se.rtp - 0.00626).abs() < 1e-4);
    }

    #[test]
    fn se_volatility_uses_2n_normal_approximation() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![]), 200_000);
        assert!((se.volatility - 2.8 / (400_000f64).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn se_hit_rates_are_binomial_per_bonus() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![0.02, 0.5]), 10_000);
        assert!((se.bonus_hit_rates[0] - (0.02f64 * 0.98 / 10_000.0).sqrt()).abs() < 1e-12);
        assert!((se.bonus_hit_rates[1] - (0.25f64 / 10_000.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn zero_n_is_finite_not_nan() {
        let se = standard_errors(&metrics(0.9, 1.0, vec![0.1]), 0);
        assert!(se.rtp.is_finite());
        assert!(se.volatility.is_finite());
        assert!(se.bonus_hit_rates[0].is_finite());
    }

    #[test]
    fn outside_measures_distance_beyond_the_band() {
        assert_eq!(outside(0.5, 1.0, 10.0), 0.5);
        assert_eq!(outside(12.0, 1.0, 10.0), 2.0);
        assert_eq!(outside(5.0, 1.0, 10.0), 0.0);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (worktree root): `cargo test -p bloom-simulator target::`
Expected: COMPILE ERROR — `standard_errors`, `outside`, `MetricSE` not found.

- [ ] **Step 3: Write the implementation** — add to `studio/simulator/src/target.rs` (above the structs is fine):

```rust
/// Verdicts allow a band miss of up to K_SIGMA standard errors (~95%
/// two-sided). Shared by the simulator's verify and the tuner's confirm so
/// the two gates can never disagree on the rule.
pub const K_SIGMA: f64 = 2.0;

/// Distance of `x` outside `[lo, hi]` (0 if inside).
pub fn outside(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo - x
    } else if x > hi {
        x - hi
    } else {
        0.0
    }
}

/// Standard errors of the measured metrics over an n-sample population.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricSE {
    /// SE of the RTP estimate: volatility / √n (exact — RTP is a sample mean).
    pub rtp: f64,
    /// SE of the volatility estimate: volatility / √(2n). Normal
    /// approximation — optimistic for heavy-tailed payouts, harmless because
    /// the volatility bands are whole units wide (spec §2).
    pub volatility: f64,
    /// SE of each bonus hit-rate estimate: √(p(1−p)/n) (binomial).
    pub bonus_hit_rates: Vec<f64>,
}

pub fn standard_errors(m: &Metrics, n: usize) -> MetricSE {
    let nf = (n as f64).max(1.0);
    MetricSE {
        rtp: m.volatility / nf.sqrt(),
        volatility: m.volatility / (2.0 * nf).sqrt(),
        bonus_hit_rates: m
            .bonus_hit_rates
            .iter()
            .map(|&p| (p * (1.0 - p) / nf).sqrt())
            .collect(),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-simulator target::`
Expected: 5 passed.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt
cargo clippy -p bloom-simulator --all-targets
git add studio/simulator/src/target.rs
git commit -m "feat(math): standard errors + K_SIGMA in bloom-simulator"
```

---

### Task 2: Noise-aware `verify(metrics, target, n)`

**Files:**

- Modify: `studio/simulator/src/run.rs` (verify at :16, caller at :102, tests at :315-343)
- Modify: `studio/tuner/src/genetic.rs:364` (mechanical call-site update — keeps the workspace compiling)
- Modify: `studio/tuner/src/fitness.rs:128-145` (`zero_fitness_iff_verify_passes` call sites — mechanical, test retired properly in Task 5)

**Interfaces:**

- Consumes: `standard_errors`, `K_SIGMA`, `outside` from Task 1.
- Produces (used by Tasks 3–5): `pub fn verify(metrics: &Metrics, target: &TargetSpec, n: usize) -> Result<(), Metrics>` — passes iff **every** band miss ≤ `K_SIGMA · SE` for that metric. Err still carries the metrics clone.

- [ ] **Step 1: Write the failing tests** — in `studio/simulator/src/run.rs` tests module, add (keep the existing verify tests; they get their `n` argument in step 3):

```rust
    // Noise-aware boundary: rtp measured 0.978 vs band 0.95–0.97 (miss 0.008),
    // volatility 2.0. At n = 160_000, SE_rtp = 2/400 = 0.005 → allowance 0.01
    // ≥ 0.008 → PASS. At n = 4_000_000, SE_rtp = 0.001 → allowance 0.002 → FAIL.
    #[test]
    fn rtp_miss_within_2_se_passes() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.978, 2.0, vec![]), &t, 160_000).is_ok());
    }

    #[test]
    fn rtp_miss_beyond_2_se_fails() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.978, 2.0, vec![]), &t, 4_000_000).is_err());
    }

    #[test]
    fn hit_rate_miss_within_2_se_passes() {
        // rate 0.06 vs band 0–0.05 (miss 0.01); at n=100, SE=√(.06·.94/100)
        // ≈ 0.0237 → allowance ≈ 0.0475 → PASS.
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.06]), &t, 100).is_ok());
    }

    #[test]
    fn hit_rate_miss_beyond_2_se_fails() {
        // same miss at n=10_000: SE ≈ 0.0024 → allowance ≈ 0.0047 → FAIL.
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.06]), &t, 10_000).is_err());
    }

    #[test]
    fn the_live_contradiction_case_now_passes() {
        // Spec §1: verify read 0.9819 vs band 0.960–0.970 at 200k spins,
        // vol 2.8 → miss 0.0119 ≤ 2·SE (0.0125) → PASS (was FAIL).
        let t = TargetSpec {
            rtp_target: 0.965,
            rtp_tolerance: 0.005,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 100,
            candidate_count: 200_000,
            realized_correction_band: 0.05,
        };
        assert!(verify(&metrics(0.9819, 2.8, vec![]), &t, 200_000).is_ok());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bloom-simulator run::`
Expected: COMPILE ERROR — verify takes 2 arguments.

- [ ] **Step 3: Implement** — replace `verify` in `studio/simulator/src/run.rs:16-37` with:

```rust
/// Check measured metrics against the target bands (RTP, volatility, and EACH
/// feature's hit-rate), allowing a miss of up to K_SIGMA standard errors of
/// the n-sample measurement — a sub-SE band miss is statistical noise, not a
/// defect (spec 2026-07-05-noise-aware-verdicts-design.md). Err carries the
/// metrics so the caller can see what missed. The band count must equal the
/// feature count.
pub fn verify(metrics: &Metrics, target: &TargetSpec, n: usize) -> Result<(), Metrics> {
    assert_eq!(
        target.bonus_hit_rate_bands.len(),
        metrics.bonus_hit_rates.len(),
        "target must provide one hit-rate band per model bonus"
    );

    let se = standard_errors(metrics, n);
    let rtp_lo = target.rtp_target - target.rtp_tolerance;
    let rtp_hi = target.rtp_target + target.rtp_tolerance;
    let rtp_ok = outside(metrics.rtp, rtp_lo, rtp_hi) <= K_SIGMA * se.rtp;
    let vol_ok = outside(
        metrics.volatility,
        target.volatility_min,
        target.volatility_max,
    ) <= K_SIGMA * se.volatility;
    let bonuses_ok = target
        .bonus_hit_rate_bands
        .iter()
        .zip(metrics.bonus_hit_rates.iter().zip(&se.bonus_hit_rates))
        .all(|(band, (&rate, &se_hit))| outside(rate, band.min, band.max) <= K_SIGMA * se_hit);

    if rtp_ok && vol_ok && bonuses_ok {
        Ok(())
    } else {
        Err(metrics.clone())
    }
}
```

Update the import at the top of `run.rs`:

```rust
use crate::target::{outside, standard_errors, Metrics, TargetSpec, K_SIGMA};
```

Update the internal caller at `run.rs:102`:

```rust
    if let Err(m) = verify(&metrics, target, samples.len()) {
```

Update the existing verify unit tests (run.rs:315-343) to pass `n = 1_000_000` (SE ≈ 0 there, so their strict-band intent is preserved — e.g. vol 0.5 vs band 1–10 misses by 0.5 ≫ 2·0.5/√(2·10⁶)):

```rust
    #[test]
    fn within_all_bands_passes() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.02]), &t, 1_000_000).is_ok());
    }

    #[test]
    fn rtp_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.80, 3.0, vec![]), &t, 1_000_000).is_err());
    }

    #[test]
    fn volatility_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.955, 0.5, vec![]), &t, 1_000_000).is_err());
    }

    #[test]
    fn feature_hit_rate_out_of_band_fails() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.20]), &t, 1_000_000).is_err());
    }
```

Mechanical cross-crate call-site updates (behavior of these gates becomes noise-aware here; their structure changes in Tasks 4–5):

`studio/tuner/src/genetic.rs:364`:

```rust
    let verdict = match verify(&metrics, target, final_samples.len()) {
```

`studio/tuner/src/fitness.rs` test `zero_fitness_iff_verify_passes` (:128-145) — both `verify(&pass, &t)` / `verify(&fail, &t)` calls become `verify(&pass, &t, 1_000_000)` / `verify(&fail, &t, 1_000_000)` (the equivalence still holds at those points; the test is retired for real in Task 5).

- [ ] **Step 4: Run the workspace tests**

Run: `cargo test --workspace`
Expected: all pass (the tuner's seed-pinned tests still pass — verify only widened; if one flips verdict on its pinned seed, re-pin per Global Constraints).

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt
cargo clippy --workspace --all-targets
git add studio/simulator/src/run.rs studio/tuner/src/genetic.rs studio/tuner/src/fitness.rs
git commit -m "feat(math): noise-aware verify — pass iff band miss <= 2*SE"
```

---

### Task 3: `curate_json` emits `se`

**Files:**

- Modify: `studio/simulator/src/bin/curate_json.rs` (result_line at :43-64, main at :133-169, tests at :194-239)

**Interfaces:**

- Consumes: `standard_errors`, `MetricSE` from Task 1.
- Produces (parsed by Task 7): result line gains top-level `"se": {"rtp": f64, "volatility": f64, "bonusHitRates": [f64]}` alongside the existing flat metrics keys.

- [ ] **Step 1: Write the failing test** — in `curate_json.rs` tests module:

```rust
    #[test]
    fn result_line_carries_se() {
        let metrics = Metrics {
            rtp: 0.95,
            volatility: 2.5,
            hit_frequency: 0.35,
            bonus_hit_rates: vec![0.1],
            base_rtp: 0.60,
            feature_rtp: 0.35,
        };
        let se = bloom_simulator::target::standard_errors(&metrics, 10_000);
        let s = result_line("pass", &metrics, &se, Some(0.961), Some(1000), None);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!((v["se"]["rtp"].as_f64().unwrap() - 2.5 / 100.0).abs() < 1e-12);
        assert!(v["se"]["volatility"].as_f64().unwrap() > 0.0);
        assert_eq!(v["se"]["bonusHitRates"].as_array().unwrap().len(), 1);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-simulator --bin curate_json`
Expected: COMPILE ERROR — result_line takes 5 arguments.

- [ ] **Step 3: Implement** — change `result_line` (curate_json.rs:43) to take the SE:

```rust
fn result_line(
    status: &str,
    metrics: &bloom_simulator::target::Metrics,
    se: &bloom_simulator::target::MetricSE,
    realized_rtp: Option<f64>,
    pool_size: Option<usize>,
    failure: Option<&str>,
) -> String {
    serde_json::json!({
        "type": "result",
        "status": status,
        "rtp": metrics.rtp,
        "volatility": metrics.volatility,
        "hitFrequency": metrics.hit_frequency,
        "baseRtp": metrics.base_rtp,
        "featureRtp": metrics.feature_rtp,
        "bonusHitRates": metrics.bonus_hit_rates,
        "se": {
            "rtp": se.rtp,
            "volatility": se.volatility,
            "bonusHitRates": se.bonus_hit_rates,
        },
        "realizedRtp": realized_rtp,
        "poolSize": pool_size,
        "failure": failure,
    })
    .to_string()
}
```

In `main` (before the final `emit`), compute and pass it — metrics are measured over `candidate_count` samples:

```rust
    let se = bloom_simulator::target::standard_errors(m, target.candidate_count);
    emit(result_line(
        status,
        m,
        &se,
        realized,
        pool_size,
        failure.as_deref(),
    ));
```

Update the two existing result_line tests (`result_line_pass_shape` at :195, `result_line_fail_shape` at :220) to build an SE the same way (`standard_errors(&metrics, 10_000)`) and pass `&se` as the third argument; add one assertion to `result_line_pass_shape`: `assert!(v["se"]["rtp"].is_number());`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p bloom-simulator --bin curate_json`
Expected: all pass.

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt
cargo clippy -p bloom-simulator --all-targets
git add studio/simulator/src/bin/curate_json.rs
git commit -m "feat(math): curate_json result line carries measurement SE"
```

---

### Task 4: Tuner stop rework — stagnation-gated confirm

**Files:**

- Modify: `studio/tuner/src/genetic.rs` (loop tail :277-300, loop-head comment :170-177, tests)

**Interfaces:**

- Consumes: `verify(m, t, n)` from Task 2; existing `confirmation_seeds` (#152) and never-worse-than-seed selection (#148) — both stay as-is.
- Produces: same `TuneOutcome`; `StopReason` variants unchanged. Behavior contract for later tasks/e2e: Feasible now only fires after `stagnation_window` flat generations + fresh-panel confirm; confirm-fail resets the stagnation counter (≤ `max_generations / stagnation_window` confirm attempts per run); stagnating with an out-of-band best still stops as `Stagnated` (prefilter).

Note: this task runs on the **old** flat-zero fitness — in-band fitness pins at 0.0, so stagnation counts cleanly and deterministically. Re-centering lands in Task 5.

- [ ] **Step 1: Write the failing tests** — in `genetic.rs` tests module:

```rust
    #[test]
    fn feasible_stop_waits_for_stagnation_not_first_in_band_read() {
        // Old behavior stopped the moment one generation read in-band. Now a
        // run must sit through a full stagnation window first, so a Feasible
        // run always spans at least stagnation_window generations.
        let mut c = cfg(7);
        c.stagnation_window = 6;
        let out = GeneticTuner.tune(&toy(1), &target_09(), &c);
        assert_eq!(out.trace.stop_reason, StopReason::Feasible);
        assert!(
            out.trace.generations_run > c.stagnation_window,
            "stopped after {} generations — before a stagnation window elapsed",
            out.trace.generations_run
        );
    }

    #[test]
    fn in_band_seed_is_not_returned_untouched_at_gen_0() {
        // The live failure: a seed already measuring in-band ended the run at
        // generation 0 with the model byte-identical. The run must now last
        // at least a stagnation window.
        let seed_model = toy(5); // true RTP exactly 0.9 — in-band from gen 0
        let mut c = cfg(7);
        c.stagnation_window = 6;
        let out = GeneticTuner.tune(&seed_model, &target_09(), &c);
        assert!(out.trace.generations_run > 1, "stopped at generation 0/1");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p bloom-tuner genetic::`
Expected: both new tests FAIL (the instant in-band stop ends runs in 1 generation for `toy(5)`, and `toy(1)` stops the generation it first reads in-band).

- [ ] **Step 3: Implement** — in `genetic.rs`, delete the instant-feasible block (:277-292):

```rust
        if scored[0].1 >= 0.0 {
            // ... (whole block through the closing brace of `if fitness(...) >= 0.0 {...}`)
        }
```

and replace the stagnation block (:293-296) with:

```rust
        if stagnation >= cfg.stagnation_window {
            // The search has converged. If the best candidate's own search
            // measurement is (noise-aware) in-band, confirm at final fidelity
            // on a fresh panel before stopping — never on the strength of a
            // low-fidelity read alone. The prefilter keeps hopeless targets
            // (miss ≫ 2·SE even at search fidelity) ending early as Stagnated
            // and skips pointless final-fidelity simulations.
            if verify(&bm, target, cfg.search_candidate_count).is_ok() {
                let candidate = decode(&scored[0].0, seed_model);
                let conf_samples = simulate(
                    &candidate,
                    &confirmation_seeds(cfg.master_seed, g, cfg.final_candidate_count),
                );
                if verify(&measure(&conf_samples), target, cfg.final_candidate_count).is_ok() {
                    feasible = Some((candidate, conf_samples));
                    stop_reason = StopReason::Feasible;
                    break;
                }
                // Confirm failed: give the search another full window rather
                // than re-drawing fresh panels every generation — bounds the
                // confirmation attempts to max_generations / stagnation_window.
                stagnation = 0;
            } else {
                stop_reason = StopReason::Stagnated;
                break;
            }
        }
```

Update the loop-head comment (:170-177) to say feasibility is confirmed **after stagnation** at final fidelity on a fresh panel (the rest of that comment — winner re-measurement — stays true). The `use bloom_simulator::run::verify;` import and everything below the loop (winner selection, verdict, profile) are untouched.

Adapt the existing tests whose timing assumptions changed:

1. `stop_reason_feasible_when_target_reached` (:492) and `converges_a_detuned_model_back_into_band` (:649), `feasible_verdict_is_measured_on_the_confirmation_panel` (:598), `locked_reels_stay_byte_identical_across_a_full_tune` (:741): runs now last `first-in-band gen + stagnation_window`. With `cfg()`'s window of 12 and `max_generations` 40 they should still reach Feasible — run them; if a pinned seed runs past budget, set a test-local `c.stagnation_window = 6` (do NOT change the shared `cfg()` — other tests depend on its exact trajectory only through their own pinned seeds).
2. `noisy_cfg` (:525): `max_generations` 8 with window 12 means the confirm path never fires. Change it so the confirmed-feasibility net (`feasible_stop_is_confirmed_at_final_fidelity`) still exercises:

```rust
    fn noisy_cfg(master_seed: u64) -> TunerConfig {
        let mut c = cfg(master_seed);
        c.search_candidate_count = 60;
        c.final_candidate_count = 50_000;
        c.max_generations = 12;
        c.stagnation_window = 2;
        c
    }
```

3. `feasible_verdict_is_measured_on_the_confirmation_panel` re-derives the panel from `generations_run - 1` — still correct (confirm happens at the stop generation); only the run length changes.

- [ ] **Step 4: Run the tuner suite**

Run: `cargo test -p bloom-tuner`
Expected: all pass, including the two new tests and `stop_reason_stagnated_when_no_improvement` (unreachable RTP 50 misses the search-fidelity allowance by miles → prefilter → Stagnated) and `stop_reason_budget_when_max_generations_exhausted` (window 100 never trips → Budget).

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt
cargo clippy -p bloom-tuner --all-targets
git add studio/tuner/src/genetic.rs
git commit -m "feat(math): tuner confirms feasibility only after stagnation"
```

---

### Task 5: Fitness re-centering + noise-aware `band_misses`

**Files:**

- Modify: `studio/tuner/src/fitness.rs` (fitness :21-35, band_misses :39-75, its private `outside` :10-18, tests)
- Modify: `studio/tuner/src/genetic.rs:367` (band_misses call site)

**Interfaces:**

- Consumes: `outside`, `standard_errors`, `K_SIGMA` from `bloom_simulator::target` (Task 1).
- Produces:
  - `pub fn fitness(m: &Metrics, t: &TargetSpec, w: &Weights) -> f64` — **new semantics:** out-of-band → `−1 − weighted_miss`; in-band → `−center_dist` with `center_dist ∈ [0, 1]` (0 = dead center; RTP + bonus-rate centering only, volatility exempt).
  - `pub fn band_misses(m: &Metrics, t: &TargetSpec, n: usize) -> Vec<BandMiss>` — lists only misses beyond `K_SIGMA · SE` (consistent with `verify`).

- [ ] **Step 1: Write the failing tests** — in `fitness.rs`, DELETE `zero_fitness_iff_verify_passes` (:127-145) and `inside_all_bands_scores_zero` (:115-125), then add:

```rust
    #[test]
    fn dead_center_scores_zero_and_off_center_in_band_scores_below() {
        let t = target(vec![]);
        assert_eq!(fitness(&metrics(0.96, 3.0, vec![]), &t, &weights()), 0.0);
        let off = fitness(&metrics(0.955, 3.0, vec![]), &t, &weights());
        assert!(off < 0.0 && off > -1.0, "in-band off-center: {off}");
    }

    #[test]
    fn in_band_fitness_is_monotone_in_distance_to_center() {
        let t = target(vec![]);
        let near = fitness(&metrics(0.9612, 3.0, vec![]), &t, &weights());
        let far = fitness(&metrics(0.955, 3.0, vec![]), &t, &weights());
        assert!(near > far);
    }

    #[test]
    fn any_in_band_candidate_outranks_any_out_of_band_candidate() {
        let t = target(vec![]);
        // worst in-band (band edge, fitness −1.0) vs best out-of-band
        // (hairline miss just past band-hi 0.97, fitness < −1.0)
        let edge_in = fitness(&metrics(0.95, 3.0, vec![]), &t, &weights());
        let hairline_out = fitness(&metrics(0.9701, 3.0, vec![]), &t, &weights());
        assert!(edge_in > hairline_out);
    }

    #[test]
    fn out_of_band_ordering_is_preserved() {
        let t = target(vec![]);
        let near = fitness(&metrics(0.94, 3.0, vec![]), &t, &weights());
        let far = fitness(&metrics(0.80, 3.0, vec![]), &t, &weights());
        assert!(near > far);
        assert!(near < -1.0 && far < -1.0);
    }

    #[test]
    fn volatility_exerts_no_centering_pull() {
        let t = target(vec![]);
        let low = fitness(&metrics(0.955, 2.0, vec![]), &t, &weights());
        let high = fitness(&metrics(0.955, 8.0, vec![]), &t, &weights());
        assert_eq!(low, high);
    }

    #[test]
    fn bonus_rates_center_toward_the_band_midpoint() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        let centered = fitness(&metrics(0.96, 3.0, vec![0.025]), &t, &weights());
        let edgy = fitness(&metrics(0.96, 3.0, vec![0.048]), &t, &weights());
        assert!(centered > edgy);
    }

    #[test]
    fn band_misses_ignores_sub_2_se_misses() {
        // rtp 0.978 vs band 0.95–0.97 (miss 0.008), vol 2.0:
        // n=160_000 → allowance 0.01 → no miss; n=4_000_000 → allowance
        // 0.002 → "rtp" reported. (Mirrors the verify boundary tests.)
        let t = target(vec![]);
        let m = metrics(0.978, 2.0, vec![]);
        assert!(band_misses(&m, &t, 160_000).is_empty());
        let misses = band_misses(&m, &t, 4_000_000);
        assert_eq!(misses.len(), 1);
        assert_eq!(misses[0].metric, "rtp");
    }

    #[test]
    fn band_misses_agrees_with_verify() {
        use bloom_simulator::run::verify;
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        for (m, n) in [
            (metrics(0.978, 2.0, vec![0.02]), 160_000usize),
            (metrics(0.978, 2.0, vec![0.02]), 4_000_000),
            (metrics(0.955, 3.0, vec![0.20]), 1_000_000),
            (metrics(0.955, 3.0, vec![0.02]), 1_000_000),
        ] {
            assert_eq!(
                band_misses(&m, &t, n).is_empty(),
                verify(&m, &t, n).is_ok(),
                "band_misses and verify disagree at n={n}"
            );
        }
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p bloom-tuner fitness::`
Expected: COMPILE ERROR — band_misses takes 2 arguments; then (after a signature-only stub) the centering tests FAIL against the flat-zero fitness.

- [ ] **Step 3: Implement** — replace the whole top of `fitness.rs` (docs, `outside`, `fitness`, `band_misses`) with:

```rust
//! The GA objective. Out-of-band: a weighted sum of each metric's normalized
//! distance outside its target band, offset below −1 so every in-band
//! candidate strictly outranks every out-of-band one. In-band: normalized
//! distance to the band centers (RTP + bonus rates; volatility bands are
//! semantic ranges with no point target), so the search keeps centering
//! instead of parking on a band edge. `fitness == 0.0` ⟺ dead center.

use crate::config::Weights;
use crate::outcome::BandMiss;
use bloom_simulator::target::{outside, standard_errors, Metrics, TargetSpec, K_SIGMA};

/// `fitness <= 0`; `0.0` at dead center. In-band values lie in `[-1, 0]`,
/// out-of-band values below `-1`.
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

    if d > 0.0 {
        return -1.0 - d;
    }

    // In-band: rank by distance to the band centers. Volatility is exempt —
    // its bands are semantic ranges (e.g. "high" = 10..1e9) whose midpoint is
    // not a design intent.
    let mut center = w.rtp * (m.rtp - t.rtp_target).abs() / t.rtp_tolerance.max(1e-9);
    let mut total_w = w.rtp;
    for (band, &rate) in t.bonus_hit_rate_bands.iter().zip(&m.bonus_hit_rates) {
        let mid = (band.min + band.max) / 2.0;
        let half = ((band.max - band.min) / 2.0).abs().max(1e-9);
        center += w.hit_rate * (rate - mid).abs() / half;
        total_w += w.hit_rate;
    }
    -(center / total_w.max(1e-9)).min(1.0)
}

/// The bands the measured metrics miss by more than `K_SIGMA` standard
/// errors (empty ⟺ the noise-aware `verify` passes). Used to explain a
/// near-miss verdict in the report.
pub fn band_misses(m: &Metrics, t: &TargetSpec, n: usize) -> Vec<BandMiss> {
    let se = standard_errors(m, n);
    let mut out = Vec::new();
    let rtp_lo = t.rtp_target - t.rtp_tolerance;
    let rtp_hi = t.rtp_target + t.rtp_tolerance;
    if outside(m.rtp, rtp_lo, rtp_hi) > K_SIGMA * se.rtp {
        out.push(BandMiss {
            metric: "rtp".into(),
            measured: m.rtp,
            band_lo: rtp_lo,
            band_hi: rtp_hi,
        });
    }
    if outside(m.volatility, t.volatility_min, t.volatility_max) > K_SIGMA * se.volatility {
        out.push(BandMiss {
            metric: "volatility".into(),
            measured: m.volatility,
            band_lo: t.volatility_min,
            band_hi: t.volatility_max,
        });
    }
    for (i, (band, (&rate, &se_hit))) in t
        .bonus_hit_rate_bands
        .iter()
        .zip(m.bonus_hit_rates.iter().zip(&se.bonus_hit_rates))
        .enumerate()
    {
        if outside(rate, band.min, band.max) > K_SIGMA * se_hit {
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

Update the call site in `genetic.rs:367`:

```rust
        Err(_) => Verdict::NearMiss {
            missed: band_misses(&metrics, target, final_samples.len()),
        },
```

Update the two remaining old fitness tests: `closer_to_band_scores_higher` (:148) still passes unchanged (both out-of-band). `band_misses_names_the_missed_metrics` (:156) and `band_misses_empty_when_all_inside` (:169) get `n = 1_000_000` as the third argument (their misses are enormous relative to SE at that n).

- [ ] **Step 4: Run the full tuner suite**

Run: `cargo test -p bloom-tuner`
Expected: all pass. The centering objective makes cross-generation "improvement" noisier (search-fidelity SE exceeds the centering scale), so seed-pinned stop-reason tests may shift on their pinned seeds — if `stop_reason_feasible_when_target_reached` or `converges_a_detuned_model_back_into_band` now exhausts its budget, set that test's local `c.stagnation_window = 6` (Task 4 note) or re-pin the master seed. `tuned_model_never_worse_than_seed_at_final_fidelity` holds by construction (its own `fit` closure uses the new fitness).

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt
cargo clippy -p bloom-tuner --all-targets
git add studio/tuner/src/fitness.rs studio/tuner/src/genetic.rs
git commit -m "feat(math): re-center GA fitness; band_misses honors 2*SE"
```

---

### Task 6: `tune_json` emits `se`

**Files:**

- Modify: `studio/tuner/src/bin/tune_json.rs` (result_line :131-182, tests)

**Interfaces:**

- Consumes: `standard_errors` from Task 1; `TuneOutcome` (metrics measured over `trace.final_candidate_count` samples).
- Produces (parsed by Task 7): the result line's `"metrics"` object gains a nested `"se"` key: `"metrics": {..., "se": {"rtp", "volatility", "bonusHitRates"}}` (nested here because tune_json's metrics are already an object; curate_json's are flat, so its `se` is top-level — Task 3).

- [ ] **Step 1: Write the failing test** — in `tune_json.rs` tests:

```rust
    #[test]
    fn result_line_metrics_carry_se() {
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
        // fixture: vol 3.2 over final_candidate_count 1000 → SE_rtp = 3.2/√1000
        let expected = 3.2 / (1000f64).sqrt();
        assert!((v["metrics"]["se"]["rtp"].as_f64().unwrap() - expected).abs() < 1e-12);
        assert!(v["metrics"]["se"]["volatility"].is_number());
        assert!(v["metrics"]["se"]["bonusHitRates"].is_array());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-tuner --bin tune_json`
Expected: FAIL — `v["metrics"]["se"]["rtp"]` is null.

- [ ] **Step 3: Implement** — in `result_line` (tune_json.rs:131), compute the SE and add it to the metrics object:

```rust
    let se = bloom_simulator::target::standard_errors(&out.metrics, out.trace.final_candidate_count);
```

and in the `json!` block:

```rust
        "metrics": {
            "rtp": out.metrics.rtp,
            "volatility": out.metrics.volatility,
            "hitFrequency": out.metrics.hit_frequency,
            "baseRtp": out.metrics.base_rtp,
            "featureRtp": out.metrics.feature_rtp,
            "bonusHitRates": out.metrics.bonus_hit_rates,
            "se": {
                "rtp": se.rtp,
                "volatility": se.volatility,
                "bonusHitRates": se.bonus_hit_rates,
            },
        },
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p bloom-tuner --bin tune_json`
Expected: all pass (existing shape tests assert presence of keys, not absence of new ones).

- [ ] **Step 5: Gates + commit**

```bash
cargo fmt
cargo clippy -p bloom-tuner --all-targets
git add studio/tuner/src/bin/tune_json.rs
git commit -m "feat(math): tune_json metrics carry measurement SE"
```

---

### Task 7: Backend — `MetricSEWire` pass-through

**Files:**

- Modify: `studio/backend/app/math/models.py` (MetricsWire at :27)
- Modify: `studio/backend/app/math/runners/curate.py` (parse_result_line at :27)
- Modify: `studio/backend/app/math/runners/tune.py` (parse_tune_result_line at :86)
- Test: `studio/backend/tests/test_sim_runner.py`, `studio/backend/tests/test_tuner_runner_parse.py`

**Interfaces:**

- Consumes: Task 3's top-level `se` (curate line) and Task 6's `metrics.se` (tune line).
- Produces (used by Task 8): `MetricsWire.se: MetricSEWire | None` with `MetricSEWire { rtp: float, volatility: float, bonus_hit_rates: list[float] }`; dumps by alias as `"se": {"rtp", "volatility", "bonusHitRates"}` inside every metrics object on the wire (`math_run_wire`, socket events, REST). No hub.py change — the field rides the existing model dumps.

- [ ] **Step 1: Write the failing tests.** In `studio/backend/tests/test_sim_runner.py` add (follow the file's existing parse-test style — it already builds result-line JSON strings):

```python
def test_parse_result_line_carries_se():
    line = json.dumps({
        "type": "result", "status": "pass", "rtp": 0.95, "volatility": 2.5,
        "hitFrequency": 0.35, "baseRtp": 0.6, "featureRtp": 0.35,
        "bonusHitRates": [0.1],
        "se": {"rtp": 0.025, "volatility": 0.0177, "bonusHitRates": [0.003]},
        "realizedRtp": 0.961, "poolSize": 1000, "failure": None,
    })
    r = parse_result_line(line, ran_at="t")
    assert r.metrics.se is not None
    assert r.metrics.se.rtp == 0.025
    assert r.metrics.se.bonus_hit_rates == [0.003]


def test_parse_result_line_without_se_is_none():
    line = json.dumps({
        "type": "result", "status": "pass", "rtp": 0.95, "volatility": 2.5,
        "hitFrequency": 0.35, "baseRtp": 0.6, "featureRtp": 0.35,
        "bonusHitRates": [], "realizedRtp": None, "poolSize": None,
        "failure": None,
    })
    assert parse_result_line(line, ran_at="t").metrics.se is None


def test_metrics_wire_dumps_se_camel_case():
    from app.math.models import MetricSEWire, MetricsWire
    m = MetricsWire(rtp=0.95, volatility=2.5, hit_frequency=0.35, base_rtp=0.6,
                    feature_rtp=0.35, bonus_hit_rates=[0.1],
                    se=MetricSEWire(rtp=0.025, volatility=0.0177, bonus_hit_rates=[0.003]))
    d = m.model_dump(by_alias=True, mode="json")
    assert d["se"] == {"rtp": 0.025, "volatility": 0.0177, "bonusHitRates": [0.003]}
```

In `studio/backend/tests/test_tuner_runner_parse.py` add:

```python
def test_parse_tune_result_line_carries_se():
    line = json.dumps({
        "type": "result", "verdict": "pass", "model": {},
        "metrics": {"rtp": 0.9, "volatility": 3.2, "hitFrequency": 0.4,
                    "baseRtp": 0.9, "featureRtp": 0.0, "bonusHitRates": [],
                    "se": {"rtp": 0.101, "volatility": 0.0716, "bonusHitRates": []}},
        "missed": [], "trace": [], "stopReason": "feasible",
    })
    r = parse_tune_result_line(line, ran_at="t")
    assert r.metrics.se is not None
    assert r.metrics.se.rtp == 0.101


def test_parse_tune_result_line_without_se_is_none():
    line = json.dumps({
        "type": "result", "verdict": "pass", "model": {},
        "metrics": {"rtp": 0.9, "volatility": 3.2, "hitFrequency": 0.4,
                    "baseRtp": 0.9, "featureRtp": 0.0, "bonusHitRates": []},
        "missed": [], "trace": [], "stopReason": "feasible",
    })
    assert parse_tune_result_line(line, ran_at="t").metrics.se is None
```

(Adjust imports to match each test file's existing header — both already import their parser under test; add `json` / model imports only if missing.)

- [ ] **Step 2: Run to verify they fail**

Run (from `studio/backend`): `uv run pytest tests/test_sim_runner.py tests/test_tuner_runner_parse.py -q`
Expected: FAIL — `MetricSEWire` doesn't exist / `MetricsWire` has no field `se`.

- [ ] **Step 3: Implement.** In `models.py`, above `MetricsWire`:

```python
class MetricSEWire(_WireModel):
    """Standard errors of the measured metrics (additive; None on results
    that predate noise-aware verdicts)."""
    rtp: float
    volatility: float
    bonus_hit_rates: list[float] = Field(default_factory=list)
```

and add to `MetricsWire`:

```python
    se: MetricSEWire | None = None
```

In `runners/curate.py`, extend `parse_result_line` (:27):

```python
def parse_result_line(line: str, *, ran_at: str) -> CurationResult:
    d = json.loads(line)
    se_d = d.get("se")
    metrics = MetricsWire(
        rtp=d["rtp"], volatility=d["volatility"], hit_frequency=d["hitFrequency"],
        base_rtp=d["baseRtp"], feature_rtp=d["featureRtp"],
        bonus_hit_rates=d.get("bonusHitRates", []),
        se=MetricSEWire(rtp=se_d["rtp"], volatility=se_d["volatility"],
                        bonus_hit_rates=se_d.get("bonusHitRates", [])) if se_d else None,
    )
```

(import `MetricSEWire` alongside `MetricsWire` in the file's existing `from app.math.models import ...` line; the two `MetricsWire(rtp=0, ...)` error-path constructions at :124/:132 need no change — `se` defaults to None.)

In `runners/tune.py`, extend `parse_tune_result_line` (:86) the same way, reading from inside the metrics object:

```python
    m = d.get("metrics") or {}
    se_d = m.get("se")
    metrics = MetricsWire(
        rtp=m["rtp"], volatility=m["volatility"], hit_frequency=m["hitFrequency"],
        base_rtp=m["baseRtp"], feature_rtp=m["featureRtp"],
        bonus_hit_rates=m.get("bonusHitRates", []),
        se=MetricSEWire(rtp=se_d["rtp"], volatility=se_d["volatility"],
                        bonus_hit_rates=se_d.get("bonusHitRates", [])) if se_d else None,
    )
```

(again add `MetricSEWire` to the models import.)

- [ ] **Step 4: Run the backend suite**

Run (from `studio/backend`): `uv run pytest -q`
Expected: all pass (replay-cassette-based tests parse results without `se` → None; nothing else validates metrics strictly).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/math/models.py studio/backend/app/math/runners/curate.py studio/backend/app/math/runners/tune.py studio/backend/tests/test_sim_runner.py studio/backend/tests/test_tuner_runner_parse.py
git commit -m "feat(math): pass measurement SE through the backend wire"
```

---

### Task 8: Frontend — `±2·SE` + "within noise" chip in ResultStrip

**Files:**

- Modify: `studio/frontend/src/plugins/math/state.ts` (IMetrics at :31)
- Modify: `studio/frontend/src/plugins/math/components/ResultStrip.tsx`
- Test: `studio/frontend/src/plugins/math/components/ResultStrip.spec.tsx`

**Interfaces:**

- Consumes: `metrics.se` from Task 7's wire (`{ rtp, volatility, bonusHitRates }`, camelCase).
- Produces: `export interface IMetricSE { rtp: number; volatility: number; bonusHitRates: number[] }`; `IMetrics.se?: IMetricSE | null`. New testids: `metric-rtp-se` (the `±` cell — kept OUT of `metric-rtp`, whose innerText the e2e parses with `Number(...)`) and `within-noise` (chip).

- [ ] **Step 1: Write the failing tests** — add to `ResultStrip.spec.tsx` (inside the top-level `describe`, using the existing `baseRun` helper):

```tsx
describe('noise-aware SE display', () => {
  const seMetrics = () => ({
    rtp: 0.9819,
    volatility: 2.8,
    hitFrequency: 0.3,
    baseRtp: 0.6,
    featureRtp: 0.3819,
    bonusHitRates: [],
    se: { rtp: 0.0063, volatility: 0.0044, bonusHitRates: [] },
  });

  it('renders ±2·SE beside the measured RTP when se is present', () => {
    mathSlice().runs.set([baseRun({ metrics: seMetrics() })]);
    render(<ResultStrip />);
    expect(screen.getByTestId('metric-rtp').textContent).toBe('0.9819'); // stays Number()-parseable
    expect(screen.getByTestId('metric-rtp-se').textContent).toBe('±0.0126');
  });

  it('omits the ± cell for runs that predate se', () => {
    mathSlice().runs.set([baseRun()]);
    render(<ResultStrip />);
    expect(screen.getByTestId('metric-rtp-se').textContent).toBe('');
  });

  it('shows the within-noise chip when a pass measured outside the band', () => {
    mathSlice().runs.set([baseRun({ metrics: seMetrics(), verdict: 'pass' })]);
    mathSlice().derivedTarget.set({ rtp_target: 0.965, rtp_tolerance: 0.005, volatility_min: 0, volatility_max: 1e9, bonus_hit_rate_bands: [] });
    render(<ResultStrip />);
    expect(screen.getByTestId('within-noise').textContent).toBe('within noise');
    expect(screen.getByTestId('within-noise').title).toContain('2·SE');
  });

  it('omits the chip when the measurement is inside the band', () => {
    mathSlice().runs.set([baseRun({ metrics: { ...seMetrics(), rtp: 0.9612 } })]);
    mathSlice().derivedTarget.set({ rtp_target: 0.96, rtp_tolerance: 0.005, volatility_min: 0, volatility_max: 1e9, bonus_hit_rate_bands: [] });
    render(<ResultStrip />);
    expect(screen.queryByTestId('within-noise')).toBeNull();
  });

  it('omits the chip without se data, even outside the band', () => {
    mathSlice().runs.set([baseRun({ metrics: { ...seMetrics(), se: undefined } })]);
    mathSlice().derivedTarget.set({ rtp_target: 0.965, rtp_tolerance: 0.005, volatility_min: 0, volatility_max: 1e9, bonus_hit_rate_bands: [] });
    render(<ResultStrip />);
    expect(screen.queryByTestId('within-noise')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run (from `studio/frontend`): `npx vitest run src/plugins/math/components/ResultStrip.spec.tsx`
Expected: FAIL — no `metric-rtp-se` / `within-noise` testids (and a TS error on `se` until state.ts is edited).

- [ ] **Step 3: Implement.** In `state.ts`, before `IMetrics`:

```ts
export interface IMetricSE {
  rtp: number;
  volatility: number;
  bonusHitRates: number[];
}
```

and inside `IMetrics`:

```ts
  se?: IMetricSE | null;
```

In `ResultStrip.tsx`, after the `metrics` line (:48) add:

```tsx
const se = metrics?.se ?? null;
const rtpOutsideBand = !!target && !!metrics && Math.abs(metrics.rtp - target.rtp_target) > target.rtp_tolerance;
const volOutsideBand = !!target && !!metrics && (metrics.volatility < target.volatility_min || metrics.volatility > target.volatility_max);
const withinNoise = !running && verdict === 'pass' && se != null && (rtpOutsideBand || volOutsideBand);
```

In the badge row (next to the stop-reason span) add:

```tsx
{
  withinNoise && (
    <span
      data-testid="within-noise"
      title={`Measured outside the target band but within the ±2·SE noise allowance (SE rtp ${se!.rtp.toFixed(4)}). Pass = band miss ≤ 2·SE.`}
      className="text-text-3"
    >
      within noise
    </span>
  );
}
```

In the metrics table, add a `±` cell between the value and band cells of the RTP and Volatility rows (empty when `se` is absent, so old runs render as today):

```tsx
            <tr>
              <td className="pr-4 text-text-2">Measured RTP</td>
              <td data-testid="metric-rtp">{metrics.rtp.toFixed(4)}</td>
              <td data-testid="metric-rtp-se" className="pl-1 text-text-3">
                {se ? `±${(2 * se.rtp).toFixed(4)}` : ''}
              </td>
              <td className="pl-3 text-text-3">
                {target ? `band ${(target.rtp_target - target.rtp_tolerance).toFixed(3)}–${(target.rtp_target + target.rtp_tolerance).toFixed(3)}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Volatility</td>
              <td>{metrics.volatility.toFixed(3)}</td>
              <td className="pl-1 text-text-3">{se ? `±${(2 * se.volatility).toFixed(3)}` : ''}</td>
              <td className="pl-3 text-text-3">
                {target ? `band ${target.volatility_min}–${target.volatility_max >= 1e9 ? '∞' : target.volatility_max}` : ''}
              </td>
            </tr>
            <tr>
              <td className="pr-4 text-text-2">Hit frequency</td>
              <td>{metrics.hitFrequency.toFixed(4)}</td>
              <td />
              <td />
            </tr>
```

(Design-language note: only existing text-tier classes are used — no raw colors.)

- [ ] **Step 4: Run all four frontend gates**

Run (from `studio/frontend` unless noted):

1. `npx vitest run src/plugins/math` — all pass.
2. worktree root: `node_modules/.bin/prettier --check .` — clean (run `--write` on touched files if not).
3. `npx nx run studio-frontend:typecheck` — clean.
4. `npx nx run studio-frontend:build` — clean.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/math/state.ts studio/frontend/src/plugins/math/components/ResultStrip.tsx studio/frontend/src/plugins/math/components/ResultStrip.spec.tsx
git commit -m "feat(math): ResultStrip shows ±2·SE and a within-noise chip"
```

---

### Task 9: Full gates + e2e sweep + known touch-points

**Files:**

- Modify: `studio/frontend/e2e/math-plugin.spec.ts` (comment at :69/:180; possibly the assertion at :196-198)
- Possibly modify: `studio/frontend/e2e/tuner-chat.spec.ts` (mirrors the same seed data)

**Interfaces:**

- Consumes: everything above. Produces: a green branch ready for PR.

- [ ] **Step 1: Build release binaries and run the whole Rust + backend + frontend gate set**

```bash
cargo fmt --check
cargo clippy --workspace --all-targets
cargo test --workspace
cargo build --release -p bloom-simulator -p bloom-tuner
cd studio/backend && uv run pytest -q && cd ../..
node_modules/.bin/prettier --check .
cd studio/frontend && npx nx run studio-frontend:typecheck && npx nx run studio-frontend:test && npx nx run studio-frontend:build && cd ../..
```

Expected: everything green before touching e2e.

- [ ] **Step 2: Update the stale e2e comments.** In `math-plugin.spec.ts` the two comments claiming the DETUNED run "deterministically runs 5 generations" (:69 and :180) are now wrong — the run goes to stagnation before confirming. Update both to say the run now lasts at least a stagnation window of generations (12 with FAST*TUNER_PARAMS) before its fresh-panel confirm, which \_widens* the live `tuning gen` / RUNNING… window those polls rely on. Mirror the same comment fix in `tuner-chat.spec.ts` if it repeats the claim (its seed block mirrors tuner.spec.ts).

- [ ] **Step 3: Run the full Playwright suite against the worktree's replay stack.** From the worktree root, in one terminal (or background):

```bash
just backend-serve-replay
```

then:

```bash
just e2e
```

Expected: the suite that was green on main stays green. Known risk (spec §4): the assertion `measuredRtp` within `0.9 ± FAST_SIM_PARAMS.rtpTolerance` (math-plugin.spec.ts:196-198). FAST params verify at 20k spins; the toy's payout SD ≈ 1.45, so 2·SE ≈ 0.0205 ≈ the 0.02 tolerance — a legitimate noise-pass can land just outside. Everything is seed-pinned, so the outcome is deterministic: **only if it actually fails**, widen exactly that assertion:

```ts
const measuredRtp = Number(await page.getByTestId('metric-rtp').innerText());
// Noise-aware pass: the measurement may exceed the design tolerance by up
// to 2·SE (≈ 1.45/√20000 per side at FAST_SIM_PARAMS fidelity).
const allowance = FAST_SIM_PARAMS.rtpTolerance + 2 * (1.45 / Math.sqrt(FAST_SIM_PARAMS.candidateCount));
expect(measuredRtp).toBeGreaterThanOrEqual(0.9 - allowance);
expect(measuredRtp).toBeLessThanOrEqual(0.9 + allowance);
```

Do NOT pre-emptively widen it — check the deterministic value first.

- [ ] **Step 4: Commit any e2e adjustments**

```bash
git add studio/frontend/e2e/math-plugin.spec.ts studio/frontend/e2e/tuner-chat.spec.ts
git commit -m "test(math): adapt e2e to stagnation-gated feasible stop"
```

- [ ] **Step 5: Push and open the PR**

```bash
git push -u origin feat/noise-aware-verdicts
gh pr create --title "feat(math): noise-aware verdicts + GA re-centering" --body "Implements docs/superpowers/specs/2026-07-05-noise-aware-verdicts-design.md — pass iff band miss <= 2*SE in BOTH gates; GA re-centers in-band instead of gen-0 stopping; SE on the wire + ResultStrip within-noise chip."
```

Then request the whole-branch review per subagent-driven-development before merging.

---

## Verification against the spec (for the final reviewer)

- §3.1 → Tasks 1–3, 6 (K_SIGMA, MetricSE, verify(n), both binaries' `se`).
- §3.2 → Task 5 (fitness split, volatility exempt, invariants replace `zero_fitness_iff_verify_passes`; noise-aware band_misses).
- §3.3 → Task 4 (stagnation-gated confirm, prefilter, reset-on-confirm-fail, #148/#152 machinery untouched).
- §3.4 → Tasks 7–8 (additive wire, ResultStrip, old runs render unchanged).
- §4 blast radius → Task 2 step 4 (frozen templates: verify only widens — nothing to re-freeze), Task 9 (e2e touch-points).
- §5 → every task's RED step.
