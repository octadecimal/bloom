//! Simulate rounds through the math engine and measure aggregate characteristics.

use crate::target::Metrics;
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

/// Aggregate a population of samples into measured characteristics.
pub fn measure(samples: &[RoundSample]) -> Metrics {
    let n = samples.len() as f64;
    assert!(n > 0.0, "cannot measure an empty population");

    let mean = |f: fn(&RoundSample) -> u64| samples.iter().map(|s| f(s) as f64).sum::<f64>() / n;

    let rtp = mean(|s| s.payout);
    let base_rtp = mean(|s| s.base_payout);
    let feature_rtp = mean(|s| s.feature_payout);

    let variance = samples
        .iter()
        .map(|s| {
            let d = s.payout as f64 - rtp;
            d * d
        })
        .sum::<f64>()
        / n;

    let feature_count = samples[0].feature_triggers.len();
    let bonus_hit_rates = (0..feature_count)
        .map(|i| samples.iter().filter(|s| s.feature_triggers[i]).count() as f64 / n)
        .collect();

    Metrics {
        rtp,
        volatility: variance.sqrt(),
        hit_frequency: samples.iter().filter(|s| s.payout > 0).count() as f64 / n,
        bonus_hit_rates,
        base_rtp,
        feature_rtp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::Metrics;
    use bloom_math::mechanics::slots::{Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole};

    fn toy() -> SlotModel {
        SlotModel {
            symbols: vec![SymbolDef {
                id: 0,
                role: SymbolRole::Normal,
            }],
            reels: vec![vec![0]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![PaytableEntry {
                    symbol: 0,
                    count: 1,
                    payout: 1,
                }],
            },
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

    fn measurable() -> SlotModel {
        // 1 reel, 1 row, 1 line. strip = 5x sym0, 4x sym1, 1x sym2 (10 cells).
        // paytable: sym1 count1 -> 1 ; sym2 count1 -> 5. Closed-form RTP = 0.9.
        SlotModel {
            symbols: vec![
                SymbolDef {
                    id: 0,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 1,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 2,
                    role: SymbolRole::Normal,
                },
            ],
            reels: vec![vec![0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry {
                        symbol: 1,
                        count: 1,
                        payout: 1,
                    },
                    PaytableEntry {
                        symbol: 2,
                        count: 1,
                        payout: 5,
                    },
                ],
            },
            bonuses: vec![],
        }
    }

    #[test]
    fn rtp_converges_to_closed_form() {
        let m = measurable();
        let seeds = crate::seedgen::generate_seeds(2026, 1_000_000);
        let metrics: Metrics = measure(&simulate(&m, &seeds));
        assert!((metrics.rtp - 0.9).abs() < 0.02, "rtp = {}", metrics.rtp);
        assert!(metrics.hit_frequency > 0.0 && metrics.hit_frequency < 1.0);
        assert!(metrics.bonus_hit_rates.is_empty()); // no bonuses
        assert!((metrics.base_rtp - metrics.rtp).abs() < 1e-9);
    }
}
