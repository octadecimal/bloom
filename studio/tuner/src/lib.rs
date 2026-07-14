//! Bloom layer-3 math tuner: a genetic algorithm behind a swappable `Tuner`
//! seam that adjusts a `SlotModel`'s parameters until it satisfies a
//! `TargetSpec`. AI-designed, never AI-decided — the output is an interpretable
//! model a human reviews and signs. See the design spec.

pub mod config;
pub mod fitness;
pub mod genetic;
pub mod genome;
pub mod outcome;
pub mod report;
pub mod telemetry;
pub mod validate;

pub use genetic::{tune_with_progress, GeneticTuner};
pub use validate::validate;

use bloom_simulator::artifact::MathArtifact;
use bloom_simulator::target::TargetSpec;
use config::TunerConfig;
use outcome::TuneOutcome;

/// The layer-3 seam (math-spec §8). One implementor this slice: `GeneticTuner`.
/// A future hill-climb / CMA-ES / AI-designer is a new `impl Tuner` with no
/// change to callers.
pub trait Tuner {
    fn tune(&self, seed: &MathArtifact, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome;
}
