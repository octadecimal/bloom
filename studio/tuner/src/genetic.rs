//! `GeneticTuner`: a deterministic custom GA. Initialize from the seed model,
//! evolve at low fidelity with common random numbers (all candidates in a
//! generation share one seed set), stop on feasibility / stagnation / budget,
//! then re-measure the best at full fidelity and run the real `verify`.

use crate::config::TunerConfig;
use crate::fitness::{band_misses, fitness};
use crate::genome::{decode, encode, repair, Genome};
use crate::outcome::{GenSnapshot, RunProfile, TuneOutcome, TuningTrace, Verdict};
use crate::telemetry::{gene_agreement, population_stats};
use crate::Tuner;
use bloom_math::mechanics::slots::SlotModel;
use bloom_math::rng::SplitMix64;
use bloom_simulator::measure::{measure, simulate};
use bloom_simulator::profile::profile;
use bloom_simulator::run::verify;
use bloom_simulator::seedgen::generate_seeds;
use bloom_simulator::target::TargetSpec;

const FINAL_SALT: u64 = 0xF1A1_5EED_C0DE_0001;

pub struct GeneticTuner;

/// A uniform f64 in [0, 1) from one u64 draw.
fn unit(rng: &mut SplitMix64) -> f64 {
    (rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

/// Deterministic per-generation seed set (common random numbers).
fn generation_seeds(master_seed: u64, generation: usize, count: usize) -> Vec<u64> {
    let mixed =
        SplitMix64::new(master_seed ^ (generation as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
            .next_u64();
    generate_seeds(mixed, count)
}

/// Mutate a genome in place, then repair. Each gene mutates with probability
/// `cfg.mutation_rate`; numeric genes step within their bounds.
fn mutate(g: &mut Genome, template: &SlotModel, cfg: &TunerConfig, rng: &mut SplitMix64) {
    let b = &cfg.bounds;
    for counts in &mut g.reel_counts {
        // move one unit between two buckets (preserves sum; repair re-normalizes).
        if counts.len() >= 2 && unit(rng) < cfg.mutation_rate {
            let from = (rng.next_u64() as usize) % counts.len();
            let to = (rng.next_u64() as usize) % counts.len();
            if from != to && counts[from] > 0 {
                counts[from] -= 1;
                counts[to] += 1;
            }
        }
    }
    for p in &mut g.payouts {
        if unit(rng) < cfg.mutation_rate {
            *p = b.payout_min + (rng.next_u64() % (b.payout_max - b.payout_min + 1));
        }
    }
    for bonus in &mut g.bonuses {
        if unit(rng) < cfg.mutation_rate {
            bonus.spins_awarded =
                b.spins_min + (rng.next_u64() as u32 % (b.spins_max - b.spins_min + 1));
        }
        if unit(rng) < cfg.mutation_rate {
            bonus.multiplier =
                b.multiplier_min + (rng.next_u64() % (b.multiplier_max - b.multiplier_min + 1));
        }
        if unit(rng) < cfg.mutation_rate {
            bonus.min_count = b.min_count_min.max(1)
                + (rng.next_u64() as u8 % (b.min_count_max - b.min_count_min.max(1) + 1));
        }
    }
    repair(g, template, &cfg.bounds);
}

/// Uniform crossover of two parents (gene-wise coin flip), then repair.
fn crossover(
    p1: &Genome,
    p2: &Genome,
    template: &SlotModel,
    cfg: &TunerConfig,
    rng: &mut SplitMix64,
) -> Genome {
    if unit(rng) >= cfg.crossover_rate {
        return p1.clone();
    }
    let mut child = p1.clone();
    for (r, src) in child.reel_counts.iter_mut().zip(&p2.reel_counts) {
        if unit(rng) < 0.5 {
            *r = src.clone();
        }
    }
    for (i, c) in child.payouts.iter_mut().enumerate() {
        if unit(rng) < 0.5 {
            *c = p2.payouts[i];
        }
    }
    for (i, c) in child.bonuses.iter_mut().enumerate() {
        if unit(rng) < 0.5 {
            *c = p2.bonuses[i].clone();
        }
    }
    repair(&mut child, template, &cfg.bounds);
    child
}

/// Binary tournament: pick the fitter of two random candidates.
fn tournament<'a>(scored: &'a [(Genome, f64)], rng: &mut SplitMix64) -> &'a Genome {
    let i = (rng.next_u64() as usize) % scored.len();
    let j = (rng.next_u64() as usize) % scored.len();
    if scored[i].1 >= scored[j].1 {
        &scored[i].0
    } else {
        &scored[j].0
    }
}

/// Like `GeneticTuner::tune`, but reports each generation's best snapshot through
/// `on_progress` as it is produced. `tune` delegates here with a no-op callback,
/// so the deterministic result is identical. Progress is cosmetic.
pub fn tune_with_progress(
    seed_model: &SlotModel,
    target: &TargetSpec,
    cfg: &TunerConfig,
    on_progress: &mut dyn FnMut(&GenSnapshot),
) -> TuneOutcome {
    let mut rng = SplitMix64::new(cfg.master_seed);
    let base = encode(seed_model);

    // Initial population: the seed model + mutated variants.
    let mut pop: Vec<Genome> = (0..cfg.population)
        .map(|i| {
            if i == 0 {
                base.clone()
            } else {
                let mut g = base.clone();
                mutate(&mut g, seed_model, cfg, &mut rng);
                g
            }
        })
        .collect();

    let mut snapshots: Vec<GenSnapshot> = Vec::new();
    let mut best: Option<(Genome, f64)> = None;
    let mut stagnation = 0usize;
    let mut generations_run = 0usize;
    let max_generations = cfg.max_generations.max(1);

    for g in 0..max_generations {
        generations_run = g + 1;
        let seeds = generation_seeds(cfg.master_seed, g, cfg.search_candidate_count);

        let mut scored: Vec<(Genome, f64)> = pop
            .iter()
            .map(|genome| {
                let model = decode(genome, seed_model);
                let f = fitness(&measure(&simulate(&model, &seeds)), target, &cfg.weights);
                (genome.clone(), f)
            })
            .collect();
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));

        let best_model = decode(&scored[0].0, seed_model);
        let bm = measure(&simulate(&best_model, &seeds));

        let fitnesses: Vec<f64> = scored.iter().map(|(_, f)| *f).collect();
        let decoded: Vec<SlotModel> = scored
            .iter()
            .map(|(gn, _)| decode(gn, seed_model))
            .collect();
        // one column per tunable gene dimension: mean payout, and (if present) the first
        // bonus's spins / multiplier / min_count. Guarded for models without bonuses.
        let col_payout: Vec<f64> = decoded
            .iter()
            .map(|m| {
                m.paytable
                    .entries
                    .iter()
                    .map(|e| e.payout as f64)
                    .sum::<f64>()
                    / m.paytable.entries.len().max(1) as f64
            })
            .collect();
        let mut cols = vec![col_payout];
        if decoded.iter().all(|m| !m.bonuses.is_empty()) {
            cols.push(
                decoded
                    .iter()
                    .map(|m| match &m.bonuses[0] {
                        bloom_math::mechanics::slots::BonusFeature::FreeSpins {
                            config, ..
                        } => config.spins_awarded as f64,
                    })
                    .collect(),
            );
            cols.push(
                decoded
                    .iter()
                    .map(|m| match &m.bonuses[0] {
                        bloom_math::mechanics::slots::BonusFeature::FreeSpins {
                            config, ..
                        } => config.multiplier as f64,
                    })
                    .collect(),
            );
            cols.push(
                decoded
                    .iter()
                    .map(|m| match &m.bonuses[0] {
                        bloom_math::mechanics::slots::BonusFeature::FreeSpins {
                            trigger, ..
                        } => trigger.min_count as f64,
                    })
                    .collect(),
            );
        }

        let snap = GenSnapshot {
            generation: g,
            best_fitness: scored[0].1,
            best_rtp: bm.rtp,
            best_volatility: bm.volatility,
            best_bonus_hit_rates: bm.bonus_hit_rates.clone(),
            population: population_stats(&fitnesses),
            gene_agreement: gene_agreement(&cols),
        };
        on_progress(&snap);
        snapshots.push(snap);

        let improved = match &best {
            Some((_, pf)) => scored[0].1 > *pf + 1e-12,
            None => true,
        };
        if improved {
            best = Some((scored[0].0.clone(), scored[0].1));
            stagnation = 0;
        } else {
            stagnation += 1;
        }

        if scored[0].1 >= 0.0 {
            break;
        }
        if stagnation >= cfg.stagnation_window {
            break;
        }
        if g + 1 == max_generations {
            break;
        }

        let mut next: Vec<Genome> = scored
            .iter()
            .take(cfg.elitism)
            .map(|s| s.0.clone())
            .collect();
        while next.len() < cfg.population {
            let p1 = tournament(&scored, &mut rng).clone();
            let p2 = tournament(&scored, &mut rng).clone();
            let mut child = crossover(&p1, &p2, seed_model, cfg, &mut rng);
            mutate(&mut child, seed_model, cfg, &mut rng);
            next.push(child);
        }
        pop = next;
    }

    let (best_genome, _) = best.expect("at least one generation always runs");
    let model = decode(&best_genome, seed_model);
    let final_seeds = generate_seeds(cfg.master_seed ^ FINAL_SALT, cfg.final_candidate_count);
    let final_samples = simulate(&model, &final_seeds);
    let metrics = measure(&final_samples);
    let verdict = match verify(&metrics, target) {
        Ok(()) => Verdict::Pass,
        Err(_) => Verdict::NearMiss {
            missed: band_misses(&metrics, target),
        },
    };
    let (distribution, tail) = profile(&final_samples, 1);
    let rtp_convergence = bloom_simulator::profile::rtp_convergence(&final_samples, 24);

    TuneOutcome {
        model,
        metrics,
        verdict,
        trace: TuningTrace {
            master_seed: cfg.master_seed,
            generations_run,
            snapshots,
            population: cfg.population,
            search_candidate_count: cfg.search_candidate_count,
            final_candidate_count: cfg.final_candidate_count,
        },
        profile: RunProfile {
            distribution,
            tail,
            rtp_convergence,
        },
    }
}

