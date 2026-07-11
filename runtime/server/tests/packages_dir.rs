//! Dir-mode integration: lazy load by id, param required, sanitization,
//! mtime-based reload on handshake, spin cache stability.

use bloom_math::mechanics::composed::{to_payload, GameDefinition};
use bloom_package::{build, Envelope, PackageContent};
use bloom_runtime_server::build_app;
use bloom_runtime_server::state::{AppState, PackageSource};
use ed25519_dalek::SigningKey;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tower::util::ServiceExt;

fn demo_definition() -> GameDefinition {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/demo/composed.definition.json"
    ))
    .expect("read composed.definition.json");
    serde_json::from_str(&json).expect("parse composed.definition.json")
}

fn composed_pkg_bytes(package_id: &str) -> Vec<u8> {
    let def = demo_definition();
    let content = PackageContent {
        envelope: Envelope {
            package_id: package_id.to_string(),
            package_version: 1,
            mechanic: "composed@1".to_string(),
        },
        math_payload: to_payload(&def),
        seeds: (0..500u64).collect(),
        presentation: b"{}".to_vec(),
    };
    build(&content, &SigningKey::from_bytes(&[7u8; 32]))
}

fn dir_state(dir: &std::path::Path) -> Arc<AppState> {
    Arc::new(AppState {
        source: PackageSource::Dir {
            dir: dir.to_path_buf(),
            cache: RwLock::new(HashMap::new()),
        },
        draw: Box::new(bloom_runtime_server::draw::OsRngDraw),
        audit: Box::new(bloom_runtime_server::audit::MemoryAuditSink::new()),
    })
}

fn test_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bloom-pkgdir-{}-{}", std::process::id(), name));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn get(app: axum::Router, uri: &str) -> (axum::http::StatusCode, serde_json::Value) {
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(uri)
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, v)
}

async fn post_spin(app: axum::Router, body: &str) -> (axum::http::StatusCode, serde_json::Value) {
    let resp = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/spin")
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, v)
}

#[tokio::test]
async fn handshake_without_package_param_is_400_in_dir_mode() {
    let dir = test_dir("no-param");
    let (status, _) = get(build_app(dir_state(&dir)), "/handshake").await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unknown_and_traversal_ids_are_404() {
    let dir = test_dir("unknown");
    let (status, _) = get(build_app(dir_state(&dir)), "/handshake?package=nope").await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    let (status, _) = get(build_app(dir_state(&dir)), "/handshake?package=..%2Fdemo").await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn handshake_and_spin_resolve_a_dir_package() {
    let dir = test_dir("resolve");
    std::fs::write(dir.join("g1.pkg"), composed_pkg_bytes("g1")).unwrap();
    let state = dir_state(&dir);

    let (status, v) = get(build_app(state.clone()), "/handshake?package=g1").await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(v["package_id"], "g1");
    assert_eq!(v["mechanic"], "composed@1");
    assert!(v["definition"].is_object());

    let (status, v) = post_spin(build_app(state), r#"{"bet":1,"package":"g1"}"#).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(
        v["trace"].as_array().unwrap().last().unwrap()["t"],
        "round_end"
    );
}

#[tokio::test]
async fn spin_without_package_is_400_in_dir_mode() {
    let dir = test_dir("spin-no-param");
    std::fs::write(dir.join("g1.pkg"), composed_pkg_bytes("g1")).unwrap();
    let (status, _) = post_spin(build_app(dir_state(&dir)), r#"{"bet":1}"#).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn handshake_reloads_when_the_file_is_rebuilt() {
    let dir = test_dir("reload");
    let path = dir.join("g1.pkg");
    std::fs::write(&path, composed_pkg_bytes("g1-v1")).unwrap();
    let state = dir_state(&dir);
    let (_, v) = get(build_app(state.clone()), "/handshake?package=g1").await;
    assert_eq!(v["package_id"], "g1-v1");

    // Rebuild with different content and force a NEWER mtime (fs mtime
    // granularity can otherwise swallow a fast rewrite).
    std::fs::write(&path, composed_pkg_bytes("g1-v2")).unwrap();
    let f = std::fs::File::options().write(true).open(&path).unwrap();
    f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
        .unwrap();

    let (_, v) = get(build_app(state), "/handshake?package=g1").await;
    assert_eq!(v["package_id"], "g1-v2");
}

#[tokio::test]
async fn spin_serves_from_cache_even_if_the_file_churns() {
    let dir = test_dir("cache");
    let path = dir.join("g1.pkg");
    std::fs::write(&path, composed_pkg_bytes("g1")).unwrap();
    let state = dir_state(&dir);
    let (_, _) = get(build_app(state.clone()), "/handshake?package=g1").await;
    std::fs::write(&path, b"garbage").unwrap(); // cached spin must not re-read
    let (status, _) = post_spin(build_app(state), r#"{"package":"g1"}"#).await;
    assert_eq!(status, axum::http::StatusCode::OK);
}
