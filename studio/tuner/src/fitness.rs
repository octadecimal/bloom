//! The GA objective. Out-of-band: a weighted sum of each metric's normalized
//! distance outside its target band, offset below −1 so every in-band
//! candidate strictly outranks every out-of-band one. In-band: normalized
//! distance to the band centers (RTP + bonus rates; volatility bands are
//! semantic ranges with no point target), so the search keeps centering
//! instead of parking on a band edge. `fitness == 0.0` ⟺ dead center.

use crate::config::Weights;
use crate::outcome::BandMiss;
use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::constraints::static_violations;
use bloom_simulator::target::{outside, standard_errors, Metrics, TargetSpec, K_SIGMA};

/// `fitness <= 0`; `0.0` at dead center. In-band values lie in `[-1, 0]`,
/// out-of-band values below `-1`.
pub fn fitness(m: &Metrics, t: &TargetSpec, w: &Weights) -> f64 {
    let rtp_lo = t.rtp_target - t.rtp_tolerance;
    let rtp_hi = t.rtp_target + t.rtp_tolerance;
    let mut d = w.rtp * outside(m.rtp, rtp_lo, rtp_hi) / t.rtp_target.abs().max(1e-9);

    let vol_norm = (t.volatility_max - t.volatility_min).abs().max(1e-9);
    d += w.volatility * outside(m.volatility, t.volatility_min, t.volatility_max) / vol_norm;

    for (band, &rate) in t.bonus_hit_rate_bands.iter().zip(&m.bonus_hit_rates) {
        let width = (band.max - band.min).abs().max(1e-9);
        d += w.hit_rate * outside(rate, band.min, band.max) / width;
    }

    if let Some(band) = &t.hit_frequency_band {
        let width = (band.max - band.min).abs().max(1e-9);
        d += w.hit_frequency * outside(m.hit_frequency, band.min, band.max) / width;
    }

    if d > 0.0 {
        return -1.0 - d;
    }

    // In-band: rank by distance to the band centers. Volatility is exempt —
    // its bands are semantic ranges (e.g. "high" = 10..1e9) whose midpoint is
    // not a design intent.
    let mut center = w.rtp * (m.rtp - t.rtp_target).abs() / t.rtp_tolerance.max(1e-9);
    let mut total_w = w.rtp;
    for (band, &rate) in t.bonus_hit_rate_bands.iter().zip(&m.bonus_hit_rates) {
        let mid = (band.min + band.max) / 2.0;
        let half = ((band.max - band.min) / 2.0).abs().max(1e-9);
        center += w.hit_rate * (rate - mid).abs() / half;
        total_w += w.hit_rate;
    }
    if let Some(band) = &t.hit_frequency_band {
        let mid = (band.min + band.max) / 2.0;
        let half = ((band.max - band.min) / 2.0).abs().max(1e-9);
        center += w.hit_frequency * (m.hit_frequency - mid).abs() / half;
        total_w += w.hit_frequency;
    }
    -(center / total_w.max(1e-9)).min(1.0)
}

