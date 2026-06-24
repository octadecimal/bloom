//! Mechanic #1: slots (`slots@1`). Expands one seed into one round's symbolic
//! outcome and its payout. Integer-only and deterministic — see `trusted/AGENTS.md`.

mod eval;
mod model;

pub use model::{
    from_payload, to_payload, BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel,
    Symbol, SymbolDef, SymbolRole, TriggerSpec,
};
