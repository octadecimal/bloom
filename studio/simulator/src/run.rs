//! Orchestrate a curation run: generate → simulate → measure → verify → freeze
//! → build+sign. Approach A: a model that misses targets FAILS; the simulator
//! never reshapes the pool to force a target.

use crate::target::{Metrics, TargetSpec};
#[cfg(test)]
use crate::target::HitRateBand;

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

#[cfg(test)]
mod tests {
    use super::*;

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
        Metrics { rtp, volatility: vol, hit_frequency: 0.3, bonus_hit_rates: bonus, base_rtp: rtp, feature_rtp: 0.0 }
    }

    #[test]
    fn within_all_bands_passes() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
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
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.20]), &t).is_err());
    }
}
