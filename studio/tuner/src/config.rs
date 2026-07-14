//! Tuner search configuration: gene bounds, GA hyperparameters, objective
//! weights, fidelity, and the master seed that makes a run reproducible.

/// Inclusive bounds for the scalar genes. Reel counts are bounded
/// `[0, strip_len]` (strip_len is fixed per reel from the seed model), so they
/// are not listed here.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneBounds {
    pub payout_min: u64,
    pub payout_max: u64,
    pub spins_min: u32,
    pub spins_max: u32,
    pub multiplier_min: u64,
    pub multiplier_max: u64,
    pub min_count_min: u8,
    pub min_count_max: u8,
    /// Bounds for composed `meter@1` targets (the features gene group rides
    /// GeneBounds like slots' bonus genes; awarded budgets ride spins_min/max —
    /// a budget IS spins awarded).
    pub meter_target_min: u32,
    pub meter_target_max: u32,
}

/// Per-metric weights for the distance-to-band objective.
#[derive(Debug, Clone, PartialEq)]
pub struct Weights {
    pub rtp: f64,
    pub volatility: f64,
    pub hit_rate: f64,
    /// Weight of the base-game hit-frequency band (Plan 2).
    pub hit_frequency: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TunerConfig {
    pub master_seed: u64,
    pub population: usize,
    pub max_generations: usize,
    pub elitism: usize,
    /// Per-gene mutation probability in [0, 1].
    pub mutation_rate: f64,
    /// Probability that a child is a crossover (else a clone of parent 1).
    pub crossover_rate: f64,
    /// Stop if the global best fitness does not improve for this many gens.
    pub stagnation_window: usize,
    /// Rounds simulated per candidate DURING the search (cheap).
    pub search_candidate_count: usize,
    /// Rounds simulated to re-measure the winner (full fidelity).
    pub final_candidate_count: usize,
    pub bounds: GeneBounds,
    pub weights: Weights,
    pub locks: SectionLocks,
}

/// Section-level automation locks. A locked group's genes are omitted from the
/// genome entirely (the search space genuinely shrinks); `decode` copies that
/// group verbatim from the seed model. Locks constrain automation, never humans.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SectionLocks {
    pub reels: bool,
    pub paytable: bool,
    pub bonus: bool,
}

impl SectionLocks {
    pub fn all_locked(&self) -> bool {
        self.reels && self.paytable && self.bonus
    }
}
