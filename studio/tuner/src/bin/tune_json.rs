//! Streaming tuning CLI: emit NDJSON per-generation progress + a final result
//! line on stdout. Usage: tune_json <seed_model.json> <target.json> <tuner_config.json>
//! Pass/near-miss are valid results (exit 0); only bad input exits non-zero (2).
//! An all-locked config emits a {"type":"error"} frame and exits 0.

use bloom_simulator::artifact::MathArtifact;
use bloom_simulator::target::TargetSpec;
use bloom_tuner::config::{GeneBounds, SectionLocks, TunerConfig, Weights};
use bloom_tuner::genetic::tune_with_progress;
use bloom_tuner::outcome::{GenSnapshot, RunProfile, TuneOutcome, Verdict};
use bloom_tuner::telemetry::PopulationStats;
use serde::Deserialize;
use serde_json::json;
use std::fs;

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
    #[serde(default = "default_meter_target_min")]
    meter_target_min: u32,
    #[serde(default = "default_meter_target_max")]
    meter_target_max: u32,
}

fn default_meter_target_min() -> u32 {
    1
}
fn default_meter_target_max() -> u32 {
    100
}

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

#[derive(Deserialize, Default)]
struct LocksJson {
    #[serde(default)]
    reels: bool,
    #[serde(default)]
    paytable: bool,
    #[serde(default)]
    bonus: bool,
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
    #[serde(default)]
    locks: LocksJson,
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

fn progress_line(snap: &GenSnapshot, max_generations: usize, family: &str) -> String {
    json!({
        "type": "progress",
        "generation": snap.generation,
        "maxGenerations": max_generations,
        "bestFitness": snap.best_fitness,
        "bestRtp": snap.best_rtp,
        "bestVolatility": snap.best_volatility,
        "population": pop_json(&snap.population),
        "geneAgreement": snap.gene_agreement,
        "family": family,
        "stateRtp": snap.best_state_rtp,
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
    let se =
        bloom_simulator::target::standard_errors(&out.metrics, out.trace.final_candidate_count);
    let model_json = match &out.model {
        MathArtifact::Slots(m) => serde_json::to_value(m),
        a => serde_json::to_value(a.composed_def().expect("two families")),
    }
    .expect("model serializes");
    json!({
        "type": "result",
        "verdict": verdict,
        "family": out.model.family(),
        "model": model_json,
        "metrics": {
            "rtp": out.metrics.rtp,
            "volatility": out.metrics.volatility,
            "hitFrequency": out.metrics.hit_frequency,
            "baseRtp": out.metrics.base_rtp,
            "featureRtp": out.metrics.feature_rtp,
            "bonusHitRates": out.metrics.bonus_hit_rates,
            "stateRtp": out.metrics.state_rtp,
            "stateVisitFreq": out.metrics.state_visit_freq,
            "se": {
                "rtp": se.rtp,
                "volatility": se.volatility,
                "bonusHitRates": se.bonus_hit_rates,
                "hitFrequency": se.hit_frequency,
            },
        },
        "missed": missed,
        "trace": trace,
        "profile": profile_json(&out.profile),
        "stopReason": out.trace.stop_reason.as_str(),
    })
    .to_string()
}

fn error_line(message: &str) -> String {
    json!({ "type": "error", "message": message }).to_string()
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

    let artifact = match fs::read_to_string(&args[1])
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
    let target: TargetSpec = read_json(&args[2], "target"); // master_seed key ignored by serde
    let cj: ConfigJson = read_json(&args[3], "config");

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
            meter_target_min: cj.bounds.meter_target_min,
            meter_target_max: cj.bounds.meter_target_max,
        },
        weights: Weights {
            rtp: cj.weights.rtp,
            volatility: cj.weights.volatility,
            hit_rate: cj.weights.hit_rate,
            hit_frequency: cj.weights.hit_frequency,
        },
        locks: SectionLocks {
            reels: cj.locks.reels,
            paytable: cj.locks.paytable,
            bonus: cj.locks.bonus,
        },
    };

    if cfg.locks.all_locked() {
        emit(error_line("everything is locked — nothing to tune"));
        return;
    }

    if let Err(e) = bloom_tuner::validate(&artifact, &target, &cfg) {
        eprintln!("invalid input: {e}");
        std::process::exit(2);
    }

    let family = artifact.family();
    let max_generations = cfg.max_generations;
    let mut on_progress = |s: &GenSnapshot| emit(progress_line(s, max_generations, family));
    let out = tune_with_progress(&artifact, &target, &cfg, &mut on_progress);
    emit(result_line(&out));
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{Paytable, SlotModel};
    use bloom_simulator::profile::{HistogramBin, RtpPoint, WinDistribution};
    use bloom_simulator::target::Metrics;
    use bloom_tuner::outcome::{BandMiss, GenSnapshot, RunProfile, TuningTrace};
    use bloom_tuner::telemetry::population_stats;

    fn outcome(verdict: Verdict) -> TuneOutcome {
        TuneOutcome {
            model: MathArtifact::Slots(SlotModel {
                symbols: vec![],
                reels: vec![],
                rows: 1,
                paylines: vec![],
                paytable: Paytable { entries: vec![] },
                bonuses: vec![],
            }),
            metrics: Metrics {
                rtp: 0.901,
                volatility: 3.2,
                hit_frequency: 0.41,
                bonus_hit_rates: vec![],
                base_rtp: 0.901,
                feature_rtp: 0.0,
                state_rtp: [("base".to_string(), 0.901)].into(),
                state_visit_freq: [("base".to_string(), 1.0)].into(),
                ..Default::default()
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
                    best_state_rtp: Default::default(),
                    population: population_stats(&[-0.9, -0.5, -0.1]),
                    gene_agreement: vec![0.8, 0.6],
                }],
                population: 8,
                search_candidate_count: 1000,
                final_candidate_count: 1000,
                stop_reason: bloom_tuner::outcome::StopReason::Stagnated,
            },
            profile: RunProfile {
                distribution: WinDistribution {
                    bins: vec![HistogramBin {
                        bin_lo: 5.0,
                        bin_hi: 10.0,
                        base: 3,
                        feature: 1,
                    }],
                    zero_count: 7,
                },
                tail: bloom_simulator::profile::TailMetrics {
                    max_win: 120.0,
                    p_ge_100x: 0.02,
                    p_losing_spin: 0.6,
                    longest_dead_streak: 9,
                    bonus_trigger_rate: 0.05,
                },
                rtp_convergence: vec![RtpPoint {
                    n: 1000,
                    realized_rtp: 0.95,
                }],
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
            best_state_rtp: Default::default(),
            population: population_stats(&[-0.25]),
            gene_agreement: vec![1.0],
        };
        let v: serde_json::Value =
            serde_json::from_str(&progress_line(&snap, 40, "slots@1")).unwrap();
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
    fn result_line_carries_stop_reason() {
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
        assert_eq!(v["stopReason"], "stagnated"); // fixture's trace.stop_reason
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
            best_state_rtp: Default::default(),
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
        let v: serde_json::Value =
            serde_json::from_str(&progress_line(&snap, 40, "slots@1")).unwrap();
        assert_eq!(v["population"]["diversity"], 0.4);
        assert_eq!(v["geneAgreement"][0], 0.8);
    }

    const FULL_CONFIG: &str = r#"{
        "master_seed": 7, "population": 8, "max_generations": 4, "elitism": 1,
        "mutation_rate": 0.25, "crossover_rate": 0.9, "stagnation_window": 3,
        "search_candidate_count": 1000, "final_candidate_count": 1000,
        "bounds": {"payout_min": 0, "payout_max": 20, "spins_min": 1, "spins_max": 50,
                   "multiplier_min": 1, "multiplier_max": 10,
                   "min_count_min": 1, "min_count_max": 5},
        "weights": {"rtp": 1.0, "volatility": 1.0, "hit_rate": 1.0}"#;

    #[test]
    fn config_json_locks_default_to_unlocked() {
        let cj: ConfigJson = serde_json::from_str(&format!("{FULL_CONFIG}}}")).unwrap();
        assert!(!cj.locks.reels && !cj.locks.paytable && !cj.locks.bonus);
    }

    #[test]
    fn config_json_parses_locks() {
        let with_locks = format!(
            r#"{FULL_CONFIG}, "locks": {{"reels": true, "paytable": false, "bonus": true}}}}"#
        );
        let cj: ConfigJson = serde_json::from_str(&with_locks).unwrap();
        assert!(cj.locks.reels && !cj.locks.paytable && cj.locks.bonus);
    }

    #[test]
    fn error_line_shape() {
        let v: serde_json::Value =
            serde_json::from_str(&error_line("everything is locked — nothing to tune")).unwrap();
        assert_eq!(v["type"], "error");
        assert!(v["message"].as_str().unwrap().contains("locked"));
    }

    #[test]
    fn result_line_carries_profile_block() {
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
        assert!(v["profile"]["distribution"]["bins"].is_array());
        assert!(v["profile"]["tail"]["maxWin"].is_number());
        assert!(v["profile"]["rtpConvergence"].is_array());
        assert!(v["trace"][0]["population"].is_object());

        // Lock the exact camelCase wire contract the Python/TS layers key off:
        // concrete values, not just presence, catch a misspelled/renamed key.
        assert_eq!(v["profile"]["tail"]["pGE100x"], 0.02);
        assert_eq!(v["profile"]["tail"]["maxWin"], 120.0);
        assert_eq!(v["profile"]["tail"]["pLosingSpin"], 0.6);
        assert_eq!(v["profile"]["tail"]["longestDeadStreak"], 9);
        assert_eq!(v["profile"]["tail"]["bonusTriggerRate"], 0.05);
        assert_eq!(v["profile"]["distribution"]["bins"][0]["binLo"], 5.0);
        assert_eq!(v["profile"]["distribution"]["bins"][0]["binHi"], 10.0);
        assert_eq!(v["profile"]["distribution"]["bins"][0]["base"], 3);
        assert_eq!(v["profile"]["distribution"]["bins"][0]["feature"], 1);
        assert_eq!(v["profile"]["distribution"]["zeroCount"], 7);
        assert_eq!(v["profile"]["rtpConvergence"][0]["n"], 1000);
        assert_eq!(v["profile"]["rtpConvergence"][0]["realizedRtp"], 0.95);
        assert_eq!(v["trace"][0]["geneAgreement"][0], 0.8);
    }

    #[test]
    fn result_line_metrics_carry_se() {
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
        // fixture: vol 3.2 over final_candidate_count 1000 → SE_rtp = 3.2/√1000
        let expected = 3.2 / (1000f64).sqrt();
        assert!((v["metrics"]["se"]["rtp"].as_f64().unwrap() - expected).abs() < 1e-12);
        assert!(v["metrics"]["se"]["volatility"].is_number());
        assert!(v["metrics"]["se"]["bonusHitRates"].is_array());
        assert!(v["metrics"]["se"]["hitFrequency"].is_number());
    }

    #[test]
    fn result_line_carries_family_and_state_shares() {
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
        assert_eq!(v["family"], "slots@1");
        assert_eq!(v["metrics"]["stateRtp"]["base"], 0.901);
        assert_eq!(v["metrics"]["stateVisitFreq"]["base"], 1.0);
        // slots "model" keeps its legacy shape (an object with "reels")
        assert!(v["model"]["reels"].is_array());
    }

    #[test]
    fn composed_result_line_model_is_the_definition() {
        let mut o = outcome(Verdict::Pass);
        let def: bloom_math::mechanics::composed::GameDefinition = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../runtime/server/demo/composed.definition.json"
            ))
            .unwrap(),
        )
        .unwrap();
        o.model = bloom_simulator::artifact::MathArtifact::from_definition(def).unwrap();
        let v: serde_json::Value = serde_json::from_str(&result_line(&o)).unwrap();
        assert_eq!(v["family"], "composed@1");
        assert_eq!(v["model"]["family"], "composed@1");
        assert!(v["model"]["states"].is_array());
        assert!(v["model"]["reels"].is_null()); // not a SlotModel shape
    }

    #[test]
    fn progress_line_carries_family_and_state_rtp() {
        let mut snap = GenSnapshot {
            generation: 3,
            best_fitness: -0.25,
            best_rtp: 0.85,
            best_volatility: 2.1,
            best_bonus_hit_rates: vec![],
            best_state_rtp: [("base".to_string(), 0.7), ("fs".to_string(), 0.15)].into(),
            population: population_stats(&[-0.25]),
            gene_agreement: vec![1.0],
        };
        let v: serde_json::Value =
            serde_json::from_str(&progress_line(&snap, 40, "composed@1")).unwrap();
        assert_eq!(v["family"], "composed@1");
        assert_eq!(v["stateRtp"]["fs"], 0.15);
        snap.best_state_rtp.clear();
        let v: serde_json::Value =
            serde_json::from_str(&progress_line(&snap, 40, "slots@1")).unwrap();
        assert_eq!(v["family"], "slots@1");
    }

    #[test]
    fn bounds_json_meter_target_defaults() {
        let cj: ConfigJson = serde_json::from_str(&format!("{FULL_CONFIG}}}")).unwrap();
        assert_eq!(cj.bounds.meter_target_min, 1);
        assert_eq!(cj.bounds.meter_target_max, 100);
    }
}
