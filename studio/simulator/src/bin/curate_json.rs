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
struct BandJson {
    min: f64,
    max: f64,
}

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
        CurationProgress::Phase(name) => json!({ "type": "progress", "phase": name }).to_string(),
        CurationProgress::Simulating { done, total } => {
            json!({ "type": "progress", "phase": "simulate", "done": done, "total": total })
                .to_string()
        }
    }
}

fn result_line(
    status: &str,
    metrics: &bloom_simulator::target::Metrics,
    realized_rtp: Option<f64>,
    pool_size: Option<usize>,
    failure: Option<&str>,
) -> String {
    serde_json::json!({
        "type": "result",
        "status": status,
        "rtp": metrics.rtp,
        "volatility": metrics.volatility,
        "hitFrequency": metrics.hit_frequency,
        "baseRtp": metrics.base_rtp,
        "featureRtp": metrics.feature_rtp,
        "bonusHitRates": metrics.bonus_hit_rates,
        "realizedRtp": realized_rtp,
        "poolSize": pool_size,
        "failure": failure,
    })
    .to_string()
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

    let model: SlotModel = match fs::read_to_string(&args[1])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(m) => m,
        Err(e) => {
            eprintln!("bad model json: {e}");
            std::process::exit(2);
        }
    };
    let tj: TargetJson = match fs::read_to_string(&args[2])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("bad target json: {e}");
            std::process::exit(2);
        }
    };

    let target = TargetSpec {
        rtp_target: tj.rtp_target,
        rtp_tolerance: tj.rtp_tolerance,
        volatility_min: tj.volatility_min,
        volatility_max: tj.volatility_max,
        bonus_hit_rate_bands: tj
            .bonus_hit_rate_bands
            .iter()
            .map(|b| HitRateBand {
                min: b.min,
                max: b.max,
            })
            .collect(),
        pool_size: tj.pool_size,
        candidate_count: tj.candidate_count,
        realized_correction_band: tj.realized_correction_band,
    };

    if let Err(e) = bloom_simulator::validate_target(&target) {
        eprintln!("invalid target: {e}");
        std::process::exit(2);
    }

    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only (umbrella §9)
    let mut on_progress = |p: CurationProgress| emit(progress_line(&p));
    let s = run_curation_streamed(
        &model,
        &target,
        tj.master_seed,
        &args[3],
        &signing_key,
        &mut on_progress,
    );

    let m = &s.metrics;
    let (status, realized, pool_size, failure) = match &s.outcome {
        Ok(out) => {
            if let Err(e) = fs::write(&args[4], &out.package_bytes) {
                eprintln!("write package failed: {e}");
                std::process::exit(1);
            }
            (
                "pass",
                Some(out.pool.realized_rtp),
                Some(out.pool.seeds.len()),
                None,
            )
        }
        Err(RunError::VerifyFailed(_)) => (
            "fail",
            None,
            None,
            Some("measured characteristics missed the target bands".to_string()),
        ),
        Err(RunError::Curate(e)) => (
            "fail",
            None,
            None,
            Some(format!(
                "curation guardrail: {e:?} — retune the model, not the pool"
            )),
        ),
    };

    emit(result_line(
        status,
        m,
        realized,
        pool_size,
        failure.as_deref(),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_simulator::target::Metrics;

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

    #[test]
    fn result_line_pass_shape() {
        let metrics = Metrics {
            rtp: 0.95,
            volatility: 2.5,
            hit_frequency: 0.35,
            bonus_hit_rates: vec![0.1, 0.2],
            base_rtp: 0.60,
            feature_rtp: 0.35,
        };
        let s = result_line("pass", &metrics, Some(0.961), Some(1000), None);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();

        assert_eq!(v["type"], "result");
        assert_eq!(v["status"], "pass");
        assert_eq!(v["rtp"], 0.95);
        assert_eq!(v["volatility"], 2.5);
        assert_eq!(v["hitFrequency"], 0.35);
        assert_eq!(v["baseRtp"], 0.60);
        assert_eq!(v["featureRtp"], 0.35);
        assert_eq!(v["realizedRtp"], 0.961);
        assert_eq!(v["poolSize"], 1000);
        assert!(v["failure"].is_null());
    }

    #[test]
    fn result_line_fail_shape() {
        let metrics = Metrics {
            rtp: 0.94,
            volatility: 2.3,
            hit_frequency: 0.34,
            bonus_hit_rates: vec![0.09],
            base_rtp: 0.59,
            feature_rtp: 0.35,
        };
        let s = result_line("fail", &metrics, None, None, Some("missed bands"));
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();

        assert_eq!(v["status"], "fail");
        assert!(v["realizedRtp"].is_null());
        assert!(v["poolSize"].is_null());
        assert_eq!(v["failure"], "missed bands");
        assert_eq!(v["rtp"], 0.94);
        assert_eq!(v["volatility"], 2.3);
        assert_eq!(v["hitFrequency"], 0.34);
    }
}
