//! The tunable genome and its lossless mapping to/from a `SlotModel`. Only the
//! tunable levers are genes (reel composition, paytable payouts, bonus config);
//! everything else comes from the seed model (the template) at decode time.

use crate::config::{GeneBounds, SectionLocks};
use bloom_math::mechanics::composed::definition::{BudgetSpec, StateDef};
use bloom_math::mechanics::composed::GameDefinition;
use bloom_math::mechanics::slots::{
    BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, Symbol, TriggerSpec,
};
use bloom_simulator::artifact::MathArtifact;
use bloom_simulator::target::{PayConstraint, PayRelation};

#[derive(Debug, Clone, PartialEq)]
pub struct BonusGenes {
    pub spins_awarded: u32,
    pub multiplier: u64,
    pub min_count: u8,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Genome {
    Slots(SlotsGenome),
    Composed(ComposedGenome),
}

#[derive(Debug, Clone, PartialEq)]
pub struct SlotsGenome {
    /// Per reel, the count of each distinct symbol id (in the reel's
    /// ascending-id order). Sums to the reel's fixed strip length.
    pub reel_counts: Vec<Vec<u32>>,
    /// Payout per paytable entry, in entry order.
    pub payouts: Vec<u64>,
    /// One entry per `FreeSpins` bonus, in order.
    pub bonuses: Vec<BonusGenes>,
}

/// Composed genes (spec §3.4): numbers only, never structure. A locked/absent
/// group is an empty vec — decode's zips then no-op and the template's values
/// survive verbatim (same convention as SlotsGenome).
#[derive(Debug, Clone, PartialEq)]
pub struct ComposedGenome {
    /// Per reels-surface, per strip: count of each distinct symbol id
    /// (ascending). Surface order = `strip_surfaces` order.
    pub surfaces: Vec<Vec<Vec<u32>>>,
    /// The reels instance's paytable payouts, entry order.
    pub payouts: Vec<u64>,
    /// One per `meter@1` instance, mechanics order.
    pub meter_targets: Vec<u32>,
    /// One per state with `"budget": "awarded"`, state order.
    pub awarded_budgets: Vec<u32>,
}

/// The distinct symbol ids present on a reel, ascending. The canonical key for
/// that reel's count vector (encode + decode must agree on this order).
fn reel_symbols(reel: &[Symbol]) -> Vec<Symbol> {
    let mut s: Vec<Symbol> = reel.to_vec();
    s.sort_unstable();
    s.dedup();
    s
}

/// Where a tunable strip set lives in the definition.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SurfaceLoc {
    Base { mechanic: usize },
    Override { state: usize, binding: usize },
}

fn strips_from(v: &serde_json::Value) -> Option<Vec<Vec<Symbol>>> {
    serde_json::from_value(v.get("strips")?.clone()).ok()
}

/// Canonical surface enumeration (encode + decode + repair must agree): the
/// first `reels@1` instance's base strips, then every state-binding override
/// on that instance that defines `strips` (state order, binding order).
/// Feature strips tune independently of base strips (spec §3.4).
fn strip_surfaces(def: &GameDefinition) -> Vec<(SurfaceLoc, Vec<Vec<Symbol>>)> {
    let mut out = Vec::new();
    let Some(m_idx) = def.mechanics.iter().position(|m| m.kind == "reels@1") else {
        return out;
    };
    if let Some(strips) = strips_from(&def.mechanics[m_idx].config) {
        out.push((SurfaceLoc::Base { mechanic: m_idx }, strips));
    }
    let reels_id = def.mechanics[m_idx].id.clone();
    for (s_idx, s) in def.states.iter().enumerate() {
        for (b_idx, b) in s.bindings.iter().enumerate() {
            if b.mechanic == reels_id {
                if let Some(strips) = b.config_override.as_ref().and_then(strips_from) {
                    out.push((
                        SurfaceLoc::Override {
                            state: s_idx,
                            binding: b_idx,
                        },
                        strips,
                    ));
                }
            }
        }
    }
    out
}

fn strip_counts(strip: &[Symbol]) -> Vec<u32> {
    reel_symbols(strip)
        .iter()
        .map(|&sym| strip.iter().filter(|&&c| c == sym).count() as u32)
        .collect()
}

fn is_awarded(s: &StateDef) -> bool {
    matches!(&s.steps.budget, BudgetSpec::Keyword(k) if k == "awarded")
}

