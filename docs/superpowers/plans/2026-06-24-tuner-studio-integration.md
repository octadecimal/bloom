# Tuner Studio Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the headless `bloom-tuner` genetic optimizer into the studio so a designer can tune a game's `SlotModel` toward its GDD design intent, watch the search converge live, read a PASS / NEAR-MISS verdict, and apply the tuned model back into the one model-of-record.

**Architecture:** Mirror the simulator-studio integration (PR #67) layer-for-layer. A new additive Rust streaming binary (`tune_json`) wraps the existing GA behind a per-generation progress callback. A new Python `app/tuner` package (models / store / bounds / runner / hub / rest / sockets) invokes it as a subprocess behind a `TunerRunner` Protocol, derives the target by **reusing** the simulator's `derive_target`, reads the seed from the simulator's `SlotModelStore`, and streams progress over Socket.IO. A new `plugins/tuner` Dockview pane drives it and writes the tuned model back via an explicit Apply.

**Tech Stack:** Rust (cargo workspace, `bloom-tuner` / `bloom-simulator` / `bloom-math`), Python (FastAPI + python-socketio + Motor/Mongo + Pydantic v2), TypeScript/React (Hookstate + Dockview + socket.io-client), Playwright e2e.

## Global Constraints

- **Repo root for all commands:** `C:\code\bloom.wt\tuner-studio` (this worktree, `BLOOM_PORT_OFFSET=1` → backend :8001, frontend :4201). Cargo runs from repo root; pytest runs from `studio/backend`; nx/vitest from repo root.
- **TDD mandatory** — failing test first, watch it fail, minimal code, pass, commit. (`AGENTS.md`)
- **Conventional Commits** — `<type>(<scope>): <desc>`, imperative mood.
- **TypeScript interfaces use an `I` prefix** (`ITuningParams`, `ITuneResult`). (`docs/coding-standards.md`)
- **Design language** — 4 surfaces / 2 hairlines / 3 text tiers / 1 accent; `text-success` for PASS, `text-danger`/`text-warning` for near-miss/error; **no raw hex** outside `styles.css` (a guard test blocks it). Mirror `SimulatorPane.tsx` classes exactly.
- **Engine is read-only EXCEPT two additive changes**: `tune_with_progress` (Task 1) and `tune_json` (Task 2). Do **not** alter `Tuner::tune`, the `tune` CLI, `genome.rs`, `fitness.rs`, `config.rs`, `outcome.rs`, or `report.rs` behavior.
- **The tuner optimizes model parameters, never seed selection** — never pass the tuner a seed pool to choose from; `master_seed` flows through config only.
- **Reuse, don't duplicate**: `app.simulator.targets.derive_target` + `TargetGap` (GDD→target), `app.simulator.models.MetricsWire`, and `app.simulator.store.SlotModelStore` (seed + curation params + apply write-back).
- **No edits to `ToolFactory._BUILDERS` or `RoomHub.__init__`** — agent tools are deferred (hot-collision files).
- **Config JSON written for the Rust binary uses snake_case keys** (the Rust structs deserialize snake_case); only the studio HTTP/Socket wire is camelCase.
- **Markdown/spec files** formatted with `npx prettier@3.6.2 --write <files>` (pinned); backtick underscore identifiers in prose.
- **Offline + deterministic** — no replay cassettes; e2e and the Rust integration test run real tunes at tiny candidate counts.

---

## File Structure

**Rust** (`studio/tuner/`):

- `src/genetic.rs` — _modify_: extract the evolve loop into `pub fn tune_with_progress(...)`; `Tuner::tune` delegates with a no-op callback.
- `src/lib.rs` — _modify_: export `tune_with_progress`.
- `src/bin/tune_json.rs` — _create_: NDJSON streaming binary (per-generation progress + final result on stdout).

**Backend** (`studio/backend/app/tuner/`, new package):

- `__init__.py` — _create_ (empty).
- `models.py` — wire models (`TuningParams`, `TuneWeights`, `TuneResult`, `BandMissWire`, `GenSnapshotWire`, `TunerJobDoc`), `default_tuning_params`, `tuner_wire`.
- `store.py` — `TunerStore` (Mongo `tuner_jobs`).
- `bounds.py` — `derive_bounds(model)` + `build_config(params, bounds)` (pure → Rust input contract).
- `runner.py` — `TunerRunner` Protocol + `SubprocessTunerRunner` + `FakeTunerRunner` + `TuneProgress` + `parse_tune_result_line` + `build_tuner_runner`.
- `hub.py` — `TunerHub` (reuses `derive_target`, `SlotModelStore`).
- `rest.py` — routers (`/games/{id}/tuner`, `/seed`, `/target`, `/tune`, `/apply`, `/result`).
- `sockets.py` — `register_tuner_handlers`.
- `app/config.py` — _modify_: add `tuner_bin: str = ""`.
- `app/main.py` — _modify_: wire the package into `build()`.

**Frontend** (`studio/frontend/src/plugins/tuner/`, new plugin):

- `config.ts`, `state.ts`, `restClient.ts`, `reducers.ts`, `socketClient.ts`, `actions.ts`, `TunerPane.tsx`, `index.ts`.
- `src/plugins/index.ts` — _modify_: register `tuner`.
- `src/app/routes/RoomRoute.tsx` — _modify_: open/close the tuner per active game.
- `e2e/tuner.spec.ts` — _create_.

---

## Task 1: Rust — `tune_with_progress` per-generation callback

**Files:**

- Modify: `studio/tuner/src/genetic.rs`
- Modify: `studio/tuner/src/lib.rs:14`
- Test: `studio/tuner/src/genetic.rs` (in the existing `#[cfg(test)] mod tests`)

**Interfaces:**

- Consumes: existing `GenSnapshot` (`outcome.rs`), `TuneOutcome`, `Tuner`.
- Produces: `pub fn tune_with_progress(seed_model: &SlotModel, target: &TargetSpec, cfg: &TunerConfig, on_progress: &mut dyn FnMut(&GenSnapshot)) -> TuneOutcome`. The callback fires exactly once per generation, in order, immediately before the snapshot is recorded. `GeneticTuner::tune` returns an identical `TuneOutcome` (delegates with a no-op).

- [ ] **Step 1: Write the failing test**

Add to the `tests` module at the bottom of `studio/tuner/src/genetic.rs` (it already defines `toy`, `target_09`, `cfg`):

```rust
    #[test]
    fn progress_fires_once_per_generation_and_matches_tune() {
        use crate::genetic::tune_with_progress;
        let seed = toy(1);
        let t = target_09();
        let c = cfg(7);

        let mut gens: Vec<usize> = Vec::new();
        let out = tune_with_progress(&seed, &t, &c, &mut |s: &GenSnapshot| gens.push(s.generation));

        // Bit-identical to the trait method (no behavior drift).
        let direct = GeneticTuner.tune(&seed, &t, &c);
        assert_eq!(out.model, direct.model);
        assert_eq!(out.metrics.rtp, direct.metrics.rtp);
        assert_eq!(out.verdict, direct.verdict);
        assert_eq!(out.trace.generations_run, direct.trace.generations_run);

        // One callback per generation, in order 0..generations_run.
        assert_eq!(gens.len(), out.trace.generations_run);
        assert_eq!(gens, (0..out.trace.generations_run).collect::<Vec<_>>());
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-tuner progress_fires_once_per_generation`
Expected: FAIL — `cannot find function tune_with_progress in module crate::genetic`.

- [ ] **Step 3: Refactor the loop into `tune_with_progress` and delegate**

In `studio/tuner/src/genetic.rs`, replace the entire `impl Tuner for GeneticTuner { ... }` block (currently lines ~114–228) with the free function below **plus** a thin delegating impl. The body is the existing loop verbatim, with one added line: `on_progress(&snap);` right where the snapshot is built.

```rust
/// Like `GeneticTuner::tune`, but reports each generation's best snapshot through
/// `on_progress` as it is produced. `tune` delegates here with a no-op callback,
/// so the deterministic result is identical. Progress is cosmetic.
pub fn tune_with_progress(
    seed_model: &SlotModel,
    target: &TargetSpec,
    cfg: &TunerConfig,
    on_progress: &mut dyn FnMut(&GenSnapshot),
) -> TuneOutcome {
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
    let max_generations = cfg.max_generations.max(1);

    for g in 0..max_generations {
        generations_run = g + 1;
        let seeds = generation_seeds(cfg.master_seed, g, cfg.search_candidate_count);

        let mut scored: Vec<(Genome, f64)> = pop
            .iter()
            .map(|genome| {
                let model = decode(genome, seed_model);
                let f = fitness(&measure(&simulate(&model, &seeds)), target, &cfg.weights);
                (genome.clone(), f)
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));

        let best_model = decode(&scored[0].0, seed_model);
        let bm = measure(&simulate(&best_model, &seeds));
        let snap = GenSnapshot {
            generation: g,
            best_fitness: scored[0].1,
            best_rtp: bm.rtp,
            best_volatility: bm.volatility,
            best_bonus_hit_rates: bm.bonus_hit_rates.clone(),
        };
        on_progress(&snap);
        snapshots.push(snap);

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

        if scored[0].1 >= 0.0 {
            break;
        }
        if stagnation >= cfg.stagnation_window {
            break;
        }
        if g + 1 == max_generations {
            break;
        }

        let mut next: Vec<Genome> = scored
            .iter()
            .take(cfg.elitism)
            .map(|s| s.0.clone())
            .collect();
        while next.len() < cfg.population {
            let p1 = tournament(&scored, &mut rng).clone();
            let p2 = tournament(&scored, &mut rng).clone();
            let mut child = crossover(&p1, &p2, seed_model, cfg, &mut rng);
            mutate(&mut child, seed_model, cfg, &mut rng);
            next.push(child);
        }
        pop = next;
    }

    let (best_genome, _) = best.expect("at least one generation always runs");
    let model = decode(&best_genome, seed_model);
    let final_seeds = generate_seeds(cfg.master_seed ^ FINAL_SALT, cfg.final_candidate_count);
    let metrics = measure(&simulate(&model, &final_seeds));
    let verdict = match verify(&metrics, target) {
        Ok(()) => Verdict::Pass,
        Err(_) => Verdict::NearMiss {
            missed: band_misses(&metrics, target),
        },
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

impl Tuner for GeneticTuner {
    fn tune(&self, seed_model: &SlotModel, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome {
        tune_with_progress(seed_model, target, cfg, &mut |_| {})
    }
}
```

Then in `studio/tuner/src/lib.rs`, change the re-export line (currently `pub use genetic::GeneticTuner;`) to:

```rust
pub use genetic::{tune_with_progress, GeneticTuner};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-tuner`
Expected: PASS — the new test plus all existing genetic/reproducibility/convergence tests stay green (proves no drift).

- [ ] **Step 5: Commit**

```bash
git add studio/tuner/src/genetic.rs studio/tuner/src/lib.rs
git commit -m "feat(tuner): add tune_with_progress per-generation callback"
```

---

## Task 2: Rust — `tune_json` streaming binary

**Files:**

- Create: `studio/tuner/src/bin/tune_json.rs`
- Test: `studio/tuner/src/bin/tune_json.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**

- Consumes: `tune_with_progress` (Task 1), `GeneticTuner`/`Tuner`, `bloom_tuner::validate`, `TunerConfig`/`GeneBounds`/`Weights`, `Verdict`, `GenSnapshot`, `TuneOutcome`, `TargetSpec`/`HitRateBand`, `SlotModel`.
- Produces: a binary `tune_json` invoked as `tune_json <seed_model.json> <target.json> <tuner_config.json>`. Emits to stdout: one `{"type":"progress",...}` line per generation, then one `{"type":"result",...}` line. Exit 0 on pass/near-miss; exit 2 on bad args / unparseable input. The config JSON is snake_case (matches `tune.rs`'s `ConfigJson`); the result/progress JSON is camelCase.

- [ ] **Step 1: Write the failing test (line shapes)**

Create `studio/tuner/src/bin/tune_json.rs` with **only** the helpers + tests first (so it compiles and fails meaningfully). Paste this whole file; Step 3 adds `main`:

```rust
//! Streaming tuning CLI: emit NDJSON per-generation progress + a final result
//! line on stdout. Usage: tune_json <seed_model.json> <target.json> <tuner_config.json>
//! Pass/near-miss are valid results (exit 0); only bad input exits non-zero (2).

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::{HitRateBand, TargetSpec};
use bloom_tuner::config::{GeneBounds, TunerConfig, Weights};
use bloom_tuner::genetic::tune_with_progress;
use bloom_tuner::outcome::{GenSnapshot, TuneOutcome, Verdict};
use serde::Deserialize;
use serde_json::json;
use std::fs;

#[derive(Deserialize)]
struct BandJson {
    min: f64,
    max: f64,
}

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
    payout_min: u64,
    payout_max: u64,
    spins_min: u32,
    spins_max: u32,
    multiplier_min: u64,
    multiplier_max: u64,
    min_count_min: u8,
    min_count_max: u8,
}

