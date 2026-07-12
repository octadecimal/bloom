//! Studio compose bin: read one JSON job from stdin, validate (kernel compile)
//! or build+curate a composed@1 package, print one NDJSON result line.
//! Mirrors curate_json's contract style; no streaming (compose is fast).
//! Usage: compose_json  (job on stdin)

use bloom_math::mechanics::composed::{compile, GameDefinition};
use bloom_simulator::compose::build_composed;
use bloom_simulator::run::RunError;
use bloom_simulator::target::{Metrics, TargetSpec};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::json;
use std::io::Read;

fn default_seed_count() -> usize {
    10_000
}

#[derive(Deserialize)]
struct ComposeJob {
    definition: serde_json::Value,
    #[serde(default)]
    presentation: Option<serde_json::Value>,
    package_id: String,
    #[serde(default = "default_seed_count")]
    seed_count: usize,
    master_seed: u64,
    #[serde(default)]
    out_path: Option<String>,
    #[serde(default)]
    validate_only: bool,
    /// Full curation target (same snake_case keys as target.json). None →
    /// self-centered default (compose::self_target).
    #[serde(default)]
    target: Option<TargetSpec>,
}

fn result_ok() -> String {
    json!({ "type": "result", "ok": true }).to_string()
}

fn result_errors(errors: &[String]) -> String {
    json!({ "type": "result", "ok": false, "errors": errors }).to_string()
}

fn metrics_json(m: &Metrics, n: usize) -> serde_json::Value {
    let visits: std::collections::BTreeMap<String, u64> = m
        .state_visit_freq
        .iter()
        .map(|(k, f)| (k.clone(), (f * n as f64).round() as u64))
        .collect();
    json!({
        "rtp": m.rtp,
        "hitRate": m.hit_frequency,
        "maxWinX": m.max_win,
        "stateVisits": visits,
        "volatility": m.volatility,
        "stateRtp": m.state_rtp,
        "stateVisitFreq": m.state_visit_freq,
    })
}

fn verdict_json(
    status: &str,
    failure: Option<&str>,
    realized_rtp: Option<f64>,
    target: &TargetSpec,
    self_derived: bool,
) -> serde_json::Value {
    json!({
        "status": status,
        "failure": failure,
        "realizedRtp": realized_rtp,
        "poolSize": target.pool_size,
        "rtpTarget": target.rtp_target,
        "rtpTolerance": target.rtp_tolerance,
        "selfDerived": self_derived,
    })
}

