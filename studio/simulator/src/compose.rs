//! Build a `composed@1` package through the SAME curate → verify → freeze →
//! sign pipeline as slots (spec §3.3; closes #172). `measure_pool` is retired —
//! the verify verdict replaces its readout. Pure (no I/O); bins do file
//! handling.

use crate::artifact::{self, MathArtifact};
use crate::measure::measure;
use crate::run::{run_curation_streamed, StreamedOutcome};
use crate::seedgen::generate_seeds;
use crate::target::TargetSpec;
use bloom_math::mechanics::composed::{DefinitionError, GameDefinition};
use ed25519_dalek::SigningKey;

/// A target centered on the artifact's own measurement over the exact seed
/// stream curation will use: verify passes by construction and freeze corrects
/// the pool toward the model's measured mean (honesty guardrail trivially
/// satisfied). The bridge until GDD-derived targets arrive through the job
/// (SP-C); a caller-supplied target replaces it entirely.
/// ponytail: simulates the candidates twice (once here, once inside the
/// curation run) — fold into a measure-first pipeline if builds feel slow.
pub fn self_target(artifact: &MathArtifact, pool_size: usize, master_seed: u64) -> TargetSpec {
    let candidate_count = pool_size.saturating_mul(2).max(2);
    let m = measure(&artifact::simulate(
        artifact,
        &generate_seeds(master_seed, candidate_count),
    ));
    TargetSpec {
        rtp_target: m.rtp,
        rtp_tolerance: 0.01,
        volatility_min: 0.0,
        volatility_max: 1e9,
        bonus_hit_rate_bands: vec![],
        pool_size,
        candidate_count,
        realized_correction_band: 0.05,
        hit_frequency_band: None,
        max_win_band: None,
        pay_constraints: vec![],
    }
}

/// Full curated build for a composed definition. `target: None` → self-centered
/// default sized off `seed_count` (a provided target carries its own
/// pool_size/candidate_count and `seed_count` is ignored). Err = the definition
/// failed kernel compile (nothing is signed). The returned TargetSpec is
/// whichever target the run actually used.
pub fn build_composed(
    def: &GameDefinition,
    target: Option<TargetSpec>,
    package_id: &str,
    seed_count: usize,
    master_seed: u64,
    presentation: &[u8],
    signing_key: &SigningKey,
) -> Result<(TargetSpec, StreamedOutcome), Vec<DefinitionError>> {
    let art = MathArtifact::from_definition(def.clone())?;
    let target = target.unwrap_or_else(|| self_target(&art, seed_count, master_seed));
    let outcome = run_curation_streamed(
        &art,
        &target,
        master_seed,
        package_id,
        presentation,
        signing_key,
        &mut |_| {},
    );
    Ok((target, outcome))
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
    fn self_target_centers_on_the_measured_rtp() {
        let art = MathArtifact::from_definition(valid_def()).unwrap();
        let t = self_target(&art, 100, 42);
        assert!((t.rtp_target - 5.0).abs() < 1e-9); // valid_def always pays 5
        assert_eq!(t.pool_size, 100);
        assert_eq!(t.candidate_count, 200);
        assert!(t.bonus_hit_rate_bands.is_empty());
    }

    #[test]
    fn curated_build_round_trips_through_verify_and_load() {
        let def = valid_def();
        let (target, s) =
            build_composed(&def, None, "pkg-composed", 100, 42, b"{\"p\":1}", &key()).unwrap();
        let out = s.outcome.expect("self-target verifies by construction");
        let content = verify_and_load(&out.package_bytes, &key().verifying_key()).unwrap();
        assert_eq!(content.envelope.mechanic, "composed@1");
        assert_eq!(content.envelope.package_id, "pkg-composed");
        assert_eq!(content.seeds.len(), 100); // curated pool, not raw candidates
        assert_eq!(content.presentation, b"{\"p\":1}");
        assert_eq!(from_payload(&content.math_payload).unwrap(), def);
        assert!((out.pool.realized_rtp - target.rtp_target).abs() <= target.rtp_tolerance);
    }

    #[test]
    fn invalid_definition_signs_nothing() {
        let err = build_composed(&invalid_def(), None, "pkg-bad", 100, 42, &[], &key());
        assert!(matches!(err, Err(ref e) if !e.is_empty()));
    }

    #[test]
    fn build_is_deterministic() {
        let def = valid_def();
        let a = build_composed(&def, None, "p", 50, 7, &[], &key()).unwrap();
        let b = build_composed(&def, None, "p", 50, 7, &[], &key()).unwrap();
        assert_eq!(
            a.1.outcome.unwrap().package_bytes,
            b.1.outcome.unwrap().package_bytes
        );
    }

    #[test]
    fn explicit_off_target_fails_verify_instead_of_signing() {
        let target = TargetSpec {
            rtp_target: 50.0, // valid_def pays exactly 5
            rtp_tolerance: 0.001,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 50,
            candidate_count: 100,
            realized_correction_band: 0.05,
            ..Default::default()
        };
        let (_, s) = build_composed(&valid_def(), Some(target), "p", 50, 7, &[], &key()).unwrap();
        assert!(matches!(
            s.outcome,
            Err(crate::run::RunError::VerifyFailed(_))
        ));
    }
}
