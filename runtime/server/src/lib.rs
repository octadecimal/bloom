//! `bloom-runtime-server` — the authoritative, zero-AI, audited game server.
//! See docs/superpowers/specs/2026-06-28-runtime-server-spin-service-design.md.

pub mod audit;
pub mod config;
pub mod draw;
pub mod routes;
pub mod state;
pub mod wire;

use axum::http::Method;
use axum::routing::{get, post};
use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

pub fn build_app(state: Arc<state::AppState>) -> Router {
    // Permissive for the demo: the untrusted client is served from a different
    // origin (and, in production, a different host entirely) and must reach the
    // authoritative server directly. A real origin allowlist is a deferred seam
    // (see the SP2 spec §8).
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    Router::new()
        .route("/health", get(routes::health))
        .route("/handshake", get(routes::handshake))
        .route("/spin", post(routes::spin))
        .layer(cors)
        .with_state(state)
}