#[derive(Deserialize)]
struct WeightsJson {
    rtp: f64,
    volatility: f64,
    hit_rate: f64,
}

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

fn progress_line(snap: &GenSnapshot, max_generations: usize) -> String {
    json!({
        "type": "progress",
        "generation": snap.generation,
        "maxGenerations": max_generations,
        "bestFitness": snap.best_fitness,
        "bestRtp": snap.best_rtp,
        "bestVolatility": snap.best_volatility,
    })
    .to_string()
}

fn result_line(out: &TuneOutcome) -> String {
    let (verdict, missed): (&str, Vec<serde_json::Value>) = match &out.verdict {
        Verdict::Pass => ("pass", Vec::new()),
        Verdict::NearMiss { missed } => (
            "near_miss",
            missed
                .iter()
                .map(|m| {
                    json!({
                        "metric": m.metric,
                        "measured": m.measured,
                        "bandLo": m.band_lo,
                        "bandHi": m.band_hi,
                    })
                })
                .collect(),
        ),
    };
    let trace: Vec<serde_json::Value> = out
        .trace
        .snapshots
        .iter()
        .map(|s| {
            json!({
                "generation": s.generation,
                "bestFitness": s.best_fitness,
                "bestRtp": s.best_rtp,
                "bestVolatility": s.best_volatility,
            })
        })
        .collect();
    json!({
        "type": "result",
        "verdict": verdict,
        "model": out.model,
        "metrics": {
            "rtp": out.metrics.rtp,
            "volatility": out.metrics.volatility,
            "hitFrequency": out.metrics.hit_frequency,
            "baseRtp": out.metrics.base_rtp,
            "featureRtp": out.metrics.feature_rtp,
            "bonusHitRates": out.metrics.bonus_hit_rates,
        },
        "missed": missed,
        "trace": trace,
    })
    .to_string()
}

fn emit(line: String) {
    println!("{line}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{Paytable, SlotModel};
    use bloom_simulator::target::Metrics;
    use bloom_tuner::outcome::{BandMiss, GenSnapshot, TuningTrace};

    fn outcome(verdict: Verdict) -> TuneOutcome {
        TuneOutcome {
            model: SlotModel {
                symbols: vec![],
                reels: vec![],
                rows: 1,
                paylines: vec![],
                paytable: Paytable { entries: vec![] },
                bonuses: vec![],
            },
            metrics: Metrics {
                rtp: 0.901,
                volatility: 3.2,
                hit_frequency: 0.41,
                bonus_hit_rates: vec![],
                base_rtp: 0.901,
                feature_rtp: 0.0,
            },
            verdict,
            trace: TuningTrace {
                master_seed: 2026,
                generations_run: 1,
                snapshots: vec![GenSnapshot {
                    generation: 0,
                    best_fitness: -0.5,
                    best_rtp: 0.5,
                    best_volatility: 2.0,
                    best_bonus_hit_rates: vec![],
                }],
                population: 8,
                search_candidate_count: 1000,
                final_candidate_count: 1000,
            },
        }
    }

    #[test]
    fn progress_line_is_ndjson() {
        let snap = GenSnapshot {
            generation: 3,
            best_fitness: -0.25,
            best_rtp: 0.85,
            best_volatility: 2.1,
            best_bonus_hit_rates: vec![],
        };
        let v: serde_json::Value = serde_json::from_str(&progress_line(&snap, 40)).unwrap();
        assert_eq!(v["type"], "progress");
        assert_eq!(v["generation"], 3);
        assert_eq!(v["maxGenerations"], 40);
        assert_eq!(v["bestRtp"], 0.85);
    }

    #[test]
    fn result_line_pass_shape() {
        let v: serde_json::Value = serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
        assert_eq!(v["type"], "result");
        assert_eq!(v["verdict"], "pass");
        assert_eq!(v["metrics"]["rtp"], 0.901);
        assert_eq!(v["metrics"]["hitFrequency"], 0.41);
        assert!(v["model"].is_object());
        assert!(v["missed"].as_array().unwrap().is_empty());
        assert_eq!(v["trace"].as_array().unwrap().len(), 1);
        assert_eq!(v["trace"][0]["bestFitness"], -0.5);
    }

    #[test]
    fn result_line_near_miss_carries_missed_bands() {
        let v: serde_json::Value = serde_json::from_str(&result_line(&outcome(Verdict::NearMiss {
            missed: vec![BandMiss {
                metric: "rtp".into(),
                measured: 0.80,
                band_lo: 0.89,
                band_hi: 0.91,
            }],
        })))
        .unwrap();
        assert_eq!(v["verdict"], "near_miss");
        assert_eq!(v["missed"][0]["metric"], "rtp");
        assert_eq!(v["missed"][0]["bandLo"], 0.89);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-tuner --bin tune_json`
Expected: FAIL to compile/run — `main` function not found (a `[[bin]]` needs `main`), or unused-import errors. This confirms the test harness sees the file.

- [ ] **Step 3: Add `main` (the streaming entrypoint)**

Insert this `fn main()` into `studio/tuner/src/bin/tune_json.rs` (above the `#[cfg(test)]` module):

```rust
fn read_json<T: for<'de> Deserialize<'de>>(path: &str, what: &str) -> T {
    match fs::read_to_string(path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(v) => v,
        Err(e) => {
            eprintln!("bad {what} json: {e}");
            std::process::exit(2);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("usage: tune_json <seed_model.json> <target.json> <tuner_config.json>");
        std::process::exit(2);
    }

    let model: SlotModel = read_json(&args[1], "model");
    let tj: TargetJson = read_json(&args[2], "target");
    let cj: ConfigJson = read_json(&args[3], "config");

    let target = TargetSpec {
        rtp_target: tj.rtp_target,
        rtp_tolerance: tj.rtp_tolerance,
        volatility_min: tj.volatility_min,
        volatility_max: tj.volatility_max,
        bonus_hit_rate_bands: tj
            .bonus_hit_rate_bands
            .iter()
            .map(|b| HitRateBand {
                min: b.min,
                max: b.max,
            })
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
            payout_min: cj.bounds.payout_min,
            payout_max: cj.bounds.payout_max,
            spins_min: cj.bounds.spins_min,
            spins_max: cj.bounds.spins_max,
            multiplier_min: cj.bounds.multiplier_min,
            multiplier_max: cj.bounds.multiplier_max,
            min_count_min: cj.bounds.min_count_min,
            min_count_max: cj.bounds.min_count_max,
        },
        weights: Weights {
            rtp: cj.weights.rtp,
            volatility: cj.weights.volatility,
            hit_rate: cj.weights.hit_rate,
        },
    };

    if let Err(e) = bloom_tuner::validate(&model, &target, &cfg) {
        eprintln!("invalid input: {e}");
        std::process::exit(2);
    }

    let max_generations = cfg.max_generations;
    let mut on_progress = |s: &GenSnapshot| emit(progress_line(s, max_generations));
    let out = tune_with_progress(&model, &target, &cfg, &mut on_progress);
    emit(result_line(&out));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-tuner --bin tune_json`
Expected: PASS (all three line-shape tests).

- [ ] **Step 5: Smoke-test the real binary (manual, optional but recommended)**

Build it so later subprocess tests are fast: `cargo build -p bloom-tuner --bin tune_json`
Expected: compiles. (No assertion; this just warms the binary.)

- [ ] **Step 6: Commit**

```bash
git add studio/tuner/src/bin/tune_json.rs
git commit -m "feat(tuner): add tune_json streaming NDJSON binary"
```

---

## Task 3: Backend — tuner models + store

**Files:**

- Create: `studio/backend/app/tuner/__init__.py` (empty)
- Create: `studio/backend/app/tuner/models.py`
- Create: `studio/backend/app/tuner/store.py`
- Test: `studio/backend/tests/test_tuner_models.py`
- Test: `studio/backend/tests/test_tuner_store.py`

**Interfaces:**

- Consumes: `app.simulator.models.MetricsWire`.
- Produces:
  - `TuneWeights(rtp, volatility, hit_rate)`, `TuningParams(master_seed, population, max_generations, search_candidate_count, final_candidate_count, elitism, mutation_rate, crossover_rate, stagnation_window, weights)`, `BandMissWire(metric, measured, band_lo, band_hi)`, `GenSnapshotWire(generation, best_fitness, best_rtp, best_volatility)`, `TuneResult(status, verdict, tuned_model, metrics, missed, trace, failure, ran_at)`, `TunerJobDoc(id, game_id, params, result, created_at, updated_at)` — all camelCase wire via `to_camel`.
  - `default_tuning_params() -> TuningParams`, `tuner_wire(doc) -> dict`.
  - `TunerStore(db)` with `get`, `get_or_seed`, `put(game_id, *, params=None)`, `save_result(game_id, result)` over the `tuner_jobs` collection.

- [ ] **Step 1: Write the failing model tests**

Create `studio/backend/tests/test_tuner_models.py`:

```python
from app.tuner.models import (
    TuningParams, TuneWeights, TuneResult, BandMissWire, GenSnapshotWire,
    default_tuning_params, tuner_wire, TunerJobDoc,
)
from app.simulator.models import MetricsWire


def test_default_params_are_sane():
    p = default_tuning_params()
    assert p.population > 0
    assert p.search_candidate_count < p.final_candidate_count
    assert isinstance(p.weights, TuneWeights)


def test_params_round_trip_camel_case():
    p = default_tuning_params()
    raw = p.model_dump(by_alias=True)
    assert "masterSeed" in raw and "searchCandidateCount" in raw
    assert raw["weights"]["hitRate"] == p.weights.hit_rate
    again = TuningParams.model_validate(raw)
    assert again == p


def test_tune_result_near_miss_holds_missed_and_trace():
    r = TuneResult(
        status="near_miss", verdict="near_miss",
        tuned_model={"reels": [[0, 1]]},
        metrics=MetricsWire(rtp=0.8, volatility=3.0, hit_frequency=0.3,
                            base_rtp=0.8, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[BandMissWire(metric="rtp", measured=0.8, band_lo=0.89, band_hi=0.91)],
        trace=[GenSnapshotWire(generation=0, best_fitness=-0.5, best_rtp=0.5, best_volatility=2.0)],
        ran_at="t",
    )
    wire = r.model_dump(by_alias=True)
    assert wire["missed"][0]["bandLo"] == 0.89
    assert wire["trace"][0]["bestFitness"] == -0.5
    assert wire["tunedModel"] == {"reels": [[0, 1]]}


def test_tuner_wire_uses_aliases():
    doc = TunerJobDoc(id="x", game_id="g1", params=default_tuning_params(),
                      result=None, created_at="t", updated_at="t")
    w = tuner_wire(doc)
    assert w["gameId"] == "g1" and w["result"] is None
```

- [ ] **Step 2: Run to verify it fails**

Run (from `studio/backend`): `uv run pytest tests/test_tuner_models.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.tuner'`.

- [ ] **Step 3: Create the package + models**

Create empty `studio/backend/app/tuner/__init__.py`. Create `studio/backend/app/tuner/models.py`:

```python
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel
from app.simulator.models import MetricsWire


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class TuneWeights(_WireModel):
    rtp: float
    volatility: float
    hit_rate: float


class TuningParams(_WireModel):
    # minimal (always shown in the UI)
    master_seed: int
    population: int
    max_generations: int
    search_candidate_count: int
    final_candidate_count: int
    # advanced (collapsible)
    elitism: int
    mutation_rate: float
    crossover_rate: float
    stagnation_window: int
    weights: TuneWeights


class BandMissWire(_WireModel):
    metric: str
    measured: float
    band_lo: float
    band_hi: float


class GenSnapshotWire(_WireModel):
    generation: int
    best_fitness: float
    best_rtp: float
    best_volatility: float


class TuneResult(_WireModel):
    status: Literal["pass", "near_miss", "error"]
    verdict: Literal["pass", "near_miss"] | None = None
    tuned_model: dict | None = None
    metrics: MetricsWire | None = None
    missed: list[BandMissWire] = Field(default_factory=list)
    trace: list[GenSnapshotWire] = Field(default_factory=list)
    failure: str | None = None
    ran_at: str


class TunerJobDoc(_WireModel):
    id: str
    game_id: str
    params: TuningParams
    result: TuneResult | None = None
    created_at: str
    updated_at: str


def default_tuning_params() -> TuningParams:
    return TuningParams(
        master_seed=2026,
        population=24,
        max_generations=40,
        search_candidate_count=20_000,
        final_candidate_count=200_000,
        elitism=2,
        mutation_rate=0.25,
        crossover_rate=0.9,
        stagnation_window=12,
        weights=TuneWeights(rtp=1.0, volatility=1.0, hit_rate=1.0),
    )


def tuner_wire(doc: TunerJobDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")
```

- [ ] **Step 4: Run model tests to verify they pass**

Run: `uv run pytest tests/test_tuner_models.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing store tests**

Create `studio/backend/tests/test_tuner_store.py`:

```python
import pytest
import pytest_asyncio
from app.tuner.models import default_tuning_params, TuneResult, GenSnapshotWire
from app.tuner.store import TunerStore


@pytest_asyncio.fixture(autouse=True)
async def _clear_tuner_jobs(mongo_db):
    await mongo_db["tuner_jobs"].delete_many({})
    yield
    await mongo_db["tuner_jobs"].delete_many({})


@pytest.mark.asyncio
async def test_get_or_seed_creates_defaults(mongo_db):
    store = TunerStore(mongo_db)
    doc = await store.get_or_seed("g1")
    assert doc.game_id == "g1"
    assert doc.params.population == default_tuning_params().population
    assert doc.result is None


@pytest.mark.asyncio
async def test_put_patches_params(mongo_db):
    store = TunerStore(mongo_db)
    await store.get_or_seed("g1")
    p = default_tuning_params()
    p.population = 11
    doc = await store.put("g1", params=p)
    assert doc.params.population == 11


@pytest.mark.asyncio
async def test_save_result_persists(mongo_db):
    store = TunerStore(mongo_db)
    await store.get_or_seed("g1")
    res = TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0]]},
        metrics=None, missed=[],
        trace=[GenSnapshotWire(generation=0, best_fitness=0.0, best_rtp=0.9, best_volatility=2.0)],
        failure=None, ran_at="t",
    )
    doc = await store.save_result("g1", res)
    assert doc.result is not None and doc.result.status == "pass"
    again = await store.get("g1")
    assert again.result.tuned_model == {"reels": [[0]]}
    assert len(again.result.trace) == 1
