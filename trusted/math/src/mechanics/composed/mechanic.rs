//! The Mechanic contract: named triggers invoked by a Game State's step
//! script. The client module system mirrors this trigger vocabulary
//! (spec §2 decision 8, §7).

use crate::components::Symbol;
use crate::rng::SplitMix64;
use serde::{Deserialize, Serialize};

use super::meter::{MeterConfig, MeterMechanic};
use super::reels::{ReelsConfig, ReelsMechanic};

pub type Event = String;

/// Shared per-step context. Mechanics read what earlier triggers in the same
/// step produced (e.g. the meter counts symbols on the reels' grid).
#[derive(Debug, Default)]
pub struct StepCtx {
    pub grid: Option<Vec<Vec<Symbol>>>,
    pub events: Vec<Event>,
    pub payout: u64,
}

impl StepCtx {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Presentation-facing result data carried in the trace (spec §6): what the
/// client needs to animate this trigger — never re-computed client-side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TriggerData {
    Reels { grid: Vec<Vec<Symbol>>, payout: u64 },
    Meter { fill: u32, target: u32 },
}

#[derive(Debug)]
pub struct InvokeOutcome {
    pub events: Vec<Event>,
    pub data: TriggerData,
}

/// Contract: an implementation appends its emitted events to `ctx.events`
/// AND returns them in the outcome (the evaluator records them in the
/// trace). All randomness comes from `rng`; all instance state lives in
/// `self` (round-scoped: instances are created fresh per `evaluate`).
pub trait Mechanic {
    fn invoke(
        &mut self,
        trigger: &str,
        config: &MechanicConfig,
        ctx: &mut StepCtx,
        rng: &mut SplitMix64,
    ) -> InvokeOutcome;
}

/// Effective (post-override) config for one binding, typed per mechanic.
#[derive(Debug, Clone, PartialEq)]
pub enum MechanicConfig {
    Reels(ReelsConfig),
    Meter(MeterConfig),
}

/// The mechanic-type catalog: `type@version` → kind. Closed set; adding a
/// type (or version) is a new variant + match arms — append-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MechanicKind {
    Reels,
    Meter,
}

impl MechanicKind {
    pub fn parse(type_str: &str) -> Option<MechanicKind> {
        match type_str {
            "reels@1" => Some(MechanicKind::Reels),
            "meter@1" => Some(MechanicKind::Meter),
            _ => None,
        }
    }

    pub fn triggers(self) -> &'static [&'static str] {
        match self {
            MechanicKind::Reels => &["spin"],
            MechanicKind::Meter => &["accumulate"],
        }
    }

    pub fn instantiate(self) -> Box<dyn Mechanic> {
        match self {
            MechanicKind::Reels => Box::new(ReelsMechanic),
            MechanicKind::Meter => Box::new(MeterMechanic { fill: 0 }),
        }
    }

    pub fn parse_config(self, json: &serde_json::Value) -> Result<MechanicConfig, String> {
        match self {
            MechanicKind::Reels => serde_json::from_value::<ReelsConfig>(json.clone())
                .map(MechanicConfig::Reels)
                .map_err(|e| e.to_string()),
            MechanicKind::Meter => serde_json::from_value::<MeterConfig>(json.clone())
                .map(MechanicConfig::Meter)
                .map_err(|e| e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kind_parses_type_strings() {
        assert_eq!(MechanicKind::parse("reels@1"), Some(MechanicKind::Reels));
        assert_eq!(MechanicKind::parse("meter@1"), Some(MechanicKind::Meter));
        assert_eq!(MechanicKind::parse("tower@1"), None);
        assert_eq!(MechanicKind::parse("reels@2"), None); // append-only: future version
    }

    #[test]
    fn kind_declares_triggers() {
        assert_eq!(MechanicKind::Reels.triggers(), ["spin"]);
        assert_eq!(MechanicKind::Meter.triggers(), ["accumulate"]);
    }

    #[test]
    fn parse_config_applies_serde_defaults() {
        let cfg = MechanicKind::Meter
            .parse_config(&json!({ "target": 4, "count_symbol": 9 }))
            .expect("valid meter config");
        match cfg {
            MechanicConfig::Meter(m) => {
                assert_eq!(m.on_full, "meter:full");
                assert!(!m.reset_on_full);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_config_rejects_bad_shape() {
        assert!(MechanicKind::Reels
            .parse_config(&json!({ "rows": 1 }))
            .is_err());
    }

    #[test]
    fn trigger_data_serializes_tagged() {
        let d = TriggerData::Meter { fill: 3, target: 4 };
        assert_eq!(
            serde_json::to_value(&d).unwrap(),
            json!({ "kind": "meter", "fill": 3, "target": 4 })
        );
    }
}
