//! CLI: read a seed model JSON + a target JSON + a tuner-config JSON, run a
//! genetic tuning, write the tuned model JSON + the audit report. Exits non-zero
//! on a near-miss (so it is scriptable).
//!
//! Usage: tune <seed_model.json> <target.json> <tuner_config.json> <out_model.json> <out_report.txt>

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::{HitRateBand, TargetSpec};
use bloom_tuner::config::{GeneBounds, SectionLocks, TunerConfig, Weights};
use bloom_tuner::outcome::Verdict;
use bloom_tuner::report::render_report;
use bloom_tuner::{GeneticTuner, Tuner};
use serde::Deserialize;
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
        locks: SectionLocks::default(),
    };

    if let Err(e) = bloom_tuner::validate(&model, &target, &cfg) {
        eprintln!("invalid input: {e}");
        std::process::exit(2);
    }

    let out = GeneticTuner.tune(&model, &target, &cfg);
    let report = render_report(&out);
    let model_json = serde_json::to_string_pretty(&out.model).expect("serialize tuned model");

    fs::write(&args[4], model_json).expect("write tuned model");
    fs::write(&args[5], &report).expect("write report");
    println!("{report}");
    println!(
        "wrote tuned model -> {}\nwrote report      -> {}",
        args[4], args[5]
    );

    if matches!(out.verdict, Verdict::NearMiss { .. }) {
        std::process::exit(1);
    }
}