```

- [ ] **Step 6: Run to verify it fails**

Run: `uv run pytest tests/test_tuner_store.py -q`
Expected: FAIL — `No module named 'app.tuner.store'`.

- [ ] **Step 7: Create the store**

Create `studio/backend/app/tuner/store.py`:

```python
import uuid
from datetime import datetime, timezone
from app.tuner.models import TunerJobDoc, TuningParams, TuneResult, default_tuning_params


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_doc(doc: TunerJobDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> TunerJobDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return TunerJobDoc.model_validate(data)


class TunerStore:
    def __init__(self, db):
        self._docs = db["tuner_jobs"]

    async def get(self, game_id: str) -> TunerJobDoc | None:
        raw = await self._docs.find_one({"game_id": game_id})
        return _from_doc(raw) if raw else None

    async def get_or_seed(self, game_id: str) -> TunerJobDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = TunerJobDoc(
            id=str(uuid.uuid4()), game_id=game_id, params=default_tuning_params(),
            result=None, created_at=now, updated_at=now,
        )
        await self._docs.insert_one(_to_doc(doc))
        return doc

    async def put(self, game_id: str, *, params: TuningParams | None = None) -> TunerJobDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        return await self.get(game_id)

    async def save_result(self, game_id: str, result: TuneResult) -> TunerJobDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"result": result.model_dump(mode="json"), "updated_at": _now()}},
        )
        return await self.get(game_id)
```

- [ ] **Step 8: Run all tuner tests to verify they pass**

Run: `uv run pytest tests/test_tuner_models.py tests/test_tuner_store.py -q`
Expected: PASS (7 tests).

- [ ] **Step 9: Commit**

```bash
git add studio/backend/app/tuner/__init__.py studio/backend/app/tuner/models.py studio/backend/app/tuner/store.py studio/backend/tests/test_tuner_models.py studio/backend/tests/test_tuner_store.py
git commit -m "feat(tuner): add backend tuner models + TunerStore"
```

---

## Task 4: Backend — bounds derivation + config assembly

**Files:**

- Create: `studio/backend/app/tuner/bounds.py`
- Test: `studio/backend/tests/test_tuner_bounds.py`

**Interfaces:**

- Consumes: `TuningParams` (Task 3).
- Produces:
  - `derive_bounds(model: dict) -> dict` — snake_case `GeneBounds` keys (`payout_min`, `payout_max`, `spins_min`, `spins_max`, `multiplier_min`, `multiplier_max`, `min_count_min`, `min_count_max`). `payout_max = max(20, max_existing_payout * 4)`.
  - `build_config(params: TuningParams, bounds: dict) -> dict` — the snake_case `tuner_config.json` contract `tune_json` reads (top-level GA knobs + nested `bounds` + `weights`).

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_tuner_bounds.py`:

```python
from app.tuner.bounds import derive_bounds, build_config
from app.tuner.models import default_tuning_params


def test_derive_bounds_scales_payout_ceiling_to_existing_payouts():
    model = {"paytable": {"entries": [
        {"symbol": 1, "count": 1, "payout": 1},
        {"symbol": 2, "count": 1, "payout": 30},
    ]}}
    b = derive_bounds(model)
    assert b["payout_min"] == 0
    assert b["payout_max"] == 120  # 30 * 4
    assert b["spins_min"] == 1 and b["min_count_min"] == 1


def test_derive_bounds_floor_for_tiny_payouts():
    model = {"paytable": {"entries": [{"symbol": 1, "count": 1, "payout": 1}]}}
    assert derive_bounds(model)["payout_max"] == 20  # max(20, 1*4)


def test_derive_bounds_handles_empty_model():
    assert derive_bounds({})["payout_max"] == 20


def test_build_config_emits_snake_case_rust_contract():
    p = default_tuning_params()
    p.population = 16
    cfg = build_config(p, derive_bounds({}))
    assert cfg["population"] == 16
    assert cfg["search_candidate_count"] == p.search_candidate_count
    assert cfg["weights"]["hit_rate"] == p.weights.hit_rate
    assert cfg["bounds"]["payout_max"] == 20
    # exactly the keys tune_json's ConfigJson expects
    assert set(cfg) == {
        "master_seed", "population", "max_generations", "elitism",
        "mutation_rate", "crossover_rate", "stagnation_window",
        "search_candidate_count", "final_candidate_count", "bounds", "weights",
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_tuner_bounds.py -q`
Expected: FAIL — `No module named 'app.tuner.bounds'`.

- [ ] **Step 3: Create `bounds.py`**

```python
"""Translate the studio's seed model + TuningParams into the snake_case JSON the
bloom-tuner `tune_json` binary reads. Pure; no IO. Gene bounds are DERIVED from
the seed model (not user-edited) — the payout ceiling scales to the model's own
payouts so the search can both raise and lower them."""
from app.tuner.models import TuningParams


def derive_bounds(model: dict) -> dict:
    entries = (model.get("paytable") or {}).get("entries") or []
    payouts = [int(e.get("payout", 0)) for e in entries]
    max_payout = max(payouts) if payouts else 0
    return {
        "payout_min": 0,
        "payout_max": max(20, max_payout * 4),
        "spins_min": 1,
        "spins_max": 50,
        "multiplier_min": 1,
        "multiplier_max": 10,
        "min_count_min": 1,
        "min_count_max": 5,
    }


def build_config(params: TuningParams, bounds: dict) -> dict:
    return {
        "master_seed": params.master_seed,
        "population": params.population,
        "max_generations": params.max_generations,
        "elitism": params.elitism,
        "mutation_rate": params.mutation_rate,
        "crossover_rate": params.crossover_rate,
        "stagnation_window": params.stagnation_window,
        "search_candidate_count": params.search_candidate_count,
        "final_candidate_count": params.final_candidate_count,
        "bounds": dict(bounds),
        "weights": {
            "rtp": params.weights.rtp,
            "volatility": params.weights.volatility,
            "hit_rate": params.weights.hit_rate,
        },
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_tuner_bounds.py -q`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/tuner/bounds.py studio/backend/tests/test_tuner_bounds.py
git commit -m "feat(tuner): derive gene bounds + assemble Rust config from params"
```

---

## Task 5: Backend — TunerRunner seam (subprocess + fake) + settings

**Files:**

- Create: `studio/backend/app/tuner/runner.py`
- Modify: `studio/backend/app/config.py` (add `tuner_bin`)
- Test: `studio/backend/tests/test_tuner_runner.py`
- Test: `studio/backend/tests/test_tuner_tune_binary.py` (integration, `@pytest.mark.e2e`)

**Interfaces:**

- Consumes: `TuneResult`, `BandMissWire`, `GenSnapshotWire` (Task 3); `MetricsWire` (simulator); `build_config`/`derive_bounds` (Task 4, used by the integration test).
- Produces:
  - `TuneProgress(generation, max_generations, best_fitness, best_rtp, best_volatility)` dataclass.
  - `parse_tune_result_line(line: str, *, ran_at: str) -> TuneResult`.
  - `TunerRunner` Protocol: `async run(seed_model: dict, target: dict, config: dict, on_progress: Callable[[TuneProgress], None]) -> TuneResult`.
  - `SubprocessTunerRunner(settings)`, `FakeTunerRunner(progress=[...], result=...)`, `build_tuner_runner(settings) -> TunerRunner`.
  - `Settings.tuner_bin: str = ""`.

- [ ] **Step 1: Write the failing settings + parse + fake tests**

Create `studio/backend/tests/test_tuner_runner.py`:

```python
import pytest
from app.config import Settings
from app.tuner.runner import (
    TuneProgress, FakeTunerRunner, parse_tune_result_line,
)
from app.tuner.models import TuneResult
from app.simulator.models import MetricsWire


def test_settings_has_tuner_bin():
    assert hasattr(Settings(), "tuner_bin")


