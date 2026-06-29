//! `bloom-runtime-server` — the authoritative, zero-AI, audited game server.
//! See docs/superpowers/specs/2026-06-28-runtime-server-spin-service-design.md.

pub mod config;
pub mod routes;
pub mod state;

use axum::routing::get;
use axum::Router;
use std::sync::Arc;

pub fn build_app(state: Arc<state::AppState>) -> Router {
    Router::new()
        .route("/health", get(routes::health))
        .with_state(state)
}
