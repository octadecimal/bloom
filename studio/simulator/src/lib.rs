//! Bloom studio simulator: measure a slot model, verify against targets, and
//! freeze a faithful signed seed pool. Approach A — the model defines the
//! characteristics; the pool is a faithful sample (see the design spec).

pub mod seedgen;
pub mod measure;
pub mod target;