/// Run the job. Returns (stdout line, exit code). Writes the package file as a
/// side effect on a successful build.
fn run_job(job: ComposeJob) -> (String, i32) {
    let def: GameDefinition = match serde_json::from_value(job.definition) {
        Ok(d) => d,
        Err(e) => return (result_errors(&[format!("definition parse: {e}")]), 0),
    };
    if job.validate_only {
        return match compile(&def) {
            Ok(_) => (result_ok(), 0),
            Err(errs) => {
                let msgs: Vec<String> = errs.iter().map(|e| format!("{e:?}")).collect();
                (result_errors(&msgs), 0)
            }
        };
    }
    let Some(out_path) = job.out_path else {
        eprintln!("compose_json: out_path is required unless validate_only");
        return (String::new(), 2);
    };
    let presentation: Vec<u8> = match &job.presentation {
        Some(v) => serde_json::to_vec(v).expect("presentation Value serializes"),
        None => Vec::new(),
    };
    let key = SigningKey::from_bytes(&[7u8; 32]); // dev-only, same as compose/curate
    let self_derived = job.target.is_none();
    if let Some(t) = &job.target {
        // Caller-supplied targets must be validated before building — the
        // self-derived default (None) is correct by construction and skips
        // this. Compiling here duplicates the compile build_composed does
        // internally, but compile is cheap next to simulation.
        let artifact = match bloom_simulator::artifact::MathArtifact::from_definition(def.clone()) {
            Ok(a) => a,
            Err(errs) => {
                let msgs: Vec<String> = errs.iter().map(|e| format!("{e:?}")).collect();
                return (result_errors(&msgs), 0);
            }
        };
        if let Err(msg) = bloom_simulator::validate_target(t) {
            return (result_errors(&[format!("invalid target: {msg}")]), 0);
        }
        if let Err(msg) = artifact.validate_constraints(t) {
            return (result_errors(&[format!("invalid target: {msg}")]), 0);
        }
    }
    let (target, s) = match build_composed(
        &def,
        job.target,
        &job.package_id,
        job.seed_count,
        job.master_seed,
        &presentation,
        &key,
    ) {
        Ok(pair) => pair,
        Err(errs) => {
            let msgs: Vec<String> = errs.iter().map(|e| format!("{e:?}")).collect();
            return (result_errors(&msgs), 0);
        }
    };
    let n = target.candidate_count;
    match s.outcome {
        Ok(out) => {
            if let Err(e) = std::fs::write(&out_path, &out.package_bytes) {
                eprintln!("write package failed: {e}");
                return (String::new(), 1);
            }
            let line = json!({
                "type": "result",
                "ok": true,
                "metrics": metrics_json(&s.metrics, n),
                "verdict": verdict_json(
                    "pass", None, Some(out.pool.realized_rtp), &target, self_derived
                ),
            });
            (line.to_string(), 0)
        }
        Err(e) => {
            let failure = match e {
                RunError::VerifyFailed(_) => {
                    "measured characteristics missed the target bands".to_string()
                }
                RunError::Curate(e) => {
                    format!("curation guardrail: {e:?} — retune the definition, not the pool")
                }
            };
            let line = json!({
                "type": "result",
                "ok": false,
                "errors": [failure],
                "metrics": metrics_json(&s.metrics, n),
                "verdict": verdict_json("fail", Some(&failure), None, &target, self_derived),
            });
            (line.to_string(), 0)
        }
    }
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("compose_json: failed to read stdin");
        std::process::exit(2);
    }
    let job: ComposeJob = match serde_json::from_str(&input) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("compose_json: bad job json: {e}");
            std::process::exit(2);
        }
    };
    let (line, code) = run_job(job);
    if !line.is_empty() {
        println!("{line}");
    }
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_definition_value() -> serde_json::Value {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime/server/demo/composed.definition.json"
        ))
        .expect("read demo definition");
        serde_json::from_str(&json).expect("parse demo definition")
    }

    fn job(v: serde_json::Value) -> ComposeJob {
        serde_json::from_value(v).expect("job parses")
    }

    #[test]
    fn job_defaults_apply() {
        let j = job(json!({
            "definition": demo_definition_value(),
            "package_id": "p1",
            "master_seed": 7
        }));
        assert_eq!(j.seed_count, 10_000);
        assert!(!j.validate_only);
        assert!(j.out_path.is_none());
        assert!(j.presentation.is_none());
        assert!(j.target.is_none());
    }

    #[test]
    fn validate_only_ok_and_errors() {
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "p1",
            "master_seed": 7,
            "validate_only": true
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], true);

        let mut bad = demo_definition_value();
        bad["start"] = json!("no-such-state");
        let (line, code) = run_job(job(json!({
            "definition": bad,
            "package_id": "p1",
            "master_seed": 7,
            "validate_only": true
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        assert!(!v["errors"].as_array().unwrap().is_empty());
    }

    #[test]
    fn definition_parse_failure_is_an_ok_false_result() {
        let (line, code) = run_job(job(json!({
            "definition": {"family": 42},
            "package_id": "p1",
            "master_seed": 7,
            "validate_only": true
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["errors"][0]
            .as_str()
            .unwrap()
            .starts_with("definition parse:"));
    }

    #[test]
    fn build_writes_pkg_and_reports_metrics() {
        let out =
            std::env::temp_dir().join(format!("compose-json-test-{}.pkg", std::process::id()));
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "presentation": {"p": 1},
            "package_id": "pkg-test",
            "seed_count": 200,
            "master_seed": 42,
            "out_path": out.to_string_lossy(),
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], true);
        let m = &v["metrics"];
        assert!(m["rtp"].as_f64().unwrap() >= 0.0);
        assert!(m["stateVisits"]["base"].as_u64().unwrap() == 400);
        assert_eq!(v["verdict"]["status"], "pass");
        assert_eq!(v["verdict"]["selfDerived"], true);
        assert_eq!(v["verdict"]["poolSize"], 200);
        assert!(v["verdict"]["realizedRtp"].is_number());
        assert!(m["stateRtp"]["base"].is_number());
        let bytes = std::fs::read(&out).expect("package written");
        assert!(!bytes.is_empty());
        std::fs::remove_file(&out).ok();
    }

    #[test]
    fn build_without_out_path_is_usage_error() {
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "p1",
            "master_seed": 7
        })));
        assert_eq!(code, 2);
        assert!(line.is_empty());
    }

    #[test]
    fn explicit_failing_target_reports_a_fail_verdict_and_writes_nothing() {
        let out =
            std::env::temp_dir().join(format!("compose-json-fail-{}.pkg", std::process::id()));
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "pkg-fail",
            "seed_count": 100,
            "master_seed": 42,
            "out_path": out.to_string_lossy(),
            "target": {
                "rtp_target": 50.0, "rtp_tolerance": 0.001,
                "volatility_min": 0.0, "volatility_max": 1e9,
                "bonus_hit_rate_bands": [],
                "pool_size": 50, "candidate_count": 100,
                "realized_correction_band": 0.05
            }
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["verdict"]["status"], "fail");
        assert_eq!(v["verdict"]["selfDerived"], false);
        assert!(!v["errors"].as_array().unwrap().is_empty());
        assert!(v["metrics"]["rtp"].is_number()); // metrics still measured
        assert!(!out.exists(), "a failed verify must not sign a package");
    }

    #[test]
    fn caller_target_with_bonus_bands_is_rejected_not_panicked() {
        let out = std::env::temp_dir().join(format!(
            "compose-json-bonus-bands-{}.pkg",
            std::process::id()
        ));
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "pkg-bonus-bands",
            "seed_count": 100,
            "master_seed": 42,
            "out_path": out.to_string_lossy(),
            "target": {
                "rtp_target": 0.96, "rtp_tolerance": 0.01,
                "volatility_min": 0.0, "volatility_max": 1e9,
                "bonus_hit_rate_bands": [{"min": 0.0, "max": 1.0}],
                "pool_size": 50, "candidate_count": 100,
                "realized_correction_band": 0.05
            }
        })));
        assert_eq!(code, 0, "must not panic (exit 101)");
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        let msg = v["errors"][0].as_str().unwrap();
        assert!(msg.contains("#160"), "got: {msg}");
        assert!(!out.exists());
    }

    #[test]
    fn caller_target_with_unknown_pay_symbol_is_rejected() {
        let out = std::env::temp_dir().join(format!(
            "compose-json-unknown-symbol-{}.pkg",
            std::process::id()
        ));
        let (line, code) = run_job(job(json!({
            "definition": demo_definition_value(),
            "package_id": "pkg-unknown-symbol",
            "seed_count": 100,
            "master_seed": 42,
            "out_path": out.to_string_lossy(),
            "target": {
                "rtp_target": 0.96, "rtp_tolerance": 0.01,
                "volatility_min": 0.0, "volatility_max": 1e9,
                "bonus_hit_rate_bands": [],
                "pool_size": 50, "candidate_count": 100,
                "realized_correction_band": 0.05,
                "pay_constraints": [{"symbol": 42, "relation": "floor", "value": 1}]
            }
        })));
        assert_eq!(code, 0);
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], false);
        let msg = v["errors"][0].as_str().unwrap();
        assert!(msg.contains("unknown model symbol"), "got: {msg}");
        assert!(!out.exists());
    }
}
