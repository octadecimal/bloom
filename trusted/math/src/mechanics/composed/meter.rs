//! `meter@1` — counts a symbol on the step's grid into a persistent fill;
//! emits its configured event when full. Fill is instance state and flows
//! across Game States within a round (spec §2 decision 5).

use serde::{Deserialize, Serialize};

use crate::components::Symbol;

use super::mechanic::{InvokeOutcome, Mechanic, MechanicConfig, StepCtx};
use crate::rng::SplitMix64;

fn default_on_full() -> String {
    "meter:full".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeterConfig {
    pub target: u32,
    pub count_symbol: Symbol,
    #[serde(default = "default_on_full")]
    pub on_full: String,
    #[serde(default)]
    pub reset_on_full: bool,
}

pub struct MeterMechanic {
    pub fill: u32,
}

impl Mechanic for MeterMechanic {
    fn invoke(&mut self, _: &str, _: &MechanicConfig, _: &mut StepCtx, _: &mut SplitMix64) -> InvokeOutcome {
        unimplemented!("Task 5")
    }
}
