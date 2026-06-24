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
