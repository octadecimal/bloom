//! Build + sign a `composed@1` package: definition → validate (kernel
//! `compile`) → uncurated seed pool → signed bytes. No curation/metrics —
//! composed curation is a filed follow-up (SP2 spec §2 decision 1). Pure
//! (no I/O); the `compose` bin does file handling.

use crate::seedgen::generate_seeds;
use bloom_math::mechanics::composed::{
    compile, to_payload, DefinitionError, GameDefinition, FAMILY,
};
use bloom_package::{build, Envelope, PackageContent};
use ed25519_dalek::SigningKey;

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
}
