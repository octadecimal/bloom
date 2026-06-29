//! Binary entrypoint: load+verify the package, build state, serve.

use bloom_runtime_server::config::ServerConfig;
use bloom_runtime_server::{build_app, state::AppState};
use std::sync::Arc;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    let config = ServerConfig::from_env();
    let state =
        Arc::new(AppState::load(&config).expect("failed to load/verify the game package at boot"));
    let app = build_app(state);
    let listener = TcpListener::bind(config.bind_addr)
        .await
        .expect("failed to bind runtime/server port");
    println!("runtime/server listening on {}", config.bind_addr);
    axum::serve(listener, app).await.expect("server error");
}
