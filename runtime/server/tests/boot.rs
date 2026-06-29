//! End-to-end: boot the real server on a dev-signed package built in-process from
//! the committed demo fixtures, and exercise all three endpoints through the
//! router. Self-contained — needs no `just runtime-demo-pkg` artifact, so it runs
//! anywhere (CI, a fresh clone) without a pre-step. The `curate`-minted demo
//! package path is separately covered by the simulator's loadable-package tests
//! and the Task 8 HTTP smoke.

use bloom_math::mechanics::slots::{to_payload, SlotModel};
use bloom_package::{build, Envelope, PackageContent};
use bloom_runtime_server::build_app;
use bloom_runtime_server::state::AppState;
use ed25519_dalek::SigningKey;
use std::sync::Arc;
use tower::ServiceExt;

fn demo_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/demo"))
}

/// Build a dev-signed package from the committed demo fixtures (`model.json` +
/// `presentation.json`) with a synthetic seed pool. This mirrors what `curate`
/// mints, minus the curation/RTP step — the boot test only needs a valid,
/// loadable, non-empty package to prove the server boots and serves. Reading the
/// committed fixtures also asserts they parse.
fn demo_package_bytes() -> Vec<u8> {
    let model_json =
        std::fs::read_to_string(demo_dir().join("model.json")).expect("read model.json");
    let model: SlotModel = serde_json::from_str(&model_json).expect("parse model.json");
    let presentation =
        std::fs::read(demo_dir().join("presentation.json")).expect("read presentation.json");

    let content = PackageContent {
        envelope: Envelope {
            package_id: "bloom-demo-slots".to_string(),
            package_version: 1,
            mechanic: "slots@1".to_string(),
        },
        math_payload: to_payload(&model),
        seeds: (0..1000u64).collect(),
        presentation,
    };
    build(&content, &SigningKey::from_bytes(&[7u8; 32]))
}

fn demo_state() -> Arc<AppState> {
    Arc::new(
        AppState::from_package_bytes(
            &demo_package_bytes(),
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
async fn demo_package_boots_and_health_reports_it() {
    let v = get(build_app(demo_state()), "/health").await;
    assert_eq!(v["status"], "ok");
    assert_eq!(v["package_id"], "bloom-demo-slots");
}

#[tokio::test]
async fn demo_handshake_carries_the_presentation_manifest() {
    let v = get(build_app(demo_state()), "/handshake").await;
    assert_eq!(v["presentation"]["cols"], 3);
    assert_eq!(v["presentation"]["parentId"], "root");
}

#[tokio::test]
async fn demo_spin_returns_an_in_pool_outcome() {
    let app = build_app(demo_state());
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
    assert!(v["seed"].is_u64());
    assert_eq!(v["outcome"]["mechanic"], "slots@1");
}
