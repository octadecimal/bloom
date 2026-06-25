//! The GA objective: a weighted sum of each metric's normalized distance
//! OUTSIDE its target band. Zero exactly when every metric is in-band — i.e.
//! exactly when `bloom_simulator::run::verify` would pass.

use crate::config::Weights;
use crate::outcome::BandMiss;
use bloom_simulator::target::{Metrics, TargetSpec};

/// Distance of `x` outside `[lo, hi]` (0 if inside).
fn outside(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo - x
    } else if x > hi {
        x - hi
    } else {
        0.0
    }
}

/// `fitness <= 0`; `0.0` is the feasible optimum (all metrics in-band).
pub fn fitness(m: &Metrics, t: &TargetSpec, w: &Weights) -> f64 {
    let rtp_lo = t.rtp_target - t.rtp_tolerance;
    let rtp_hi = t.rtp_target + t.rtp_tolerance;
    let mut d = w.rtp * outside(m.rtp, rtp_lo, rtp_hi) / t.rtp_target.abs().max(1e-9);

    let vol_norm = (t.volatility_max - t.volatility_min).abs().max(1e-9);
    d += w.volatility * outside(m.volatility, t.volatility_min, t.volatility_max) / vol_norm;

    for (band, &rate) in t.bonus_hit_rate_bands.iter().zip(&m.bonus_hit_rates) {
        let width = (band.max - band.min).abs().max(1e-9);
        d += w.hit_rate * outside(rate, band.min, band.max) / width;
    }

    -d
}

/// The bands the measured metrics miss (empty ⟺ all in-band). Used to explain a
/// near-miss verdict in the report.
pub fn band_misses(m: &Metrics, t: &TargetSpec) -> Vec<BandMiss> {
    let mut out = Vec::new();
    let rtp_lo = t.rtp_target - t.rtp_tolerance;
    let rtp_hi = t.rtp_target + t.rtp_tolerance;
    if outside(m.rtp, rtp_lo, rtp_hi) > 0.0 {
        out.push(BandMiss {
            metric: "rtp".into(),
            measured: m.rtp,
            band_lo: rtp_lo,
            band_hi: rtp_hi,
        });
    }
    if outside(m.volatility, t.volatility_min, t.volatility_max) > 0.0 {
        out.push(BandMiss {
            metric: "volatility".into(),
            measured: m.volatility,
            band_lo: t.volatility_min,
            band_hi: t.volatility_max,
        });
    }
    for (i, (band, &rate)) in t
        .bonus_hit_rate_bands
        .iter()
        .zip(&m.bonus_hit_rates)
        .enumerate()
    {
        if outside(rate, band.min, band.max) > 0.0 {
            out.push(BandMiss {
                metric: format!("bonus_hit_rate[{i}]"),
                measured: rate,
                band_lo: band.min,
                band_hi: band.max,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Weights;
    use bloom_simulator::target::{HitRateBand, Metrics, TargetSpec};

    fn weights() -> Weights {
        Weights {
            rtp: 1.0,
            volatility: 1.0,
            hit_rate: 1.0,
        }
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
    fn inside_all_bands_scores_zero() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert_eq!(
            fitness(&metrics(0.955, 3.0, vec![0.02]), &t, &weights()),
            0.0
        );
    }

    #[test]
    fn zero_fitness_iff_verify_passes() {
        // fitness 0 must coincide with the simulator's own verify Ok.
        use bloom_simulator::run::verify;
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        let pass = metrics(0.955, 3.0, vec![0.02]);
        let fail = metrics(0.80, 3.0, vec![0.02]);
        assert_eq!(
            fitness(&pass, &t, &weights()) == 0.0,
            verify(&pass, &t).is_ok()
        );
        assert_eq!(
            fitness(&fail, &t, &weights()) == 0.0,
            verify(&fail, &t).is_ok()
        );
    }

    #[test]
    fn closer_to_band_scores_higher() {
        let t = target(vec![]);
        let near = fitness(&metrics(0.94, 3.0, vec![]), &t, &weights()); // 0.01 outside
        let far = fitness(&metrics(0.80, 3.0, vec![]), &t, &weights()); // 0.15 outside
        assert!(near > far); // both negative; nearer is larger (closer to 0)
    }

    #[test]
    fn band_misses_names_the_missed_metrics() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        let misses = band_misses(&metrics(0.80, 0.5, vec![0.20]), &t);
        let names: Vec<&str> = misses.iter().map(|m| m.metric.as_str()).collect();
        assert!(names.contains(&"rtp"));
        assert!(names.contains(&"volatility"));
        assert!(names.contains(&"bonus_hit_rate[0]"));
    }

    #[test]
    fn band_misses_empty_when_all_inside() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert!(band_misses(&metrics(0.955, 3.0, vec![0.02]), &t).is_empty());
    }
}
