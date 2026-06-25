//! The tunable genome and its lossless mapping to/from a `SlotModel`. Only the
//! tunable levers are genes (reel composition, paytable payouts, bonus config);
//! everything else comes from the seed model (the template) at decode time.

use crate::config::GeneBounds;
use bloom_math::mechanics::slots::{
    BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, Symbol, TriggerSpec,
};

#[derive(Debug, Clone, PartialEq)]
pub struct BonusGenes {
    pub spins_awarded: u32,
    pub multiplier: u64,
    pub min_count: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Genome {
    /// Per reel, the count of each distinct symbol id (in the reel's
    /// ascending-id order). Sums to the reel's fixed strip length.
    pub reel_counts: Vec<Vec<u32>>,
    /// Payout per paytable entry, in entry order.
    pub payouts: Vec<u64>,
    /// One entry per `FreeSpins` bonus, in order.
    pub bonuses: Vec<BonusGenes>,
}

/// The distinct symbol ids present on a reel, ascending. The canonical key for
/// that reel's count vector (encode + decode must agree on this order).
fn reel_symbols(reel: &[Symbol]) -> Vec<Symbol> {
    let mut s: Vec<Symbol> = reel.to_vec();
    s.sort_unstable();
    s.dedup();
    s
}

pub fn encode(model: &SlotModel) -> Genome {
    let reel_counts = model
        .reels
        .iter()
        .map(|reel| {
            reel_symbols(reel)
                .iter()
                .map(|&sym| reel.iter().filter(|&&c| c == sym).count() as u32)
                .collect()
        })
        .collect();

    let payouts = model.paytable.entries.iter().map(|e| e.payout).collect();

    let bonuses = model
        .bonuses
        .iter()
        .map(|b| match b {
            BonusFeature::FreeSpins { trigger, config } => BonusGenes {
                spins_awarded: config.spins_awarded,
                multiplier: config.multiplier,
                min_count: trigger.min_count,
            },
        })
        .collect();

    Genome {
        reel_counts,
        payouts,
        bonuses,
    }
}

/// Lay out a reel's per-symbol counts in a deterministic round-robin order:
/// cycle through the symbols (ascending id) emitting one of each with remaining
/// count, until all are placed. Spreads symbols (faithful for rows > 1).
fn layout(symbols: &[Symbol], counts: &[u32]) -> Vec<Symbol> {
    let mut remaining: Vec<u32> = counts.to_vec();
    let total: u32 = remaining.iter().sum();
    let mut out = Vec::with_capacity(total as usize);
    while out.len() < total as usize {
        for (i, &sym) in symbols.iter().enumerate() {
            if remaining[i] > 0 {
                out.push(sym);
                remaining[i] -= 1;
            }
        }
    }
    out
}

pub fn decode(genome: &Genome, template: &SlotModel) -> SlotModel {
    let reels = template
        .reels
        .iter()
        .zip(&genome.reel_counts)
        .map(|(reel, counts)| layout(&reel_symbols(reel), counts))
        .collect();

    let entries = template
        .paytable
        .entries
        .iter()
        .zip(&genome.payouts)
        .map(|(e, &payout)| PaytableEntry {
            symbol: e.symbol,
            count: e.count,
            payout,
        })
        .collect();

    let bonuses = template
        .bonuses
        .iter()
        .zip(&genome.bonuses)
        .map(|(b, g)| match b {
            BonusFeature::FreeSpins { trigger, config } => BonusFeature::FreeSpins {
                trigger: TriggerSpec {
                    symbol: trigger.symbol,
                    min_count: g.min_count,
                },
                config: FreeSpinsConfig {
                    spins_awarded: g.spins_awarded,
                    retrigger: config.retrigger,
                    multiplier: g.multiplier,
                    feature_reels: config.feature_reels.clone(),
                },
            },
        })
        .collect();

    SlotModel {
        symbols: template.symbols.clone(),
        reels,
        rows: template.rows,
        paylines: template.paylines.clone(),
        paytable: Paytable { entries },
        bonuses,
    }
}

fn clamp_u64(v: u64, lo: u64, hi: u64) -> u64 {
    v.max(lo).min(hi)
}
fn clamp_u32(v: u32, lo: u32, hi: u32) -> u32 {
    v.max(lo).min(hi)
}
fn clamp_u8(v: u8, lo: u8, hi: u8) -> u8 {
    v.max(lo).min(hi)
}

/// Force every gene back into the feasible set. Deterministic. After repair,
/// `decode` always yields a structurally valid `SlotModel`.
pub fn repair(genome: &mut Genome, template: &SlotModel, bounds: &GeneBounds) {
    // Reel counts: rescale (deterministically) so each reel sums to its fixed
    // strip length, keeping at least the original number of distinct symbols.
    for (reel, counts) in template.reels.iter().zip(&mut genome.reel_counts) {
        let target = reel.len() as u32;
        let sum: u32 = counts.iter().sum();
        if sum == 0 {
            // degenerate: distribute evenly, remainder to the first symbol.
            let n = counts.len() as u32;
            for (i, c) in counts.iter_mut().enumerate() {
                *c = target / n + if (i as u32) < target % n { 1 } else { 0 };
            }
        } else if sum != target {
            // scale to target, then fix the rounding drift on the last bucket.
            let mut acc = 0u32;
            let last = counts.len() - 1;
            for c in counts.iter_mut().take(last) {
                *c = ((*c as u64 * target as u64) / sum as u64) as u32;
                acc += *c;
            }
            counts[last] = target.saturating_sub(acc);
        }
    }

    for p in &mut genome.payouts {
        *p = clamp_u64(*p, bounds.payout_min, bounds.payout_max);
    }

    for b in &mut genome.bonuses {
        b.spins_awarded = clamp_u32(b.spins_awarded, bounds.spins_min, bounds.spins_max);
        b.multiplier = clamp_u64(b.multiplier, bounds.multiplier_min, bounds.multiplier_max);
        b.min_count = clamp_u8(
            b.min_count,
            bounds.min_count_min.max(1),
            bounds.min_count_max,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{
        BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
        TriggerSpec,
    };

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
                    id: 9,
                    role: SymbolRole::Scatter,
                },
            ],
            reels: vec![vec![0, 0, 1, 9, 0], vec![0, 1, 1, 9, 0]],
            rows: 1,
            paylines: vec![vec![0, 0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry {
                        symbol: 0,
                        count: 2,
                        payout: 3,
                    },
                    PaytableEntry {
                        symbol: 1,
                        count: 2,
                        payout: 5,
                    },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec {
                    symbol: 9,
                    min_count: 2,
                },
                config: FreeSpinsConfig {
                    spins_awarded: 5,
                    retrigger: true,
                    multiplier: 2,
                    feature_reels: None,
                },
            }],
        }
    }

    fn bounds() -> GeneBounds {
        GeneBounds {
            payout_min: 0,
            payout_max: 100,
            spins_min: 1,
            spins_max: 50,
            multiplier_min: 1,
            multiplier_max: 10,
            min_count_min: 1,
            min_count_max: 5,
        }
    }

    #[test]
    fn genome_round_trips_through_model() {
        // encode -> decode -> encode is identity on the genome.
        let m = model();
        let g = encode(&m);
        let back = encode(&decode(&g, &m));
        assert_eq!(g, back);
    }

    #[test]
    fn decode_preserves_fixed_fields() {
        let m = model();
        let g = encode(&m);
        let d = decode(&g, &m);
        assert_eq!(d.symbols, m.symbols);
        assert_eq!(d.rows, m.rows);
        assert_eq!(d.paylines, m.paylines);
        // each reel keeps its length (composition only is tuned)
        assert_eq!(
            d.reels.iter().map(|r| r.len()).collect::<Vec<_>>(),
            m.reels.iter().map(|r| r.len()).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn decode_preserves_reel_composition() {
        // round-robin layout keeps the multiset of symbols per reel.
        let m = model();
        let d = decode(&encode(&m), &m);
        for (orig, got) in m.reels.iter().zip(&d.reels) {
            let mut a = orig.clone();
            a.sort();
            let mut b = got.clone();
            b.sort();
            assert_eq!(a, b);
        }
    }

    #[test]
    fn repair_forces_valid_genome() {
        let m = model();
        let mut g = encode(&m);
        // corrupt: counts that do not sum to strip length, out-of-range scalars.
        g.reel_counts[0] = vec![999, 999, 999];
        g.payouts[0] = u64::MAX;
        g.bonuses[0].min_count = 250;
        g.bonuses[0].spins_awarded = 0;
        repair(&mut g, &m, &bounds());
        // every reel's counts sum to its fixed strip length:
        for (reel, counts) in m.reels.iter().zip(&g.reel_counts) {
            assert_eq!(counts.iter().sum::<u32>() as usize, reel.len());
        }
        // scalars are back inside bounds:
        assert!(g.payouts[0] <= 100);
        assert!(g.bonuses[0].min_count >= 1 && g.bonuses[0].min_count <= 5);
        assert!(g.bonuses[0].spins_awarded >= 1);
        // and it still decodes to a structurally valid model:
        let d = decode(&g, &m);
        assert_eq!(d.reels[0].len(), m.reels[0].len());
    }
}
