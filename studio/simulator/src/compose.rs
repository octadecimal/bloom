//! Build + sign a `composed@1` package: definition → validate (kernel
//! `compile`) → uncurated seed pool → signed bytes; plus `measure_pool`,
//! informational metrics over that (uncurated) pool. No curation/verify
//! gating — that stays a filed follow-up (SP2 spec §2 decision 1, #172).
//! Pure (no I/O); the `compose` bin does file handling.

use crate::seedgen::generate_seeds;
use bloom_math::mechanics::composed::{
    compile, to_payload, DefinitionError, GameDefinition, FAMILY,
};
use bloom_package::{build, Envelope, PackageContent};
use ed25519_dalek::SigningKey;
use std::collections::BTreeMap;

/// Validate the definition (any error means nothing is signed), then build
/// the signed package with a deterministic uncurated pool.
pub fn build_composed_package(
    def: &GameDefinition,
    package_id: &str,
    seed_count: usize,
    master_seed: u64,
    presentation: &[u8],
    signing_key: &SigningKey,
) -> Result<Vec<u8>, Vec<DefinitionError>> {
    compile(def)?;
    let content = PackageContent {
        envelope: Envelope {
            package_id: package_id.to_string(),
            package_version: 1,
            mechanic: FAMILY.to_string(),
        },
        math_payload: to_payload(def),
        seeds: generate_seeds(master_seed, seed_count),
        presentation: presentation.to_vec(),
    };
    Ok(build(&content, signing_key))
}

/// Informational metrics over an (uncurated) seed pool: every seed through the
/// kernel evaluator, bet unit 1 (golden-vector convention). No gating — verify/
/// freeze for composed stays #172.
#[derive(Debug, Clone, PartialEq)]
pub struct PoolMetrics {
    /// mean total_payout per round (bet unit 1)
    pub rtp: f64,
    /// share of rounds with any payout
    pub hit_rate: f64,
    /// largest single-round payout, in bet multiples
    pub max_win_x: u64,
    /// state id -> total StateEnter count across the pool
    pub state_visits: BTreeMap<String, u64>,
}

pub fn measure_pool(
    game: &bloom_math::mechanics::composed::CompiledGame,
    seeds: &[u64],
) -> PoolMetrics {
    use bloom_math::mechanics::composed::{evaluate, TraceEntry};
    let mut total: u128 = 0;
    let mut hits: u64 = 0;
    let mut max_win: u64 = 0;
    let mut visits: BTreeMap<String, u64> = BTreeMap::new();
    for &seed in seeds {
        let trace = evaluate(game, seed);
        total += u128::from(trace.total_payout);
        if trace.total_payout > 0 {
            hits += 1;
        }
        max_win = max_win.max(trace.total_payout);
        for e in &trace.entries {
            if let TraceEntry::StateEnter { state } = e {
                *visits.entry(state.clone()).or_insert(0) += 1;
            }
        }
    }
    if seeds.is_empty() {
        return PoolMetrics {
            rtp: 0.0,
            hit_rate: 0.0,
            max_win_x: 0,
            state_visits: visits,
        };
    }
    let n = seeds.len() as f64;
    PoolMetrics {
        rtp: total as f64 / n,
        hit_rate: hits as f64 / n,
        max_win_x: max_win,
        state_visits: visits,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::composed::from_payload;
    use bloom_package::verify_and_load;
    use serde_json::json;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    /// Minimal valid single-state definition (same shape as the kernel's own
    /// eval tests).
    fn valid_def() -> GameDefinition {
        serde_json::from_value(json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "reels", "type": "reels@1",
                  "config": { "strips": [[0],[0],[0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [{"symbol":0,"count":3,"payout":5}] } } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "reels.spin" } ] }
            ],
            "start": "base",
            "transitions": [],
            "caps": { "max_steps": 50 }
        }))
        .unwrap()
    }

    /// Parses as a GameDefinition but fails compile: `start` names an
    /// unknown state.
    fn invalid_def() -> GameDefinition {
        let mut v = serde_json::to_value(valid_def()).unwrap();
        v["start"] = json!("nope");
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn round_trips_through_verify_and_load() {
        let def = valid_def();
        let bytes =
            build_composed_package(&def, "pkg-composed", 100, 42, b"{\"p\":1}", &key()).unwrap();
        let content = verify_and_load(&bytes, &key().verifying_key()).unwrap();
        assert_eq!(content.envelope.mechanic, "composed@1");
        assert_eq!(content.envelope.package_id, "pkg-composed");
        assert_eq!(content.envelope.package_version, 1);
        assert_eq!(content.seeds, generate_seeds(42, 100));
        assert_eq!(content.presentation, b"{\"p\":1}");
        assert_eq!(from_payload(&content.math_payload).unwrap(), def);
    }

    #[test]
    fn invalid_definition_signs_nothing() {
        let err = build_composed_package(&invalid_def(), "pkg-bad", 100, 42, &[], &key());
        assert!(matches!(err, Err(ref e) if !e.is_empty()));
    }

    #[test]
    fn build_is_deterministic() {
        let def = valid_def();
        let a = build_composed_package(&def, "p", 50, 7, &[], &key()).unwrap();
        let b = build_composed_package(&def, "p", 50, 7, &[], &key()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn measure_pool_is_deterministic_and_counts_state_visits() {
        let compiled = bloom_math::mechanics::composed::compile(&valid_def()).unwrap();
        let seeds = crate::seedgen::generate_seeds(42, 200);
        let a = measure_pool(&compiled, &seeds);
        let b = measure_pool(&compiled, &seeds);
        assert_eq!(a, b);
        // Every round enters the start state exactly once.
        assert_eq!(a.state_visits.get("base").copied(), Some(200));
        assert!(a.rtp >= 0.0);
        assert!((0.0..=1.0).contains(&a.hit_rate));
    }

    #[test]
    fn measure_pool_empty_seeds_is_all_zero() {
        let compiled = bloom_math::mechanics::composed::compile(&valid_def()).unwrap();
        let m = measure_pool(&compiled, &[]);
        assert_eq!(m.rtp, 0.0);
        assert_eq!(m.hit_rate, 0.0);
        assert_eq!(m.max_win_x, 0);
        assert!(m.state_visits.is_empty());
    }
}
