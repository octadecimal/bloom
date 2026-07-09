//! The `slots@1` math-model schema. Serialized into the game package's
//! `math_payload` (postcard); authored as JSON in the studio (serde_json).
//! Integer-only; meaning/art of symbols lives in presentation, never here.

use serde::{Deserialize, Serialize};

pub use crate::components::{Paytable, PaytableEntry, Symbol, SymbolDef, SymbolRole};

/// What triggers (or retriggers) a bonus feature: `min_count` of `symbol`
/// anywhere on the relevant grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerSpec {
    pub symbol: Symbol,
    pub min_count: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreeSpinsConfig {
    /// Free spins granted per (re)trigger.
    pub spins_awarded: u32,
    /// Whether the trigger condition during the feature awards more spins.
    pub retrigger: bool,
    /// Win multiplier applied to each free-spin grid's payout (integer).
    pub multiplier: u64,
    /// Optional separate strips used during the feature; falls back to base.
    pub feature_reels: Option<Vec<Vec<Symbol>>>,
}

/// A bonus feature. ONE variant today (`slots@1`); a second feature type is a
/// new variant + one match arm + a `slots@2` bump — additive, no framework.
/// Each feature carries its OWN trigger (spec §3.1 composition rule).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BonusFeature {
    FreeSpins {
        trigger: TriggerSpec,
        config: FreeSpinsConfig,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotModel {
    pub symbols: Vec<SymbolDef>,
    /// Base-game strips, one per reel. Multiplicity encodes base probability.
    pub reels: Vec<Vec<Symbol>>,
    /// Visible rows in the window.
    pub rows: usize,
    /// Paylines: row index per reel. Each line's length must equal reel count.
    pub paylines: Vec<Vec<usize>>,
    pub paytable: Paytable,
    /// The bonus features (the durable end-state shape). slots@1 composition is
    /// the frozen rule in spec §3.1: independent triggers vs base grid, list
    /// order, summed payouts, no nesting/arbitration.
    pub bonuses: Vec<BonusFeature>,
}

/// Serialize a model into the package `math_payload` (postcard, deterministic).
pub fn to_payload(model: &SlotModel) -> Vec<u8> {
    postcard::to_stdvec(model).expect("SlotModel is always serializable")
}

/// Deserialize a model from a package `math_payload`.
pub fn from_payload(bytes: &[u8]) -> Result<SlotModel, postcard::Error> {
    postcard::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample_model() -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef {
                    id: 0,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 1,
                    role: SymbolRole::Wild,
                },
                SymbolDef {
                    id: 9,
                    role: SymbolRole::Scatter,
                },
            ],
            reels: vec![
                vec![0, 1, 9, 0, 0],
                vec![0, 0, 1, 9, 0],
                vec![9, 0, 1, 0, 0],
            ],
            rows: 3,
            paylines: vec![vec![0, 0, 0], vec![1, 1, 1]],
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
                        payout: 2,
                    },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec {
                    symbol: 9,
                    min_count: 3,
                },
                config: FreeSpinsConfig {
                    spins_awarded: 5,
                    retrigger: true,
                    multiplier: 2,
                    feature_reels: None,
                },
            }],
        }
    }

    #[test]
    fn payload_round_trips() {
        let model = sample_model();
        let bytes = to_payload(&model);
        let back = from_payload(&bytes).expect("round-trips");
        assert_eq!(back, model);
    }

    #[test]
    fn payload_is_deterministic() {
        let model = sample_model();
        assert_eq!(to_payload(&model), to_payload(&model));
    }

    #[test]
    fn empty_bonuses_round_trips() {
        let mut model = sample_model();
        model.bonuses = vec![];
        let back = from_payload(&to_payload(&model)).unwrap();
        assert_eq!(back, model);
    }
}
