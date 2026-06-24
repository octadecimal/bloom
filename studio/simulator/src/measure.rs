//! Simulate rounds through the math engine and measure aggregate characteristics.

use bloom_math::mechanics::slots::{evaluate, SlotModel};
use rayon::prelude::*;

#[derive(Debug, Clone, PartialEq)]
pub struct RoundSample {
    pub seed: u64,
    pub payout: u64,
    pub base_payout: u64,
    pub feature_payout: u64,
    /// Whether each model bonus (in order) triggered this round.
    pub feature_triggers: Vec<bool>,
}

/// Evaluate every seed through the math engine, in parallel. Output order
/// matches `seeds` (rayon `map` preserves order).
pub fn simulate(model: &SlotModel, seeds: &[u64]) -> Vec<RoundSample> {
    seeds
        .par_iter()
        .map(|&seed| {
            let o = evaluate(model, seed);
            RoundSample {
                seed,
                payout: o.total_payout,
                base_payout: o.base_payout,
                feature_payout: o.feature_payout,
                feature_triggers: o.features.iter().map(|f| f.triggered).collect(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole};

    fn toy() -> SlotModel {
        SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable { entries: vec![PaytableEntry { symbol: 0, count: 1, payout: 1 }] },
            bonuses: vec![],
        }
    }

    #[test]
    fn simulate_preserves_order_and_is_deterministic() {
        let m = toy();
        let seeds = vec![1u64, 2, 3, 4, 5];
        let a = simulate(&m, &seeds);
        let b = simulate(&m, &seeds);
        assert_eq!(a, b);
        assert_eq!(a.iter().map(|s| s.seed).collect::<Vec<_>>(), seeds);
    }

    #[test]
    fn simulate_reports_payout_and_no_features() {
        let m = toy();
        let out = simulate(&m, &[10, 20, 30]);
        assert!(out.iter().all(|s| s.payout == 1));
        assert!(out.iter().all(|s| s.feature_triggers.is_empty()));
    }
}
