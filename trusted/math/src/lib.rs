//! The Bloom math engine: deterministic, integer-only seed expansion.
//! See `trusted/AGENTS.md` — determinism here is sacred.

pub mod mechanics;
pub mod rng;

/// The math-engine crate version, recorded in each runtime audit record so a
/// round names the exact engine that expanded its seed (architecture §9).
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
