//! Orchestrate a curation run: generate → simulate → measure → verify → freeze
//! → build+sign. Approach A: a model that misses targets FAILS; the simulator
//! never reshapes the pool to force a target.

use crate::constraints::static_violations;
use crate::curate::{freeze_pool, CurateError, Pool};
use crate::measure::{measure, simulate};
use crate::seedgen::generate_seeds;
use crate::target::{outside, standard_errors, Metrics, TargetSpec, K_SIGMA};
use bloom_math::mechanics::slots::{to_payload, SlotModel};
use bloom_package::{build, Envelope, PackageContent};
use ed25519_dalek::SigningKey;

/// Check measured metrics against the target bands (RTP, volatility, EACH
/// feature's hit-rate, and base-game hit-frequency), allowing a miss of up to
/// K_SIGMA standard errors of the n-sample measurement — a sub-SE band miss
/// is statistical noise, not a defect (spec
/// 2026-07-05-noise-aware-verdicts-design.md). Also gates on `model`'s static
/// constraint violations (max-win band, pay constraints): deterministic game
/// facts get no SE allowance — a hard pass/fail (spec 2026-07-09 §6). Err
/// carries the metrics so the caller can see what missed. The band count
/// must equal the feature count.
pub fn verify(
    model: &SlotModel,
    metrics: &Metrics,
    target: &TargetSpec,
    n: usize,
) -> Result<(), Metrics> {
    assert_eq!(
        target.bonus_hit_rate_bands.len(),
        metrics.bonus_hit_rates.len(),
        "target must provide one hit-rate band per model bonus"
    );

    let se = standard_errors(metrics, n);
    let rtp_lo = target.rtp_target - target.rtp_tolerance;
    let rtp_hi = target.rtp_target + target.rtp_tolerance;
    let rtp_ok = outside(metrics.rtp, rtp_lo, rtp_hi) <= K_SIGMA * se.rtp;
    let vol_ok = outside(
        metrics.volatility,
        target.volatility_min,
        target.volatility_max,
    ) <= K_SIGMA * se.volatility;
    let bonuses_ok = target
        .bonus_hit_rate_bands
        .iter()
        .zip(metrics.bonus_hit_rates.iter().zip(&se.bonus_hit_rates))
        .all(|(band, (&rate, &se_hit))| outside(rate, band.min, band.max) <= K_SIGMA * se_hit);
    let hf_ok = match &target.hit_frequency_band {
        Some(band) => {
            outside(metrics.hit_frequency, band.min, band.max) <= K_SIGMA * se.hit_frequency
        }
        None => true,
    };
    // Constraints are properties of the game, not of tuning: deterministic
    // model facts get no SE allowance (spec §6).
    let static_ok = static_violations(model, target).is_empty();

    if rtp_ok && vol_ok && hf_ok && bonuses_ok && static_ok {
        Ok(())
    } else {
        Err(metrics.clone())
    }
}

/// Coarse progress signal for a curation run (cosmetic; never affects the result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CurationProgress {
    Phase(&'static str),
    Simulating { done: usize, total: usize },
}

#[derive(Debug, Clone)]
pub enum RunError {
    /// The model's measured characteristics missed the target bands.
    VerifyFailed(Metrics),
    /// The pool could not be frozen within the honesty guardrail.
    Curate(CurateError),
}

#[derive(Debug)]
pub struct CurationOutput {
    pub package_bytes: Vec<u8>,
    pub metrics: Metrics,
    pub pool: Pool,
    /// Human-readable provenance (NOT embedded in the signed package; the
    /// package format is certified and unchanged — see the design spec).
    pub report: String,
}

/// A streamed run always carries the measured metrics, plus the pass/fail outcome.
#[derive(Debug)]
pub struct StreamedOutcome {
    pub metrics: Metrics,
    pub outcome: Result<CurationOutput, RunError>,
}

