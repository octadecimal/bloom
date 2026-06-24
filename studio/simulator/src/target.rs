//! Target spec (desired characteristics) and measured metrics.

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
