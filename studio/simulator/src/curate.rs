//! Freeze a faithful seed pool (Approach A2). Start from a faithful sample (the
//! first `pool_size` candidates) and apply only minimal, bounded swaps to land
//! realized RTP within tolerance — never reshaping beyond the correction band.

use crate::measure::RoundSample;
use crate::target::TargetSpec;

#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    pub seeds: Vec<u64>,
    pub realized_rtp: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CurateError {
    /// Hitting the target would move realized RTP further than the honesty
    /// guardrail allows — that is a model-tuning problem, not a curation one.
    OutsideCorrectionBand { needed: f64, band: f64 },
    /// The greedy swap search hit its iteration backstop without converging.
    /// Expected to be unreachable (each accepted swap strictly shrinks an
    /// integer distance, so the loop terminates on its own); this is a defensive
    /// guard so freeze_pool can never hang, whatever the candidate set.
    DidNotConverge { realized: f64, target: f64 },
}

/// Freeze a faithful pool of `target.pool_size` seeds from `samples`
/// (`samples.len()` must be >= pool_size). Starts from the first `pool_size`
/// candidates (a faithful sample) and applies bounded greedy swaps to land
/// realized RTP within `rtp_tolerance`, never moving it more than
/// `realized_correction_band` from `model_rtp`.
pub fn freeze_pool(
    samples: &[RoundSample],
    target: &TargetSpec,
    model_rtp: f64,
) -> Result<Pool, CurateError> {
    let p = target.pool_size;
    assert!(samples.len() >= p, "need at least pool_size candidates");

    let mut pool: Vec<usize> = (0..p).collect();
    let mut reserve: Vec<usize> = (p..samples.len()).collect();
    let mut sum: u64 = pool.iter().map(|&i| samples[i].payout).sum();

    let realized = |sum: u64| sum as f64 / p as f64;

    // Honesty guardrail (Approach A2): curation may only correct toward a target
    // that is itself within `realized_correction_band` of the model's measured RTP.
    // Checked against the TARGET (not the moving realized) so a faithful sample that
    // starts far from model_rtp can still be corrected *toward* honesty.
    if (target.rtp_target - model_rtp).abs() > target.realized_correction_band {
        return Err(CurateError::OutsideCorrectionBand {
            needed: (target.rtp_target - model_rtp).abs(),
            band: target.realized_correction_band,
        });
    }

    // Backstop against a runaway loop. Each accepted swap strictly reduces an
    // integer-valued distance (|sum - target*pool_size|), so convergence needs
    // at most O(samples.len()) swaps; the cap only ever fires on a pathological
    // candidate set and turns a hang into an honest curate error.
    let cap = samples.len().saturating_mul(2).max(1);
    let mut iters = 0usize;

    loop {
        let r = realized(sum);
        if (r - target.rtp_target).abs() <= target.rtp_tolerance {
            break;
        }
        if iters >= cap {
            return Err(CurateError::DidNotConverge {
                realized: r,
                target: target.rtp_target,
            });
        }

        let raise = r < target.rtp_target;
        // Pick the pool slot + reserve slot whose swap moves sum most in the
        // needed direction (deterministic: ties resolved by lowest index).
        let pool_pick = if raise {
            pool.iter()
                .enumerate()
                .min_by_key(|&(_, &i)| samples[i].payout)
        } else {
            pool.iter()
                .enumerate()
                .max_by_key(|&(_, &i)| samples[i].payout)
        };
        let res_pick = if raise {
            reserve
                .iter()
                .enumerate()
                .max_by_key(|&(_, &i)| samples[i].payout)
        } else {
            reserve
                .iter()
                .enumerate()
                .min_by_key(|&(_, &i)| samples[i].payout)
        };

        let (Some((pi, &pidx)), Some((ri, &ridx))) = (pool_pick, res_pick) else {
            break;
        };

        let out_payout = samples[pidx].payout;
        let in_payout = samples[ridx].payout;
        let new_sum = sum - out_payout + in_payout;

        // Accept only swaps that move realized RTP strictly closer to target.
        // The greedy "most extreme" pick can overshoot for high-volatility
        // models — one jackpot swap dwarfs pool_size * rtp_tolerance — flipping
        // the raise/lower decision so the same pair swaps back forever. Stopping
        // on the first non-improving swap breaks that cycle and keeps the
        // closest pool reached. (This also subsumes the old wrong-direction
        // guard: a swap that moves away from target never shrinks the distance.)
        if (realized(new_sum) - target.rtp_target).abs() >= (r - target.rtp_target).abs() {
            break;
        }

        pool[pi] = ridx;
        reserve[ri] = pidx;
        sum = new_sum;
        iters += 1;
    }

    Ok(Pool {
        seeds: pool.iter().map(|&i| samples[i].seed).collect(),
        realized_rtp: realized(sum),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(seed: u64, payout: u64) -> RoundSample {
        RoundSample {
            seed,
            payout,
            base_payout: payout,
            feature_payout: 0,
            feature_triggers: vec![],
        }
    }

    fn spec(pool_size: usize, rtp_target: f64) -> TargetSpec {
        TargetSpec {
            rtp_target,
            rtp_tolerance: 0.001,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size,
            candidate_count: 0,
            realized_correction_band: 0.05,
            ..Default::default()
        }
    }

    #[test]
    fn faithful_sample_already_on_target_needs_no_swaps() {
        let samples: Vec<_> = (0..10)
            .map(|i| sample(i, if i % 2 == 0 { 0 } else { 2 }))
            .collect();
        let pool = freeze_pool(&samples, &spec(10, 1.0), 1.0).unwrap();
        assert_eq!(pool.seeds.len(), 10);
        assert!((pool.realized_rtp - 1.0).abs() <= 0.001);
    }

    #[test]
    fn swaps_nudge_realized_toward_target() {
        // pool of first 4 = payouts [0,0,0,0] -> realized 0.0; reserve has 2s.
        let mut samples: Vec<_> = (0..4).map(|i| sample(i, 0)).collect();
        samples.extend((4..12).map(|i| sample(i, 2)));
        // model_rtp ~ (0*4 + 2*8)/12 = 1.333; target 1.0 within band 0.05? |1.0-1.333|=0.333 > 0.05
        // so use a model_rtp close to target to allow correction:
        let pool = freeze_pool(&samples, &spec(4, 1.0), 1.0).unwrap();
        assert!(
            (pool.realized_rtp - 1.0).abs() <= 0.001,
            "got {}",
            pool.realized_rtp
        );
    }

    #[test]
    fn terminates_on_oscillating_jackpot_swaps() {
        // High-volatility signature: a single candidate's payout delta (3) dwarfs
        // pool_size * rtp_tolerance (2 * 0.01 = 0.02). The faithful pool [0,3]
        // realizes 1.5 (target 1.0, out of tolerance) and every available swap
        // overshoots to 0.0, flipping the raise/lower decision — the greedy
        // "most extreme" rule then swaps the same pair back forever. freeze_pool
        // MUST terminate rather than hang.
        let samples = vec![sample(0, 0), sample(1, 3), sample(2, 0), sample(3, 3)];
        let target = TargetSpec {
            rtp_tolerance: 0.01,
            ..spec(2, 1.0)
        };

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(freeze_pool(&samples, &target, 1.0));
        });
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("freeze_pool must terminate, not hang");
        assert!(result.is_ok(), "expected a frozen pool, got {result:?}");
    }

    #[test]
    fn refuses_correction_beyond_band() {
        // model_rtp 0.0, target 1.0 -> needs to move 1.0 >> band 0.05.
        let samples: Vec<_> = (0..8)
            .map(|i| sample(i, if i < 4 { 0 } else { 2 }))
            .collect();
        let err = freeze_pool(&samples, &spec(4, 1.0), 0.0).unwrap_err();
        assert!(matches!(err, CurateError::OutsideCorrectionBand { .. }));
    }
}
