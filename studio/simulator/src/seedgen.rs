//! Deterministic candidate-seed generation. A curation run is reproducible:
//! the same master seed yields the same candidate seeds, hence the same pool.

use bloom_math::rng::SplitMix64;

/// Generate `count` candidate seeds deterministically from `master_seed`.
pub fn generate_seeds(master_seed: u64, count: usize) -> Vec<u64> {
    let mut rng = SplitMix64::new(master_seed);
    (0..count).map(|_| rng.next_u64()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_same_master() {
        assert_eq!(generate_seeds(42, 1000), generate_seeds(42, 1000));
    }

    #[test]
    fn different_masters_differ() {
        assert_ne!(generate_seeds(1, 100), generate_seeds(2, 100));
    }

    #[test]
    fn produces_requested_count() {
        assert_eq!(generate_seeds(7, 256).len(), 256);
    }
}
