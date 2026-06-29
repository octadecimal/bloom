//! axum handlers. Thin orchestration over the AppState seams.

use crate::state::AppState;
use crate::wire::{HandshakeResponse, OutcomeWire, SpinResponse};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use bloom_math::mechanics::slots::evaluate;
use serde::{Deserialize, Serialize};
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

/// Hand the untrusted client the package presentation (parsed as JSON; null if
/// empty or non-JSON) plus the envelope. SP1 demo packages carry a small JSON
/// manifest. Consuming this is SP2.
pub async fn handshake(State(state): State<Arc<AppState>>) -> Json<HandshakeResponse> {
    let presentation =
        serde_json::from_slice(&state.package.presentation).unwrap_or(serde_json::Value::Null);
    Json(HandshakeResponse {
        package_id: state.package.envelope.package_id.clone(),
        package_version: state.package.envelope.package_version,
        mechanic: state.package.envelope.mechanic.clone(),
        presentation,
    })
}

fn default_bet() -> u64 {
    1
}

#[derive(Deserialize)]
pub struct SpinRequest {
    #[serde(default = "default_bet")]
    pub bet: u64,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The authoritative round: draw an index, expand the seed, audit, respond.
/// A round that cannot be audited is NOT served (500) — every served round is
/// recorded (architecture §9).
pub async fn spin(
    State(state): State<Arc<AppState>>,
    body: Option<Json<SpinRequest>>,
) -> Result<Json<SpinResponse>, StatusCode> {
    let bet = body.map(|Json(b)| b.bet).unwrap_or(1);

    let idx = state.draw.index(state.package.seeds.len());
    let seed = state.package.seeds[idx];
    let outcome = OutcomeWire::from_round(&evaluate(&state.model, seed));

    let record = crate::audit::AuditRecord {
        package_id: state.package.envelope.package_id.clone(),
        package_version: state.package.envelope.package_version,
        mechanic: state.package.envelope.mechanic.clone(),
        math_engine_version: bloom_math::ENGINE_VERSION.to_string(),
        seed,
        bet,
        timestamp_ms: now_ms(),
        outcome: outcome.clone(),
    };
    state
        .audit
        .append(&record)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SpinResponse { seed, bet, outcome }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audit::MemoryAuditSink;
    use crate::build_app;
    use crate::draw::FixedDraw;
    use crate::wire::OutcomeWire;
    use bloom_math::mechanics::slots::{
        evaluate, to_payload, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
    };
    use bloom_package::{build, Envelope, PackageContent};
    use ed25519_dalek::SigningKey;
    use std::sync::Arc;
    use tower::ServiceExt; // for `oneshot`

    fn test_state() -> Arc<AppState> {
        let model = SlotModel {
            symbols: vec![SymbolDef {
                id: 0,
                role: SymbolRole::Normal,
            }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry {
                    symbol: 0,
                    count: 3,
                    payout: 2,
                }],
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

    /// Build state whose pool has 5 distinct seeds, a FixedDraw at `idx`, and a
    /// shared MemoryAuditSink returned alongside so the test can read records.
    fn spin_state(idx: usize) -> (Arc<AppState>, Arc<MemoryAuditSink>) {
        let model = SlotModel {
            symbols: vec![SymbolDef {
                id: 0,
                role: SymbolRole::Normal,
            }],
            reels: vec![
                vec![0, 0, 0, 0, 1],
                vec![0, 0, 1, 0, 0],
                vec![1, 0, 0, 0, 0],
            ],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry {
                    symbol: 0,
                    count: 3,
                    payout: 2,
                }],
            },
            bonuses: vec![],
        };
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-spin".into(),
                package_version: 1,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&model),
            seeds: vec![11, 22, 33, 44, 55],
            presentation: Vec::new(),
        };
        let bytes = build(&content, &SigningKey::from_bytes(&[7u8; 32]));
        let audit = Arc::new(MemoryAuditSink::new());
        // AppState needs to OWN its audit sink, but the test also needs a handle.
        // Use a thin forwarding sink that shares the Arc.
        struct Shared(Arc<MemoryAuditSink>);
        impl crate::audit::AuditSink for Shared {
            fn append(&self, rec: &crate::audit::AuditRecord) -> std::io::Result<()> {
                self.0.append(rec)
            }
        }
        let state = AppState::from_package_bytes(
            &bytes,
            Box::new(FixedDraw { index: idx }),
            Box::new(Shared(audit.clone())),
        )
        .unwrap();
        (Arc::new(state), audit)
    }

    fn state_with_presentation(presentation: &[u8]) -> Arc<AppState> {
        let model = SlotModel {
            symbols: vec![SymbolDef {
                id: 0,
                role: SymbolRole::Normal,
            }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry {
                    symbol: 0,
                    count: 3,
                    payout: 2,
                }],
            },
            bonuses: vec![],
        };
        let content = PackageContent {
            envelope: Envelope {
                package_id: "pkg-hs".into(),
                package_version: 2,
                mechanic: "slots@1".into(),
            },
            math_payload: to_payload(&model),
            seeds: vec![1, 2, 3],
            presentation: presentation.to_vec(),
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

    async fn get_json(app: axum::Router, uri: &str) -> (axum::http::StatusCode, serde_json::Value) {
        let resp = app
            .oneshot(
                axum::http::Request::builder()
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
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    async fn post_spin(
        app: axum::Router,
        body: &str,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let req = axum::http::Request::builder()
            .method("POST")
            .uri("/spin")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, v)
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
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["package_id"], "pkg-health");
        assert_eq!(v["package_version"], 7);
    }

    #[tokio::test]
    async fn spin_returns_authoritative_reproducible_outcome() {
        let (state, _audit) = spin_state(2); // draws seeds[2] == 33
        let model = state.model.clone();
        let app = build_app(state);
        let (status, v) = post_spin(app, "{}").await;
        assert_eq!(status, 200);
        assert_eq!(v["seed"], 33);
        // The served outcome must equal re-evaluating the returned seed.
        let expected =
            serde_json::to_value(OutcomeWire::from_round(&evaluate(&model, 33))).unwrap();
        assert_eq!(v["outcome"], expected);
    }

    #[tokio::test]
    async fn spin_appends_one_audit_record_that_reproduces() {
        let (state, audit) = spin_state(0); // seeds[0] == 11
        let model = state.model.clone();
        let app = build_app(state);
        let (status, _v) = post_spin(app, "{}").await;
        assert_eq!(status, 200);
        let recs = audit.records();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].seed, 11);
        assert_eq!(recs[0].bet, 1);
        // Re-expand the recorded seed; the audit outcome must match (reproducible).
        assert_eq!(
            recs[0].outcome,
            OutcomeWire::from_round(&evaluate(&model, 11))
        );
    }

    #[tokio::test]
    async fn spin_defaults_bet_to_one_and_honors_supplied_bet() {
        let (state_a, audit_a) = spin_state(0);
        let app_a = build_app(state_a);
        let (s_a, _) = post_spin(app_a, "").await; // empty body -> bet 1
        assert_eq!(s_a, 200);
        assert_eq!(audit_a.records()[0].bet, 1);

        let (state_b, audit_b) = spin_state(0);
        let app_b = build_app(state_b);
        let (s_b, v_b) = post_spin(app_b, "{\"bet\":5}").await;
        assert_eq!(s_b, 200);
        assert_eq!(v_b["bet"], 5);
        assert_eq!(audit_b.records()[0].bet, 5);
    }

    #[tokio::test]
    async fn handshake_returns_envelope_and_parsed_presentation() {
        let manifest = br#"{"cols":3,"rows":3,"symbols":["0","1","2","9"]}"#;
        let app = build_app(state_with_presentation(manifest));
        let (status, v) = get_json(app, "/handshake").await;
        assert_eq!(status, 200);
        assert_eq!(v["package_id"], "pkg-hs");
        assert_eq!(v["package_version"], 2);
        assert_eq!(v["mechanic"], "slots@1");
        assert_eq!(v["presentation"]["cols"], 3);
        assert_eq!(v["presentation"]["symbols"][3], "9");
    }

    #[tokio::test]
    async fn handshake_empty_presentation_is_null() {
        let app = build_app(state_with_presentation(b""));
        let (status, v) = get_json(app, "/handshake").await;
        assert_eq!(status, 200);
        assert_eq!(v["presentation"], serde_json::Value::Null);
    }
}
