//! Simulate rounds through the math engine and measure aggregate characteristics.

use crate::target::Metrics;
use bloom_math::mechanics::slots::{evaluate, SlotModel};
use rayon::prelude::*;

#[derive(Debug, Clone, PartialEq)]
pub struct RoundSample {
    pub seed: u64,
    /// Total round payout in bet-multiples (spec §3.2).
    pub total_payout: u64,
    pub base_payout: u64,
    pub feature_payout: u64,
    /// Whether each model bonus (in order) triggered this round. Slots only;
    /// empty for composed (feature-level bands stay issue #160).
    pub feature_triggers: Vec<bool>,
    /// Per-state payout attribution, one entry per state visit in visit order.
    /// Slots maps onto two pseudo-states: ("base", base_payout) always, plus
    /// ("feature", feature_payout) on rounds where any bonus triggered.
    pub state_payouts: Vec<(String, u64)>,
}

/// One slots round → the family-agnostic sample. Shared by `simulate` and
/// `MathArtifact::evaluate_seed`.
pub(crate) fn sample_slots(model: &SlotModel, seed: u64) -> RoundSample {
    let o = evaluate(model, seed);
    let mut state_payouts = vec![("base".to_string(), o.base_payout)];
    if o.features.iter().any(|f| f.triggered) {
        state_payouts.push(("feature".to_string(), o.feature_payout));
    }
    RoundSample {
        seed,
        total_payout: o.total_payout,
        base_payout: o.base_payout,
        feature_payout: o.feature_payout,
        feature_triggers: o.features.iter().map(|f| f.triggered).collect(),
        state_payouts,
    }
}

/// Evaluate every seed through the math engine, in parallel. Output order
/// matches `seeds` (rayon `map` preserves order).
pub fn simulate(model: &SlotModel, seeds: &[u64]) -> Vec<RoundSample> {
    seeds
        .par_iter()
        .map(|&seed| sample_slots(model, seed))
        .collect()
}

/// Aggregate a population of samples into measured characteristics.
pub fn measure(samples: &[RoundSample]) -> Metrics {
    let n = samples.len() as f64;
    assert!(n > 0.0, "cannot measure an empty population");

    let mean = |f: fn(&RoundSample) -> u64| samples.iter().map(|s| f(s) as f64).sum::<f64>() / n;

    let rtp = mean(|s| s.total_payout);
    let base_rtp = mean(|s| s.base_payout);
    let feature_rtp = mean(|s| s.feature_payout);

    let variance = samples
        .iter()
        .map(|s| {
            let d = s.total_payout as f64 - rtp;
            d * d
        })
        .sum::<f64>()
        / n;

    let feature_count = samples[0].feature_triggers.len();
    let bonus_hit_rates = (0..feature_count)
        .map(|i| samples.iter().filter(|s| s.feature_triggers[i]).count() as f64 / n)
        .collect();

    let mut state_sum: std::collections::BTreeMap<String, u64> = Default::default();
    let mut state_visits: std::collections::BTreeMap<String, u64> = Default::default();
    for s in samples {
        for (state, payout) in &s.state_payouts {
            *state_sum.entry(state.clone()).or_insert(0) += payout;
            *state_visits.entry(state.clone()).or_insert(0) += 1;
        }
    }

    Metrics {
        rtp,
        volatility: variance.sqrt(),
        hit_frequency: samples.iter().filter(|s| s.total_payout > 0).count() as f64 / n,
        bonus_hit_rates,
        base_rtp,
        feature_rtp,
        max_win: samples.iter().map(|s| s.total_payout).max().unwrap_or(0),
        state_rtp: state_sum
            .into_iter()
            .map(|(k, v)| (k, v as f64 / n))
            .collect(),
        state_visit_freq: state_visits
            .into_iter()
            .map(|(k, v)| (k, v as f64 / n))
            .collect(),
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
        assert!(out.iter().all(|s| s.total_payout == 1));
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

    // 1 reel, 1 row: strip [2, 0]. sym0@1 pays 2. Scatter sym2 min_count 1
    // triggers a 1-spin x1 free-spins bonus (~50% of spins).
    fn bonused() -> SlotModel {
        use bloom_math::mechanics::slots::{BonusFeature, FreeSpinsConfig, TriggerSpec};
        SlotModel {
            symbols: vec![
                SymbolDef {
                    id: 0,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 2,
                    role: SymbolRole::Scatter,
                },
            ],
            reels: vec![vec![2, 0]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![PaytableEntry {
                    symbol: 0,
                    count: 1,
                    payout: 2,
                }],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec {
                    symbol: 2,
                    min_count: 1,
                },
                config: FreeSpinsConfig {
                    spins_awarded: 1,
                    retrigger: false,
                    multiplier: 1,
                    feature_reels: None,
                },
            }],
        }
    }

    #[test]
    fn slots_samples_map_onto_base_and_feature_pseudo_states() {
        let samples = simulate(&bonused(), &crate::seedgen::generate_seeds(7, 2_000));
        assert!(samples.iter().any(|s| s.feature_triggers[0]));
        assert!(samples.iter().any(|s| !s.feature_triggers[0]));
        for s in &samples {
            assert_eq!(s.state_payouts[0], ("base".to_string(), s.base_payout));
            if s.feature_triggers[0] {
                assert_eq!(
                    s.state_payouts[1],
                    ("feature".to_string(), s.feature_payout)
                );
                assert_eq!(s.state_payouts.len(), 2);
            } else {
                assert_eq!(s.state_payouts.len(), 1);
                assert_eq!(s.feature_payout, 0);
            }
            assert_eq!(
                s.state_payouts.iter().map(|(_, p)| p).sum::<u64>(),
                s.total_payout
            );
        }
    }

    #[test]
    fn measure_reports_max_win_and_per_state_shares() {
        let samples = simulate(&bonused(), &crate::seedgen::generate_seeds(7, 2_000));
        let m = measure(&samples);
        assert_eq!(
            m.max_win,
            samples.iter().map(|s| s.total_payout).max().unwrap()
        );
        assert!((m.state_rtp["base"] - m.base_rtp).abs() < 1e-12);
        assert!((m.state_rtp["feature"] - m.feature_rtp).abs() < 1e-12);
        assert!((m.state_visit_freq["base"] - 1.0).abs() < 1e-12);
        // single bonus: "feature" visit frequency IS the bonus hit rate
        assert!((m.state_visit_freq["feature"] - m.bonus_hit_rates[0]).abs() < 1e-12);
    }
}
