//! Mechanic #1: slots. Expands one seed into one visible row of symbols.
//! Integer-only and deterministic — see `trusted/AGENTS.md`.

use crate::rng::SplitMix64;

/// A symbol id. Its meaning (art, name, value) lives in the game package's
/// presentation manifest, never here.
pub type Symbol = u8;

/// The slot math model: one strip of symbols per reel. Outcome probability is
/// encoded by symbol multiplicity within each strip. Reels must be non-empty.
pub struct SlotModel {
    pub reels: Vec<Vec<Symbol>>,
}

/// Expand one seed into the visible row: one symbol per reel.
/// Deterministic — the same `(model, seed)` always yields the same row.
pub fn expand(model: &SlotModel, seed: u64) -> Vec<Symbol> {
    let mut rng = SplitMix64::new(seed);
    model
        .reels
        .iter()
        .map(|reel| {
            let stop = (rng.next_u64() % reel.len() as u64) as usize;
            reel[stop]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_model() -> SlotModel {
        SlotModel {
            reels: vec![
                vec![0, 1, 2, 3, 4],
                vec![0, 1, 2, 3, 4],
                vec![0, 1, 2, 3, 4],
            ],
        }
    }

    #[test]
    fn produces_one_symbol_per_reel() {
        let model = sample_model();
        let row = expand(&model, 12345);
        assert_eq!(row.len(), 3);
    }

    #[test]
    fn every_symbol_comes_from_its_reel() {
        let model = sample_model();
        let row = expand(&model, 12345);
        for (i, sym) in row.iter().enumerate() {
            assert!(model.reels[i].contains(sym));
        }
    }

    #[test]
    fn same_seed_same_row_repeatably() {
        let model = sample_model();
        let first = expand(&model, 999);
        for _ in 0..10_000 {
            assert_eq!(expand(&model, 999), first);
        }
    }

    #[test]
    fn distribution_reflects_multiplicity() {
        // A reel weighted 3:1 toward symbol 0 should land on 0 far more often.
        let model = SlotModel {
            reels: vec![vec![0, 0, 0, 1]],
        };
        let mut zeros = 0u32;
        for seed in 0..10_000u64 {
            if expand(&model, seed)[0] == 0 {
                zeros += 1;
            }
        }
        // Expected ~7500; assert a wide, deterministic-safe band.
        assert!(zeros > 6500 && zeros < 8500, "zeros = {}", zeros);
    }
}