def test_parse_result_pass():
    line = (
        '{"type":"result","verdict":"pass",'
        '"model":{"reels":[[0,1]]},'
        '"metrics":{"rtp":0.9,"volatility":2.0,"hitFrequency":0.4,'
        '"baseRtp":0.9,"featureRtp":0.0,"bonusHitRates":[]},'
        '"missed":[],"trace":[{"generation":0,"bestFitness":0.0,"bestRtp":0.9,"bestVolatility":2.0}]}'
    )
    r = parse_tune_result_line(line, ran_at="t")
    assert r.status == "pass" and r.verdict == "pass"
    assert r.tuned_model == {"reels": [[0, 1]]}
    assert r.metrics.rtp == pytest.approx(0.9)
    assert len(r.trace) == 1 and r.trace[0].best_rtp == pytest.approx(0.9)
    assert r.missed == []


def test_parse_result_near_miss():
    line = (
        '{"type":"result","verdict":"near_miss",'
        '"model":{"reels":[[0]]},'
        '"metrics":{"rtp":0.8,"volatility":2.0,"hitFrequency":0.4,'
        '"baseRtp":0.8,"featureRtp":0.0,"bonusHitRates":[]},'
        '"missed":[{"metric":"rtp","measured":0.8,"bandLo":0.89,"bandHi":0.91}],"trace":[]}'
    )
    r = parse_tune_result_line(line, ran_at="t")
    assert r.status == "near_miss" and r.verdict == "near_miss"
    assert r.missed[0].metric == "rtp" and r.missed[0].band_lo == pytest.approx(0.89)


@pytest.mark.asyncio
async def test_fake_runner_streams_then_returns():
    seen = []
    res = TuneResult(status="pass", verdict="pass", tuned_model={"reels": []},
                     metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                                         base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
                     missed=[], trace=[], ran_at="t")
    runner = FakeTunerRunner(
        progress=[TuneProgress(0, 40, -0.5, 0.5, 2.0), TuneProgress(1, 40, -0.1, 0.85, 2.1)],
        result=res,
    )
    out = await runner.run({"reels": []}, {"rtp_target": 0.9}, {"population": 8}, on_progress=seen.append)
    assert [p.generation for p in seen] == [0, 1]
    assert out.status == "pass"
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_tuner_runner.py -q`
Expected: FAIL — `No module named 'app.tuner.runner'` (and `Settings` has no `tuner_bin`).

- [ ] **Step 3: Add the setting**

In `studio/backend/app/config.py`, directly below the existing `simulator_bin` field (line ~23), add:

```python
    tuner_bin: str = ""  # optional path to a prebuilt tune_json; "" => cargo run
```

- [ ] **Step 4: Create the runner**

Create `studio/backend/app/tuner/runner.py`:

```python
"""Invoke bloom-tuner's tune_json binary as a subprocess, parsing its NDJSON
per-generation progress + final result stream. A FakeTunerRunner backs unit tests."""
import asyncio
import json
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

from app.simulator.models import MetricsWire
from app.tuner.models import BandMissWire, GenSnapshotWire, TuneResult


@dataclass
class TuneProgress:
    generation: int
    max_generations: int
    best_fitness: float
    best_rtp: float
    best_volatility: float


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_tune_result_line(line: str, *, ran_at: str) -> TuneResult:
    d = json.loads(line)
    m = d.get("metrics") or {}
    metrics = MetricsWire(
        rtp=m["rtp"], volatility=m["volatility"], hit_frequency=m["hitFrequency"],
        base_rtp=m["baseRtp"], feature_rtp=m["featureRtp"],
        bonus_hit_rates=m.get("bonusHitRates", []),
    )
    verdict = d["verdict"]  # "pass" | "near_miss"
    return TuneResult(
        status=verdict, verdict=verdict, tuned_model=d.get("model"), metrics=metrics,
        missed=[BandMissWire(metric=x["metric"], measured=x["measured"],
                             band_lo=x["bandLo"], band_hi=x["bandHi"]) for x in d.get("missed", [])],
        trace=[GenSnapshotWire(generation=s["generation"], best_fitness=s["bestFitness"],
                               best_rtp=s["bestRtp"], best_volatility=s["bestVolatility"])
               for s in d.get("trace", [])],
        failure=None, ran_at=ran_at,
    )


class TunerRunner(Protocol):
    async def run(self, seed_model: dict, target: dict, config: dict,
                  on_progress: Callable[[TuneProgress], None]) -> TuneResult: ...


# Repo root = .../app/tuner/runner.py -> parents[4]. Verify on first run.
_REPO_ROOT = Path(__file__).resolve().parents[4]


class SubprocessTunerRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "tuner_bin", "") or ""

    def _command(self, seed_path: str, target_path: str, config_path: str) -> list[str]:
        if self._bin:
            return [self._bin, seed_path, target_path, config_path]
        return ["cargo", "run", "--release", "-p", "bloom-tuner",
                "--bin", "tune_json", "--", seed_path, target_path, config_path]

    async def run(self, seed_model, target, config, on_progress) -> TuneResult:
        ran_at = _now_iso()
        tmp = Path(tempfile.mkdtemp(prefix="bloom-tuner-"))
        try:
            seed_path = str(tmp / "seed_model.json")
            target_path = str(tmp / "target.json")
            config_path = str(tmp / "tuner_config.json")
            Path(seed_path).write_text(json.dumps(seed_model))
            Path(target_path).write_text(json.dumps(target))
            Path(config_path).write_text(json.dumps(config))

            proc = await asyncio.create_subprocess_exec(
                *self._command(seed_path, target_path, config_path),
                cwd=str(_REPO_ROOT),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            result: TuneResult | None = None

            async def _drain_stdout() -> None:
                nonlocal result
                assert proc.stdout is not None
                async for raw in proc.stdout:
                    line = raw.decode().strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("type") == "progress":
                        on_progress(TuneProgress(
                            generation=obj["generation"], max_generations=obj["maxGenerations"],
                            best_fitness=obj["bestFitness"], best_rtp=obj["bestRtp"],
                            best_volatility=obj["bestVolatility"]))
                    elif obj.get("type") == "result":
                        result = parse_tune_result_line(line, ran_at=ran_at)

            assert proc.stderr is not None
            _, stderr_bytes = await asyncio.gather(_drain_stdout(), proc.stderr.read())
            await proc.wait()

            if result is None:
                return TuneResult(
                    status="error", verdict=None, tuned_model=None, metrics=None,
                    missed=[], trace=[],
                    failure=f"tuner produced no result (exit {proc.returncode}): {stderr_bytes.decode()[:500]}",
                    ran_at=ran_at,
                )
            return result
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class FakeTunerRunner:
    def __init__(self, *, progress: list[TuneProgress], result: TuneResult):
        self._progress = progress
        self._result = result

    async def run(self, seed_model, target, config, on_progress) -> TuneResult:
        for p in self._progress:
            on_progress(p)
        return self._result


def build_tuner_runner(settings) -> TunerRunner:
    return SubprocessTunerRunner(settings)
```

- [ ] **Step 5: Run unit tests to verify they pass**

Run: `uv run pytest tests/test_tuner_runner.py -q`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the integration test (real binary, tiny tune)**

Create `studio/backend/tests/test_tuner_tune_binary.py`:

```python
"""Shells out to the real Rust tune_json binary. Marked e2e so it stays out of the
unit gate (needs the cargo toolchain). Deterministic + offline — no cassettes.
Build first for speed: `cargo build --release -p bloom-tuner --bin tune_json`."""
import pytest
from app.config import get_settings
from app.tuner.bounds import derive_bounds, build_config
from app.tuner.models import default_tuning_params
from app.tuner.runner import SubprocessTunerRunner, TuneProgress

# Detuned: sym2 pays 1 -> RTP ~0.5. Target 0.9 -> the tuner must raise payouts.
DETUNED = {
    "symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
                {"id": 2, "role": "normal"}],
    "reels": [[0, 0, 0, 0, 0, 1, 1, 1, 1, 2]], "rows": 1, "paylines": [[0]],
    "paytable": {"entries": [{"symbol": 1, "count": 1, "payout": 1},
                             {"symbol": 2, "count": 1, "payout": 1}]},
    "bonuses": [],
}
TARGET_09 = {
    "rtp_target": 0.9, "rtp_tolerance": 0.02, "volatility_min": 0.0,
    "volatility_max": 1e9, "bonus_hit_rate_bands": [], "pool_size": 0,
    "candidate_count": 0, "realized_correction_band": 0.05,
}


def _fast_params():
    p = default_tuning_params()
    p.master_seed = 7
    p.population = 16
    p.max_generations = 40
    p.search_candidate_count = 5_000
    p.final_candidate_count = 50_000
    return p


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_real_tune_converges_to_pass():
    seen: list[TuneProgress] = []
    config = build_config(_fast_params(), derive_bounds(DETUNED))
    runner = SubprocessTunerRunner(get_settings())
    res = await runner.run(DETUNED, TARGET_09, config, on_progress=seen.append)
    assert res.status == "pass", res.failure
    assert abs(res.metrics.rtp - 0.9) <= 0.02
    assert seen and seen[0].generation == 0  # streamed at least one generation
    assert res.tuned_model is not None
```

- [ ] **Step 7: Run the integration test to verify it passes**

Run: `uv run pytest -m e2e tests/test_tuner_tune_binary.py -q`
Expected: PASS (real tune, ~1–3s). If `cargo` is slow on first run, build the binary first (Step 5 of Task 2).

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/tuner/runner.py studio/backend/app/config.py studio/backend/tests/test_tuner_runner.py studio/backend/tests/test_tuner_tune_binary.py
git commit -m "feat(tuner): add TunerRunner subprocess seam + fake + integration test"
```

---

## Task 6: Backend — hub, REST, sockets, and `build()` wiring

**Files:**

- Create: `studio/backend/app/tuner/hub.py`
- Create: `studio/backend/app/tuner/rest.py`
- Create: `studio/backend/app/tuner/sockets.py`
- Modify: `studio/backend/app/main.py`
- Test: `studio/backend/tests/test_tuner_hub.py`
- Test: `studio/backend/tests/test_tuner_rest.py`
- Test: `studio/backend/tests/test_tuner_sockets.py`
- Test: `studio/backend/tests/test_tuner_wiring.py`

**Interfaces:**

- Consumes: `TunerStore` (Task 3), `SlotModelStore` (simulator), `derive_target`/`TargetGap` (simulator), `derive_bounds`/`build_config` (Task 4), `TunerRunner`/`build_tuner_runner` (Task 5), `tuner_wire`, `sim_wire`.
- Produces:
  - `TunerHub(sio, tuner_store, slot_model_store, runner, gdd_store)` with `attach_subscriber(game_id, sid)` and `request_tune(game_id)`.
  - REST handlers: `get_tuner`, `put_tuner`, `get_tuner_seed`, `get_tuner_target`, `tune_tuner` (202), `apply_tuner`, `get_tuner_result`, and `PutTunerBody`.
  - `register_tuner_handlers(sio, hub)` — `join_tuner` / `leave_tuner`.
  - `app.state.tuner_store`, `app.state.tuner_hub`; router mounted; handlers registered.
- Socket events emitted: `tuning_progress` (gameId, generation, maxGenerations, bestFitness, bestRtp, bestVolatility), `tuning_complete` (gameId, doc), `tuning_failed` (gameId, failure).

- [ ] **Step 1: Write the failing hub tests**

Create `studio/backend/tests/test_tuner_hub.py`:

