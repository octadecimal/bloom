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
use bloom_simulator::run::run_curation_streamed;
use bloom_simulator::target::TargetFile;
use ed25519_dalek::SigningKey;
use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 && args.len() != 7 {
        eprintln!(
            "usage: curate <model.json> <target.json> <package_id> <out.pkg> <out.report.txt> [presentation.json]"
        );
        std::process::exit(2);
    }

    let model: SlotModel = serde_json::from_str(&fs::read_to_string(&args[1]).expect("read model"))
        .expect("parse model");
    let tf: TargetFile = serde_json::from_str(&fs::read_to_string(&args[2]).expect("read target"))
        .expect("parse target");
    let target = tf.spec;

    if let Err(e) = bloom_simulator::validate_target(&target) {
        eprintln!("invalid target: {e}");
        std::process::exit(2);
    }
    if let Err(e) = bloom_simulator::validate_constraints(&model, &target) {
        eprintln!("invalid target: {e}");
        std::process::exit(2);
    }

    let presentation: Vec<u8> = if args.len() == 7 {
        fs::read(&args[6]).expect("read presentation")
    } else {
        Vec::new()
    };

    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only
    let streamed = run_curation_streamed(
        &model,
        &target,
        tf.master_seed,
        &args[3],
        &presentation,
        &signing_key,
        &mut |_| {},
    );
    match streamed.outcome {
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
