//! Up-front validation of curation inputs: reject absurd sizes BEFORE they drive
//! an unbounded `generate_seeds` / `Vec::with_capacity` allocation (OOM), and
//! before `freeze_pool`'s `samples.len() >= pool_size` assert can panic. These
//! are absurdity ceilings (defense-in-depth) far above any honest run; the
//! subprocess watchdog is the runtime backstop.

use crate::target::TargetSpec;

/// Largest candidate_count / pool_size we will allocate for. Honest runs are
/// ~10^5–10^6; beyond this is a typo or a degenerate realized config.
pub const MAX_CANDIDATE_COUNT: usize = 100_000_000;

/// `Err(message)` if the target would OOM or panic downstream.
pub fn validate_target(target: &TargetSpec) -> Result<(), String> {
    if target.candidate_count > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "candidate_count {} exceeds MAX_CANDIDATE_COUNT {} (refusing to allocate; retune the run)",
            target.candidate_count, MAX_CANDIDATE_COUNT
        ));
    }
    if target.pool_size > MAX_CANDIDATE_COUNT {
        return Err(format!(
            "pool_size {} exceeds MAX_CANDIDATE_COUNT {}",
            target.pool_size, MAX_CANDIDATE_COUNT
        ));
    }
    if target.pool_size > target.candidate_count {
        return Err(format!(
            "pool_size {} exceeds candidate_count {} (cannot freeze a pool larger than the candidate sample)",
            target.pool_size, target.candidate_count
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::target::TargetSpec;

    fn target(candidate_count: usize, pool_size: usize) -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size,
            candidate_count,
            realized_correction_band: 0.05,
            ..Default::default()
        }
    }

    #[test]
    fn ok_for_an_honest_run() {
        assert!(validate_target(&target(200_000, 10_000)).is_ok());
    }

    #[test]
    fn rejects_oversized_candidate_count() {
        let err = validate_target(&target(MAX_CANDIDATE_COUNT + 1, 1)).unwrap_err();
        assert!(err.contains("candidate_count"));
    }

    #[test]
    fn rejects_oversized_pool_size() {
        let err =
            validate_target(&target(MAX_CANDIDATE_COUNT + 1, MAX_CANDIDATE_COUNT + 1)).unwrap_err();
        assert!(err.contains("candidate_count"));
    }

    #[test]
    fn rejects_pool_larger_than_candidates() {
        let err = validate_target(&target(1_000, 2_000)).unwrap_err();
        assert!(err.contains("exceeds candidate_count"));
    }
}