```python
import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.models import MetricsWire
from app.simulator.store import SlotModelStore
from app.tuner.models import TuneResult, GenSnapshotWire
from app.tuner.store import TunerStore
from app.tuner.runner import FakeTunerRunner, TuneProgress
from app.tuner.hub import TunerHub


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})


class FakeSio:
    def __init__(self): self.events = []
    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))
    async def enter_room(self, sid, room): pass


class FakeGdd:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data) if aspect == "math-model" else None


def _pass_result():
    return TuneResult(status="pass", verdict="pass", tuned_model={"reels": [[0]]},
                      metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                                          base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
                      missed=[], trace=[GenSnapshotWire(generation=0, best_fitness=0.0,
                                                        best_rtp=0.9, best_volatility=2.0)],
                      ran_at="t")


@pytest.mark.asyncio
async def test_request_tune_emits_progress_then_complete(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"bonuses": []})
    tuner = TunerStore(mongo_db)
    runner = FakeTunerRunner(progress=[TuneProgress(0, 40, -0.5, 0.5, 2.0)], result=_pass_result())
    sio = FakeSio()
    hub = TunerHub(sio, tuner, sim, runner, FakeGdd({"rtp": 0.9, "volatility": "low"}))

    await hub.request_tune("g1")

    names = [e[0] for e in sio.events]
    assert "tuning_progress" in names
    assert "tuning_complete" in names
    saved = await tuner.get("g1")
    assert saved.result.status == "pass"


@pytest.mark.asyncio
async def test_request_tune_emits_failed_on_gdd_gap(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"bonuses": []})
    tuner = TunerStore(mongo_db)
    runner = FakeTunerRunner(progress=[], result=_pass_result())
    sio = FakeSio()
    hub = TunerHub(sio, tuner, sim, runner, FakeGdd({"volatility": "low"}))  # no rtp

    await hub.request_tune("g1")

    assert "tuning_failed" in [e[0] for e in sio.events]
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/test_tuner_hub.py -q`
Expected: FAIL — `No module named 'app.tuner.hub'`.

- [ ] **Step 3: Create the hub**

Create `studio/backend/app/tuner/hub.py`:

```python
import asyncio

from app.simulator.targets import derive_target, TargetGap
from app.tuner.bounds import build_config, derive_bounds
from app.tuner.models import tuner_wire


class TunerHub:
    def __init__(self, sio, tuner_store, slot_model_store, runner, gdd_store):
        self._sio = sio
        self._tuner = tuner_store
        self._slot = slot_model_store
        self._runner = runner
        self._gdd = gdd_store

    async def attach_subscriber(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._tuner.get(game_id)
        if doc is not None and doc.result is not None:
            await self._sio.emit(
                "tuning_complete",
                {"gameId": game_id, "doc": tuner_wire(doc)},
                to=sid,
            )

    async def request_tune(self, game_id: str) -> None:
        sim_doc = await self._slot.get_or_seed(game_id)
        model = sim_doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])

        gdd = await self._gdd.get_doc(game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            # Reuse the simulator's target derivation + the SAME curation params,
            # so the tuner aims at exactly the bands the simulator will verify.
            target = derive_target(math_model, sim_doc.params, num_bonuses)
        except TargetGap as gap:
            await self._sio.emit(
                "tuning_failed",
                {"gameId": game_id, "failure": gap.message},
                room=game_id,
            )
            return

        tuner_doc = await self._tuner.get_or_seed(game_id)
        config = build_config(tuner_doc.params, derive_bounds(model))

        async def on_progress(p):
            await self._sio.emit(
                "tuning_progress",
                {"gameId": game_id, "generation": p.generation,
                 "maxGenerations": p.max_generations, "bestFitness": p.best_fitness,
                 "bestRtp": p.best_rtp, "bestVolatility": p.best_volatility},
                room=game_id,
            )

        pending: list[asyncio.Task] = []
        loop = asyncio.get_running_loop()

        def sync_progress(p):
            pending.append(loop.create_task(on_progress(p)))

        result = await self._runner.run(model, target, config, on_progress=sync_progress)
        if pending:
            await asyncio.gather(*pending)
        saved = await self._tuner.save_result(game_id, result)

        event = "tuning_complete" if result.status in ("pass", "near_miss") else "tuning_failed"
        await self._sio.emit(
            event,
            {"gameId": game_id, "doc": tuner_wire(saved)},
            room=game_id,
        )
```

- [ ] **Step 4: Run hub tests to verify they pass**

Run: `uv run pytest tests/test_tuner_hub.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing REST tests**

Create `studio/backend/tests/test_tuner_rest.py`:

```python
import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.store import SlotModelStore
from app.tuner.store import TunerStore
from app.tuner.models import TuneResult
from app.simulator.models import MetricsWire
from app.tuner import rest


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})


class FakeGdd:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data)


def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


@pytest.mark.asyncio
async def test_get_seeds_and_put_params(mongo_db):
    store = TunerStore(mongo_db)
    req = _req(tuner_store=store)
    got = await rest.get_tuner("g1", req)
    assert got["gameId"] == "g1"
    body = rest.PutTunerBody(params=got["params"])
    updated = await rest.put_tuner("g1", body, req)
    assert updated["params"]["population"] == got["params"]["population"]


@pytest.mark.asyncio
async def test_seed_endpoint_returns_slot_model(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"reels": [[0, 1]]})
    req = _req(sim_store=sim)
    seed = await rest.get_tuner_seed("g1", req)
    assert seed["model"] == {"reels": [[0, 1]]}


@pytest.mark.asyncio
async def test_target_endpoint_reports_gap_when_intent_missing(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"bonuses": []})
    req = _req(sim_store=sim, gdd_store=FakeGdd({"volatility": "low"}))  # no rtp
    out = await rest.get_tuner_target("g1", req)
    assert "gap" in out


@pytest.mark.asyncio
async def test_apply_writes_tuned_model_into_slot_store(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"reels": [[9]]})  # stale seed
    tuner = TunerStore(mongo_db)
    await tuner.save_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0, 1, 2]]},
        metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[], trace=[], ran_at="t"))
    req = _req(sim_store=sim, tuner_store=tuner)
    out = await rest.apply_tuner("g1", req)
    assert out["model"] == {"reels": [[0, 1, 2]]}
    assert (await sim.get("g1")).model == {"reels": [[0, 1, 2]]}


@pytest.mark.asyncio
async def test_apply_errors_when_no_tuned_model(mongo_db):
    from fastapi import HTTPException
    sim = SlotModelStore(mongo_db)
    tuner = TunerStore(mongo_db)
    await tuner.get_or_seed("g1")  # result is None
    req = _req(sim_store=sim, tuner_store=tuner)
    with pytest.raises(HTTPException):
        await rest.apply_tuner("g1", req)


@pytest.mark.asyncio
async def test_tune_kicks_off(mongo_db):
    calls = []
    async def _req_tune(gid):
        calls.append(gid)
    hub = SimpleNamespace(request_tune=_req_tune)
    req = _req(tuner_hub=hub)
    await rest.tune_tuner("g1", req)
    import asyncio
    await asyncio.sleep(0)
    assert calls == ["g1"]
```

- [ ] **Step 6: Run to verify it fails**

Run: `uv run pytest tests/test_tuner_rest.py -q`
Expected: FAIL — `No module named 'app.tuner.rest'`.

- [ ] **Step 7: Create the REST routes**

Create `studio/backend/app/tuner/rest.py`:

```python
import asyncio
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.simulator.models import sim_wire
from app.simulator.targets import derive_target, TargetGap
from app.tuner.models import TuningParams, tuner_wire

router = APIRouter()


class PutTunerBody(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    params: TuningParams | None = None


@router.get("/games/{game_id}/tuner")
async def get_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.tuner_store.get_or_seed(game_id)
    return tuner_wire(doc)


@router.put("/games/{game_id}/tuner")
async def put_tuner(game_id: str, body: PutTunerBody, request: Request) -> dict:
    doc = await request.app.state.tuner_store.put(game_id, params=body.params)
    return tuner_wire(doc)


@router.get("/games/{game_id}/tuner/seed")
async def get_tuner_seed(game_id: str, request: Request) -> dict:
    doc = await request.app.state.sim_store.get_or_seed(game_id)
    return {"model": doc.model}


@router.get("/games/{game_id}/tuner/target")
async def get_tuner_target(game_id: str, request: Request) -> dict:
    sim_doc = await request.app.state.sim_store.get_or_seed(game_id)
    model = sim_doc.model or {}
    num_bonuses = len(model.get("bonuses", []) or [])
    gdd = await request.app.state.gdd_store.get_doc(game_id, "math-model")
    math_model = getattr(gdd, "data", {}) if gdd is not None else {}
    try:
        return {"target": derive_target(math_model, sim_doc.params, num_bonuses)}
    except TargetGap as gap:
        return {"gap": gap.message}


@router.post("/games/{game_id}/tuner/tune", status_code=202)
async def tune_tuner(game_id: str, request: Request) -> Response:
    asyncio.create_task(request.app.state.tuner_hub.request_tune(game_id))
    return Response(status_code=202)


@router.post("/games/{game_id}/tuner/apply")
async def apply_tuner(game_id: str, request: Request) -> dict:
    doc = await request.app.state.tuner_store.get(game_id)
    tuned = doc.result.tuned_model if (doc and doc.result) else None
    if not tuned:
        raise HTTPException(status_code=400, detail="no tuned model to apply")
    updated = await request.app.state.sim_store.put(game_id, model=tuned)
    return sim_wire(updated)


@router.get("/games/{game_id}/tuner/result")
async def get_tuner_result(game_id: str, request: Request) -> dict | None:
    doc = await request.app.state.tuner_store.get(game_id)
    if doc is None or doc.result is None:
        return None
    return doc.result.model_dump(by_alias=True, mode="json")
```

- [ ] **Step 8: Run REST tests to verify they pass**

Run: `uv run pytest tests/test_tuner_rest.py -q`
Expected: PASS (6 tests).

- [ ] **Step 9: Write the failing sockets test**

Create `studio/backend/tests/test_tuner_sockets.py`:

```python
import pytest
from app.tuner.sockets import register_tuner_handlers


class RecordingSio:
    def __init__(self): self.handlers = {}; self.left = []
    def on(self, event):
        def deco(fn): self.handlers[event] = fn; return fn
        return deco
    async def leave_room(self, sid, room): self.left.append((sid, room))


class RecordingHub:
    def __init__(self): self.joined = []
    async def attach_subscriber(self, game_id, sid): self.joined.append((game_id, sid))


@pytest.mark.asyncio
async def test_join_and_leave_handlers():
    sio = RecordingSio()
    hub = RecordingHub()
    register_tuner_handlers(sio, hub)
    await sio.handlers["join_tuner"]("sid1", {"gameId": "g1"})
    await sio.handlers["leave_tuner"]("sid1", {"gameId": "g1"})
    assert hub.joined == [("g1", "sid1")]
    assert sio.left == [("sid1", "g1")]
```

- [ ] **Step 10: Run to verify it fails, then create sockets**

Run: `uv run pytest tests/test_tuner_sockets.py -q` → FAIL (`No module named 'app.tuner.sockets'`).

Create `studio/backend/app/tuner/sockets.py`:

```python
def register_tuner_handlers(sio, hub):
    @sio.on("join_tuner")
    async def join_tuner(sid, data):
        await hub.attach_subscriber(data["gameId"], sid)

    @sio.on("leave_tuner")
    async def leave_tuner(sid, data):
        await sio.leave_room(sid, data["gameId"])
```

Run: `uv run pytest tests/test_tuner_sockets.py -q` → PASS.

- [ ] **Step 11: Write the failing wiring test**

Create `studio/backend/tests/test_tuner_wiring.py`:

```python
from app.config import Settings
from app.main import build


def test_build_wires_tuner_routes_and_state():
    ctx = build(Settings())
    app = ctx.fastapi_app
    paths = set(app.openapi()["paths"].keys())
    assert "/games/{game_id}/tuner" in paths
    assert "/games/{game_id}/tuner/tune" in paths
    assert "/games/{game_id}/tuner/apply" in paths
    assert hasattr(app.state, "tuner_store")
    assert hasattr(app.state, "tuner_hub")


def test_settings_has_tuner_bin():
    assert hasattr(Settings(), "tuner_bin")
```

- [ ] **Step 12: Run to verify it fails**

Run: `uv run pytest tests/test_tuner_wiring.py -q`
Expected: FAIL — tuner routes not in `paths`.

- [ ] **Step 13: Wire into `app/main.py`**

In `studio/backend/app/main.py`, add imports after the simulator imports (after line 30):

```python
from app.tuner.store import TunerStore
from app.tuner.hub import TunerHub
from app.tuner.runner import build_tuner_runner
from app.tuner.sockets import register_tuner_handlers
from app.tuner.rest import router as tuner_router
```

After the `sim_hub = CurationHub(...)` line (line 95), add:

```python
    tuner_store = TunerStore(mongo[settings.mongo_db])
    tuner_hub = TunerHub(sio, tuner_store, sim_store, build_tuner_runner(settings), gdd_store)
```

After `fastapi_app.state.sim_hub = sim_hub` (line 121), add:

```python
    fastapi_app.state.tuner_store = tuner_store
    fastapi_app.state.tuner_hub = tuner_hub
```

After `fastapi_app.include_router(sim_router)` (line 123), add:

```python
    fastapi_app.include_router(tuner_router)
```

After `register_sim_handlers(sio, sim_hub)` (line 129), add:

```python
    register_tuner_handlers(sio, tuner_hub)
```

- [ ] **Step 14: Run the full tuner backend suite to verify it passes**

Run: `uv run pytest tests/test_tuner_wiring.py tests/test_tuner_hub.py tests/test_tuner_rest.py tests/test_tuner_sockets.py -q`
Expected: PASS. Then run the whole non-e2e suite to confirm no regressions: `uv run pytest -m "not e2e" -q`.

- [ ] **Step 15: Commit**

```bash
git add studio/backend/app/tuner/hub.py studio/backend/app/tuner/rest.py studio/backend/app/tuner/sockets.py studio/backend/app/main.py studio/backend/tests/test_tuner_hub.py studio/backend/tests/test_tuner_rest.py studio/backend/tests/test_tuner_sockets.py studio/backend/tests/test_tuner_wiring.py
git commit -m "feat(tuner): wire TunerHub + REST + sockets into the backend"
```

---

## Task 7: Frontend — plugin state, config, rest client, reducers

**Files:**

- Create: `studio/frontend/src/plugins/tuner/config.ts`
- Create: `studio/frontend/src/plugins/tuner/state.ts`
- Create: `studio/frontend/src/plugins/tuner/restClient.ts`
- Create: `studio/frontend/src/plugins/tuner/reducers.ts`
- Test: `studio/frontend/src/plugins/tuner/restClient.spec.ts`
- Test: `studio/frontend/src/plugins/tuner/reducers.spec.ts`

**Interfaces:**

- Produces:
  - `TUNER_PLUGIN_ID = 'tuner'`; interfaces `ITuneWeights`, `ITuningParams`, `IMetrics`, `IBandMiss`, `IGenSnapshot`, `ITuneResult`, `ITunerJobDoc`, `ITunerState`; `makeInitialState()`, `tunerHooks`, `tunerSlice()`.
  - rest client: `getTuner`, `putTuner`, `getTunerSeed`, `getTunerTarget`, `tune`, `applyTuner`, `getTunerResult`.
  - `statusFromResult(r: ITuneResult): ITunerState['status']`.

- [ ] **Step 1: Write the failing rest client + reducer tests**

Create `studio/frontend/src/plugins/tuner/restClient.spec.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTuner, tune, applyTuner } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('tuner restClient', () => {
  it('GETs the tuner doc', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ gameId: 'g1' }) });
    vi.stubGlobal('fetch', fetchMock);
    const doc = await getTuner('g1');
    expect(doc.gameId).toBe('g1');
    expect(fetchMock.mock.calls[0][0]).toContain('/games/g1/tuner');
  });

  it('POSTs tune without throwing on 202', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    await expect(tune('g1')).resolves.toBeUndefined();
  });

  it('POSTs apply and returns the updated slot-model doc', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ model: { reels: [[0]] } }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await applyTuner('g1');
    expect(out.model).toEqual({ reels: [[0]] });
    expect(fetchMock.mock.calls[0][0]).toContain('/games/g1/tuner/apply');
  });
});
```

Create `studio/frontend/src/plugins/tuner/reducers.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { statusFromResult } from './reducers';
import type { ITuneResult } from './state';

