//! CLI: read a `composed@1` Game Definition JSON, validate it, and write the
//! dev-signed package with an uncurated deterministic seed pool.
//!
//! Usage: compose <definition.json> <package_id> <seed_count> <master_seed> <out.pkg> [presentation.json]
//!
//! NOTE: the demo signing key is fixed and for development only, same as
//! `curate`. Real signing keys are a sign-off-gate concern, out of scope.

use bloom_math::mechanics::composed::GameDefinition;
use bloom_simulator::compose::build_composed_package;
use ed25519_dalek::SigningKey;
use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 && args.len() != 7 {
        eprintln!(
            "usage: compose <definition.json> <package_id> <seed_count> <master_seed> <out.pkg> [presentation.json]"
        );
        std::process::exit(2);
    }

    let def: GameDefinition =
        serde_json::from_str(&fs::read_to_string(&args[1]).expect("read definition"))
            .expect("parse definition");
    let seed_count: usize = args[3].parse().expect("seed_count must be an integer");
    let master_seed: u64 = args[4].parse().expect("master_seed must be a u64");
    let presentation: Vec<u8> = if args.len() == 7 {
        fs::read(&args[6]).expect("read presentation")
    } else {
        Vec::new()
    };

    let key = SigningKey::from_bytes(&[7u8; 32]);
    match build_composed_package(&def, &args[2], seed_count, master_seed, &presentation, &key) {
        Ok(bytes) => {
            fs::write(&args[5], &bytes).expect("write package");
            println!(
                "composed package written: {} ({} bytes, {} seeds, master_seed {})",
                args[5],
                bytes.len(),
                seed_count,
                master_seed
            );
        }
        Err(errors) => {
            eprintln!("invalid definition — nothing signed:");
            for e in &errors {
                eprintln!("  {e:?}");
            }
            std::process::exit(2);
        }
    }
}