/// The bands the measured metrics miss by more than `K_SIGMA` standard
/// errors (empty ⟺ the noise-aware `verify` passes). Used to explain a
/// near-miss verdict in the report.
pub fn band_misses(model: &SlotModel, m: &Metrics, t: &TargetSpec, n: usize) -> Vec<BandMiss> {
    let se = standard_errors(m, n);
    let mut out = Vec::new();
    let rtp_lo = t.rtp_target - t.rtp_tolerance;
    let rtp_hi = t.rtp_target + t.rtp_tolerance;
    if outside(m.rtp, rtp_lo, rtp_hi) > K_SIGMA * se.rtp {
        out.push(BandMiss {
            metric: "rtp".into(),
            measured: m.rtp,
            band_lo: rtp_lo,
            band_hi: rtp_hi,
        });
    }
    if outside(m.volatility, t.volatility_min, t.volatility_max) > K_SIGMA * se.volatility {
        out.push(BandMiss {
            metric: "volatility".into(),
            measured: m.volatility,
            band_lo: t.volatility_min,
            band_hi: t.volatility_max,
        });
    }
    for (i, (band, (&rate, &se_hit))) in t
        .bonus_hit_rate_bands
        .iter()
        .zip(m.bonus_hit_rates.iter().zip(&se.bonus_hit_rates))
        .enumerate()
    {
        if outside(rate, band.min, band.max) > K_SIGMA * se_hit {
            out.push(BandMiss {
                metric: format!("bonus_hit_rate[{i}]"),
                measured: rate,
                band_lo: band.min,
                band_hi: band.max,
            });
        }
    }
    if let Some(band) = &t.hit_frequency_band {
        if outside(m.hit_frequency, band.min, band.max) > K_SIGMA * se.hit_frequency {
            out.push(BandMiss {
                metric: "hit_frequency".into(),
                measured: m.hit_frequency,
                band_lo: band.min,
                band_hi: band.max,
            });
        }
    }
    for v in static_violations(model, t) {
        out.push(BandMiss {
            metric: v.metric,
            measured: v.measured,
            band_lo: v.band_lo,
            band_hi: v.band_hi,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Weights;
    use bloom_simulator::target::{HitRateBand, Metrics, TargetSpec};

    fn weights() -> Weights {
        Weights {
            rtp: 1.0,
            volatility: 1.0,
            hit_rate: 1.0,
            hit_frequency: 1.0,
        }
    }

    fn target(bands: Vec<HitRateBand>) -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 1.0,
            volatility_max: 10.0,
            bonus_hit_rate_bands: bands,
            pool_size: 100,
            candidate_count: 1000,
            realized_correction_band: 0.05,
            ..Default::default()
        }
    }

    fn metrics(rtp: f64, vol: f64, bonus: Vec<f64>) -> Metrics {
        Metrics {
            rtp,
            volatility: vol,
            hit_frequency: 0.3,
            bonus_hit_rates: bonus,
            base_rtp: rtp,
            feature_rtp: 0.0,
            ..Default::default()
        }
    }

    // Mirrors genetic.rs's `toy(payout_sym2)` 1-reel fixture (here sym2 pays
    // 5, deliberately beating sym1's 1) — verify() needs a model to check
    // static constraints against, and the top_paying test needs a real
    // violation to detect.
    fn toy_model() -> bloom_math::mechanics::slots::SlotModel {
        use bloom_math::mechanics::slots::{
            Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
        };
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
    fn dead_center_scores_zero_and_off_center_in_band_scores_below() {
        let t = target(vec![]);
        assert_eq!(fitness(&metrics(0.96, 3.0, vec![]), &t, &weights()), 0.0);
        let off = fitness(&metrics(0.955, 3.0, vec![]), &t, &weights());
        assert!(off < 0.0 && off > -1.0, "in-band off-center: {off}");
    }

    #[test]
    fn in_band_fitness_is_monotone_in_distance_to_center() {
        let t = target(vec![]);
        let near = fitness(&metrics(0.9612, 3.0, vec![]), &t, &weights());
        let far = fitness(&metrics(0.955, 3.0, vec![]), &t, &weights());
        assert!(near > far);
    }

    #[test]
    fn any_in_band_candidate_outranks_any_out_of_band_candidate() {
        let t = target(vec![]);
        // worst in-band (band edge, fitness −1.0) vs best out-of-band
        // (hairline miss just past band-hi 0.97, fitness < −1.0)
        let edge_in = fitness(&metrics(0.95, 3.0, vec![]), &t, &weights());
        let hairline_out = fitness(&metrics(0.9701, 3.0, vec![]), &t, &weights());
        assert!(edge_in > hairline_out);
    }

    #[test]
    fn out_of_band_ordering_is_preserved() {
        let t = target(vec![]);
        let near = fitness(&metrics(0.94, 3.0, vec![]), &t, &weights());
        let far = fitness(&metrics(0.80, 3.0, vec![]), &t, &weights());
        assert!(near > far);
        assert!(near < -1.0 && far < -1.0);
    }

    #[test]
    fn volatility_exerts_no_centering_pull() {
        let t = target(vec![]);
        let low = fitness(&metrics(0.955, 2.0, vec![]), &t, &weights());
        let high = fitness(&metrics(0.955, 8.0, vec![]), &t, &weights());
        assert_eq!(low, high);
    }

    #[test]
    fn bonus_rates_center_toward_the_band_midpoint() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        let centered = fitness(&metrics(0.96, 3.0, vec![0.025]), &t, &weights());
        let edgy = fitness(&metrics(0.96, 3.0, vec![0.048]), &t, &weights());
        assert!(centered > edgy);
    }

    #[test]
    fn hit_frequency_band_pulls_fitness_when_out_of_band() {
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand {
            min: 0.35,
            max: 0.45,
        });
        // fixture hit_frequency 0.3 → out of band → below -1.
        let out = fitness(&metrics(0.96, 3.0, vec![]), &t, &weights());
        assert!(
            out < -1.0,
            "out-of-band hit frequency must be infeasible: {out}"
        );
        // In band (0.25–0.35) → in-band, centered scoring applies.
        t.hit_frequency_band = Some(HitRateBand {
            min: 0.25,
            max: 0.35,
        });
        let centered = fitness(&metrics(0.96, 3.0, vec![]), &t, &weights());
        assert!(centered <= 0.0 && centered > -1.0);
    }

    #[test]
    fn zero_weight_disables_the_hit_frequency_pull() {
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand {
            min: 0.35,
            max: 0.45,
        });
        let mut w = weights();
        w.hit_frequency = 0.0;
        assert_eq!(fitness(&metrics(0.96, 3.0, vec![]), &t, &w), 0.0);
    }

    #[test]
    fn band_misses_reports_hit_frequency_and_static_violations() {
        let mut t = target(vec![]);
        t.hit_frequency_band = Some(HitRateBand {
            min: 0.35,
            max: 0.45,
        });
        t.pay_constraints = vec![bloom_simulator::target::PayConstraint {
            symbol: 1,
            relation: bloom_simulator::target::PayRelation::TopPaying,
            count: None,
            value: 0,
        }];
        // toy_model(): sym2 pays 5 > sym1's 1 → top_paying violated.
        let misses = band_misses(&toy_model(), &metrics(0.96, 3.0, vec![]), &t, 4_000_000);
        let names: Vec<&str> = misses.iter().map(|m| m.metric.as_str()).collect();
        assert!(names.contains(&"hit_frequency"));
        assert!(names.iter().any(|n| n.starts_with("top_paying[")));
    }

    #[test]
    fn band_misses_ignores_sub_2_se_misses() {
        // rtp 0.978 vs band 0.95–0.97 (miss 0.008), vol 2.0:
        // n=160_000 → allowance 0.01 → no miss; n=4_000_000 → allowance
        // 0.002 → "rtp" reported. (Mirrors the verify boundary tests.)
        let t = target(vec![]);
        let m = metrics(0.978, 2.0, vec![]);
        assert!(band_misses(&toy_model(), &m, &t, 160_000).is_empty());
        let misses = band_misses(&toy_model(), &m, &t, 4_000_000);
        assert_eq!(misses.len(), 1);
        assert_eq!(misses[0].metric, "rtp");
    }

    #[test]
    fn band_misses_agrees_with_verify() {
        use bloom_simulator::run::verify;
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        for (m, n) in [
            (metrics(0.978, 2.0, vec![0.02]), 160_000usize),
            (metrics(0.978, 2.0, vec![0.02]), 4_000_000),
            (metrics(0.955, 3.0, vec![0.20]), 1_000_000),
            (metrics(0.955, 3.0, vec![0.02]), 1_000_000),
        ] {
            assert_eq!(
                band_misses(&toy_model(), &m, &t, n).is_empty(),
                verify(&toy_model(), &m, &t, n).is_ok(),
                "band_misses and verify disagree at n={n}"
            );
        }
        // static violation: any n, agreement must hold
        {
            let mut t2 = t.clone();
            t2.pay_constraints = vec![bloom_simulator::target::PayConstraint {
                symbol: 1,
                relation: bloom_simulator::target::PayRelation::TopPaying,
                count: None,
                value: 0,
            }];
            let m = metrics(0.955, 3.0, vec![0.02]);
            assert_eq!(
                band_misses(&toy_model(), &m, &t2, 1_000_000).is_empty(),
                verify(&toy_model(), &m, &t2, 1_000_000).is_ok(),
            );
        }
    }

    #[test]
    fn closer_to_band_scores_higher() {
        let t = target(vec![]);
        let near = fitness(&metrics(0.94, 3.0, vec![]), &t, &weights()); // 0.01 outside
        let far = fitness(&metrics(0.80, 3.0, vec![]), &t, &weights()); // 0.15 outside
        assert!(near > far); // both negative; nearer is larger (closer to 0)
    }

    #[test]
    fn band_misses_names_the_missed_metrics() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        let misses = band_misses(&toy_model(), &metrics(0.80, 0.5, vec![0.20]), &t, 1_000_000);
        let names: Vec<&str> = misses.iter().map(|m| m.metric.as_str()).collect();
        assert!(names.contains(&"rtp"));
        assert!(names.contains(&"volatility"));
        assert!(names.contains(&"bonus_hit_rate[0]"));
    }

    #[test]
    fn band_misses_empty_when_all_inside() {
        let t = target(vec![HitRateBand {
            min: 0.0,
            max: 0.05,
        }]);
        assert!(band_misses(
            &toy_model(),
            &metrics(0.955, 3.0, vec![0.02]),
            &t,
            1_000_000
        )
        .is_empty());
    }
}
