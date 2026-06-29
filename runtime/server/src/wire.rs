//! The server -> client outcome contract (architecture §7): a tagged union keyed
//! by mechanic, one arm today (`slots@1`). `trusted/math`'s `RoundOutcome` stays a
//! pure (non-serde) certified type; we map it here.

use bloom_math::mechanics::slots::{FeatureOutcome, RoundOutcome, Symbol};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeatureWire {
    pub triggered: bool,
    pub spins_played: u32,
    pub payout: u64,
    pub spins: Vec<Vec<Vec<Symbol>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlotsOutcomeWire {
    pub base_grid: Vec<Vec<Symbol>>,
    pub base_payout: u64,
    pub feature_payout: u64,
    pub total_payout: u64,
    pub features: Vec<FeatureWire>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mechanic")]
pub enum OutcomeWire {
    #[serde(rename = "slots@1")]
    Slots(SlotsOutcomeWire),
}

impl OutcomeWire {
    pub fn from_round(o: &RoundOutcome) -> OutcomeWire {
        OutcomeWire::Slots(SlotsOutcomeWire {
            base_grid: o.base_grid.clone(),
            base_payout: o.base_payout,
            feature_payout: o.feature_payout,
            total_payout: o.total_payout,
            features: o.features.iter().map(feature_wire).collect(),
        })
    }
}

fn feature_wire(f: &FeatureOutcome) -> FeatureWire {
    FeatureWire {
        triggered: f.triggered,
        spins_played: f.spins_played,
        payout: f.payout,
        spins: f.spins.clone(),
    }
}

#[derive(Debug, Serialize)]
pub struct SpinResponse {
    #[serde(serialize_with = "serialize_seed_as_string")]
    pub seed: u64,
    pub bet: u64,
    pub outcome: OutcomeWire,
}

/// The seed is a `u64` that can exceed 2^53; a JS client parsing it as a JSON
/// number would silently lose precision, so the client-facing wire encodes it as
/// a string. Internal types (`AuditRecord`) keep the numeric `u64`.
fn serialize_seed_as_string<S>(seed: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&seed.to_string())
}

#[derive(Debug, Serialize)]
pub struct HandshakeResponse {
    pub package_id: String,
    pub package_version: u32,
    pub mechanic: String,
    pub presentation: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{
        evaluate, BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel, SymbolDef,
        SymbolRole, TriggerSpec,
    };

    fn model_with_feature() -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef {
                    id: 0,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 9,
                    role: SymbolRole::Scatter,
                },
            ],
            reels: vec![
                vec![0, 9, 0, 0, 0],
                vec![0, 0, 9, 0, 0],
                vec![9, 0, 0, 9, 0],
            ],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry {
                        symbol: 0,
                        count: 3,
                        payout: 5,
                    },
                    PaytableEntry {
                        symbol: 9,
                        count: 3,
                        payout: 8,
                    },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec {
                    symbol: 9,
                    min_count: 3,
                },
                config: FreeSpinsConfig {
                    spins_awarded: 3,
                    retrigger: false,
                    multiplier: 2,
                    feature_reels: None,
                },
            }],
        }
    }

    #[test]
    fn maps_round_outcome_faithfully() {
        let m = model_with_feature();
        let o = evaluate(&m, 53); // a seed known to trigger in bloom-math goldens
        let wire = OutcomeWire::from_round(&o);
        let OutcomeWire::Slots(s) = &wire;
        assert_eq!(s.base_grid, o.base_grid);
        assert_eq!(s.total_payout, o.total_payout);
        assert_eq!(s.features.len(), o.features.len());
    }

    #[test]
    fn serializes_with_mechanic_tag_and_round_trips() {
        let m = model_with_feature();
        let wire = OutcomeWire::from_round(&evaluate(&m, 53));
        let json = serde_json::to_value(&wire).unwrap();
        assert_eq!(json["mechanic"], "slots@1");
        let back: OutcomeWire = serde_json::from_value(json).unwrap();
        assert_eq!(back, wire);
    }

    #[test]
    fn spin_response_serializes_seed_as_a_string() {
        let outcome = OutcomeWire::from_round(&evaluate(&model_with_feature(), 53));
        // 2^53 + 1 — the smallest u64 that a JS number cannot represent exactly.
        let resp = SpinResponse {
            seed: 9_007_199_254_740_993,
            bet: 1,
            outcome,
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert!(json["seed"].is_string(), "seed must serialize as a string");
        assert_eq!(
            json["seed"],
            serde_json::Value::String("9007199254740993".into())
        );
        assert_eq!(json["bet"], 1);
    }
}
