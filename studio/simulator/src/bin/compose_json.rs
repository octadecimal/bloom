//! Studio compose bin: read one JSON job from stdin, validate (kernel compile)
//! or build+measure a composed@1 package, print one NDJSON result line.
//! Mirrors curate_json's contract style; no streaming (compose is fast).
//! Usage: compose_json  (job on stdin)

use bloom_math::mechanics::composed::{compile, GameDefinition};
use bloom_simulator::compose::{build_composed_package, measure_pool, PoolMetrics};
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
}

fn result_ok() -> String {
    json!({ "type": "result", "ok": true }).to_string()
}

fn result_errors(errors: &[String]) -> String {
    json!({ "type": "result", "ok": false, "errors": errors }).to_string()
}

fn result_metrics(m: &PoolMetrics) -> String {
    json!({
        "type": "result",
        "ok": true,
        "metrics": {
            "rtp": m.rtp,
            "hitRate": m.hit_rate,
            "maxWinX": m.max_win_x,
            "stateVisits": m.state_visits,
        }
    })
    .to_string()
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
    let bytes = match build_composed_package(
        &def,
        &job.package_id,
        job.seed_count,
        job.master_seed,
        &presentation,
        &key,
    ) {
        Ok(b) => b,
        Err(errs) => {
            let msgs: Vec<String> = errs.iter().map(|e| format!("{e:?}")).collect();
            return (result_errors(&msgs), 0);
        }
    };
    if let Err(e) = std::fs::write(&out_path, &bytes) {
        eprintln!("write package failed: {e}");
        return (String::new(), 1);
    }
    let compiled = compile(&def).expect("compile succeeded during build");
    let seeds = bloom_simulator::seedgen::generate_seeds(job.master_seed, job.seed_count);
    (result_metrics(&measure_pool(&compiled, &seeds)), 0)
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
        assert!(m["stateVisits"]["base"].as_u64().unwrap() == 200);
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
}
