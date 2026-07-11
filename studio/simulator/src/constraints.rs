//! Static (statistics-free) constraint checks on a SlotModel. The GDD's
//! pay_constraints and max-win band are properties of the game itself, so a
//! Verify-only run on a hand-edited model reports violations too (spec
//! 2026-07-09 §6). Enforcement during tuning lives in the tuner's repair();
//! this module is the assertion side.

use crate::target::{PayConstraint, PayRelation, TargetSpec};
use bloom_math::mechanics::slots::{BonusFeature, SlotModel};

/// Finite stand-in for an open upper bound (floors have no ceiling). Follows
/// the volatility-"high" precedent (hi = 1e9): keeps wire floats finite.
pub const OPEN_HI: f64 = 1e18;

/// A deterministic constraint violation; field names mirror the BandMiss wire.
#[derive(Debug, Clone, PartialEq)]
pub struct Violation {
    pub metric: String,
    pub measured: f64,
    pub band_lo: f64,
    pub band_hi: f64,
}

/// Theoretical max win in bet-multiples: top paytable payout × the largest
/// bonus multiplier.
/// ponytail: single-line bound — ignores multi-line stacking; refine when
/// line/shape constraints land (spec §11).
pub fn theoretical_max_win(model: &SlotModel) -> u64 {
    let top_pay = model
        .paytable
        .entries
        .iter()
        .map(|e| e.payout)
        .max()
        .unwrap_or(0);
    let top_mult = model
        .bonuses
        .iter()
        .map(|b| match b {
            BonusFeature::FreeSpins { config, .. } => config.multiplier,
        })
        .max()
        .unwrap_or(1)
        .max(1);
    top_pay.saturating_mul(top_mult)
}

fn scoped(c: &PayConstraint, symbol: u8, count: u8) -> bool {
    c.symbol == symbol && c.count.is_none_or(|cc| cc == count)
}

/// Violations of the target's static invariants by `model`. Empty ⟺ the model
/// satisfies every deterministic constraint.
pub fn static_violations(model: &SlotModel, target: &TargetSpec) -> Vec<Violation> {
    let mut out = Vec::new();
    if let Some(band) = &target.max_win_band {
        let mw = theoretical_max_win(model) as f64;
        if mw < band.min || mw > band.max {
            out.push(Violation {
                metric: "max_win".into(),
                measured: mw,
                band_lo: band.min,
                band_hi: band.max,
            });
        }
    }
    for c in &target.pay_constraints {
        match c.relation {
            PayRelation::Floor => {
                for e in &model.paytable.entries {
                    if scoped(c, e.symbol, e.count) && e.payout < c.value {
                        out.push(Violation {
                            metric: format!("pay_floor[{}@{}]", e.symbol, e.count),
                            measured: e.payout as f64,
                            band_lo: c.value as f64,
                            band_hi: OPEN_HI,
                        });
                    }
                }
            }
            PayRelation::Ceiling => {
                for e in &model.paytable.entries {
                    if scoped(c, e.symbol, e.count) && e.payout > c.value {
                        out.push(Violation {
                            metric: format!("pay_ceiling[{}@{}]", e.symbol, e.count),
                            measured: e.payout as f64,
                            band_lo: 0.0,
                            band_hi: c.value as f64,
                        });
                    }
                }
            }
            PayRelation::TopPaying => {
                let top = model
                    .paytable
                    .entries
                    .iter()
                    .filter(|e| e.symbol == c.symbol)
                    .map(|e| e.payout)
                    .max()
                    .unwrap_or(0);
                for e in &model.paytable.entries {
                    if e.symbol != c.symbol && e.payout > top {
                        out.push(Violation {
                            metric: format!("top_paying[{}]", c.symbol),
                            measured: e.payout as f64,
                            band_lo: 0.0,
                            band_hi: top as f64,
                        });
                    }
                }
            }
        }
    }
    out
}

