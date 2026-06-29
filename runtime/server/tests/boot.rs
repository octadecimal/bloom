//! End-to-end: boot the real server on the minted demo package and exercise all
//! three endpoints through the router. Requires `just runtime-demo-pkg` to have
//! produced runtime/server/demo/demo.pkg first.

use bloom_runtime_server::build_app;
use bloom_runtime_server::state::AppState;
use std::sync::Arc;
use tower::ServiceExt;

fn demo_state() -> Arc<AppState> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/demo/demo.pkg");
    let bytes = std::fs::read(path)
        .unwrap_or_else(|_| panic!("run `just runtime-demo-pkg` first: missing {path}"));
    Arc::new(
        AppState::from_package_bytes(
            &bytes,
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
