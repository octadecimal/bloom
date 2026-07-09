//! `reels@1` — strips → grid → payline/scatter payout, plus configurable
//! grid events (e.g. 3+ scatters → "scatters:3").

use serde::{Deserialize, Serialize};

use crate::components::{Paytable, Symbol, SymbolDef};

use super::mechanic::{InvokeOutcome, Mechanic, MechanicConfig, StepCtx};
use crate::rng::SplitMix64;

fn default_multiplier() -> u64 {
    1
}

/// Emit `emit` when `symbol` appears at least `min_count` times on the grid.
/// Event names are definition-authored — the transition table matches them
/// by exact string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GridEvent {
    pub symbol: Symbol,
    pub min_count: u8,
    pub emit: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReelsConfig {
    pub strips: Vec<Vec<Symbol>>,
    pub rows: usize,
    pub symbols: Vec<SymbolDef>,
    pub paylines: Vec<Vec<usize>>,
    pub paytable: Paytable,
    /// Win multiplier (integer, ≥1). Free-spins states override this.
    #[serde(default = "default_multiplier")]
    pub multiplier: u64,
    #[serde(default)]
    pub events: Vec<GridEvent>,
}

pub struct ReelsMechanic;

impl Mechanic for ReelsMechanic {
    fn invoke(
        &mut self,
        _: &str,
        _: &MechanicConfig,
        _: &mut StepCtx,
        _: &mut SplitMix64,
    ) -> InvokeOutcome {
        unimplemented!("Task 4")
    }
}