/// `Err(message)` for nonsensical constraint/band inputs, BEFORE a search or
/// curation runs on them: unknown symbol id, floor above ceiling, more than
/// one top-paying, inverted bands (spec §6 "up-front validation").
pub fn validate_constraints(model: &SlotModel, target: &TargetSpec) -> Result<(), String> {
    if let Some(b) = &target.hit_frequency_band {
        if b.min > b.max {
            return Err(format!(
                "hit_frequency_band inverted ({} > {})",
                b.min, b.max
            ));
        }
    }
    if let Some(b) = &target.max_win_band {
        if b.min > b.max {
            return Err(format!("max_win_band inverted ({} > {})", b.min, b.max));
        }
    }
    let mut top_paying = 0usize;
    for c in &target.pay_constraints {
        if !model.symbols.iter().any(|s| s.id == c.symbol) {
            return Err(format!(
                "pay constraint references unknown model symbol id {}",
                c.symbol
            ));
        }
        if matches!(c.relation, PayRelation::TopPaying) {
            top_paying += 1;
            if !model.paytable.entries.iter().any(|e| e.symbol == c.symbol) {
                return Err(format!(
                    "top-paying symbol {} has no paytable entries (line-pay symbols only)",
                    c.symbol
                ));
            }
        }
    }
    if top_paying > 1 {
        return Err(format!(
            "{top_paying} top-paying constraints; at most one symbol can pay the most"
        ));
    }
    for f in target
        .pay_constraints
        .iter()
        .filter(|c| matches!(c.relation, PayRelation::Floor))
    {
        for cl in target
            .pay_constraints
            .iter()
            .filter(|c| matches!(c.relation, PayRelation::Ceiling))
        {
            let overlap = f.symbol == cl.symbol
                && match (f.count, cl.count) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                };
            if overlap && f.value > cl.value {
                return Err(format!(
                    "floor {} exceeds ceiling {} for symbol {}",
                    f.value, cl.value, f.symbol
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::{HitRateBand, PayConstraint, PayRelation, TargetSpec};
    use bloom_math::mechanics::slots::{
        BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
        TriggerSpec,
    };

    // sym0 pays 10@3, sym1 pays 50@3, sym2 (scatter) triggers a x3 bonus.
    fn model() -> SlotModel {
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
                    role: SymbolRole::Scatter,
                },
            ],
            reels: vec![vec![0, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry {
                        symbol: 0,
                        count: 3,
                        payout: 10,
                    },
                    PaytableEntry {
                        symbol: 1,
                        count: 3,
                        payout: 50,
                    },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec {
                    symbol: 2,
                    min_count: 3,
                },
                config: FreeSpinsConfig {
                    spins_awarded: 5,
                    retrigger: false,
                    multiplier: 3,
                    feature_reels: None,
                },
            }],
        }
    }

    fn target_with(constraints: Vec<PayConstraint>) -> TargetSpec {
        TargetSpec {
            pay_constraints: constraints,
            ..Default::default()
        }
    }

    #[test]
    fn theoretical_max_win_is_top_pay_times_top_multiplier() {
        assert_eq!(theoretical_max_win(&model()), 150); // 50 × 3
        let mut m = model();
        m.bonuses.clear();
        assert_eq!(theoretical_max_win(&m), 50); // multiplier defaults to 1
    }

    #[test]
    fn max_win_band_violation_is_reported() {
        let mut t = target_with(vec![]);
        t.max_win_band = Some(HitRateBand {
            min: 500.0,
            max: 1000.0,
        });
        let v = static_violations(&model(), &t);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].metric, "max_win");
        assert_eq!(v[0].measured, 150.0);
        t.max_win_band = Some(HitRateBand {
            min: 100.0,
            max: 1000.0,
        });
        assert!(static_violations(&model(), &t).is_empty());
    }

    #[test]
    fn floor_and_ceiling_violations_respect_the_count_scope() {
        // floor 20 on sym0@3 (pays 10) → violated; scoped to a count that
        // doesn't exist → no violation.
        let t = target_with(vec![PayConstraint {
            symbol: 0,
            relation: PayRelation::Floor,
            count: Some(3),
            value: 20,
        }]);
        let v = static_violations(&model(), &t);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].metric, "pay_floor[0@3]");
        assert_eq!(v[0].band_hi, OPEN_HI);

        let t = target_with(vec![PayConstraint {
            symbol: 0,
            relation: PayRelation::Floor,
            count: Some(4),
            value: 20,
        }]);
        assert!(static_violations(&model(), &t).is_empty());

        let t = target_with(vec![PayConstraint {
            symbol: 1,
            relation: PayRelation::Ceiling,
            count: None,
            value: 30,
        }]);
        assert_eq!(
            static_violations(&model(), &t)[0].metric,
            "pay_ceiling[1@3]"
        );
    }

    #[test]
    fn top_paying_flags_any_competitor_above_the_designated_symbol() {
        // sym0 designated top but sym1 pays 50 > 10 → violation.
        let t = target_with(vec![PayConstraint {
            symbol: 0,
            relation: PayRelation::TopPaying,
            count: None,
            value: 0,
        }]);
        let v = static_violations(&model(), &t);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].metric, "top_paying[0]");
        // sym1 designated top → already true → clean.
        let t = target_with(vec![PayConstraint {
            symbol: 1,
            relation: PayRelation::TopPaying,
            count: None,
            value: 0,
        }]);
        assert!(static_violations(&model(), &t).is_empty());
    }

    #[test]
    fn validate_rejects_unknown_symbol_two_tops_inverted_bands_and_floor_over_ceiling() {
        let unknown = target_with(vec![PayConstraint {
            symbol: 9,
            relation: PayRelation::Floor,
            count: None,
            value: 1,
        }]);
        assert!(validate_constraints(&model(), &unknown)
            .unwrap_err()
            .contains("unknown model symbol"));

        let two_tops = target_with(vec![
            PayConstraint {
                symbol: 0,
                relation: PayRelation::TopPaying,
                count: None,
                value: 0,
            },
            PayConstraint {
                symbol: 1,
                relation: PayRelation::TopPaying,
                count: None,
                value: 0,
            },
        ]);
        assert!(validate_constraints(&model(), &two_tops)
            .unwrap_err()
            .contains("at most one"));

        let mut inverted = target_with(vec![]);
        inverted.hit_frequency_band = Some(HitRateBand { min: 0.4, max: 0.2 });
        assert!(validate_constraints(&model(), &inverted)
            .unwrap_err()
            .contains("hit_frequency_band"));

        let clash = target_with(vec![
            PayConstraint {
                symbol: 0,
                relation: PayRelation::Floor,
                count: None,
                value: 100,
            },
            PayConstraint {
                symbol: 0,
                relation: PayRelation::Ceiling,
                count: None,
                value: 50,
            },
        ]);
        assert!(validate_constraints(&model(), &clash)
            .unwrap_err()
            .contains("floor"));

        assert!(validate_constraints(&model(), &target_with(vec![])).is_ok());
    }

    #[test]
    fn validate_rejects_top_paying_on_a_symbol_with_no_paytable_entries() {
        // sym2 is a scatter with no paytable entries — TopPaying on it would
        // make repair's `top = ...max().unwrap_or(0)` cap every competitor to 0.
        let no_entries = target_with(vec![PayConstraint {
            symbol: 2,
            relation: PayRelation::TopPaying,
            count: None,
            value: 0,
        }]);
        assert!(validate_constraints(&model(), &no_entries)
            .unwrap_err()
            .contains("no paytable entries"));
    }
}
