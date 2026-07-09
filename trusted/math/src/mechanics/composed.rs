//! Mechanic family #2: composed games (`composed@1`).
//!
//! Doctrine amendment (spec §4, 2026-07-09-composed-games): inside this
//! family, composition IS the framework. Append-only applies per mechanic
//! type version — `reels@1`/`meter@1` are frozen once shipped; a behavior
//! change is a new type version. `slots@1` is untouched.

pub mod compile;
pub mod definition;
pub mod eval;
pub mod mechanic;
pub mod meter;
pub mod reels;
pub mod trace;

pub use compile::{compile, CompiledGame, DefinitionError};
pub use definition::{from_payload, to_payload, GameDefinition, FAMILY};
pub use eval::evaluate;
pub use trace::{RoundTrace, TraceEntry};
