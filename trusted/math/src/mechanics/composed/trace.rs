//! The lifecycle trace — shared artifact #2 (spec §6). The server emits it
//! in one deterministic pass; the client walks it with animation. Entries
//! are a flat, walkable sequence (resumable-steps seam: a future
//! interactive state ends a partial trace with an await-input entry —
//! nothing in v1 emits one, but nesting is forbidden so that stays possible).

use crate::mechanics::composed::mechanic::TriggerData;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum TraceEntry {
    RoundStart {
        seed: String,
    },
    StateEnter {
        state: String,
    },
    Step {
        n: u32,
    },
    Trigger {
        mechanic: String,
        name: String,
        events: Vec<String>,
        data: TriggerData,
    },
    Transition {
        on: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effect: Option<String>,
    },
    StateExit {
        state: String,
        payout: u64,
    },
    RoundEnd {
        total_payout: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundTrace {
    pub entries: Vec<TraceEntry>,
    pub total_payout: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mechanics::composed::mechanic::TriggerData;
    use serde_json::json;

    #[test]
    fn trace_serializes_to_the_spec_shape_and_round_trips() {
        let trace = RoundTrace {
            entries: vec![
                TraceEntry::RoundStart {
                    seed: u64::MAX.to_string(),
                },
                TraceEntry::StateEnter {
                    state: "base".into(),
                },
                TraceEntry::Step { n: 1 },
                TraceEntry::Trigger {
                    mechanic: "main_reels".into(),
                    name: "spin".into(),
                    events: vec!["scatters:3".into()],
                    data: TriggerData::Reels {
                        grid: vec![vec![9], vec![9], vec![9]],
                        payout: 8,
                    },
                },
                TraceEntry::Transition {
                    on: "scatters:3".into(),
                    to: Some("fs1".into()),
                    effect: None,
                },
                TraceEntry::StateExit {
                    state: "base".into(),
                    payout: 8,
                },
                TraceEntry::RoundEnd { total_payout: 8 },
            ],
            total_payout: 8,
        };
        let v = serde_json::to_value(&trace).unwrap();
        assert_eq!(
            v["entries"][0],
            json!({ "t": "round_start", "seed": "18446744073709551615" })
        );
        assert_eq!(v["entries"][2], json!({ "t": "step", "n": 1 }));
        assert_eq!(
            v["entries"][3]["data"],
            json!({ "kind": "reels", "grid": [[9],[9],[9]], "payout": 8 })
        );
        assert_eq!(
            v["entries"][4],
            json!({ "t": "transition", "on": "scatters:3", "to": "fs1" })
        ); // effect omitted
        let back: RoundTrace = serde_json::from_value(v).unwrap();
        assert_eq!(back, trace);
    }
}
