//! Target spec (desired characteristics) and measured metrics.

/// Verdicts allow a band miss of up to K_SIGMA standard errors (~95%
/// two-sided). Shared by the simulator's verify and the tuner's confirm so
/// the two gates can never disagree on the rule.
pub const K_SIGMA: f64 = 2.0;

/// Distance of `x` outside `[lo, hi]` (0 if inside).
pub fn outside(x: f64, lo: f64, hi: f64) -> f64 {
    if x < lo {
        lo - x
    } else if x > hi {
        x - hi
    } else {
        0.0
    }
}

/// Standard errors of the measured metrics over an n-sample population.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricSE {
    /// SE of the RTP estimate: volatility / √n (exact — RTP is a sample mean).
    pub rtp: f64,
    /// SE of the volatility estimate: volatility / √(2n). Normal
    /// approximation — optimistic for heavy-tailed payouts, harmless because
    /// the volatility bands are whole units wide (spec §2).
    pub volatility: f64,
    /// SE of each bonus hit-rate estimate: √(p(1−p)/n) (binomial).
    pub bonus_hit_rates: Vec<f64>,
}

pub fn standard_errors(m: &Metrics, n: usize) -> MetricSE {
    let nf = (n as f64).max(1.0);
    MetricSE {
        rtp: m.volatility / nf.sqrt(),
        volatility: m.volatility / (2.0 * nf).sqrt(),
        bonus_hit_rates: m
            .bonus_hit_rates
            .iter()
            .map(|&p| (p * (1.0 - p) / nf).sqrt())
            .collect(),
    }
}

/// Measured characteristics over a simulated population. Floats are fine here —
/// this is studio measurement, never the certified outcome path.
#[derive(Debug, Clone, PartialEq)]
pub struct Metrics {
    /// Return to player: mean payout (bet-multiples) per spin.
    pub rtp: f64,
    /// Std-dev of per-spin payout (a volatility index).
    pub volatility: f64,
    /// Fraction of spins that pay > 0.
    pub hit_frequency: f64,
    /// Fraction of spins that trigger each bonus feature (one per model bonus).
    pub bonus_hit_rates: Vec<f64>,
    /// RTP contributed by the base game.
    pub base_rtp: f64,
    /// RTP contributed by all features.
    pub feature_rtp: f64,
}

/// An acceptable inclusive range for one feature's hit-rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitRateBand {
    pub min: f64,
    pub max: f64,
}

/// Desired characteristics + curation parameters for a curation run.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetSpec {
    pub rtp_target: f64,
    pub rtp_tolerance: f64,
    pub volatility_min: f64,
    pub volatility_max: f64,
    /// One band per feature in `model.bonuses`, in order.
    pub bonus_hit_rate_bands: Vec<HitRateBand>,
    /// Number of seeds frozen into the pool.
    pub pool_size: usize,
    /// Number of rounds simulated to measure + draw the pool from.
    pub candidate_count: usize,
    /// Max distance curation may move realized RTP from the measured model RTP.
    pub realized_correction_band: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn se_rtp_is_volatility_over_sqrt_n() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![]), 200_000);
        assert!((se.rtp - 2.8 / (200_000f64).sqrt()).abs() < 1e-12);
        // the live-diagnosis number from the spec: ≈ 0.00626
        assert!((se.rtp - 0.00626).abs() < 1e-4);
    }

    #[test]
    fn se_volatility_uses_2n_normal_approximation() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![]), 200_000);
        assert!((se.volatility - 2.8 / (400_000f64).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn se_hit_rates_are_binomial_per_bonus() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![0.02, 0.5]), 10_000);
        assert!((se.bonus_hit_rates[0] - (0.02f64 * 0.98 / 10_000.0).sqrt()).abs() < 1e-12);
        assert!((se.bonus_hit_rates[1] - (0.25f64 / 10_000.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn zero_n_is_finite_not_nan() {
        let se = standard_errors(&metrics(0.9, 1.0, vec![0.1]), 0);
        assert!(se.rtp.is_finite());
        assert!(se.volatility.is_finite());
        assert!(se.bonus_hit_rates[0].is_finite());
    }

    #[test]
    fn outside_measures_distance_beyond_the_band() {
        assert_eq!(outside(0.5, 1.0, 10.0), 0.5);
        assert_eq!(outside(12.0, 1.0, 10.0), 2.0);
        assert_eq!(outside(5.0, 1.0, 10.0), 0.0);
    }
}
