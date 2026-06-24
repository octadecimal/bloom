//! Streaming curation CLI: emit NDJSON progress + a final result line on stdout.
//! Usage: curate_json <model.json> <target.json> <package_id> <out.pkg>
//! Verify/correction failures are valid results (exit 0, status="fail"); only
//! bad input or IO errors exit non-zero.

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::run::{run_curation_streamed, CurationProgress, RunError};
use bloom_simulator::target::{HitRateBand, TargetSpec};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::json;
use std::fs;

#[derive(Deserialize)]
struct BandJson { min: f64, max: f64 }

#[derive(Deserialize)]
struct TargetJson {
    rtp_target: f64,
    rtp_tolerance: f64,
    volatility_min: f64,
    volatility_max: f64,
    bonus_hit_rate_bands: Vec<BandJson>,
    pool_size: usize,
    candidate_count: usize,
    realized_correction_band: f64,
    master_seed: u64,
}

fn progress_line(p: &CurationProgress) -> String {
    match p {
        CurationProgress::Phase(name) => {
            json!({ "type": "progress", "phase": name }).to_string()
        }
        CurationProgress::Simulating { done, total } => {
            json!({ "type": "progress", "phase": "simulate", "done": done, "total": total })
                .to_string()
        }
    }
}

fn emit(line: String) {
    println!("{line}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        eprintln!("usage: curate_json <model.json> <target.json> <package_id> <out.pkg>");
        std::process::exit(2);
    }

    let model: SlotModel = match fs::read_to_string(&args[1]).map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(m) => m,
        Err(e) => { eprintln!("bad model json: {e}"); std::process::exit(2); }
    };
    let tj: TargetJson = match fs::read_to_string(&args[2]).map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(t) => t,
        Err(e) => { eprintln!("bad target json: {e}"); std::process::exit(2); }
    };

    let target = TargetSpec {
        rtp_target: tj.rtp_target,
        rtp_tolerance: tj.rtp_tolerance,
        volatility_min: tj.volatility_min,
        volatility_max: tj.volatility_max,
        bonus_hit_rate_bands: tj.bonus_hit_rate_bands.iter()
            .map(|b| HitRateBand { min: b.min, max: b.max }).collect(),
        pool_size: tj.pool_size,
        candidate_count: tj.candidate_count,
        realized_correction_band: tj.realized_correction_band,
    };

    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only (umbrella §9)
    let mut on_progress = |p: CurationProgress| emit(progress_line(&p));
    let s = run_curation_streamed(&model, &target, tj.master_seed, &args[3], &signing_key, &mut on_progress);

    let m = &s.metrics;
    let (status, realized, pool_size, failure) = match &s.outcome {
        Ok(out) => {
            if let Err(e) = fs::write(&args[4], &out.package_bytes) {
                eprintln!("write package failed: {e}"); std::process::exit(1);
            }
            ("pass", Some(out.pool.realized_rtp), Some(out.pool.seeds.len()), None)
        }
        Err(RunError::VerifyFailed(_)) => (
            "fail", None, None,
            Some("measured characteristics missed the target bands".to_string()),
        ),
        Err(RunError::Curate(e)) => (
            "fail", None, None,
            Some(format!("curation guardrail: {e:?} — retune the model, not the pool")),
        ),
    };

    let result = json!({
        "type": "result",
        "status": status,
        "rtp": m.rtp,
        "volatility": m.volatility,
        "hitFrequency": m.hit_frequency,
        "baseRtp": m.base_rtp,
        "featureRtp": m.feature_rtp,
        "bonusHitRates": m.bonus_hit_rates,
        "realizedRtp": realized,
        "poolSize": pool_size,
        "failure": failure,
    });
    emit(result.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_line_is_ndjson() {
        let s = progress_line(&CurationProgress::Phase("freeze"));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "progress");
        assert_eq!(v["phase"], "freeze");
    }

    #[test]
    fn simulate_line_carries_done_total() {
        let s = progress_line(&CurationProgress::Simulating { done: 5, total: 10 });
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["phase"], "simulate");
        assert_eq!(v["done"], 5);
        assert_eq!(v["total"], 10);
    }
}
