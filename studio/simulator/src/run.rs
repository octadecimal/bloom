//! Orchestrate a curation run: generate → simulate → measure → verify → freeze
//! → build+sign. Approach A: a model that misses targets FAILS; the simulator
//! never reshapes the pool to force a target.

use crate::curate::{freeze_pool, CurateError, Pool};
use crate::measure::{measure, simulate};
use crate::seedgen::generate_seeds;
use crate::target::{Metrics, TargetSpec};
use bloom_math::mechanics::slots::{to_payload, SlotModel};
use bloom_package::{build, Envelope, PackageContent};
use ed25519_dalek::SigningKey;

/// Check measured metrics against the target bands (RTP, volatility, and EACH
/// feature's hit-rate). Err carries the metrics so the caller (human / future
/// tuner) can see what missed. The band count must equal the feature count.
pub fn verify(metrics: &Metrics, target: &TargetSpec) -> Result<(), Metrics> {
    assert_eq!(
        target.bonus_hit_rate_bands.len(),
        metrics.bonus_hit_rates.len(),
        "target must provide one hit-rate band per model bonus"
    );

    let rtp_ok = (metrics.rtp - target.rtp_target).abs() <= target.rtp_tolerance;
    let vol_ok =
        metrics.volatility >= target.volatility_min && metrics.volatility <= target.volatility_max;
    let bonuses_ok = target
        .bonus_hit_rate_bands
        .iter()
        .zip(&metrics.bonus_hit_rates)
        .all(|(band, &rate)| rate >= band.min && rate <= band.max);

    if rtp_ok && vol_ok && bonuses_ok {
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
    if let Err(m) = verify(&metrics, target) {
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
        assert!(verify(&metrics(0.955, 3.0, vec![0.02]), &t).is_ok());
    }

    #[test]
    fn rtp_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.80, 3.0, vec![]), &t).is_err());
    }

    #[test]
    fn volatility_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.955, 0.5, vec![]), &t).is_err());
    }

    #[test]
    fn feature_hit_rate_out_of_band_fails() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.20]), &t).is_err());
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