/// Like `run_curation`, but reports progress and always returns the measured
/// metrics. `run_curation` delegates here with a no-op callback.
pub fn run_curation_streamed(
    model: &SlotModel,
    target: &TargetSpec,
    master_seed: u64,
    package_id: &str,
    presentation: &[u8],
    signing_key: &SigningKey,
    on_progress: &mut dyn FnMut(CurationProgress),
) -> StreamedOutcome {
    on_progress(CurationProgress::Phase("generate"));
    let seeds = generate_seeds(master_seed, target.candidate_count);

    // Chunked simulation: identical results to a single `simulate` call (each seed
    // is evaluated the same way; order preserved by concatenation) but lets us
    // report sub-progress through the dominant step.
    let total = seeds.len();
    let chunk = (total / 100).max(1);
    let mut samples = Vec::with_capacity(total);
    let mut done = 0usize;
    for part in seeds.chunks(chunk) {
        samples.extend(simulate(model, part));
        done += part.len();
        on_progress(CurationProgress::Simulating { done, total });
    }

    on_progress(CurationProgress::Phase("measure"));
    let metrics = measure(&samples);

    on_progress(CurationProgress::Phase("verify"));
    if let Err(m) = verify(model, &metrics, target, samples.len()) {
        return StreamedOutcome {
            metrics,
            outcome: Err(RunError::VerifyFailed(m)),
        };
    }

    on_progress(CurationProgress::Phase("freeze"));
    let pool = match freeze_pool(&samples, target, metrics.rtp) {
        Ok(p) => p,
        Err(e) => {
            return StreamedOutcome {
                metrics,
                outcome: Err(RunError::Curate(e)),
            }
        }
    };

    on_progress(CurationProgress::Phase("sign"));
    let content = PackageContent {
        envelope: Envelope {
            package_id: package_id.to_string(),
            package_version: 1,
            mechanic: "slots@1".to_string(),
        },
        math_payload: to_payload(model),
        seeds: pool.seeds.clone(),
        presentation: presentation.to_vec(),
    };
    let package_bytes = build(&content, signing_key);

    let bonus_rates = metrics
        .bonus_hit_rates
        .iter()
        .enumerate()
        .map(|(i, r)| format!("bonus_hit_rate[{i}]={r:.5}"))
        .collect::<Vec<_>>()
        .join("\n");
    let report = format!(
        "package_id={package_id}\nmechanic=slots@1\nmaster_seed={master_seed}\n\
         candidate_count={}\npool_size={}\n\
         measured_rtp={:.5}\nrealized_rtp={:.5}\nvolatility={:.5}\n\
         hit_frequency={:.5}\nbase_rtp={:.5}\nfeature_rtp={:.5}\n{}\n",
        target.candidate_count,
        target.pool_size,
        metrics.rtp,
        pool.realized_rtp,
        metrics.volatility,
        metrics.hit_frequency,
        metrics.base_rtp,
        metrics.feature_rtp,
        bonus_rates,
    );

    StreamedOutcome {
        metrics: metrics.clone(),
        outcome: Ok(CurationOutput {
            package_bytes,
            metrics,
            pool,
            report,
        }),
    }
}

