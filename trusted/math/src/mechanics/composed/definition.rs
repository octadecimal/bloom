//! The `composed@1` Game Definition — shared artifact #1 (spec §3).
//! Pure serde wire shapes; all validation/semantics live in `compile`.
//! Payload is JSON, not postcard: per-mechanic configs travel as
//! `serde_json::Value`, which postcard (non-self-describing) cannot decode.
//! serde_json maps are BTreeMaps → sorted keys → deterministic bytes.

use serde::{Deserialize, Serialize};

pub const FAMILY: &str = "composed@1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameDefinition {
    pub family: String,
    pub mechanics: Vec<MechanicDecl>,
    pub states: Vec<StateDef>,
    pub start: String,
    pub transitions: Vec<TransitionRow>,
    pub caps: Caps,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MechanicDecl {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateDef {
    pub id: String,
    pub bindings: Vec<Binding>,
    pub steps: StepsSpec,
    pub script: Vec<ScriptEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub mechanic: String,
    #[serde(rename = "override", default, skip_serializing_if = "Option::is_none")]
    pub config_override: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepsSpec {
    pub budget: BudgetSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial: Option<u32>,
}

/// `"budget": 1` or `"budget": "awarded"` — resolved/validated in compile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BudgetSpec {
    Fixed(u32),
    Keyword(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptEntry {
    pub invoke: String, // "<instance_id>.<trigger>"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionRow {
    pub from: String,
    pub on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caps {
    pub max_steps: u32,
}

/// Serialize a definition into the package `math_payload` (JSON, deterministic).
pub fn to_payload(def: &GameDefinition) -> Vec<u8> {
    serde_json::to_vec(def).expect("GameDefinition is always serializable")
}

/// Deserialize a definition from a package `math_payload`.
pub fn from_payload(bytes: &[u8]) -> Result<GameDefinition, serde_json::Error> {
    serde_json::from_slice(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub fn sample_def_json() -> serde_json::Value {
        json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "main_reels", "type": "reels@1",
                  "config": { "strips": [[0,1,9,0,0],[0,0,9,1,0],[9,0,1,0,0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"},{"id":1,"role":"wild"},{"id":9,"role":"scatter"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [{"symbol":0,"count":3,"payout":5},{"symbol":9,"count":3,"payout":8}] },
                              "events": [{"symbol":9,"min_count":3,"emit":"scatters:3"}] } },
                { "id": "bonus_meter", "type": "meter@1",
                  "config": { "target": 4, "count_symbol": 9 } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [ { "mechanic": "main_reels" }, { "mechanic": "bonus_meter" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" } ] },
                { "id": "fs1",
                  "bindings": [ { "mechanic": "main_reels", "override": { "multiplier": 2 } },
                                { "mechanic": "bonus_meter" } ],
                  "steps": { "budget": "awarded", "initial": 3 },
                  "script": [ { "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" } ] }
            ],
            "start": "base",
            "transitions": [
                { "from": "base", "on": "scatters:3", "to": "fs1" },
                { "from": "fs1", "on": "scatters:3", "effect": "steps:add:2" }
            ],
            "caps": { "max_steps": 50 }
        })
    }

    #[test]
    fn definition_json_round_trips() {
        let def: GameDefinition = serde_json::from_value(sample_def_json()).expect("parses");
        assert_eq!(def.family, FAMILY);
        assert_eq!(def.mechanics.len(), 2);
        assert_eq!(def.mechanics[0].kind, "reels@1");
        assert_eq!(def.states[1].steps.budget, BudgetSpec::Keyword("awarded".into()));
        assert_eq!(def.states[1].steps.initial, Some(3));
        assert_eq!(def.transitions[1].effect.as_deref(), Some("steps:add:2"));
        assert_eq!(def.transitions[1].to, None);
        let back: GameDefinition =
            serde_json::from_value(serde_json::to_value(&def).unwrap()).unwrap();
        assert_eq!(back, def);
    }

    #[test]
    fn payload_round_trips_and_is_deterministic() {
        let def: GameDefinition = serde_json::from_value(sample_def_json()).unwrap();
        let bytes = to_payload(&def);
        assert_eq!(bytes, to_payload(&def));
        let back = from_payload(&bytes).expect("round-trips");
        assert_eq!(back, def);
    }
}
