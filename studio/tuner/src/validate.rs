//! Up-front validation of tuner inputs, so malformed targets/configs fail with
//! a clear message instead of panicking deep in the search (e.g. the final-tier
//! `verify` asserts band-count == bonus-count).

use crate::config::TunerConfig;
use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::target::TargetSpec;

/// Absurdity ceilings: far above any honest tune (defaults: population 24,
/// generations 40, candidate counts ~10^4–10^5). Reject beyond these BEFORE the
/// GA allocates `generate_seeds(count)` / a population vector and OOMs.
pub const MAX_POPULATION: usize = 1_000_000;
pub const MAX_GENERATIONS: usize = 1_000_000;
pub const MAX_CANDIDATE_COUNT: usize = 100_000_000;

/// Returns `Err(message)` if the inputs would cause a downstream panic or are
/// nonsensical. Checks: one hit-rate band per model bonus; every gene bound has
/// `min <= max`; non-zero population.
pub fn validate(
    seed_model: &SlotModel,
    target: &TargetSpec,
    cfg: &TunerConfig,
) -> Result<(), String> {
    if target.bonus_hit_rate_bands.len() != seed_model.bonuses.len() {
        return Err(format!(
            "target has {} bonus_hit_rate_bands but model has {} bonuses (must match)",
            target.bonus_hit_rate_bands.len(),
            seed_model.bonuses.len()
        ));
    }
    let b = &cfg.bounds;
    if b.payout_min > b.payout_max {
        return Err(format!(
            "payout_min ({}) > payout_max ({})",
            b.payout_min, b.payout_max
        ));
    }
    if b.spins_min > b.spins_max {
        return Err(format!(
            "spins_min ({}) > spins_max ({})",
            b.spins_min, b.spins_max
        ));
    }
    if b.multiplier_min > b.multiplier_max {
        return Err(format!(
            "multiplier_min ({}) > multiplier_max ({})",
            b.multiplier_min, b.multiplier_max
        ));
    }
    if b.min_count_min > b.min_count_max {
        return Err(format!(
            "min_count_min ({}) > min_count_max ({})",
            b.min_count_min, b.min_count_max
        ));
    }
    if cfg.population == 0 {
        return Err("population must be > 0".to_string());
    }
    if cfg.population > MAX_POPULATION {
        return Err(format!(
            "population {} exceeds MAX_POPULATION {}",
            cfg.population, MAX_POPULATION
        ));
    }
    if cfg.max_generations > MAX_GENERATIONS {
        return Err(format!(
            "max_generations {} exceeds MAX_GENERATIONS {}",
            cfg.max_generations, MAX_GENERATIONS
        ));
    }
    if cfg.search_candidate_count > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "search_candidate_count {} exceeds MAX_CANDIDATE_COUNT {}",
            cfg.search_candidate_count, MAX_CANDIDATE_COUNT
        ));
    }
    if cfg.final_candidate_count > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "final_candidate_count {} exceeds MAX_CANDIDATE_COUNT {}",
            cfg.final_candidate_count, MAX_CANDIDATE_COUNT
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GeneBounds, TunerConfig, Weights};
    use bloom_math::mechanics::slots::{Paytable, SlotModel};
    use bloom_simulator::target::{HitRateBand, TargetSpec};

    fn model(n_bonuses: usize) -> SlotModel {
        // bonuses content is irrelevant to validate(); only the count matters,
        // so build a vec of the right length from one sample bonus.
        use bloom_math::mechanics::slots::{BonusFeature, FreeSpinsConfig, TriggerSpec};
        let bonus = BonusFeature::FreeSpins {
            trigger: TriggerSpec {
                symbol: 9,
                min_count: 3,
            },
            config: FreeSpinsConfig {
                spins_awarded: 5,
                retrigger: true,
                multiplier: 2,
                feature_reels: None,
            },
        };
        SlotModel {
            symbols: vec![],
            reels: vec![],
            rows: 1,
            paylines: vec![],
            paytable: Paytable { entries: vec![] },
            bonuses: std::iter::repeat_n(bonus, n_bonuses).collect(),
        }
    }

    fn target(n_bands: usize) -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 1.0,
            volatility_max: 10.0,
            bonus_hit_rate_bands: std::iter::repeat_n(
                HitRateBand {
                    min: 0.0,
                    max: 0.05,
                },
                n_bands,
            )
            .collect(),
            pool_size: 100,
            candidate_count: 1000,
            realized_correction_band: 0.05,
        }
    }

    fn cfg() -> TunerConfig {
        TunerConfig {
            master_seed: 1,
            population: 8,
            max_generations: 5,
            elitism: 1,
            mutation_rate: 0.2,
            crossover_rate: 0.9,
            stagnation_window: 5,
            search_candidate_count: 1000,
            final_candidate_count: 1000,
            bounds: GeneBounds {
                payout_min: 0,
                payout_max: 20,
                spins_min: 1,
                spins_max: 50,
                multiplier_min: 1,
                multiplier_max: 10,
                min_count_min: 1,
                min_count_max: 5,
            },
            weights: Weights {
                rtp: 1.0,
                volatility: 1.0,
                hit_rate: 1.0,
            },
        }
    }

    #[test]
    fn ok_when_counts_match_and_bounds_sane() {
        assert!(validate(&model(1), &target(1), &cfg()).is_ok());
    }

    #[test]
    fn rejects_band_bonus_count_mismatch() {
        let err = validate(&model(1), &target(0), &cfg()).unwrap_err();
        assert!(err.contains("bonus_hit_rate_bands"));
    }

    #[test]
    fn rejects_inverted_bound() {
        let mut c = cfg();
        c.bounds.payout_min = 100;
        c.bounds.payout_max = 1;
        assert!(validate(&model(1), &target(1), &c).is_err());
    }

    #[test]
    fn rejects_zero_population() {
        let mut c = cfg();
        c.population = 0;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("population"));
    }

    #[test]
    fn rejects_oversized_population() {
        let mut c = cfg();
        c.population = MAX_POPULATION + 1;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("population"));
    }

    #[test]
    fn rejects_oversized_generations() {
        let mut c = cfg();
        c.max_generations = MAX_GENERATIONS + 1;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("max_generations"));
    }

    #[test]
    fn rejects_oversized_candidate_count() {
        let mut c = cfg();
        c.search_candidate_count = MAX_CANDIDATE_COUNT + 1;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("search_candidate_count"));
    }

    #[test]
    fn rejects_oversized_final_candidate_count() {
        let mut c = cfg();
        c.final_candidate_count = MAX_CANDIDATE_COUNT + 1;
        assert!(validate(&model(1), &target(1), &c)
            .unwrap_err()
            .contains("final_candidate_count"));
    }
}
