//! Composed demo package end-to-end: boot the committed fixture through the
//! real router, and prove the served trace replays bit-for-bit from the
//! audited seed (SP2 spec §6). Builds the package in-process from the
//! committed definition (like boot.rs), and separately asserts the
//! CLI-minted, checked-in composed.pkg loads.

use bloom_math::mechanics::composed::{compile, evaluate, GameDefinition};
use bloom_package::{build, Envelope, PackageContent};
use bloom_runtime_server::build_app;
use bloom_runtime_server::state::{AppState, LoadedGame};
use ed25519_dalek::SigningKey;
use std::sync::Arc;
use tower::ServiceExt;

fn demo_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/demo"))
}

fn demo_definition() -> GameDefinition {
    let json = std::fs::read_to_string(demo_dir().join("composed.definition.json"))
        .expect("read composed.definition.json");
    serde_json::from_str(&json).expect("parse composed.definition.json")
}

/// In-process package from the committed fixtures (mirrors boot.rs: no
/// pre-step needed; reading the fixtures also asserts they parse).
fn composed_package_bytes() -> Vec<u8> {
    let def = demo_definition();
    let presentation = std::fs::read(demo_dir().join("composed.presentation.json"))
        .expect("read composed.presentation.json");
    let content = PackageContent {
        envelope: Envelope {
            package_id: "bloom-demo-composed".to_string(),
            package_version: 1,
            mechanic: "composed@1".to_string(),
        },
        math_payload: bloom_math::mechanics::composed::to_payload(&def),
        seeds: (0..1000u64).collect(),
        presentation,
    };
    build(&content, &SigningKey::from_bytes(&[7u8; 32]))
}

fn composed_state() -> Arc<AppState> {
    Arc::new(
        AppState::from_package_bytes(
            &composed_package_bytes(),
            Box::new(bloom_runtime_server::draw::OsRngDraw),
            Box::new(bloom_runtime_server::audit::MemoryAuditSink::new()),
        )
        .unwrap(),
    )
}

async fn get(app: axum::Router, uri: &str) -> serde_json::Value {
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .uri(uri)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn composed_demo_boots_and_health_reports_the_family() {
    let v = get(build_app(composed_state()), "/health").await;
    assert_eq!(v["status"], "ok");
    assert_eq!(v["package_id"], "bloom-demo-composed");
    assert_eq!(v["mechanic"], "composed@1");
}

#[tokio::test]
async fn composed_demo_handshake_carries_presentation_and_definition() {
    let v = get(build_app(composed_state()), "/handshake").await;
    assert_eq!(v["presentation"]["cols"], 3);
    assert_eq!(v["definition"]["family"], "composed@1");
    assert_eq!(v["definition"]["start"], "base");
    assert_eq!(v["definition"]["states"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn composed_demo_spin_trace_replays_bit_for_bit() {
    let app = build_app(composed_state());
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/spin")
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

    // Walkable: starts with round_start, ends with round_end.
    let trace = v["trace"]
        .as_array()
        .expect("composed spin carries a trace");
    assert_eq!(trace.first().unwrap()["t"], "round_start");
    assert_eq!(trace.last().unwrap()["t"], "round_end");

    // Replay: re-evaluate the served (string-encoded) seed; the trace and
    // summary must match exactly — the audit-reproducibility guarantee.
    let seed: u64 = v["seed"]
        .as_str()
        .expect("seed is a string")
        .parse()
        .unwrap();
    let compiled = compile(&demo_definition()).expect("demo definition compiles");
    let expected = evaluate(&compiled, seed);
    assert_eq!(v["trace"], serde_json::to_value(&expected.entries).unwrap());
    assert_eq!(v["outcome"]["mechanic"], "composed@1");
    assert_eq!(v["outcome"]["total_payout"], expected.total_payout);
}

#[tokio::test]
async fn checked_in_composed_pkg_loads_and_is_composed() {
    let bytes =
        std::fs::read(demo_dir().join("composed.pkg")).expect("read checked-in composed.pkg");
    let state = AppState::from_package_bytes(
        &bytes,
        Box::new(bloom_runtime_server::draw::OsRngDraw),
        Box::new(bloom_runtime_server::audit::MemoryAuditSink::new()),
    )
    .expect("checked-in composed.pkg verifies and compiles");
    assert_eq!(state.package.envelope.package_id, "bloom-demo-composed");
    assert_eq!(state.package.seeds.len(), 10000);
    assert!(matches!(state.game, LoadedGame::Composed(_)));
}
