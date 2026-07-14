//! Render a `TuneOutcome` into the human-readable audit report — the
//! "AI-designed, never AI-decided" evidence trail (provenance + search trace +
//! final verdict). The tuned model itself is written separately as JSON.

use crate::outcome::{TuneOutcome, Verdict};
use std::fmt::Write;

pub fn render_report(out: &TuneOutcome) -> String {
    let t = &out.trace;
    let mut s = String::new();
    let verdict = match &out.verdict {
        Verdict::Pass => "PASS".to_string(),
        Verdict::NearMiss { .. } => "NEAR_MISS".to_string(),
    };

    writeln!(s, "verdict={verdict}").unwrap();
    writeln!(s, "master_seed={}", t.master_seed).unwrap();
    writeln!(s, "generations_run={}", t.generations_run).unwrap();
    writeln!(s, "population={}", t.population).unwrap();
    writeln!(
        s,
        "search_candidate_count={}\nfinal_candidate_count={}",
        t.search_candidate_count, t.final_candidate_count
    )
    .unwrap();
    writeln!(
        s,
        "measured_rtp={:.5}\nmeasured_volatility={:.5}\nhit_frequency={:.5}",
        out.metrics.rtp, out.metrics.volatility, out.metrics.hit_frequency
    )
    .unwrap();
    for (i, r) in out.metrics.bonus_hit_rates.iter().enumerate() {
        writeln!(s, "bonus_hit_rate[{i}]={r:.5}").unwrap();
    }

    if let Verdict::NearMiss { missed } = &out.verdict {
        writeln!(s, "-- missed bands --").unwrap();
        for m in missed {
            writeln!(
                s,
                "{}: measured={:.5} band=[{:.5}, {:.5}]",
                m.metric, m.measured, m.band_lo, m.band_hi
            )
            .unwrap();
        }
    }

    writeln!(s, "-- search trace (best per generation) --").unwrap();
    for snap in &t.snapshots {
        writeln!(
            s,
            "gen {:>4}: fitness={:.5} rtp={:.5} volatility={:.5}",
            snap.generation, snap.best_fitness, snap.best_rtp, snap.best_volatility
        )
        .unwrap();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outcome::{GenSnapshot, RunProfile, TuneOutcome, TuningTrace, Verdict};
    use crate::telemetry::population_stats;
    use bloom_math::mechanics::slots::{Paytable, SlotModel};
    use bloom_simulator::artifact::MathArtifact;
    use bloom_simulator::profile::WinDistribution;
    use bloom_simulator::target::Metrics;

    fn outcome(verdict: Verdict) -> TuneOutcome {
        TuneOutcome {
            model: MathArtifact::Slots(SlotModel {
                symbols: vec![],
                reels: vec![],
                rows: 1,
                paylines: vec![],
                paytable: Paytable { entries: vec![] },
                bonuses: vec![],
            }),
            metrics: Metrics {
                rtp: 0.901,
                volatility: 3.2,
                hit_frequency: 0.41,
                bonus_hit_rates: vec![],
                base_rtp: 0.901,
                feature_rtp: 0.0,
                ..Default::default()
            },
            verdict,
            trace: TuningTrace {
                master_seed: 2026,
                generations_run: 7,
                snapshots: vec![GenSnapshot {
                    generation: 0,
                    best_fitness: -0.5,
                    best_rtp: 0.5,
                    best_volatility: 2.0,
                    best_bonus_hit_rates: vec![],
                    best_state_rtp: Default::default(),
                    population: population_stats(&[-0.5]),
                    gene_agreement: vec![1.0],
                }],
                population: 24,
                search_candidate_count: 20_000,
                final_candidate_count: 200_000,
                stop_reason: crate::outcome::StopReason::Feasible,
            },
            profile: RunProfile {
                distribution: WinDistribution {
                    bins: vec![],
                    zero_count: 0,
                },
                tail: bloom_simulator::profile::TailMetrics {
                    max_win: 0.0,
                    p_ge_100x: 0.0,
                    p_losing_spin: 0.0,
                    longest_dead_streak: 0,
                    bonus_trigger_rate: 0.0,
                },
                rtp_convergence: vec![],
            },
        }
    }

    #[test]
    fn report_shows_pass_verdict_and_provenance() {
        let r = render_report(&outcome(Verdict::Pass));
        assert!(r.contains("verdict=PASS"));
        assert!(r.contains("master_seed=2026"));
        assert!(r.contains("generations_run=7"));
        assert!(r.contains("measured_rtp=0.901"));
    }

    #[test]
    fn report_shows_near_miss_with_missed_bands() {
        use crate::outcome::BandMiss;
        let r = render_report(&outcome(Verdict::NearMiss {
            missed: vec![BandMiss {
                metric: "rtp".into(),
                measured: 0.80,
                band_lo: 0.89,
                band_hi: 0.91,
            }],
        }));
        assert!(r.contains("verdict=NEAR_MISS"));
        assert!(r.contains("rtp"));
        assert!(r.contains("0.8")); // the missed measured value
        assert!(r.contains("-- missed bands --"));
    }
}
