//! Streaming tuning CLI: emit NDJSON per-generation progress + a final result
//! line on stdout. Usage: tune_json <seed_model.json> <target.json> <tuner_config.json>
//! Pass/near-miss are valid results (exit 0); only bad input exits non-zero (2).

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::{HitRateBand, TargetSpec};
use bloom_tuner::config::{GeneBounds, TunerConfig, Weights};
use bloom_tuner::genetic::tune_with_progress;
use bloom_tuner::outcome::{GenSnapshot, RunProfile, TuneOutcome, Verdict};
use bloom_tuner::telemetry::PopulationStats;
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

fn pop_json(p: &PopulationStats) -> serde_json::Value {
    json!({
        "min": p.min,
        "q1": p.q1,
        "median": p.median,
        "q3": p.q3,
        "max": p.max,
        "mean": p.mean,
        "diversity": p.diversity,
    })
}

fn profile_json(p: &RunProfile) -> serde_json::Value {
    json!({
        "distribution": {
            "bins": p.distribution.bins.iter().map(|b| json!({
                "binLo": b.bin_lo,
                "binHi": b.bin_hi,
                "base": b.base,
                "feature": b.feature,
            })).collect::<Vec<_>>(),
            "zeroCount": p.distribution.zero_count,
        },
        "tail": {
            "maxWin": p.tail.max_win,
            "pGE100x": p.tail.p_ge_100x,
            "pLosingSpin": p.tail.p_losing_spin,
            "longestDeadStreak": p.tail.longest_dead_streak,
            "bonusTriggerRate": p.tail.bonus_trigger_rate,
        },
        "rtpConvergence": p.rtp_convergence.iter().map(|r| json!({
            "n": r.n,
            "realizedRtp": r.realized_rtp,
        })).collect::<Vec<_>>(),
    })
}

fn progress_line(snap: &GenSnapshot, max_generations: usize) -> String {
    json!({
        "type": "progress",
        "generation": snap.generation,
        "maxGenerations": max_generations,
        "bestFitness": snap.best_fitness,
        "bestRtp": snap.best_rtp,
        "bestVolatility": snap.best_volatility,
        "population": pop_json(&snap.population),
        "geneAgreement": snap.gene_agreement,
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
                "population": pop_json(&s.population),
                "geneAgreement": s.gene_agreement,
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
        "profile": profile_json(&out.profile),
    })
    .to_string()
}

fn emit(line: String) {
    println!("{line}");
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{Paytable, SlotModel};
    use bloom_simulator::profile::WinDistribution;
    use bloom_simulator::target::Metrics;
    use bloom_tuner::outcome::{BandMiss, GenSnapshot, RunProfile, TuningTrace};
    use bloom_tuner::telemetry::population_stats;

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
                    population: population_stats(&[-0.5]),
                    gene_agreement: vec![1.0],
                }],
                population: 8,
                search_candidate_count: 1000,
                final_candidate_count: 1000,
            },
            profile: RunProfile {
                distribution: WinDistribution {
                    bins: vec![],
                    zero_count: 0,
                },
                tail: bloom_simulator::profile::TailMetrics {
                    max_win: 0.0,
                    p_ge_100x: 0.0,
                    p_losing_spin: 0.0,
                    longest_dead_streak: 0,
                    bonus_trigger_rate: 0.0,
                },
                rtp_convergence: vec![],
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
            population: population_stats(&[-0.25]),
            gene_agreement: vec![1.0],
        };
        let v: serde_json::Value = serde_json::from_str(&progress_line(&snap, 40)).unwrap();
        assert_eq!(v["type"], "progress");
        assert_eq!(v["generation"], 3);
        assert_eq!(v["maxGenerations"], 40);
        assert_eq!(v["bestRtp"], 0.85);
    }

    #[test]
    fn result_line_pass_shape() {
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
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
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::NearMiss {
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

    #[test]
    fn progress_line_carries_population_stats() {
        let snap = GenSnapshot {
            generation: 3,
            best_fitness: -0.25,
            best_rtp: 0.85,
            best_volatility: 2.1,
            best_bonus_hit_rates: vec![],
            population: bloom_tuner::telemetry::PopulationStats {
                min: -0.9,
                q1: -0.7,
                median: -0.5,
                q3: -0.3,
                max: -0.1,
                mean: -0.5,
                diversity: 0.4,
            },
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
}