describe('statusFromResult', () => {
  it('maps the result status through', () => {
    const r = { status: 'near_miss' } as ITuneResult;
    expect(statusFromResult(r)).toBe('near_miss');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (repo root): `npx nx test frontend`
Expected: FAIL — cannot resolve `./restClient` / `./state` / `./reducers`.

- [ ] **Step 3: Create `config.ts`, `state.ts`, `reducers.ts`, `restClient.ts`**

`studio/frontend/src/plugins/tuner/config.ts`:

```ts
export { BACKEND_URL } from '../assets/config';
```

`studio/frontend/src/plugins/tuner/state.ts`:

```ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const TUNER_PLUGIN_ID = 'tuner';

export interface ITuneWeights {
  rtp: number;
  volatility: number;
  hitRate: number;
}

export interface ITuningParams {
  masterSeed: number;
  population: number;
  maxGenerations: number;
  searchCandidateCount: number;
  finalCandidateCount: number;
  elitism: number;
  mutationRate: number;
  crossoverRate: number;
  stagnationWindow: number;
  weights: ITuneWeights;
}

export interface IMetrics {
  rtp: number;
  volatility: number;
  hitFrequency: number;
  baseRtp: number;
  featureRtp: number;
  bonusHitRates: number[];
}

export interface IBandMiss {
  metric: string;
  measured: number;
  bandLo: number;
  bandHi: number;
}

export interface IGenSnapshot {
  generation: number;
  bestFitness: number;
  bestRtp: number;
  bestVolatility: number;
}

export interface ITuneResult {
  status: 'pass' | 'near_miss' | 'error';
  verdict: 'pass' | 'near_miss' | null;
  tunedModel: unknown | null;
  metrics: IMetrics | null;
  missed: IBandMiss[];
  trace: IGenSnapshot[];
  failure: string | null;
  ranAt: string;
}

export interface ITunerJobDoc {
  id: string;
  gameId: string;
  params: ITuningParams;
  result: ITuneResult | null;
}

export interface ITunerProgress {
  generation: number;
  maxGenerations: number;
  bestFitness: number;
  bestRtp: number;
  bestVolatility: number;
}

export interface ITunerState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  seedModelText: string;
  params: ITuningParams | null;
  derivedTarget: unknown | null;
  targetGap: string | null;
  status: 'idle' | 'running' | 'pass' | 'near_miss' | 'error';
  progress: ITunerProgress | null;
  result: ITuneResult | null;
  failure: string | null;
  applied: boolean;
  loadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): ITunerState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    seedModelText: '',
    params: null,
    derivedTarget: null,
    targetGap: null,
    status: 'idle',
    progress: null,
    result: null,
    failure: null,
    applied: false,
    loadStatus: 'idle',
  };
}

export const tunerHooks = makePluginHooks<ITunerState>(TUNER_PLUGIN_ID);

export function tunerSlice(): State<ITunerState> {
  return rootStore.plugins.nested(TUNER_PLUGIN_ID) as unknown as State<ITunerState>;
}
```

`studio/frontend/src/plugins/tuner/reducers.ts`:

```ts
import type { ITuneResult, ITunerState } from './state';

export function statusFromResult(r: ITuneResult): ITunerState['status'] {
  return r.status; // 'pass' | 'near_miss' | 'error'
}
```

`studio/frontend/src/plugins/tuner/restClient.ts`:

```ts
import { BACKEND_URL } from './config';
import type { ITunerJobDoc, ITuneResult, ITuningParams } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getTuner(gameId: string): Promise<ITunerJobDoc> {
  return okJson<ITunerJobDoc>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner`));
}

export async function putTuner(gameId: string, params: ITuningParams): Promise<ITunerJobDoc> {
  return okJson<ITunerJobDoc>(
    await fetch(`${BACKEND_URL}/games/${gameId}/tuner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params }),
    }),
  );
}

export async function getTunerSeed(gameId: string): Promise<{ model: unknown }> {
  return okJson<{ model: unknown }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/seed`));
}

export async function getTunerTarget(gameId: string): Promise<{ target?: unknown; gap?: string }> {
  return okJson<{ target?: unknown; gap?: string }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/target`));
}

export async function tune(gameId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/tuner/tune`, { method: 'POST' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function applyTuner(gameId: string): Promise<{ model: unknown }> {
  return okJson<{ model: unknown }>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/apply`, { method: 'POST' }));
}

export async function getTunerResult(gameId: string): Promise<ITuneResult | null> {
  return okJson<ITuneResult | null>(await fetch(`${BACKEND_URL}/games/${gameId}/tuner/result`));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx nx test frontend`
Expected: PASS (the new tuner specs plus the existing suite stay green).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/tuner/config.ts studio/frontend/src/plugins/tuner/state.ts studio/frontend/src/plugins/tuner/reducers.ts studio/frontend/src/plugins/tuner/restClient.ts studio/frontend/src/plugins/tuner/restClient.spec.ts studio/frontend/src/plugins/tuner/reducers.spec.ts
git commit -m "feat(tuner): add frontend tuner plugin state + rest client"
```

---

## Task 8: Frontend — socket client + actions

**Files:**

- Create: `studio/frontend/src/plugins/tuner/socketClient.ts`
- Create: `studio/frontend/src/plugins/tuner/actions.ts`
- Test: `studio/frontend/src/plugins/tuner/socketClient.spec.ts`

**Interfaces:**

- Consumes: `tunerSlice`, `ITunerJobDoc` (Task 7); `statusFromResult` (Task 7); `getTuner`, `getTunerTarget` (Task 7).
- Produces:
  - `createTunerSocket()` / `tunerSock()` — subscribes to `tuning_progress` (accumulate snapshot into `progress` + push to `result.trace`-like live view via `progress`), `tuning_complete` (set `result`, derive `status`), `tuning_failed` (status `error`); `joinTuner`/`leaveTuner` emit.
  - actions `initTuner()`, `openGameTuner(gameId)`, `closeGameTuner()`.

- [ ] **Step 1: Write the failing socket test**

Create `studio/frontend/src/plugins/tuner/socketClient.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers: Record<string, (p: unknown) => void> = {};
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, cb: (p: unknown) => void) => {
      handlers[event] = cb;
    },
    emit: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

import { createTunerSocket } from './socketClient';
import { tunerSlice } from './state';

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
  tunerSlice().activeGameId.set('g1');
  tunerSlice().status.set('idle');
  tunerSlice().progress.set(null);
  tunerSlice().result.set(null);
});

describe('tuner socketClient', () => {
  it('updates progress for the active game', () => {
    createTunerSocket().connect();
    handlers['tuning_progress']({ gameId: 'g1', generation: 3, maxGenerations: 40, bestFitness: -0.1, bestRtp: 0.85, bestVolatility: 2.1 });
    expect(tunerSlice().progress.get()?.generation).toBe(3);
    expect(tunerSlice().status.get()).toBe('running');
  });

  it('ignores events for other games', () => {
    createTunerSocket().connect();
    handlers['tuning_progress']({ gameId: 'other', generation: 9, maxGenerations: 40, bestFitness: 0, bestRtp: 0, bestVolatility: 0 });
    expect(tunerSlice().progress.get()).toBeNull();
  });

  it('sets the verdict status on tuning_complete', () => {
    createTunerSocket().connect();
    handlers['tuning_complete']({ gameId: 'g1', doc: { result: { status: 'near_miss' } } });
    expect(tunerSlice().status.get()).toBe('near_miss');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test frontend`
Expected: FAIL — cannot resolve `./socketClient`.

- [ ] **Step 3: Create `socketClient.ts` and `actions.ts`**

`studio/frontend/src/plugins/tuner/socketClient.ts`:

```ts
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { tunerSlice, type ITunerJobDoc, type ITunerProgress } from './state';
import { statusFromResult } from './reducers';

let sock: Socket | null = null;
function isActive(gameId: string): boolean {
  return tunerSlice().activeGameId.get() === gameId;
}

export function createTunerSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'tuner' } });
    sock.on('tuning_progress', (p: ITunerProgress & { gameId: string }) => {
      if (!isActive(p.gameId)) return;
      tunerSlice().progress.set({
        generation: p.generation,
        maxGenerations: p.maxGenerations,
        bestFitness: p.bestFitness,
        bestRtp: p.bestRtp,
        bestVolatility: p.bestVolatility,
      });
      tunerSlice().status.set('running');
      tunerSlice().failure.set(null);
    });
    const onDoc = (p: { gameId: string; doc: ITunerJobDoc }) => {
      if (!isActive(p.gameId)) return;
      const result = p.doc.result;
      tunerSlice().result.set(result);
      tunerSlice().progress.set(null);
      tunerSlice().failure.set(null);
      tunerSlice().status.set(result ? statusFromResult(result) : 'idle');
    };
    sock.on('tuning_complete', onDoc);
    sock.on('tuning_failed', (p: { gameId: string; failure?: string }) => {
      if (!isActive(p.gameId)) return;
      tunerSlice().status.set('error');
      tunerSlice().progress.set(null);
      tunerSlice().result.set(null);
      tunerSlice().failure.set(p.failure ?? null);
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinTuner: (gameId: string) => sock?.emit('join_tuner', { gameId }),
    leaveTuner: (gameId: string) => sock?.emit('leave_tuner', { gameId }),
  };
}

let client: ReturnType<typeof createTunerSocket> | null = null;
export function tunerSock() {
  if (!client) client = createTunerSocket();
  return client;
}
```

`studio/frontend/src/plugins/tuner/actions.ts`:

```ts
import { tunerSock } from './socketClient';
import { tunerSlice } from './state';
import { getTuner, getTunerTarget } from './restClient';

export function initTuner(): void {
  tunerSock().connect();
}

export async function openGameTuner(gameId: string): Promise<void> {
  const s = tunerSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  s.applied.set(false);
  tunerSock().joinTuner(gameId);
  try {
    const doc = await getTuner(gameId);
    s.params.set(doc.params);
    s.result.set(doc.result);
    s.failure.set(null);
    s.status.set(doc.result ? doc.result.status : 'idle');
    await refreshSeedAndTarget(gameId);
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

export async function refreshSeedAndTarget(gameId: string): Promise<void> {
  const s = tunerSlice();
  const { getTunerSeed } = await import('./restClient');
  const seed = await getTunerSeed(gameId);
  s.seedModelText.set(JSON.stringify(seed.model ?? {}, null, 2));
  const target = await getTunerTarget(gameId);
  s.derivedTarget.set(target.target ?? null);
  s.targetGap.set(target.gap ?? null);
}

export function closeGameTuner(): void {
  const s = tunerSlice();
  const prev = s.activeGameId.get();
  if (prev) tunerSock().leaveTuner(prev);
  s.activeGameId.set(null);
  s.seedModelText.set('');
  s.params.set(null);
  s.derivedTarget.set(null);
  s.targetGap.set(null);
  s.result.set(null);
  s.failure.set(null);
  s.progress.set(null);
  s.applied.set(false);
  s.status.set('idle');
  s.loadStatus.set('idle');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx nx test frontend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/tuner/socketClient.ts studio/frontend/src/plugins/tuner/actions.ts studio/frontend/src/plugins/tuner/socketClient.spec.ts
git commit -m "feat(tuner): add frontend tuner socket client + actions"
```

---

## Task 9: Frontend — TunerPane, plugin registration, RoomRoute wiring

**Files:**

- Create: `studio/frontend/src/plugins/tuner/TunerPane.tsx`
- Create: `studio/frontend/src/plugins/tuner/index.ts`
- Modify: `studio/frontend/src/plugins/index.ts`
- Modify: `studio/frontend/src/app/routes/RoomRoute.tsx`
- Test: `studio/frontend/src/plugins/tuner/TunerPane.spec.tsx`

**Interfaces:**

- Consumes: `tunerHooks`, `tunerSlice` (Task 7); `tune`, `applyTuner` (Task 7); `openGameTuner`, `closeGameTuner`, `initTuner`, `refreshSeedAndTarget` (Task 8).
- Produces: `tuner: IPlugin<ITunerState>` with pane id `tuner/viewer` + command `tuner/open-viewer`; registered in `PLUGINS`; opened/closed per active game in `RoomRoute`.

- [ ] **Step 1: Write the failing pane test**

Create `studio/frontend/src/plugins/tuner/TunerPane.spec.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TunerPane } from './TunerPane';
import { tunerSlice } from './state';

vi.mock('./actions', () => ({ openGameTuner: vi.fn(), closeGameTuner: vi.fn(), initTuner: vi.fn(), refreshSeedAndTarget: vi.fn() }));
vi.mock('./restClient', () => ({ tune: vi.fn(), applyTuner: vi.fn() }));

beforeEach(() => {
  tunerSlice().activeGameId.set(null);
  tunerSlice().status.set('idle');
  tunerSlice().result.set(null);
});

describe('TunerPane', () => {
  it('shows a no-game placeholder when no game is open', () => {
    render(<TunerPane {...({} as never)} />);
    expect(screen.getByTestId('tuner-no-game')).toBeTruthy();
  });

  it('shows the PASS verdict and enables apply when a tuned model exists', () => {
    tunerSlice().activeGameId.set('g1');
    tunerSlice().status.set('pass');
    tunerSlice().result.set({
      status: 'pass',
      verdict: 'pass',
      tunedModel: { reels: [[0]] },
      metrics: { rtp: 0.9, volatility: 2.0, hitFrequency: 0.4, baseRtp: 0.9, featureRtp: 0, bonusHitRates: [] },
      missed: [],
      trace: [],
      failure: null,
      ranAt: 't',
    });
    render(<TunerPane {...({} as never)} />);
    expect(screen.getByTestId('tuning-status').textContent).toContain('PASS');
    expect((screen.getByTestId('apply-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists missed bands on near-miss', () => {
    tunerSlice().activeGameId.set('g1');
    tunerSlice().status.set('near_miss');
    tunerSlice().result.set({
      status: 'near_miss',
      verdict: 'near_miss',
      tunedModel: { reels: [[0]] },
      metrics: { rtp: 0.8, volatility: 2.0, hitFrequency: 0.4, baseRtp: 0.8, featureRtp: 0, bonusHitRates: [] },
      missed: [{ metric: 'rtp', measured: 0.8, bandLo: 0.89, bandHi: 0.91 }],
      trace: [],
      failure: null,
      ranAt: 't',
    });
    render(<TunerPane {...({} as never)} />);
    expect(screen.getByTestId('tuner-missed').textContent).toContain('rtp');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx nx test frontend`
Expected: FAIL — cannot resolve `./TunerPane`.

- [ ] **Step 3: Create `TunerPane.tsx`**

```tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { tunerHooks, tunerSlice } from './state';
import { tune, applyTuner } from './restClient';
import { putTuner } from './restClient';
import { refreshSeedAndTarget } from './actions';

export function TunerPane(_props: IDockviewPanelProps) {
  const s = tunerHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!activeGameId) {
    return (
      <div data-testid="tuner-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to tune its slot model toward the GDD intent.
      </div>
    );
  }

  const status = s.status.get();
  const result = s.result.get();
  const failure = s.failure.get();
  const progress = s.progress.get();
  const params = s.params.get();
  const targetGap = s.targetGap.get();
  const applied = s.applied.get();
  const hasTunedModel = !!result?.tunedModel;

  async function onTune() {
    try {
      const p = tunerSlice().params.get();
      if (p) await putTuner(activeGameId!, p as never);
      tunerSlice().applied.set(false);
      tunerSlice().status.set('running');
      tunerSlice().progress.set({ generation: 0, maxGenerations: p?.maxGenerations ?? 0, bestFitness: 0, bestRtp: 0, bestVolatility: 0 });
      await tune(activeGameId!);
    } catch (_e) {
      tunerSlice().status.set('error');
      tunerSlice().progress.set(null);
    }
  }

  async function onApply() {
    try {
      await applyTuner(activeGameId!);
      tunerSlice().applied.set(true);
      await refreshSeedAndTarget(activeGameId!);
    } catch (_e) {
      tunerSlice().failure.set('apply failed');
    }
  }

  const badge = status === 'pass' ? 'PASS' : status === 'near_miss' ? 'NEAR-MISS' : status === 'error' ? 'ERROR' : '';
  const badgeClass = status === 'pass' ? 'text-success' : status === 'near_miss' ? 'text-warning' : status === 'error' ? 'text-danger' : 'text-text-3';

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-hairline p-2">
        <span className="text-sm text-text-1">Tuner</span>
        <div className="flex gap-2">
          <button
            data-testid="tune-button"
            onClick={onTune}
            disabled={status === 'running' || !!targetGap}
            className="rounded px-3 py-1 text-sm text-text-1 hover:bg-raised-hover disabled:text-text-3"
          >
            {status === 'running' ? 'Tuning…' : 'Tune'}
          </button>
          <button
            data-testid="apply-button"
            onClick={onApply}
            disabled={!hasTunedModel || status === 'running'}
            className="rounded px-3 py-1 text-sm text-text-1 hover:bg-raised-hover disabled:text-text-3"
          >
            Apply tuned model
          </button>
        </div>
      </div>

      {targetGap && (
        <div data-testid="tuner-gap" className="border-b border-hairline p-2 text-xs text-danger">
          {targetGap}
        </div>
      )}

      <div className="border-b border-hairline p-2 text-xs text-text-2">
        <div className="mb-1 text-text-1">Seed model (tuned from this; read-only)</div>
        <pre data-testid="tuner-seed-json" className="max-h-32 overflow-auto bg-canvas p-2 font-mono text-text-1">
          {s.seedModelText.get()}
        </pre>
      </div>

      {params && (
        <div className="border-b border-hairline p-2 text-xs text-text-2">
          <label className="mr-3">
            seed{' '}
            <input
              data-testid="param-master-seed"
              type="number"
              value={params.masterSeed}
              onChange={(e) => tunerSlice().params.masterSeed.set(Number(e.target.value))}
              className="w-20 bg-canvas px-1 text-text-1"
            />
          </label>
          <label className="mr-3">
            population{' '}
            <input
              type="number"
              value={params.population}
              onChange={(e) => tunerSlice().params.population.set(Number(e.target.value))}
              className="w-16 bg-canvas px-1 text-text-1"
            />
          </label>
          <label className="mr-3">
            generations{' '}
            <input
              type="number"
              value={params.maxGenerations}
              onChange={(e) => tunerSlice().params.maxGenerations.set(Number(e.target.value))}
              className="w-16 bg-canvas px-1 text-text-1"
            />
          </label>
          <button data-testid="toggle-advanced" onClick={() => setShowAdvanced((v) => !v)} className="text-text-2 underline">
            {showAdvanced ? 'hide advanced' : 'advanced'}
          </button>
          {showAdvanced && (
            <div data-testid="advanced-params" className="mt-2 flex flex-wrap gap-3">
              <label>
                search{' '}
                <input
                  type="number"
                  value={params.searchCandidateCount}
                  onChange={(e) => tunerSlice().params.searchCandidateCount.set(Number(e.target.value))}
                  className="w-24 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                final{' '}
                <input
                  type="number"
                  value={params.finalCandidateCount}
                  onChange={(e) => tunerSlice().params.finalCandidateCount.set(Number(e.target.value))}
                  className="w-24 bg-canvas px-1 text-text-1"
                />
              </label>
              <label>
                mutation{' '}
                <input
                  type="number"
                  step="0.05"
                  value={params.mutationRate}
                  onChange={(e) => tunerSlice().params.mutationRate.set(Number(e.target.value))}
                  className="w-16 bg-canvas px-1 text-text-1"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {progress && (
        <div data-testid="tuning-progress" className="border-b border-hairline p-2 text-xs text-text-2">
          gen {progress.generation}/{progress.maxGenerations} · best RTP {progress.bestRtp.toFixed(4)} · fitness {progress.bestFitness.toFixed(4)}
        </div>
      )}

      <div className="flex-1 overflow-auto p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-sm text-text-2">Verdict</span>
          <span data-testid="tuning-status" className={`text-sm font-semibold ${badgeClass}`}>
            {badge}
          </span>
        </div>
        {result?.metrics && (
          <table className="text-xs text-text-1">
            <tbody>
              <tr>
                <td className="pr-4 text-text-2">Measured RTP</td>
                <td data-testid="metric-rtp">{result.metrics.rtp.toFixed(4)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Volatility</td>
                <td>{result.metrics.volatility.toFixed(3)}</td>
              </tr>
              <tr>
                <td className="pr-4 text-text-2">Hit frequency</td>
                <td>{result.metrics.hitFrequency.toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        )}
        {result && result.missed.length > 0 && (
          <div data-testid="tuner-missed" className="mt-2 text-xs text-warning">
            {result.missed.map((m) => (
              <div key={m.metric}>
                {m.metric}: measured {m.measured.toFixed(4)} band [{m.bandLo.toFixed(4)}, {m.bandHi.toFixed(4)}]
              </div>
            ))}
          </div>
        )}
        {applied && (
          <p data-testid="tuner-applied" className="mt-2 text-xs text-success">
            Applied — open the Simulator to curate &amp; sign.
          </p>
        )}
        {status === 'error' && failure && (
          <p data-testid="tuner-error" className="text-sm text-danger">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `index.ts` and register the plugin**

`studio/frontend/src/plugins/tuner/index.ts`:

```ts
import type { IPlugin } from '../../host/types';
import { TunerPane } from './TunerPane';
import { TUNER_PLUGIN_ID, makeInitialState, type ITunerState } from './state';
import { initTuner } from './actions';

export const tuner: IPlugin<ITunerState> = {
  id: TUNER_PLUGIN_ID,
  title: 'Tuner',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'tuner/viewer', title: 'Tuner', component: TunerPane as never }],
  commands: [{ id: 'tuner/open-viewer', title: 'Open Tuner', run: (host) => host.openPane('tuner/viewer') }],
  init: () => initTuner(),
};
```

In `studio/frontend/src/plugins/index.ts`, add the import and append to `PLUGINS`:

```ts
import { tuner } from './tuner';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets, gdd, game, simulator, tuner];
```

- [ ] **Step 5: Wire open/close into `RoomRoute.tsx`**

In `studio/frontend/src/app/routes/RoomRoute.tsx`, add an import next to the simulator one (line 9):

```ts
import { openGameTuner, closeGameTuner } from '../../plugins/tuner/actions';
```

Next to the `if (found.gameId) void openGameSim(found.gameId);` line (line 35), add:

```ts
if (found.gameId) void openGameTuner(found.gameId);
```

Next to the `closeGameSim();` call (line 54), add:

```ts
closeGameTuner();
```

- [ ] **Step 6: Run the frontend suite to verify it passes**

Run: `npx nx test frontend`
Expected: PASS (the new pane spec + existing suites; note `RoomRoute.spec.tsx` may mock `../../plugins/tuner/actions` — if the existing spec breaks on the new import, add `openGameTuner`/`closeGameTuner` to its mock the same way `openGameSim`/`closeGameSim` are mocked).

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/tuner/TunerPane.tsx studio/frontend/src/plugins/tuner/TunerPane.spec.tsx studio/frontend/src/plugins/tuner/index.ts studio/frontend/src/plugins/index.ts studio/frontend/src/app/routes/RoomRoute.tsx
git commit -m "feat(tuner): add TunerPane + register plugin + RoomRoute wiring"
```

---

## Task 10: e2e — real tune to PASS + apply, and near-miss

**Files:**

- Create: `studio/frontend/e2e/tuner.spec.ts`

**Interfaces:**

- Consumes: the running replay backend (:8001 in this worktree via `BLOOM_PORT_OFFSET`) + frontend; helpers `seedLocalStorage`, `BACKEND_URL`; the `/rooms`, `/games/:id/gdd/math-model`, `/games/:id/slot-model`, `/games/:id/tuner` REST endpoints; the `tuner/viewer` pane.

- [ ] **Step 1: Write the e2e spec**

Create `studio/frontend/e2e/tuner.spec.ts`:

```ts
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the real Tuner UI against a running backend + frontend. Local-only; never
// in CI (see AGENTS.md). DETERMINISTIC + OFFLINE — no cassettes: the tune runs the
// real bloom-tuner tune_json subprocess. Build first for speed:
//   cargo build --release -p bloom-tuner --bin tune_json
//
// Flow: seed a DETUNED model (sym2 pays 1 -> RTP ~0.5) + GDD intent rtp 90% / vol
// low. The tuner must raise payouts to reach 0.9 ± tol -> PASS. Then Apply writes
// the tuned model back into the slot-model store (verified via the API).

const DETUNED = {
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
      { symbol: 2, count: 1, payout: 1 },
    ],
  },
  bonuses: [],
};

const FAST_SIM_PARAMS = {
  poolSize: 500,
  candidateCount: 20000,
  masterSeed: 2026,
  rtpTolerance: 0.02,
  realizedCorrectionBand: 0.05,
  bonusRateTolerance: 0.25,
};

const FAST_TUNER_PARAMS = {
  masterSeed: 7,
  population: 16,
  maxGenerations: 40,
  searchCandidateCount: 5000,
  finalCandidateCount: 50000,
  elitism: 2,
  mutationRate: 0.25,
  crossoverRate: 0.9,
  stagnationWindow: 12,
  weights: { rtp: 1, volatility: 1, hitRate: 1 },
};

async function setupGame(
  page: Page,
  request: APIRequestContext,
  username: string,
  roomName: string,
  intent: { rtp: string; volatility: string },
): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  const gddResp = await request.put(`${BACKEND}/games/${room.gameId}/gdd/math-model`, {
    data: { fields: intent },
  });
  expect(gddResp.ok()).toBeTruthy();

  // Seed the detuned model + curation params (the tuner reads both for the target).
  const slotResp = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, {
    data: { model: DETUNED, params: FAST_SIM_PARAMS },
  });
  expect(slotResp.ok()).toBeTruthy();

  const tunerResp = await request.put(`${BACKEND}/games/${room.gameId}/tuner`, {
    data: { params: FAST_TUNER_PARAMS },
  });
  expect(tunerResp.ok()).toBeTruthy();

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openTuner(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-tuner/viewer')).toBeVisible();
  await page.getByTestId('view-open-tuner/viewer').click();
  await page.getByTestId('tune-button').waitFor({ state: 'visible', timeout: 5_000 });
}

test('tune a detuned model to PASS and apply it back', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'alice', `tuner ${Date.now()}`, { rtp: '90%', volatility: 'low' });
  await openTuner(page);

  await page.getByTestId('tune-button').click();
  await expect(page.getByTestId('tuning-status')).toContainText('PASS', { timeout: 120_000 });

  const measuredRtp = Number(await page.getByTestId('metric-rtp').innerText());
  expect(measuredRtp).toBeGreaterThanOrEqual(0.9 - FAST_SIM_PARAMS.rtpTolerance);
  expect(measuredRtp).toBeLessThanOrEqual(0.9 + FAST_SIM_PARAMS.rtpTolerance);

  // Apply writes the tuned model back into the slot-model store.
  await page.getByTestId('apply-button').click();
  await expect(page.getByTestId('tuner-applied')).toBeVisible({ timeout: 15_000 });

  const after = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  const doc = (await after.json()) as { model: { paytable: { entries: { symbol: number; payout: number }[] } } };
  const sym2 = doc.model.paytable.entries.find((e) => e.symbol === 2)!;
  expect(sym2.payout).toBeGreaterThan(1); // raised from the detuned seed
});

test('an unreachable RTP intent reports NEAR-MISS', async ({ page, request }) => {
  await setupGame(page, request, 'bob', `tuner ${Date.now()}`, { rtp: '5000%', volatility: 'low' });
  await openTuner(page);

  await page.getByTestId('tune-button').click();
  await expect(page.getByTestId('tuning-status')).toContainText('NEAR-MISS', { timeout: 120_000 });
  await expect(page.getByTestId('tuner-missed')).toContainText('rtp');
});
```

- [ ] **Step 2: Build the binary + start the replay backend, then run the e2e**

```bash
cargo build --release -p bloom-tuner --bin tune_json
just backend-serve-replay   # in a separate terminal; serves :8001 in this worktree
just e2e -- tuner.spec.ts
```

Expected: both tests PASS. The first tune converges to PASS and the API confirms the tuned payout was written back; the second reports NEAR-MISS with the missed `rtp` band. (If `just e2e` runs the whole suite, narrow with the Playwright `--grep` flag, e.g. `npx playwright test --config=studio/frontend/playwright.config.ts tuner.spec.ts`.)

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/tuner.spec.ts
git commit -m "test(tuner): e2e real tune to PASS + apply and near-miss paths"
```

---

## Final verification (before the PR)

Run from the **repo root** (`C:\code\bloom.wt\tuner-studio`):

- [ ] **Rust:** `cargo test --workspace` → green; `cargo fmt --check` and `cargo clippy --workspace -- -D warnings` → clean (CI gates on fmt + clippy, not just tests).
- [ ] **Backend:** from `studio/backend`, `uv run pytest -m "not e2e" -q` → green; `uv run pytest -m e2e tests/test_tuner_tune_binary.py -q` → green.
- [ ] **Frontend (all four CI gates):** `npx prettier@3.6.2 --check .` (or `--write` then re-check), `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend` → all green. (Vitest green ≠ types valid — run all four.)
- [ ] **e2e:** `just e2e` (replay backend on :8001) including `tuner.spec.ts` → green.
- [ ] Then `git push -u origin feat/tuner-studio` and `gh pr create`; watch `gh pr checks --watch`; squash-merge; clean up the worktree + branch.

---

## Self-review notes (plan ↔ spec)

- **Spec §2.1 (seed from `SlotModelStore`, one model-of-record):** Tasks 6 (hub reads `sim_store.get_or_seed`) + 6 REST (`/tuner/seed`) + 9 (read-only seed panel). ✔
- **Spec §2.2 (human-gated Apply):** Task 6 `apply_tuner` + Task 9 Apply button (disabled until a tuned model exists) + Task 10 write-back assertion. ✔
- **Spec §2.4 (reuse `derive_target`):** Task 6 hub + rest import `app.simulator.targets.derive_target`; no re-implementation. ✔
- **Spec §4.2 (additive streaming binary, engine untouched):** Tasks 1–2; `Tuner::tune`/`tune` CLI delegate with no-op and stay green. ✔
- **Spec §4.3 (derived gene bounds):** Task 4 `derive_bounds`. ✔
- **Spec §3.2 (minimal + advanced params; bounds not user-edited):** Task 7 `ITuningParams` + Task 9 advanced toggle; bounds never in params. ✔
- **Spec §5 (REST + socket surface):** Task 6 (all 6 routes) + Task 6/8 (`tuning_progress`/`_complete`/`_failed`, `join_tuner`/`leave_tuner`). ✔
- **Spec §7 (error handling — near-miss first-class, gap blocks tune, no-model):** Task 9 (`tuner-gap`, near-miss badge + missed list, apply disabled) + Task 6 (`apply` 400, hub `tuning_failed` on gap). ✔
- **Spec §8 (offline, no cassettes, real tunes):** Task 5 integration test + Task 10 e2e. ✔
- **Constraint (no `ToolFactory`/`RoomHub` edits):** none in any task. ✔
