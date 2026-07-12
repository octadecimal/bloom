//! Streaming curation CLI: emit NDJSON progress + a final result line on stdout.
//! Usage: curate_json <model.json> <target.json> <package_id> <out.pkg>
//! Verify/correction failures are valid results (exit 0, status="fail"); only
//! bad input or IO errors exit non-zero.

use bloom_simulator::artifact::MathArtifact;
use bloom_simulator::run::{run_curation_streamed, CurationProgress, RunError};
use bloom_simulator::target::TargetFile;
use ed25519_dalek::SigningKey;
use serde_json::json;
use std::fs;

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
    se: &bloom_simulator::target::MetricSE,
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
        "maxWin": metrics.max_win,
        "stateRtp": metrics.state_rtp,
        "stateVisitFreq": metrics.state_visit_freq,
        "se": {
            "rtp": se.rtp,
            "volatility": se.volatility,
            "bonusHitRates": se.bonus_hit_rates,
            "hitFrequency": se.hit_frequency,
        },
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

    let artifact: MathArtifact = match fs::read_to_string(&args[1])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
        .and_then(MathArtifact::from_json_value)
    {
        Ok(a) => a,
        Err(e) => {
            eprintln!("bad model json: {e}");
            std::process::exit(2);
        }
    };
    let tf: TargetFile = match fs::read_to_string(&args[2])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("bad target json: {e}");
            std::process::exit(2);
        }
    };
    let target = tf.spec;

    if let Err(e) = bloom_simulator::validate_target(&target) {
        eprintln!("invalid target: {e}");
        std::process::exit(2);
    }
    if let Err(e) = artifact.validate_constraints(&target) {
        eprintln!("invalid target: {e}");
        std::process::exit(2);
    }

    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only (umbrella §9)
    let mut on_progress = |p: CurationProgress| emit(progress_line(&p));
    let s = run_curation_streamed(
        &artifact,
        &target,
        tf.master_seed,
        &args[3],
        &[],
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
        Err(RunError::VerifyFailed(_)) => {
            let sv = artifact.static_violations(&target);
            let msg = if sv.is_empty() {
                "measured characteristics missed the target bands".to_string()
            } else {
                format!(
                    "constraint violations: {}",
                    sv.iter()
                        .map(|v| v.metric.clone())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            };
            ("fail", None, None, Some(msg))
        }
        Err(RunError::Curate(e)) => (
            "fail",
            None,
            None,
            Some(format!(
                "curation guardrail: {e:?} — retune the model, not the pool"
            )),
        ),
    };

    let se = bloom_simulator::target::standard_errors(m, target.candidate_count);
    emit(result_line(
        status,
        m,
        &se,
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
    fn result_line_carries_se() {
        let metrics = Metrics {
            rtp: 0.95,
            volatility: 2.5,
            hit_frequency: 0.35,
            bonus_hit_rates: vec![0.1],
            base_rtp: 0.60,
            feature_rtp: 0.35,
            ..Default::default()
        };
        let se = bloom_simulator::target::standard_errors(&metrics, 10_000);
        let s = result_line("pass", &metrics, &se, Some(0.961), Some(1000), None);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!((v["se"]["rtp"].as_f64().unwrap() - 2.5 / 100.0).abs() < 1e-12);
        assert!(v["se"]["volatility"].as_f64().unwrap() > 0.0);
        assert_eq!(v["se"]["bonusHitRates"].as_array().unwrap().len(), 1);
        assert!(v["se"]["hitFrequency"].is_number());
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
            ..Default::default()
        };
        let se = bloom_simulator::target::standard_errors(&metrics, 10_000);
        let s = result_line("pass", &metrics, &se, Some(0.961), Some(1000), None);
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
        assert!(v["se"]["rtp"].is_number());
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
            ..Default::default()
        };
        let se = bloom_simulator::target::standard_errors(&metrics, 10_000);
        let s = result_line("fail", &metrics, &se, None, None, Some("missed bands"));
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
