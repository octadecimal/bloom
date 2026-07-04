//! What a tuning run returns: the tuned model, its full-fidelity metrics, a
//! PASS/near-miss verdict, and the search trace (for the audit report).

use crate::telemetry::PopulationStats;
use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::Metrics;

#[derive(Debug, Clone, PartialEq)]
pub struct BandMiss {
    /// "rtp" | "volatility" | "bonus_hit_rate[i]".
    pub metric: String,
    pub measured: f64,
    pub band_lo: f64,
    pub band_hi: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Pass,
    NearMiss { missed: Vec<BandMiss> },
}

#[derive(Debug, Clone, PartialEq)]
pub struct GenSnapshot {
    pub generation: usize,
    pub best_fitness: f64,
    pub best_rtp: f64,
    pub best_volatility: f64,
    pub best_bonus_hit_rates: Vec<f64>,
    pub population: PopulationStats,
    pub gene_agreement: Vec<f64>,
}

/// End-of-tune math profile over the final full-fidelity sample population —
/// the same samples used to measure the returned metrics.
#[derive(Debug, Clone, PartialEq)]
pub struct RunProfile {
    pub distribution: bloom_simulator::profile::WinDistribution,
    pub tail: bloom_simulator::profile::TailMetrics,
    pub rtp_convergence: Vec<bloom_simulator::profile::RtpPoint>,
}

/// Why the GA loop ended — surfaced to the studio so a run that stops at
/// generation 40 of 4000 reads as "stagnated", not as a silent failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The best candidate was confirmed in-band at final fidelity.
    Feasible,
    /// `stagnation_window` generations passed without improvement.
    Stagnated,
    /// `max_generations` exhausted.
    Budget,
}

impl StopReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            StopReason::Feasible => "feasible",
            StopReason::Stagnated => "stagnated",
            StopReason::Budget => "budget",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TuningTrace {
    pub master_seed: u64,
    pub generations_run: usize,
    pub snapshots: Vec<GenSnapshot>,
    pub population: usize,
    pub search_candidate_count: usize,
    pub final_candidate_count: usize,
    pub stop_reason: StopReason,
}

#[derive(Debug, Clone)]
pub struct TuneOutcome {
    pub model: SlotModel,
    pub metrics: Metrics,
    pub verdict: Verdict,
    pub trace: TuningTrace,
    pub profile: RunProfile,
}