impl Tuner for GeneticTuner {
    fn tune(&self, seed_model: &SlotModel, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome {
        tune_with_progress(seed_model, target, cfg, &mut |_| {})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GeneBounds, SectionLocks, TunerConfig, Weights};
    use crate::outcome::Verdict;
    use crate::Tuner;
    use bloom_math::mechanics::slots::{Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole};
    use bloom_simulator::target::TargetSpec;

    // 1 reel, 1 row, 1 line. strip = 5x sym0, 4x sym1, 1x sym2 (10 cells).
    // paytable: sym1@1 -> 1, sym2@1 -> 5. Closed-form base RTP = 0.9.
    fn toy(payout_sym2: u64) -> SlotModel {
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
                        payout: payout_sym2,
                    },
                ],
            },
            bonuses: vec![],
        }
    }

    fn target_09() -> TargetSpec {
        TargetSpec {
            rtp_target: 0.9,
            rtp_tolerance: 0.02,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size: 0,
            candidate_count: 0,
            realized_correction_band: 0.05,
        }
    }

    fn cfg(master_seed: u64) -> TunerConfig {
        TunerConfig {
            master_seed,
            population: 24,
            max_generations: 40,
            elitism: 2,
            mutation_rate: 0.25,
            crossover_rate: 0.9,
            stagnation_window: 12,
            search_candidate_count: 20_000,
            final_candidate_count: 200_000,
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
            locks: SectionLocks::default(),
        }
    }

    #[test]
    fn reproducible_same_seed_same_outcome() {
        let seed = toy(1); // detuned: sym2 pays 1 -> RTP ~0.5
        let a = GeneticTuner.tune(&seed, &target_09(), &cfg(2026));
        let b = GeneticTuner.tune(&seed, &target_09(), &cfg(2026));
        assert_eq!(a.model, b.model);
        assert_eq!(a.metrics.rtp, b.metrics.rtp);
        assert_eq!(a.trace.generations_run, b.trace.generations_run);
        assert_eq!(a.verdict, b.verdict);
    }

    #[test]
    fn converges_a_detuned_model_back_into_band() {
        // start far from target (sym2 pays 1 -> RTP ~0.5); tuner must reach 0.9 ± 0.02.
        let out = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
        assert!(
            matches!(out.verdict, Verdict::Pass),
            "verdict was {:?}",
            out.verdict
        );
        assert!(
            (out.metrics.rtp - 0.9).abs() <= 0.02,
            "rtp = {}",
            out.metrics.rtp
        );
    }

    #[test]
    fn unreachable_target_reports_near_miss_not_pass() {
        // payout_max is 20, but an RTP of 50.0 is unreachable -> NearMiss, never Pass.
        let mut t = target_09();
        t.rtp_target = 50.0;
        t.rtp_tolerance = 0.1;
        let out = GeneticTuner.tune(&toy(1), &t, &cfg(3));
        match out.verdict {
            Verdict::NearMiss { missed } => assert!(missed.iter().any(|m| m.metric == "rtp")),
            Verdict::Pass => panic!("must not report PASS for an unreachable target"),
        }
    }

    #[test]
    fn progress_fires_once_per_generation_and_matches_tune() {
        use crate::genetic::tune_with_progress;
        let seed = toy(1);
        let t = target_09();
        let c = cfg(7);

        let mut gens: Vec<usize> = Vec::new();
        let out = tune_with_progress(&seed, &t, &c, &mut |s: &GenSnapshot| {
            gens.push(s.generation)
        });

        // Bit-identical to the trait method (no behavior drift).
        let direct = GeneticTuner.tune(&seed, &t, &c);
        assert_eq!(out.model, direct.model);
        assert_eq!(out.metrics.rtp, direct.metrics.rtp);
        assert_eq!(out.verdict, direct.verdict);
        assert_eq!(out.trace.generations_run, direct.trace.generations_run);

        // One callback per generation, in order 0..generations_run.
        assert_eq!(gens.len(), out.trace.generations_run);
        assert_eq!(gens, (0..out.trace.generations_run).collect::<Vec<_>>());
    }

    #[test]
    fn snapshots_carry_population_stats_and_profile_is_present() {
        let out = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
        // every generation snapshot has population stats + one agreement value per gene dim
        assert!(out
            .trace
            .snapshots
            .iter()
            .all(|s| s.population.max >= s.population.min));
        assert!(out
            .trace
            .snapshots
            .iter()
            .all(|s| !s.gene_agreement.is_empty()));
        // end-of-tune profile exists and its histogram covers the fixed bins
        assert_eq!(
            out.profile.distribution.bins.len(),
            bloom_simulator::profile::log_bins().len() - 1
        );
        assert!(out.profile.tail.p_losing_spin >= 0.0 && out.profile.tail.p_losing_spin <= 1.0);
        assert!(out.profile.rtp_convergence.last().is_some());
    }

    #[test]
    fn telemetry_does_not_change_the_deterministic_result() {
        let a = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
        let b = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
        assert_eq!(a.model, b.model);
        assert_eq!(a.metrics.rtp, b.metrics.rtp);
        assert_eq!(a.profile.tail.max_win, b.profile.tail.max_win);
    }
}
