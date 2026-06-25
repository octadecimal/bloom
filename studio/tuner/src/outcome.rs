//! What a tuning run returns: the tuned model, its full-fidelity metrics, a
//! PASS/near-miss verdict, and the search trace (for the audit report).

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
}

#[derive(Debug, Clone, PartialEq)]
pub struct TuningTrace {
    pub master_seed: u64,
    pub generations_run: usize,
    pub snapshots: Vec<GenSnapshot>,
    pub population: usize,
    pub search_candidate_count: usize,
    pub final_candidate_count: usize,
}

#[derive(Debug, Clone)]
pub struct TuneOutcome {
    pub model: SlotModel,
    pub metrics: Metrics,
    pub verdict: Verdict,
    pub trace: TuningTrace,
}