/// Generate → simulate → measure → verify → freeze → build+sign.
pub fn run_curation(
    model: &SlotModel,
    target: &TargetSpec,
    master_seed: u64,
    package_id: &str,
    signing_key: &SigningKey,
) -> Result<CurationOutput, RunError> {
    run_curation_streamed(
        model,
        target,
        master_seed,
        package_id,
        &[],
        signing_key,
        &mut |_| {},
    )
    .outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::HitRateBand;
    use bloom_math::mechanics::slots::{
        evaluate, from_payload, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
    };
    use bloom_package::verify_and_load;
    use ed25519_dalek::SigningKey;

    fn measurable_model() -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef {
                    id: 0,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 1,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 2,
                    role: SymbolRole::Normal,
                },
            ],
            reels: vec![vec![0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry {
                        symbol: 1,
                        count: 1,
                        payout: 1,
                    },
                    PaytableEntry {
                        symbol: 2,
                        count: 1,
                        payout: 5,
                    },
                ],
            },
            bonuses: vec![],
        }
    }

    fn target_09() -> TargetSpec {
        TargetSpec {
            rtp_target: 0.9,
            rtp_tolerance: 0.02,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![], // no bonuses in this model
            pool_size: 10_000,
            candidate_count: 200_000,
            realized_correction_band: 0.05,
            ..Default::default()
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn run_curation_builds_a_loadable_package() {
        let out =
            run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let content = verify_and_load(&out.package_bytes, &key().verifying_key()).expect("loads");
        assert_eq!(content.seeds.len(), 10_000);
        assert_eq!(content.envelope.mechanic, "slots@1");
    }

    #[test]
    fn run_curation_is_reproducible() {
        let a = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let b = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        assert_eq!(a.pool.seeds, b.pool.seeds);
        assert_eq!(a.package_bytes, b.package_bytes);
    }

    #[test]
    fn freeze_boundary_determinism_holds() {
        let out =
            run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let content = verify_and_load(&out.package_bytes, &key().verifying_key()).unwrap();
        let model = from_payload(&content.math_payload).unwrap();
        let sum: u64 = content
            .seeds
            .iter()
            .map(|&s| evaluate(&model, s).total_payout)
            .sum();
        let reexpanded_rtp = sum as f64 / content.seeds.len() as f64;
        assert!((reexpanded_rtp - out.pool.realized_rtp).abs() < 1e-9);
    }

    #[test]
    fn missing_target_fails_loudly() {
        let mut t = target_09();
        t.rtp_target = 0.50; // model is ~0.9, far outside tolerance
        let err = run_curation(&measurable_model(), &t, 2026, "pkg-test", &key()).unwrap_err();
        assert!(matches!(err, RunError::VerifyFailed(_)));
    }

    fn target(bands: Vec<HitRateBand>) -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 1.0,
            volatility_max: 10.0,
            bonus_hit_rate_bands: bands,
            pool_size: 100,
            candidate_count: 1000,
            realized_correction_band: 0.05,
            ..Default::default()
        }
    }

    fn metrics(rtp: f64, vol: f64, bonus: Vec<f64>) -> Metrics {
        Metrics {
            rtp,
            volatility: vol,
            hit_frequency: 0.3,
            bonus_hit_rates: bonus,
            base_rtp: rtp,
            feature_rtp: 0.0,
        }
    }

    #[test]
    fn within_all_bands_passes() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![0.02]),
            &t,
            1_000_000
        )
        .is_ok());
    }

    #[test]
    fn rtp_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.80, 3.0, vec![]),
            &t,
            1_000_000
        )
        .is_err());
    }

    #[test]
    fn volatility_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 0.5, vec![]),
            &t,
            1_000_000
        )
        .is_err());
    }

    #[test]
    fn feature_hit_rate_out_of_band_fails() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![0.20]),
            &t,
            1_000_000
        )
        .is_err());
    }

    // Noise-aware boundary: rtp measured 0.978 vs band 0.95–0.97 (miss 0.008),
    // volatility 2.0. At n = 160_000, SE_rtp = 2/400 = 0.005 → allowance 0.01
    // ≥ 0.008 → PASS. At n = 4_000_000, SE_rtp = 0.001 → allowance 0.002 → FAIL.
    #[test]
    fn rtp_miss_within_2_se_passes() {
        let t = target(vec![]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.978, 2.0, vec![]),
            &t,
            160_000
        )
        .is_ok());
    }

    #[test]
    fn rtp_miss_beyond_2_se_fails() {
        let t = target(vec![]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.978, 2.0, vec![]),
            &t,
            4_000_000
        )
        .is_err());
    }

    #[test]
    fn hit_rate_miss_within_2_se_passes() {
        // rate 0.06 vs band 0–0.05 (miss 0.01); at n=100, SE=√(.06·.94/100)
        // ≈ 0.0237 → allowance ≈ 0.0475 → PASS.
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![0.06]),
            &t,
            100
        )
        .is_ok());
    }

    #[test]
    fn hit_rate_miss_beyond_2_se_fails() {
        // same miss at n=10_000: SE ≈ 0.0024 → allowance ≈ 0.0047 → FAIL.
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![0.06]),
            &t,
            10_000
        )
        .is_err());
    }

    #[test]
    fn the_live_contradiction_case_now_passes() {
        // Spec §1: verify read 0.9819 vs band 0.960–0.970 at 200k spins,
        // vol 2.8 → miss 0.0119 ≤ 2·SE (0.0125) → PASS (was FAIL).
        let t = TargetSpec {
            rtp_target: 0.965,
            rtp_tolerance: 0.005,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 100,
            candidate_count: 200_000,
            realized_correction_band: 0.05,
            ..Default::default()
        };
        assert!(verify(
            &measurable_model(),
            &metrics(0.9819, 2.8, vec![]),
            &t,
            200_000
        )
        .is_ok());
    }

    #[test]
    fn streamed_matches_run_curation_on_pass() {
        let mut seen: Vec<String> = Vec::new();
        let s = run_curation_streamed(
            &measurable_model(),
            &target_09(),
            2026,
            "pkg-test",
            &[],
            &key(),
            &mut |p| match p {
                CurationProgress::Phase(name) => seen.push(name.to_string()),
                CurationProgress::Simulating { done, total } => {
                    assert!(done <= total);
                    seen.push("simulating".to_string());
                }
            },
        );
        // metrics always present; outcome equals the legacy path's package bytes.
        let legacy =
            run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let streamed = s.outcome.expect("passes");
        assert_eq!(streamed.package_bytes, legacy.package_bytes);
        assert!((s.metrics.rtp - 0.9).abs() < 0.02);
        assert!(seen.iter().any(|n| n == "simulating"));
        assert!(seen.iter().any(|n| n == "freeze"));
    }

    #[test]
    fn streamed_reports_metrics_even_on_verify_fail() {
        let mut t = target_09();
        t.rtp_target = 0.50; // model ~0.9 -> verify fails
        let s = run_curation_streamed(
            &measurable_model(),
            &t,
            2026,
            "pkg-test",
            &[],
            &key(),
            &mut |_| {},
        );
        assert!(matches!(s.outcome, Err(RunError::VerifyFailed(_))));
        assert!((s.metrics.rtp - 0.9).abs() < 0.02); // metrics still measured
    }

    #[test]
    fn hit_frequency_out_of_band_fails_and_2_se_noise_passes() {
        // fixture hit_frequency is 0.3. Band 0.35–0.45: miss 0.05.
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand {
            min: 0.35,
            max: 0.45,
        });
        // n=1_000_000 → SE ≈ 0.00046 → allowance ≈ 0.0009 → FAIL.
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![]),
            &t,
            1_000_000
        )
        .is_err());
        // n=300 → SE ≈ 0.0265 → allowance ≈ 0.053 ≥ 0.05 → PASS (noise).
        assert!(verify(&measurable_model(), &metrics(0.955, 3.0, vec![]), &t, 300).is_ok());
        // No band → no gate.
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![]),
            &target(vec![]),
            100
        )
        .is_ok());
    }

    #[test]
    fn static_violations_fail_verify_regardless_of_metrics() {
        // measurable_model(): top pay 5, no bonuses → theoretical max win 5.
        let mut t = target(vec![]);
        t.max_win_band = Some(HitRateBand {
            min: 100.0,
            max: 1000.0,
        });
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![]),
            &t,
            1_000_000
        )
        .is_err());

        let mut t = target(vec![]);
        t.pay_constraints = vec![crate::target::PayConstraint {
            symbol: 1,
            relation: crate::target::PayRelation::TopPaying,
            count: None,
            value: 0,
        }];
        // sym2 pays 5 > sym1's 1 → top-paying violated → hard fail.
        assert!(verify(
            &measurable_model(),
            &metrics(0.955, 3.0, vec![]),
            &t,
            1_000_000
        )
        .is_err());
    }

    #[test]
    fn presentation_bytes_are_carried_into_the_package() {
        let pres = br#"{"cols":1}"#;
        let s = run_curation_streamed(
            &measurable_model(),
            &target_09(),
            2026,
            "pkg-pres",
            pres,
            &key(),
            &mut |_| {},
        );
        let out = s.outcome.expect("passes");
        let content =
            bloom_package::verify_and_load(&out.package_bytes, &key().verifying_key()).unwrap();
        assert_eq!(content.presentation, pres.to_vec());
    }
}