pub fn encode_slots(model: &SlotModel) -> SlotsGenome {
    let reel_counts = model.reels.iter().map(|reel| strip_counts(reel)).collect();

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

    SlotsGenome {
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

/// Encode only the unlocked gene groups. A locked group's genes are omitted
/// (empty vec): mutation/crossover/repair loops then skip the group naturally,
/// and `decode` copies it verbatim from the template.
pub fn encode_with_locks(artifact: &MathArtifact, locks: &SectionLocks) -> Genome {
    match artifact {
        MathArtifact::Slots(m) => {
            let mut g = encode_slots(m);
            if locks.reels {
                g.reel_counts.clear();
            }
            if locks.paytable {
                g.payouts.clear();
            }
            if locks.bonus {
                g.bonuses.clear();
            }
            Genome::Slots(g)
        }
        MathArtifact::Composed { def, .. } => {
            let mut g = encode_composed(def);
            if locks.reels {
                g.surfaces.clear();
            }
            if locks.paytable {
                g.payouts.clear();
            }
            if locks.bonus {
                g.meter_targets.clear();
                g.awarded_budgets.clear();
            }
            Genome::Composed(g)
        }
    }
}

pub fn decode(genome: &Genome, template: &MathArtifact) -> MathArtifact {
    match (genome, template) {
        (Genome::Slots(g), MathArtifact::Slots(m)) => MathArtifact::Slots(decode_slots(g, m)),
        (Genome::Composed(g), MathArtifact::Composed { def, .. }) => {
            MathArtifact::from_definition(decode_composed(g, def))
                .expect("decode only changes numbers; a valid template stays compiling")
        }
        _ => unreachable!("a genome is only ever decoded against its own template"),
    }
}

pub fn decode_slots(genome: &SlotsGenome, template: &SlotModel) -> SlotModel {
    // An empty gene group means the group is locked (omitted from the genome)
    // or absent from the template: copy it verbatim from the template.
    let reels = if genome.reel_counts.is_empty() {
        template.reels.clone()
    } else {
        template
            .reels
            .iter()
            .zip(&genome.reel_counts)
            .map(|(reel, counts)| layout(&reel_symbols(reel), counts))
            .collect()
    };

    let entries = if genome.payouts.is_empty() {
        template.paytable.entries.clone()
    } else {
        template
            .paytable
            .entries
            .iter()
            .zip(&genome.payouts)
            .map(|(e, &payout)| PaytableEntry {
                symbol: e.symbol,
                count: e.count,
                payout,
            })
            .collect()
    };

    let bonuses = if genome.bonuses.is_empty() {
        template.bonuses.clone()
    } else {
        template
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
            .collect()
    };

    SlotModel {
        symbols: template.symbols.clone(),
        reels,
        rows: template.rows,
        paylines: template.paylines.clone(),
        paytable: Paytable { entries },
        bonuses,
    }
}

pub fn encode_composed(def: &GameDefinition) -> ComposedGenome {
    let surfaces = strip_surfaces(def)
        .iter()
        .map(|(_, strips)| strips.iter().map(|s| strip_counts(s)).collect())
        .collect();
    let payouts = def
        .mechanics
        .iter()
        .find(|m| m.kind == "reels@1")
        .and_then(|m| m.config["paytable"]["entries"].as_array())
        .map(|es| {
            es.iter()
                .map(|e| e["payout"].as_u64().unwrap_or(0))
                .collect()
        })
        .unwrap_or_default();
    let meter_targets = def
        .mechanics
        .iter()
        .filter(|m| m.kind == "meter@1")
        .map(|m| m.config["target"].as_u64().unwrap_or(0) as u32)
        .collect();
    let awarded_budgets = def
        .states
        .iter()
        .filter(|s| is_awarded(s))
        .map(|s| s.steps.initial.unwrap_or(0))
        .collect();
    ComposedGenome {
        surfaces,
        payouts,
        meter_targets,
        awarded_budgets,
    }
}

/// Write the genes back into a clone of the template. JSON is edited in
/// place (never round-tripped through the typed configs), so keys the genome
/// doesn't own — events, paylines, symbols, multiplier, unknown fields —
/// survive byte-for-byte. Empty gene groups (locks) zip to no-ops.
pub fn decode_composed(genome: &ComposedGenome, template: &GameDefinition) -> GameDefinition {
    let mut def = template.clone();
    for ((loc, strips), counts) in strip_surfaces(template).iter().zip(&genome.surfaces) {
        let new_strips: Vec<Vec<Symbol>> = strips
            .iter()
            .zip(counts)
            .map(|(strip, c)| layout(&reel_symbols(strip), c))
            .collect();
        let v = serde_json::to_value(&new_strips).expect("strips serialize");
        match loc {
            SurfaceLoc::Base { mechanic } => def.mechanics[*mechanic].config["strips"] = v,
            SurfaceLoc::Override { state, binding } => {
                def.states[*state].bindings[*binding]
                    .config_override
                    .as_mut()
                    .expect("surface came from this override")["strips"] = v;
            }
        }
    }
    if !genome.payouts.is_empty() {
        if let Some(m) = def.mechanics.iter_mut().find(|m| m.kind == "reels@1") {
            if let Some(entries) = m.config["paytable"]["entries"].as_array_mut() {
                for (e, &p) in entries.iter_mut().zip(&genome.payouts) {
                    e["payout"] = serde_json::json!(p);
                }
            }
        }
    }
    for (m, &t) in def
        .mechanics
        .iter_mut()
        .filter(|m| m.kind == "meter@1")
        .zip(&genome.meter_targets)
    {
        m.config["target"] = serde_json::json!(t);
    }
    for (s, &b) in def
        .states
        .iter_mut()
        .filter(|s| is_awarded(s))
        .zip(&genome.awarded_budgets)
    {
        s.steps.initial = Some(b);
    }
    def
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

/// Rescale a count vector (deterministically) so it sums to `target`.
/// Extracted from the slots repair — strip math is identical on both sides
/// (spec §3.4).
fn rescale_counts(counts: &mut [u32], target: u32) {
    if counts.is_empty() {
        return;
    }
    let sum: u32 = counts.iter().sum();
    if sum == 0 {
        let n = counts.len() as u32;
        for (i, c) in counts.iter_mut().enumerate() {
            *c = target / n + if (i as u32) < target % n { 1 } else { 0 };
        }
    } else if sum != target {
        let mut acc = 0u32;
        let last = counts.len() - 1;
        for c in counts.iter_mut().take(last) {
            *c = ((*c as u64 * target as u64) / sum as u64) as u32;
            acc += *c;
        }
        counts[last] = target.saturating_sub(acc);
    }
}

/// GDD pay-constraint clamps over a paytable's entries — the exact block
/// from the slots repair, parameterized on the entry list so composed can
/// bind it to the reels instance's paytable (spec §3.3).
fn clamp_payout_constraints(
    entries: &[PaytableEntry],
    payouts: &mut [u64],
    constraints: &[PayConstraint],
) {
    if payouts.is_empty() {
        return;
    }
    for (e, p) in entries.iter().zip(payouts.iter_mut()) {
        for c in constraints {
            if c.symbol != e.symbol || c.count.is_some_and(|cc| cc != e.count) {
                continue;
            }
            match c.relation {
                PayRelation::Floor => *p = (*p).max(c.value),
                PayRelation::Ceiling => *p = (*p).min(c.value),
                PayRelation::TopPaying => {}
            }
        }
    }
    if let Some(top_sym) = constraints
        .iter()
        .find(|c| matches!(c.relation, PayRelation::TopPaying))
        .map(|c| c.symbol)
    {
        let top = entries
            .iter()
            .zip(payouts.iter())
            .filter(|(e, _)| e.symbol == top_sym)
            .map(|(_, &p)| p)
            .max()
            .unwrap_or(0);
        for (e, p) in entries.iter().zip(payouts.iter_mut()) {
            if e.symbol != top_sym && *p > top {
                *p = top;
            }
        }
    }
}

/// Force every gene back into the feasible set. Deterministic. After repair,
/// `decode` always yields a structurally valid `SlotModel`.
pub fn repair_slots(
    genome: &mut SlotsGenome,
    template: &SlotModel,
    bounds: &GeneBounds,
    constraints: &[PayConstraint],
) {
    // Reel counts: rescale (deterministically) so each reel sums to its fixed
    // strip length, keeping at least the original number of distinct symbols.
    for (reel, counts) in template.reels.iter().zip(&mut genome.reel_counts) {
        if counts.is_empty() {
            continue;
        }
        rescale_counts(counts, reel.len() as u32);
    }

    for p in &mut genome.payouts {
        *p = clamp_u64(*p, bounds.payout_min, bounds.payout_max);
    }

    // GDD pay constraints (spec §6): floors/ceilings are per-gene clamps
    // layered ON TOP of GeneBounds (the designed constraint wins); TopPaying
    // is a deterministic post-clamp fix-up in fixed entry order. A locked
    // paytable has no payout genes — nothing to enforce here; verify still
    // reports violations on the stored paytable.
    clamp_payout_constraints(&template.paytable.entries, &mut genome.payouts, constraints);

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

fn repair_composed(
    genome: &mut ComposedGenome,
    def: &GameDefinition,
    reels: &Option<bloom_math::mechanics::composed::reels::ReelsConfig>,
    bounds: &GeneBounds,
    constraints: &[PayConstraint],
) {
    for ((_, strips), counts) in strip_surfaces(def).iter().zip(&mut genome.surfaces) {
        for (strip, c) in strips.iter().zip(counts.iter_mut()) {
            rescale_counts(c, strip.len() as u32);
        }
    }
    for p in &mut genome.payouts {
        *p = clamp_u64(*p, bounds.payout_min, bounds.payout_max);
    }
    if let Some(r) = reels {
        clamp_payout_constraints(&r.paytable.entries, &mut genome.payouts, constraints);
    }
    for t in &mut genome.meter_targets {
        *t = clamp_u32(*t, bounds.meter_target_min.max(1), bounds.meter_target_max);
    }
    for b in &mut genome.awarded_budgets {
        *b = clamp_u32(*b, bounds.spins_min.max(1), bounds.spins_max);
    }
}

pub fn repair(
    genome: &mut Genome,
    template: &MathArtifact,
    bounds: &GeneBounds,
    constraints: &[PayConstraint],
) {
    match (genome, template) {
        (Genome::Slots(g), MathArtifact::Slots(m)) => repair_slots(g, m, bounds, constraints),
        (Genome::Composed(g), MathArtifact::Composed { def, reels, .. }) => {
            repair_composed(g, def, reels, bounds, constraints)
        }
        _ => unreachable!("a genome is only ever repaired against its own template"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SectionLocks;
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
            meter_target_min: 1,
            meter_target_max: 100,
        }
    }

    #[test]
    fn genome_round_trips_through_model() {
        // encode -> decode -> encode is identity on the genome.
        let m = model();
        let g = encode_slots(&m);
        let back = encode_slots(&decode_slots(&g, &m));
        assert_eq!(g, back);
    }

    #[test]
    fn decode_preserves_fixed_fields() {
        let m = model();
        let g = encode_slots(&m);
        let d = decode_slots(&g, &m);
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
        let d = decode_slots(&encode_slots(&m), &m);
        for (orig, got) in m.reels.iter().zip(&d.reels) {
            let mut a = orig.clone();
            a.sort();
            let mut b = got.clone();
            b.sort();
            assert_eq!(a, b);
        }
    }

    #[test]
    fn repair_distributes_all_zero_counts_to_strip_length() {
        let m = model();
        let mut g = encode_slots(&m);
        for counts in &mut g.reel_counts {
            for c in counts.iter_mut() {
                *c = 0;
            }
        }
        repair_slots(&mut g, &m, &bounds(), &[]);
        for (reel, counts) in m.reels.iter().zip(&g.reel_counts) {
            assert_eq!(counts.iter().sum::<u32>() as usize, reel.len());
        }
    }

    #[test]
    fn repair_forces_valid_genome() {
        let m = model();
        let mut g = encode_slots(&m);
        // corrupt: counts that do not sum to strip length, out-of-range scalars.
        g.reel_counts[0] = vec![999, 999, 999];
        g.payouts[0] = u64::MAX;
        g.bonuses[0].min_count = 250;
        g.bonuses[0].spins_awarded = 0;
        repair_slots(&mut g, &m, &bounds(), &[]);
        // every reel's counts sum to its fixed strip length:
        for (reel, counts) in m.reels.iter().zip(&g.reel_counts) {
            assert_eq!(counts.iter().sum::<u32>() as usize, reel.len());
        }
        // scalars are back inside bounds:
        assert!(g.payouts[0] <= 100);
        assert!(g.bonuses[0].min_count >= 1 && g.bonuses[0].min_count <= 5);
        assert!(g.bonuses[0].spins_awarded >= 1);
        // and it still decodes to a structurally valid model:
        let d = decode_slots(&g, &m);
        assert_eq!(d.reels[0].len(), m.reels[0].len());
    }

    #[test]
    fn encode_with_locks_omits_locked_groups() {
        let m = model();
        let l = SectionLocks {
            reels: true,
            paytable: false,
            bonus: true,
        };
        let Genome::Slots(g) = encode_with_locks(&MathArtifact::Slots(m.clone()), &l) else {
            panic!("expected slots genome");
        };
        assert!(g.reel_counts.is_empty());
        assert_eq!(g.payouts, encode_slots(&m).payouts); // unlocked group intact
        assert!(g.bonuses.is_empty());
    }

    #[test]
    fn decode_copies_locked_groups_verbatim_from_template() {
        // all three locked -> decode reproduces the seed model exactly,
        // byte-for-byte (reels keep their original order, not the round-robin
        // layout()).
        let m = model();
        let l = SectionLocks {
            reels: true,
            paytable: true,
            bonus: true,
        };
        let art = MathArtifact::Slots(m.clone());
        let d = decode(&encode_with_locks(&art, &l), &art);
        assert_eq!(d, art);
    }

    #[test]
    fn locked_group_survives_repair_of_the_rest() {
        // reels locked; corrupt + repair the remaining genes; reels untouched.
        let m = model();
        let l = SectionLocks {
            reels: true,
            ..Default::default()
        };
        let Genome::Slots(mut g) = encode_with_locks(&MathArtifact::Slots(m.clone()), &l) else {
            panic!("expected slots genome");
        };
        g.payouts[0] = u64::MAX;
        repair_slots(&mut g, &m, &bounds(), &[]);
        let d = decode_slots(&g, &m);
        assert_eq!(d.reels, m.reels);
        assert!(d.paytable.entries[0].payout <= 100);
    }

    #[test]
    fn unlocked_encode_decode_behavior_is_unchanged() {
        // Default (no locks) must round-trip exactly as before.
        let m = model();
        let g = encode_with_locks(&MathArtifact::Slots(m.clone()), &SectionLocks::default());
        assert_eq!(g, Genome::Slots(encode_slots(&m)));
    }

    use bloom_simulator::target::{PayConstraint, PayRelation};

    fn floor(symbol: u8, count: Option<u8>, value: u64) -> PayConstraint {
        PayConstraint {
            symbol,
            relation: PayRelation::Floor,
            count,
            value,
        }
    }

    #[test]
    fn repair_applies_floor_and_ceiling_clamps() {
        let m = model();
        let mut g = encode_slots(&m);
        g.payouts = vec![1, 90];
        repair_slots(
            &mut g,
            &m,
            &bounds(),
            &[
                floor(0, None, 10),
                PayConstraint {
                    symbol: 1,
                    relation: PayRelation::Ceiling,
                    count: Some(2),
                    value: 40,
                },
            ],
        );
        assert_eq!(g.payouts[0], 10); // floored up
        assert_eq!(g.payouts[1], 40); // ceilinged down
    }

    #[test]
    fn constraint_floor_wins_over_gene_bounds_ceiling() {
        // bounds().payout_max is 100; a floor of 200 must still hold — the
        // designed floor is the stronger intent (deterministic resolution).
        let m = model();
        let mut g = encode_slots(&m);
        g.payouts = vec![1, 5];
        repair_slots(&mut g, &m, &bounds(), &[floor(0, None, 200)]);
        assert_eq!(g.payouts[0], 200);
    }

    #[test]
    fn repair_caps_competitors_at_the_top_paying_symbol() {
        let m = model();
        let mut g = encode_slots(&m);
        g.payouts = vec![80, 30]; // sym0 outpays sym1
        repair_slots(
            &mut g,
            &m,
            &bounds(),
            &[PayConstraint {
                symbol: 1,
                relation: PayRelation::TopPaying,
                count: None,
                value: 0,
            }],
        );
        assert_eq!(g.payouts[1], 30); // designated symbol untouched
        assert_eq!(g.payouts[0], 30); // competitor capped AT its top pay (tie ok)
    }

    #[test]
    fn repair_with_constraints_is_deterministic() {
        let m = model();
        let cs = [
            floor(0, None, 10),
            PayConstraint {
                symbol: 1,
                relation: PayRelation::TopPaying,
                count: None,
                value: 0,
            },
        ];
        let mut a = encode_slots(&m);
        a.payouts = vec![97, 13];
        let mut b = a.clone();
        repair_slots(&mut a, &m, &bounds(), &cs);
        repair_slots(&mut b, &m, &bounds(), &cs);
        assert_eq!(a, b);
    }

    #[test]
    fn locked_paytable_skips_constraint_enforcement() {
        // payouts omitted from the genome → nothing to clamp; verify still
        // reports violations on the decoded model (Task 3), repair must not panic.
        let m = model();
        let l = SectionLocks {
            paytable: true,
            ..Default::default()
        };
        let Genome::Slots(mut g) = encode_with_locks(&MathArtifact::Slots(m.clone()), &l) else {
            panic!("expected slots genome");
        };
        repair_slots(&mut g, &m, &bounds(), &[floor(0, None, 10)]);
        assert!(g.payouts.is_empty());
    }

    /// Composed template with everything the genome touches: two strip
    /// surfaces (base + an fs override that redefines strips), a paytable,
    /// one meter, one awarded budget. Mirrors the demo definition's shape.
    fn composed_def() -> GameDefinition {
        serde_json::from_value(serde_json::json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "main_reels", "type": "reels@1",
                  "config": {
                    "strips": [[0, 0, 0, 1, 1, 9], [0, 1, 0, 1, 0, 9]],
                    "rows": 1,
                    "symbols": [{"id":0,"role":"normal"},{"id":1,"role":"normal"},{"id":9,"role":"scatter"}],
                    "paylines": [[0, 0]],
                    "paytable": { "entries": [
                        {"symbol":0,"count":2,"payout":2},
                        {"symbol":1,"count":2,"payout":6} ] },
                    "events": [{ "symbol": 9, "min_count": 2, "emit": "scatters:2" }] } },
                { "id": "bonus_meter", "type": "meter@1",
                  "config": { "target": 4, "count_symbol": 9 } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [{ "mechanic": "main_reels" }, { "mechanic": "bonus_meter" }],
                  "steps": { "budget": 1 },
                  "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }] },
                { "id": "fs",
                  "bindings": [
                    { "mechanic": "main_reels",
                      "override": { "multiplier": 2, "strips": [[0, 0, 1, 1, 1, 9], [1, 1, 0, 0, 1, 9]] } },
                    { "mechanic": "bonus_meter" }],
                  "steps": { "budget": "awarded", "initial": 5 },
                  "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }] }
            ],
            "start": "base",
            "transitions": [
                { "from": "base", "on": "scatters:2", "to": "fs" },
                { "from": "base", "on": "meter:full", "to": "fs" }
            ],
            "caps": { "max_steps": 100 }
        }))
        .expect("fixture parses")
    }

    fn composed_artifact() -> MathArtifact {
        MathArtifact::from_definition(composed_def()).expect("fixture compiles")
    }

    #[test]
    fn composed_encode_reads_all_four_gene_groups() {
        let g = encode_composed(&composed_def());
        // two surfaces: base config strips, then the fs override strips
        assert_eq!(g.surfaces.len(), 2);
        // base strip 0 = [0,0,0,1,1,9] -> counts by ascending symbol (0,1,9)
        assert_eq!(g.surfaces[0][0], vec![3, 2, 1]);
        assert_eq!(g.surfaces[0][1], vec![3, 2, 1]);
        // fs strip 0 = [0,0,1,1,1,9]
        assert_eq!(g.surfaces[1][0], vec![2, 3, 1]);
        assert_eq!(g.payouts, vec![2, 6]);
        assert_eq!(g.meter_targets, vec![4]);
        assert_eq!(g.awarded_budgets, vec![5]);
    }

    #[test]
    fn composed_genome_round_trips_through_definition() {
        let def = composed_def();
        let g = encode_composed(&def);
        let back = encode_composed(&decode_composed(&g, &def));
        assert_eq!(g, back);
    }

    #[test]
    fn composed_decode_preserves_structure_verbatim() {
        let def = composed_def();
        let mut g = encode_composed(&def);
        // perturb every gene group
        g.surfaces[0][0] = vec![1, 4, 1];
        g.surfaces[1][1] = vec![4, 1, 1];
        g.payouts = vec![3, 9];
        g.meter_targets = vec![7];
        g.awarded_budgets = vec![11];
        let d = decode_composed(&g, &def);

        // tuned numbers landed where they should
        let strips: Vec<Vec<u8>> =
            serde_json::from_value(d.mechanics[0].config["strips"].clone()).unwrap();
        assert_eq!(strips[0].len(), 6);
        assert_eq!(strips[0].iter().filter(|&&s| s == 1).count(), 4);
        let fs_over = d.states[1].bindings[0].config_override.as_ref().unwrap();
        let fs_strips: Vec<Vec<u8>> = serde_json::from_value(fs_over["strips"].clone()).unwrap();
        assert_eq!(fs_strips[1].iter().filter(|&&s| s == 0).count(), 4);
        assert_eq!(d.mechanics[0].config["paytable"]["entries"][1]["payout"], 9);
        assert_eq!(d.mechanics[1].config["target"], 7);
        assert_eq!(d.states[1].steps.initial, Some(11));

        // structure untouched
        assert_eq!(d.states.len(), def.states.len());
        assert_eq!(d.transitions, def.transitions);
        assert_eq!(d.start, def.start);
        assert_eq!(d.caps, def.caps);
        assert_eq!(d.states[0].script, def.states[0].script);
        assert_eq!(
            d.mechanics[0].config["paylines"],
            def.mechanics[0].config["paylines"]
        );
        assert_eq!(
            d.mechanics[0].config["symbols"],
            def.mechanics[0].config["symbols"]
        );
        assert_eq!(
            d.mechanics[0].config["events"],
            def.mechanics[0].config["events"]
        );
        assert_eq!(fs_over["multiplier"], 2); // override's other keys survive
        assert_eq!(
            d.mechanics[0].config["paytable"]["entries"][1]["symbol"],
            def.mechanics[0].config["paytable"]["entries"][1]["symbol"]
        );
        // it still compiles
        assert!(MathArtifact::from_definition(d).is_ok());
    }

    #[test]
    fn artifact_encode_decode_dispatches_both_families() {
        // slots arm unchanged behavior
        let m = model();
        let art = MathArtifact::Slots(m.clone());
        let g = encode_with_locks(&art, &SectionLocks::default());
        assert!(matches!(g, Genome::Slots(_)));
        let d = decode(&g, &art);
        assert_eq!(encode_with_locks(&d, &SectionLocks::default()), g);

        // composed arm
        let art = composed_artifact();
        let g = encode_with_locks(&art, &SectionLocks::default());
        assert!(matches!(g, Genome::Composed(_)));
        let d = decode(&g, &art);
        assert_eq!(d.family(), "composed@1");
        assert_eq!(encode_with_locks(&d, &SectionLocks::default()), g);
    }

    #[test]
    fn composed_locks_map_to_the_three_groups() {
        let art = composed_artifact();
        let Genome::Composed(g) = encode_with_locks(
            &art,
            &SectionLocks {
                reels: true,
                paytable: false,
                bonus: true,
            },
        ) else {
            panic!("expected composed genome");
        };
        assert!(g.surfaces.is_empty());
        assert_eq!(g.payouts, vec![2, 6]); // unlocked group intact
        assert!(g.meter_targets.is_empty());
        assert!(g.awarded_budgets.is_empty());
    }

    #[test]
    fn composed_all_locked_decode_reproduces_the_template() {
        let art = composed_artifact();
        let locks = SectionLocks {
            reels: true,
            paytable: true,
            bonus: true,
        };
        let d = decode(&encode_with_locks(&art, &locks), &art);
        assert_eq!(d.composed_def().unwrap(), &composed_def());
    }

    fn composed_bounds() -> GeneBounds {
        GeneBounds {
            payout_min: 0,
            payout_max: 100,
            spins_min: 1,
            spins_max: 50,
            multiplier_min: 1,
            multiplier_max: 10,
            min_count_min: 1,
            min_count_max: 5,
            meter_target_min: 1,
            meter_target_max: 100,
        }
    }

    #[test]
    fn composed_repair_rescales_every_surface_to_its_strip_length() {
        let art = composed_artifact();
        let mut g = Genome::Composed(encode_composed(&composed_def()));
        if let Genome::Composed(cg) = &mut g {
            cg.surfaces[0][0] = vec![999, 999, 999];
            cg.surfaces[1][1] = vec![0, 0, 0];
        }
        repair(&mut g, &art, &composed_bounds(), &[]);
        let Genome::Composed(cg) = &g else { panic!() };
        for surface in &cg.surfaces {
            for counts in surface {
                assert_eq!(counts.iter().sum::<u32>(), 6); // fixture strips are 6 long
            }
        }
        // and it still decodes + compiles
        let d = decode(&g, &art);
        assert_eq!(d.family(), "composed@1");
    }

    #[test]
    fn composed_repair_clamps_payouts_targets_and_budgets() {
        let art = composed_artifact();
        let mut g = Genome::Composed(encode_composed(&composed_def()));
        if let Genome::Composed(cg) = &mut g {
            cg.payouts = vec![u64::MAX, 0];
            cg.meter_targets = vec![0];
            cg.awarded_budgets = vec![9999];
        }
        repair(&mut g, &art, &composed_bounds(), &[]);
        let Genome::Composed(cg) = &g else { panic!() };
        assert_eq!(cg.payouts[0], 100); // payout_max
        assert_eq!(cg.meter_targets[0], 1); // meter_target_min floor
        assert_eq!(cg.awarded_budgets[0], 50); // spins_max
    }

    #[test]
    fn composed_repair_applies_pay_constraints_to_the_reels_paytable() {
        // fixture paytable: sym0@2 -> 2, sym1@2 -> 6
        let art = composed_artifact();
        let mut g = Genome::Composed(encode_composed(&composed_def()));
        if let Genome::Composed(cg) = &mut g {
            cg.payouts = vec![80, 30]; // sym0 outpays sym1
        }
        repair(
            &mut g,
            &art,
            &composed_bounds(),
            &[
                floor(1, None, 40),
                PayConstraint {
                    symbol: 1,
                    relation: PayRelation::TopPaying,
                    count: None,
                    value: 0,
                },
            ],
        );
        let Genome::Composed(cg) = &g else { panic!() };
        assert_eq!(cg.payouts[1], 40); // floored up to 40
        assert_eq!(cg.payouts[0], 40); // competitor capped at sym1's top pay
    }

    #[test]
    fn composed_repair_is_deterministic_and_skips_locked_groups() {
        let art = composed_artifact();
        let locks = SectionLocks {
            paytable: true,
            ..Default::default()
        };
        let mut a = encode_with_locks(&art, &locks);
        if let Genome::Composed(cg) = &mut a {
            cg.surfaces[0][0] = vec![7, 0, 2];
        }
        let mut b = a.clone();
        repair(&mut a, &art, &composed_bounds(), &[floor(0, None, 10)]);
        repair(&mut b, &art, &composed_bounds(), &[floor(0, None, 10)]);
        assert_eq!(a, b);
        let Genome::Composed(cg) = &a else { panic!() };
        assert!(cg.payouts.is_empty()); // locked group untouched (nothing to clamp)
    }

    #[test]
    fn repair_composed_handles_a_definition_with_no_reels_instance() {
        // No reels@1 mechanic: `MathArtifact::Composed { reels, .. }` is None,
        // so the pay-constraint clamp (which binds to the reels paytable) must
        // be skipped rather than panic; `encode_composed` also finds no
        // paytable to read, so payouts/surfaces stay empty groups.
        let def: GameDefinition = serde_json::from_value(serde_json::json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "meter", "type": "meter@1",
                  "config": { "target": 4, "count_symbol": 9 } }
            ],
            "states": [
                { "id": "base", "bindings": [{ "mechanic": "meter" }],
                  "steps": { "budget": 1 }, "script": [{ "invoke": "meter.accumulate" }] }
            ],
            "start": "base",
            "transitions": [],
            "caps": { "max_steps": 10 }
        }))
        .expect("fixture parses");
        let art = MathArtifact::from_definition(def).expect("fixture compiles");
        assert!(matches!(&art, MathArtifact::Composed { reels: None, .. }));

        let mut g = Genome::Composed(encode_composed(art.composed_def().unwrap()));
        repair(&mut g, &art, &composed_bounds(), &[floor(0, None, 10)]);
        let Genome::Composed(cg) = &g else { panic!() };
        assert!(cg.payouts.is_empty());
        assert!(cg.surfaces.is_empty());

        let d = decode(&g, &art);
        assert_eq!(d.family(), "composed@1");
    }
}
