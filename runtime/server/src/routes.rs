//! axum handlers. Thin orchestration over the AppState seams.

use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use std::sync::Arc;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub package_id: String,
    pub package_version: u32,
    pub mechanic: String,
}

pub async fn health(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        package_id: state.package.envelope.package_id.clone(),
        package_version: state.package.envelope.package_version,
        mechanic: state.package.envelope.mechanic.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_app;
    use bloom_math::mechanics::slots::{
        to_payload, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
    };
    use bloom_package::{build, Envelope, PackageContent};
    use ed25519_dalek::SigningKey;
    use tower::ServiceExt; // for `oneshot`

    fn test_state() -> Arc<AppState> {
        let model = SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }],
            },
            bonuses: vec![],
        };
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-health".into(),
                package_version: 7,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&model),
            seeds: vec![1, 2, 3],
            presentation: Vec::new(),
        };
        let bytes = build(&content, &SigningKey::from_bytes(&[7u8; 32]));
        Arc::new(
            AppState::from_package_bytes(
                &bytes,
                Box::new(crate::draw::FixedDraw { index: 0 }),
                Box::new(crate::audit::MemoryAuditSink::new()),
            )
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn health_reports_loaded_package() {
        let app = build_app(test_state());
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/health")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["package_id"], "pkg-health");
        assert_eq!(v["package_version"], 7);
    }
}
