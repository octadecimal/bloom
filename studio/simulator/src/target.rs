//! Target spec (desired characteristics) and measured metrics.

use serde::Deserialize;

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
    /// SE of the base-game hit-frequency estimate: √(p(1−p)/n) (binomial).
    pub hit_frequency: f64,
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
        hit_frequency: (m.hit_frequency * (1.0 - m.hit_frequency) / nf).sqrt(),
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
#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
pub struct HitRateBand {
    pub min: f64,
    pub max: f64,
}

/// Same {min, max} shape; named for deterministic quantities (max win).
pub type Band = HitRateBand;

/// How a pay constraint binds a symbol's paytable entries. Serialized
/// kebab-case, matching the GDD schema enum verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PayRelation {
    TopPaying,
    Floor,
    Ceiling,
}

/// One GDD pay constraint, compiled by Python `derive_target` through the
/// GDD↔model join key: `symbol` is the MODEL symbol id (spec §6).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct PayConstraint {
    pub symbol: u8,
    pub relation: PayRelation,
    /// None = every paytable entry of `symbol`; Some(c) = only the c-of-a-kind entry.
    #[serde(default)]
    pub count: Option<u8>,
    /// x-bet payout bound (unused for TopPaying).
    #[serde(default)]
    pub value: u64,
}

/// Desired characteristics + curation parameters for a curation run.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
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
    /// Base-game hit-frequency band. Statistical gate (binomial SE), exactly
    /// the bonus_hit_rate pattern. None = no gate (intent absent from the GDD).
    #[serde(default)]
    pub hit_frequency_band: Option<HitRateBand>,
    /// Band for the model's THEORETICAL max win — a static pass/fail check
    /// (observed max is a noisy tail statistic; no SE term). None = no gate.
    #[serde(default)]
    pub max_win_band: Option<Band>,
    /// GDD pay constraints: enforced in GA repair(), asserted in verify.
    #[serde(default)]
    pub pay_constraints: Vec<PayConstraint>,
}

/// The on-disk target-file contract shared by every CLI: the spec fields plus
/// the curation master seed. Replaces the four duplicated `TargetJson` parsers.
#[derive(Deserialize)]
pub struct TargetFile {
    #[serde(flatten)]
    pub spec: TargetSpec,
    pub master_seed: u64,
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

    #[test]
    fn se_hit_frequency_is_binomial() {
        let se = standard_errors(&metrics(0.96, 2.8, vec![]), 10_000);
        // fixture hit_frequency is 0.3
        assert!((se.hit_frequency - (0.3f64 * 0.7 / 10_000.0).sqrt()).abs() < 1e-12);
    }

    #[test]
    fn target_json_contract_parses_the_python_emission() {
        // Locked wire contract with app/math/targets.py::derive_target — if a key
        // or casing changes on either side, this test or its Python twin fails.
        let json = r#"{
            "rtp_target": 0.96, "rtp_tolerance": 0.01,
            "volatility_min": 3.0, "volatility_max": 6.0,
            "bonus_hit_rate_bands": [{"min": 0.004, "max": 0.006}],
            "pool_size": 1000, "candidate_count": 50000,
            "realized_correction_band": 0.05, "master_seed": 2026,
            "hit_frequency_band": {"min": 0.225, "max": 0.375},
            "max_win_band": {"min": 2500.0, "max": 7500.0},
            "pay_constraints": [
                {"symbol": 2, "relation": "top-paying"},
                {"symbol": 0, "relation": "floor", "count": 3, "value": 5},
                {"symbol": 1, "relation": "ceiling", "value": 100}
            ]
        }"#;
        let t: TargetSpec = serde_json::from_str(json).unwrap(); // master_seed ignored
        assert_eq!(t.rtp_target, 0.96);
        assert_eq!(t.hit_frequency_band.unwrap().min, 0.225);
        assert_eq!(t.max_win_band.unwrap().max, 7500.0);
        assert_eq!(t.pay_constraints.len(), 3);
        assert!(matches!(
            t.pay_constraints[0].relation,
            PayRelation::TopPaying
        ));
        assert_eq!(t.pay_constraints[1].count, Some(3));
        assert_eq!(t.pay_constraints[1].value, 5);
        assert_eq!(t.pay_constraints[2].count, None);
        let tf: TargetFile = serde_json::from_str(json).unwrap();
        assert_eq!(tf.master_seed, 2026);
        assert_eq!(tf.spec.pay_constraints.len(), 3);
    }

    #[test]
    fn legacy_target_json_without_new_fields_still_parses() {
        let json = r#"{
            "rtp_target": 0.9, "rtp_tolerance": 0.02,
            "volatility_min": 0.0, "volatility_max": 1e9,
            "bonus_hit_rate_bands": [],
            "pool_size": 100, "candidate_count": 1000,
            "realized_correction_band": 0.05, "master_seed": 7
        }"#;
        let t: TargetSpec = serde_json::from_str(json).unwrap();
        assert!(t.hit_frequency_band.is_none());
        assert!(t.max_win_band.is_none());
        assert!(t.pay_constraints.is_empty());
    }
}
