//! `GeneticTuner`: a deterministic custom GA. Initialize from the seed model,
//! evolve at low fidelity with common random numbers (all candidates in a
//! generation share one seed set), stop on feasibility / stagnation / budget,
//! then re-measure the best at full fidelity and run the real `verify`.

use crate::config::TunerConfig;
use crate::fitness::{band_misses, fitness};
use crate::genome::{decode, encode, repair, Genome};
use crate::outcome::{GenSnapshot, TuneOutcome, TuningTrace, Verdict};
use crate::Tuner;
use bloom_math::mechanics::slots::SlotModel;
use bloom_math::rng::SplitMix64;
use bloom_simulator::measure::{measure, simulate};
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
    let mixed = SplitMix64::new(master_seed ^ (generation as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
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
            bonus.spins_awarded = b.spins_min + (rng.next_u64() as u32 % (b.spins_max - b.spins_min + 1));
        }
        if unit(rng) < cfg.mutation_rate {
            bonus.multiplier = b.multiplier_min + (rng.next_u64() % (b.multiplier_max - b.multiplier_min + 1));
        }
        if unit(rng) < cfg.mutation_rate {
            bonus.min_count = b.min_count_min.max(1)
                + (rng.next_u64() as u8 % (b.min_count_max - b.min_count_min.max(1) + 1));
        }
    }
    repair(g, template, &cfg.bounds);
}

/// Uniform crossover of two parents (gene-wise coin flip), then repair.
fn crossover(p1: &Genome, p2: &Genome, template: &SlotModel, cfg: &TunerConfig, rng: &mut SplitMix64) -> Genome {
    if unit(rng) >= cfg.crossover_rate {
        return p1.clone();
    }
    let mut child = p1.clone();
    for (r, src) in child.reel_counts.iter_mut().zip(&p2.reel_counts) {
        if unit(rng) < 0.5 { *r = src.clone(); }
    }
    for (i, c) in child.payouts.iter_mut().enumerate() {
        if unit(rng) < 0.5 { *c = p2.payouts[i]; }
    }
    for (i, c) in child.bonuses.iter_mut().enumerate() {
        if unit(rng) < 0.5 { *c = p2.bonuses[i].clone(); }
    }
    repair(&mut child, template, &cfg.bounds);
    child
}

/// Binary tournament: pick the fitter of two random candidates.
fn tournament<'a>(scored: &'a [(Genome, f64)], rng: &mut SplitMix64) -> &'a Genome {
    let i = (rng.next_u64() as usize) % scored.len();
    let j = (rng.next_u64() as usize) % scored.len();
    if scored[i].1 >= scored[j].1 { &scored[i].0 } else { &scored[j].0 }
}

impl Tuner for GeneticTuner {
    fn tune(&self, seed_model: &SlotModel, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome {
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

        for g in 0..cfg.max_generations {
            generations_run = g + 1;
            let seeds = generation_seeds(cfg.master_seed, g, cfg.search_candidate_count);

            // Score every candidate on the SAME seed set (common random numbers).
            let mut scored: Vec<(Genome, f64)> = pop
                .iter()
                .map(|genome| {
                    let model = decode(genome, seed_model);
                    let f = fitness(&measure(&simulate(&model, &seeds)), target, &cfg.weights);
                    (genome.clone(), f)
                })
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

            // Snapshot the generation's best (re-derive its metrics for the trace).
            let best_model = decode(&scored[0].0, seed_model);
            let bm = measure(&simulate(&best_model, &seeds));
            snapshots.push(GenSnapshot {
                generation: g,
                best_fitness: scored[0].1,
                best_rtp: bm.rtp,
                best_volatility: bm.volatility,
                best_bonus_hit_rates: bm.bonus_hit_rates.clone(),
            });

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

            if scored[0].1 >= 0.0 { break; }              // feasible in the search tier
            if stagnation >= cfg.stagnation_window { break; }
            if g + 1 == cfg.max_generations { break; }

            // Next generation: elitism + tournament selection + crossover + mutation.
            let mut next: Vec<Genome> =
                scored.iter().take(cfg.elitism).map(|s| s.0.clone()).collect();
            while next.len() < cfg.population {
                let p1 = tournament(&scored, &mut rng).clone();
                let p2 = tournament(&scored, &mut rng).clone();
                let mut child = crossover(&p1, &p2, seed_model, cfg, &mut rng);
                mutate(&mut child, seed_model, cfg, &mut rng);
                next.push(child);
            }
            pop = next;
        }

        // Final tier: re-measure the best at full fidelity, then the REAL verify.
        let (best_genome, _) = best.expect("at least one generation always runs");
        let model = decode(&best_genome, seed_model);
        let final_seeds = generate_seeds(cfg.master_seed ^ FINAL_SALT, cfg.final_candidate_count);
        let metrics = measure(&simulate(&model, &final_seeds));
        let verdict = match verify(&metrics, target) {
            Ok(()) => Verdict::Pass,
            Err(_) => Verdict::NearMiss { missed: band_misses(&metrics, target) },
        };

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
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GeneBounds, TunerConfig, Weights};
    use crate::outcome::Verdict;
    use crate::Tuner;
    use bloom_math::mechanics::slots::{Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole};
    use bloom_simulator::target::TargetSpec;

    // 1 reel, 1 row, 1 line. strip = 5x sym0, 4x sym1, 1x sym2 (10 cells).
    // paytable: sym1@1 -> 1, sym2@1 -> 5. Closed-form base RTP = 0.9.
    fn toy(payout_sym2: u64) -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Normal },
                SymbolDef { id: 2, role: SymbolRole::Normal },
            ],
            reels: vec![vec![0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 1, count: 1, payout: 1 },
                    PaytableEntry { symbol: 2, count: 1, payout: payout_sym2 },
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
                payout_min: 0, payout_max: 20,
                spins_min: 1, spins_max: 50,
                multiplier_min: 1, multiplier_max: 10,
                min_count_min: 1, min_count_max: 5,
            },
            weights: Weights { rtp: 1.0, volatility: 1.0, hit_rate: 1.0 },
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
    }

    #[test]
    fn converges_a_detuned_model_back_into_band() {
        // start far from target (sym2 pays 1 -> RTP ~0.5); tuner must reach 0.9 ± 0.02.
        let out = GeneticTuner.tune(&toy(1), &target_09(), &cfg(7));
        assert!(matches!(out.verdict, Verdict::Pass), "verdict was {:?}", out.verdict);
        assert!((out.metrics.rtp - 0.9).abs() <= 0.02, "rtp = {}", out.metrics.rtp);
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
}
