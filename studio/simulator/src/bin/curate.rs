//! CLI: read a slot model JSON + a target JSON, run a curation, write the
//! signed package and the provenance report to disk.
//!
//! Usage: curate <model.json> <target.json> <package_id> <out.pkg> <out.report.txt>
//!
//! The model JSON matches `SlotModel` (serde). Bonus features use serde's
//! external tagging, e.g.:
//!   "bonuses": [ { "FreeSpins": { "trigger": {"symbol":9,"min_count":3},
//!                                 "config": {"spins_awarded":10,"retrigger":true,
//!                                            "multiplier":2,"feature_reels":null} } } ]
//!
//! NOTE: the demo signing key is fixed and for development only. Real signing
//! keys are a sign-off-gate concern (umbrella §9), out of scope here.

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::run::run_curation;
use bloom_simulator::target::{HitRateBand, TargetSpec};
use ed25519_dalek::SigningKey;
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
    master_seed: u64,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        eprintln!(
            "usage: curate <model.json> <target.json> <package_id> <out.pkg> <out.report.txt>"
        );
        std::process::exit(2);
    }

    let model: SlotModel = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read model"))
        .expect("parse model");
    let tj: TargetJson = serde_json::from_str(&fs::read_to_string(&args[2]).expect("read target"))
        .expect("parse target");

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

    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only
    match run_curation(&model, &target, tj.master_seed, &args[3], &signing_key) {
        Ok(out) => {
            fs::write(&args[4], &out.package_bytes).expect("write package");
            fs::write(&args[5], &out.report).expect("write report");
            println!("{}", out.report);
            println!("wrote package -> {}\nwrote report  -> {}", args[4], args[5]);
        }
        Err(e) => {
            eprintln!("curation failed: {e:?}");
            std::process::exit(1);
        }
    }
}
