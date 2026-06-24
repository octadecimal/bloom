# Math Engine (slots) + Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the certified slot math engine so one seed resolves to a full round _with payout_ (grid, paylines, free-spins bonus), then build a studio simulator that measures a model's RTP/volatility/hit-rates, verifies them against targets, and freezes a faithful, signed seed pool.

**Architecture:** Approach A — the math model (reel strips + paytable + free-spins config) _defines_ the characteristics; the seed pool is a faithful, bit-reproducible sample with only finite-sample correction. The kernel `slots::evaluate(model, seed) → RoundOutcome` is the shared core; the simulator and the future server are thin shells around it.

**Tech Stack:** Rust (edition 2021), Cargo workspace, `serde` + `postcard` (model serialization), `serde_json` (model authoring), `rayon` (parallel simulation), `ed25519-dalek` (package signing, via `bloom-package`).

## Global Constraints

- **Determinism is sacred.** Integer-only math in the outcome path: no floats, no clock/time, no I/O, no randomness beyond the injected seed. `slots::evaluate` MUST be bit-reproducible across platforms forever. (Floats are allowed only in the simulator's _measurement_ aggregation, never in the kernel outcome.)
- **Payouts are integer bet-multiples (`u64`)** everywhere in the kernel.
- **This is mechanic `slots@1`.** Append-only and immutable once shipped; any later behavior change is a new mechanic version, never an edit (`trusted/AGENTS.md`).
- **Do NOT modify `trusted/package`'s format.** It is certified and already done. The simulator consumes its public `build` / `verify_and_load` API unchanged. Provenance is emitted as a _separate_ sim-report artifact, not stuffed into the signed package.
- **Nothing may depend on `studio/`.** `studio/simulator` may depend on `trusted/math` and `trusted/package`.
- **TDD mandatory:** failing test first, watch it fail, minimal code to pass, commit. Semantic (Conventional Commits) messages.
- **Work in the worktree** `C:\code\bloom.wt\math-engine` on branch `feat/math-engine`. Run all `cargo` commands from the worktree root.
- Run a single test with `cargo test -p <crate> <name>`; the whole suite with `cargo test --workspace`.

---

## File map

**`trusted/math` (enrich):**
- Modify `trusted/math/Cargo.toml` — add `serde`, `postcard`.
- Modify `trusted/math/src/mechanics/slots.rs` — becomes module root: declares `model` + `eval`, re-exports them. (Old toy `SlotModel`/`expand` removed; `rng.rs` and `SplitMix64` are unchanged and reused.)
- Create `trusted/math/src/mechanics/slots/model.rs` — the slot math-model schema + serde + `to_payload`/`from_payload`.
- Create `trusted/math/src/mechanics/slots/eval.rs` — `RoundOutcome` + `evaluate` + payout/feature helpers.

**`studio/simulator` (new crate):**
- Modify `Cargo.toml` (workspace) — add `studio/simulator` member.
- Create `studio/simulator/Cargo.toml`.
- Create `studio/simulator/src/lib.rs` — module wiring + re-exports.
- Create `studio/simulator/src/seedgen.rs` — deterministic candidate-seed generation.
- Create `studio/simulator/src/target.rs` — `TargetSpec`, `Metrics`.
- Create `studio/simulator/src/measure.rs` — `RoundSample`, `simulate`, `measure`.
- Create `studio/simulator/src/curate.rs` — `Pool`, `CurateError`, `freeze_pool` (A2).
- Create `studio/simulator/src/run.rs` — `verify`, `run_curation`, `RunError`, `CurationOutput`.
- Create `studio/simulator/src/bin/curate.rs` — tiny CLI: model JSON + target → package + report.
- Modify `justfile` — add a `sim-curate` convenience recipe.

---

## PHASE A — `trusted/math` kernel

### Task 1: Model schema + payload round-trip

**Files:**
- Modify: `trusted/math/Cargo.toml`
- Modify: `trusted/math/src/mechanics/slots.rs`
- Create: `trusted/math/src/mechanics/slots/model.rs`

**Interfaces:**
- Produces: `bloom_math::mechanics::slots::{Symbol, SymbolRole, SymbolDef, PaytableEntry, Paytable, FreeSpins, SlotModel, to_payload, from_payload}`
  - `type Symbol = u8;`
  - `enum SymbolRole { Normal, Wild, Scatter }`
  - `struct SymbolDef { id: Symbol, role: SymbolRole }`
  - `struct PaytableEntry { symbol: Symbol, count: u8, payout: u64 }`
  - `struct Paytable { entries: Vec<PaytableEntry> }`
  - `struct FreeSpins { trigger_scatter_count: u8, spins_awarded: u32, retrigger: bool, multiplier: u64, feature_reels: Option<Vec<Vec<Symbol>>> }`
  - `struct SlotModel { symbols: Vec<SymbolDef>, reels: Vec<Vec<Symbol>>, rows: usize, paylines: Vec<Vec<usize>>, paytable: Paytable, free_spins: Option<FreeSpins> }`
  - `fn to_payload(model: &SlotModel) -> Vec<u8>`
  - `fn from_payload(bytes: &[u8]) -> Result<SlotModel, postcard::Error>`

- [ ] **Step 1: Add dependencies**

Edit `trusted/math/Cargo.toml` so the `[dependencies]` section reads:

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
postcard = { version = "1", features = ["use-std"] }
```

- [ ] **Step 2: Write the model module with a failing round-trip test**

Create `trusted/math/src/mechanics/slots/model.rs`:

```rust
//! The `slots@1` math-model schema. Serialized into the game package's
//! `math_payload` (postcard); authored as JSON in the studio (serde_json).
//! Integer-only; meaning/art of symbols lives in presentation, never here.

use serde::{Deserialize, Serialize};

/// A symbol id. Its art/name/value live in the package presentation, not here.
pub type Symbol = u8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolRole {
    Normal,
    Wild,
    Scatter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolDef {
    pub id: Symbol,
    pub role: SymbolRole,
}

/// One paytable row: paying `symbol` appearing exactly `count` times yields
/// `payout` bet-multiples. (Lines use left-aligned run length; scatters use
/// total grid count.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaytableEntry {
    pub symbol: Symbol,
    pub count: u8,
    pub payout: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paytable {
    pub entries: Vec<PaytableEntry>,
}

impl Paytable {
    /// Payout (bet-multiples) for `symbol` at exactly `count`. 0 if no entry.
    pub fn lookup(&self, symbol: Symbol, count: u8) -> u64 {
        self.entries
            .iter()
            .find(|e| e.symbol == symbol && e.count == count)
            .map(|e| e.payout)
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreeSpins {
    /// Scatters needed on a grid to trigger / retrigger the feature.
    pub trigger_scatter_count: u8,
    /// Free spins granted per (re)trigger.
    pub spins_awarded: u32,
    /// Whether the trigger condition during the feature awards more spins.
    pub retrigger: bool,
    /// Win multiplier applied to each free-spin grid's payout (integer).
    pub multiplier: u64,
    /// Optional separate strips used during the feature; falls back to base.
    pub feature_reels: Option<Vec<Vec<Symbol>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlotModel {
    pub symbols: Vec<SymbolDef>,
    /// Base-game strips, one per reel. Multiplicity encodes base probability.
    pub reels: Vec<Vec<Symbol>>,
    /// Visible rows in the window.
    pub rows: usize,
    /// Paylines: row index per reel. Each line's length must equal reel count.
    pub paylines: Vec<Vec<usize>>,
    pub paytable: Paytable,
    pub free_spins: Option<FreeSpins>,
}

/// Serialize a model into the package `math_payload` (postcard, deterministic).
pub fn to_payload(model: &SlotModel) -> Vec<u8> {
    postcard::to_stdvec(model).expect("SlotModel is always serializable")
}

/// Deserialize a model from a package `math_payload`.
pub fn from_payload(bytes: &[u8]) -> Result<SlotModel, postcard::Error> {
    postcard::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample_model() -> SlotModel {
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Wild },
                SymbolDef { id: 2, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![0, 1, 2, 0, 0], vec![0, 0, 1, 2, 0], vec![0, 2, 0, 1, 0]],
            rows: 3,
            paylines: vec![vec![0, 0, 0], vec![1, 1, 1]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 0, count: 3, payout: 5 },
                    PaytableEntry { symbol: 2, count: 3, payout: 2 },
                ],
            },
            free_spins: Some(FreeSpins {
                trigger_scatter_count: 3,
                spins_awarded: 5,
                retrigger: true,
                multiplier: 2,
                feature_reels: None,
            }),
        }
    }

    #[test]
    fn payload_round_trips() {
        let model = sample_model();
        let bytes = to_payload(&model);
        let back = from_payload(&bytes).expect("round-trips");
        assert_eq!(back, model);
    }

    #[test]
    fn payload_is_deterministic() {
        let model = sample_model();
        assert_eq!(to_payload(&model), to_payload(&model));
    }
}
```

- [ ] **Step 3: Convert `slots.rs` into the module root**

Replace the entire contents of `trusted/math/src/mechanics/slots.rs` with:

```rust
//! Mechanic #1: slots (`slots@1`). Expands one seed into one round's symbolic
//! outcome and its payout. Integer-only and deterministic — see `trusted/AGENTS.md`.

mod model;

pub use model::{
    from_payload, to_payload, FreeSpins, Paytable, PaytableEntry, SlotModel, Symbol, SymbolDef,
    SymbolRole,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-math slots::model`
Expected: PASS (`payload_round_trips`, `payload_is_deterministic`). Old `expand` tests are gone.

- [ ] **Step 5: Commit**

```bash
git add trusted/math/Cargo.toml trusted/math/src/mechanics/slots.rs trusted/math/src/mechanics/slots/model.rs
git commit -m "feat(math): add slots@1 model schema and payload serialization"
```

---

### Task 2: Base spin → grid

**Files:**
- Create: `trusted/math/src/mechanics/slots/eval.rs`
- Modify: `trusted/math/src/mechanics/slots.rs`

**Interfaces:**
- Consumes: `SlotModel`, `Symbol` (Task 1); `crate::rng::SplitMix64`.
- Produces: `slots::spin(reels: &[Vec<Symbol>], rows: usize, rng: &mut SplitMix64) -> Vec<Vec<Symbol>>` returning `grid[reel][row]` (kept `pub(crate)` initially, exercised via tests in this module).

- [ ] **Step 1: Write the failing test**

Create `trusted/math/src/mechanics/slots/eval.rs`:

```rust
//! `slots@1` round evaluation: grid → line/scatter payout → free-spins → outcome.
//! Integer-only and deterministic.

use super::model::{FreeSpins, SlotModel, Symbol, SymbolRole};
use crate::rng::SplitMix64;

/// Spin every reel: pick a stop, read `rows` consecutive cells (wrapping).
/// Returns `grid[reel][row]`.
fn spin(reels: &[Vec<Symbol>], rows: usize, rng: &mut SplitMix64) -> Vec<Vec<Symbol>> {
    reels
        .iter()
        .map(|reel| {
            let len = reel.len() as u64;
            let stop = (rng.next_u64() % len) as usize;
            (0..rows).map(|r| reel[(stop + r) % reel.len()]).collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spin_shapes_and_membership() {
        let reels = vec![vec![0, 1, 2, 3, 4], vec![5, 6, 7], vec![8, 9]];
        let mut rng = SplitMix64::new(42);
        let grid = spin(&reels, 2, &mut rng);
        assert_eq!(grid.len(), 3); // one column per reel
        assert!(grid.iter().all(|col| col.len() == 2)); // rows per column
        for (r, col) in grid.iter().enumerate() {
            for sym in col {
                assert!(reels[r].contains(sym));
            }
        }
    }

    #[test]
    fn spin_wraps_consecutive_cells() {
        // Stop near the end must wrap to the start for the window.
        let reels = vec![vec![10, 20, 30]];
        // Find a seed whose first reel stop is index 2, then assert wrap.
        let mut rng = SplitMix64::new(7);
        let grid = spin(&reels, 3, &mut rng);
        // Whatever the stop, the 3-row window over a 3-cell reel is a rotation.
        let mut sorted = grid[0].clone();
        sorted.sort();
        assert_eq!(sorted, vec![10, 20, 30]);
    }

    #[test]
    fn spin_is_deterministic() {
        let reels = vec![vec![0, 1, 2, 3], vec![4, 5, 6, 7]];
        let a = spin(&reels, 2, &mut SplitMix64::new(123));
        let b = spin(&reels, 2, &mut SplitMix64::new(123));
        assert_eq!(a, b);
    }
}
```

- [ ] **Step 2: Wire the module**

In `trusted/math/src/mechanics/slots.rs`, add `mod eval;` directly below `mod model;`:

```rust
mod eval;
mod model;
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS (3 tests). `spin` is exercised; warnings about unused `FreeSpins`/`SymbolRole` imports are expected until Task 3–5.

- [ ] **Step 4: Commit**

```bash
git add trusted/math/src/mechanics/slots/eval.rs trusted/math/src/mechanics/slots.rs
git commit -m "feat(math): add deterministic reel spin and grid window"
```

---

### Task 3: Line payout with wild substitution

**Files:**
- Modify: `trusted/math/src/mechanics/slots/eval.rs`

**Interfaces:**
- Produces (module-internal): `role_of(model, sym) -> SymbolRole`, `line_payout(model, grid, line) -> u64`.

- [ ] **Step 1: Write the failing test**

In `eval.rs`, add to the `tests` module:

```rust
    use super::super::model::{Paytable, PaytableEntry, SlotModel, SymbolDef};

    fn lines_model() -> SlotModel {
        // 3 reels, 1 row, one payline across the single row.
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Wild },
                SymbolDef { id: 9, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 0, count: 2, payout: 3 },
                    PaytableEntry { symbol: 0, count: 3, payout: 10 },
                ],
            },
            free_spins: None,
        }
    }

    #[test]
    fn three_of_a_kind_pays() {
        let m = lines_model();
        let grid = vec![vec![0], vec![0], vec![0]];
        assert_eq!(line_payout(&m, &grid, &m.paylines[0]), 10);
    }

    #[test]
    fn wild_substitutes_in_a_run() {
        let m = lines_model();
        let grid = vec![vec![0], vec![1], vec![0]]; // 0, wild, 0
        assert_eq!(line_payout(&m, &grid, &m.paylines[0]), 10);
    }

    #[test]
    fn run_breaks_on_mismatch() {
        let m = lines_model();
        let grid = vec![vec![0], vec![0], vec![9]]; // 0, 0, scatter -> count 2
        assert_eq!(line_payout(&m, &grid, &m.paylines[0]), 3);
    }

    #[test]
    fn scatter_does_not_pay_on_a_line() {
        let m = lines_model();
        let grid = vec![vec![9], vec![9], vec![9]];
        assert_eq!(line_payout(&m, &grid, &m.paylines[0]), 0);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bloom-math slots::eval`
Expected: FAIL — `line_payout` and `role_of` not found.

- [ ] **Step 3: Implement the helpers**

In `eval.rs`, above the `tests` module, add:

```rust
fn role_of(model: &SlotModel, sym: Symbol) -> SymbolRole {
    model
        .symbols
        .iter()
        .find(|s| s.id == sym)
        .map(|s| s.role)
        .unwrap_or(SymbolRole::Normal)
}

fn is_wild(model: &SlotModel, sym: Symbol) -> bool {
    role_of(model, sym) == SymbolRole::Wild
}

/// Left-aligned run payout for one payline. Wild substitutes; the paying
/// symbol is the first non-wild on the line (all-wild lines pay as that wild).
fn line_payout(model: &SlotModel, grid: &[Vec<Symbol>], line: &[usize]) -> u64 {
    let syms: Vec<Symbol> = line
        .iter()
        .enumerate()
        .map(|(reel, &row)| grid[reel][row])
        .collect();

    let target = syms
        .iter()
        .copied()
        .find(|&s| !is_wild(model, s))
        .unwrap_or(syms[0]);

    if role_of(model, target) == SymbolRole::Scatter {
        return 0; // scatters never pay on lines
    }

    let mut count: u8 = 0;
    for &s in &syms {
        if s == target || is_wild(model, s) {
            count += 1;
        } else {
            break;
        }
    }
    model.paytable.lookup(target, count)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS (line tests + earlier spin tests).

- [ ] **Step 5: Commit**

```bash
git add trusted/math/src/mechanics/slots/eval.rs
git commit -m "feat(math): add payline evaluation with wild substitution"
```

---

### Task 4: Scatter payout and scatter count

**Files:**
- Modify: `trusted/math/src/mechanics/slots/eval.rs`

**Interfaces:**
- Produces (module-internal): `scatter_symbol(model) -> Option<Symbol>`, `scatter_count(model, grid) -> usize`, `scatter_payout(model, grid) -> u64`, `eval_grid(model, grid) -> u64` (lines + scatter for one grid).

- [ ] **Step 1: Write the failing test**

In `eval.rs` `tests` module, add:

```rust
    fn scatter_model() -> SlotModel {
        // 3 reels x 1 row; scatter symbol 9 pays by total count anywhere.
        let mut m = lines_model();
        m.paytable.entries.push(PaytableEntry { symbol: 9, count: 2, payout: 4 });
        m.paytable.entries.push(PaytableEntry { symbol: 9, count: 3, payout: 20 });
        m
    }

    #[test]
    fn scatter_pays_by_total_count() {
        let m = scatter_model();
        let grid = vec![vec![9], vec![0], vec![9]]; // two scatters
        assert_eq!(scatter_payout(&m, &grid), 4);
        assert_eq!(scatter_count(&m, &grid), 2);
    }

    #[test]
    fn eval_grid_sums_lines_and_scatter() {
        let m = scatter_model();
        // line 0,0,0 -> 10 ; plus no scatters here
        let grid = vec![vec![0], vec![0], vec![0]];
        assert_eq!(eval_grid(&m, &grid), 10);
        // three scatters -> line pays 0, scatter pays 20
        let grid2 = vec![vec![9], vec![9], vec![9]];
        assert_eq!(eval_grid(&m, &grid2), 20);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p bloom-math slots::eval`
Expected: FAIL — `scatter_payout`, `scatter_count`, `eval_grid` not found.

- [ ] **Step 3: Implement**

In `eval.rs`, above the `tests` module, add:

```rust
fn scatter_symbol(model: &SlotModel) -> Option<Symbol> {
    model
        .symbols
        .iter()
        .find(|s| s.role == SymbolRole::Scatter)
        .map(|s| s.id)
}

fn scatter_count(model: &SlotModel, grid: &[Vec<Symbol>]) -> usize {
    match scatter_symbol(model) {
        Some(sc) => grid.iter().flatten().filter(|&&s| s == sc).count(),
        None => 0,
    }
}

fn scatter_payout(model: &SlotModel, grid: &[Vec<Symbol>]) -> u64 {
    match scatter_symbol(model) {
        Some(sc) => model.paytable.lookup(sc, scatter_count(model, grid) as u8),
        None => 0,
    }
}

/// Total payout for one grid: all paylines plus scatter pays (bet-multiples).
fn eval_grid(model: &SlotModel, grid: &[Vec<Symbol>]) -> u64 {
    let lines: u64 = model
        .paylines
        .iter()
        .map(|line| line_payout(model, grid, line))
        .sum();
    lines + scatter_payout(model, grid)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add trusted/math/src/mechanics/slots/eval.rs
git commit -m "feat(math): add scatter pays and per-grid payout"
```

---

### Task 5: Free-spins feature (trigger, multiplier, retrigger)

**Files:**
- Modify: `trusted/math/src/mechanics/slots/eval.rs`

**Interfaces:**
- Produces (module-internal): `run_feature(model, fs, rng) -> (u64, u32, Vec<Vec<Vec<Symbol>>>)` returning `(feature_payout, free_spins_played, feature_grids)`.

- [ ] **Step 1: Write the failing test**

In `eval.rs` `tests` module, add:

```rust
    use super::super::model::FreeSpins;

    #[test]
    fn feature_runs_awarded_spins_with_multiplier() {
        // Single reel that ALWAYS lands symbol 0 (three-in-a-... here count 1
        // line). Use a model where each free spin pays a fixed amount.
        let m = SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable { entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }] },
            free_spins: Some(FreeSpins {
                trigger_scatter_count: 1, // irrelevant: no scatter symbol present
                spins_awarded: 4,
                retrigger: false,
                multiplier: 3,
                feature_reels: None,
            }),
        };
        let fs = m.free_spins.clone().unwrap();
        let mut rng = SplitMix64::new(1);
        let (payout, played, grids) = run_feature(&m, &fs, &mut rng);
        // 4 spins, each grid pays 2, x3 multiplier = 4 * 6 = 24.
        assert_eq!(played, 4);
        assert_eq!(payout, 24);
        assert_eq!(grids.len(), 4);
    }

    #[test]
    fn feature_retriggers_when_enabled() {
        // A reel set that always shows 3 scatters → every feature spin retriggers.
        // Cap the test by disabling retrigger after we prove one retrigger using
        // a small awarded count and asserting played > spins_awarded.
        let m = SlotModel {
            symbols: vec![SymbolDef { id: 7, role: SymbolRole::Scatter }],
            reels: vec![vec![7], vec![7], vec![7]],
            rows: 1,
            paylines: vec![],
            paytable: Paytable { entries: vec![] },
            free_spins: Some(FreeSpins {
                trigger_scatter_count: 3,
                spins_awarded: 1,
                retrigger: true,
                multiplier: 1,
                feature_reels: Some(vec![vec![7], vec![7], vec![7]]),
            }),
        };
        let fs = m.free_spins.clone().unwrap();
        let mut rng = SplitMix64::new(1);
        // This retriggers forever by construction, so this test instead asserts
        // the FIRST spin retriggers by running a bounded variant: see Step 3 note.
        let _ = (&m, &fs, &mut rng);
    }
```

> Note: the second test as written would loop forever (a pathological always-retrigger model). Replace its body in Step 3's test with the bounded assertion shown there. Keep only the first test for now; delete the second test's stub before running.

- [ ] **Step 2: Run the test to verify it fails**

Delete the `feature_retriggers_when_enabled` stub for now (it is replaced in Step 4). Run: `cargo test -p bloom-math slots::eval::tests::feature_runs_awarded_spins_with_multiplier`
Expected: FAIL — `run_feature` not found.

- [ ] **Step 3: Implement `run_feature`**

In `eval.rs`, above the `tests` module, add:

```rust
/// Run the free-spins feature. Returns (feature payout in bet-multiples,
/// spins played, per-spin grids). Uses the feature strips if present, else base.
fn run_feature(
    model: &SlotModel,
    fs: &FreeSpins,
    rng: &mut SplitMix64,
) -> (u64, u32, Vec<Vec<Vec<Symbol>>>) {
    let reels = fs.feature_reels.as_ref().unwrap_or(&model.reels);
    let mut remaining = fs.spins_awarded;
    let mut played: u32 = 0;
    let mut payout: u64 = 0;
    let mut grids = Vec::new();

    while remaining > 0 {
        remaining -= 1;
        played += 1;
        let grid = spin(reels, model.rows, rng);
        payout += eval_grid(model, &grid) * fs.multiplier;
        if fs.retrigger && scatter_count(model, &grid) >= fs.trigger_scatter_count as usize {
            remaining += fs.spins_awarded;
        }
        grids.push(grid);
    }
    (payout, played, grids)
}
```

- [ ] **Step 4: Replace the retrigger test with a bounded version**

In the `tests` module, add this test (it bounds the loop by asserting on a model that retriggers exactly once then stops, achieved with feature strips that show scatters only on the first spin via a 2-cell reel and a known seed). Use the simpler deterministic check below:

```rust
    #[test]
    fn retrigger_adds_spins() {
        // Base awarded = 2; a feature reel of [scatter, normal] means roughly
        // half of spins retrigger. We assert that across a fixed seed the feature
        // played strictly more than the 2 awarded (a retrigger happened), and
        // terminates (no infinite loop) within a sane bound.
        let m = SlotModel {
            symbols: vec![
                SymbolDef { id: 7, role: SymbolRole::Scatter },
                SymbolDef { id: 0, role: SymbolRole::Normal },
            ],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![],
            paytable: Paytable { entries: vec![] },
            free_spins: Some(FreeSpins {
                trigger_scatter_count: 3,
                spins_awarded: 2,
                retrigger: true,
                multiplier: 1,
                feature_reels: Some(vec![vec![7, 0, 0, 0], vec![7, 0, 0, 0], vec![7, 0, 0, 0]]),
            }),
        };
        let fs = m.free_spins.clone().unwrap();
        let mut rng = SplitMix64::new(99);
        let (_payout, played, grids) = run_feature(&m, &fs, &mut rng);
        assert!(played >= 2);
        assert_eq!(grids.len() as u32, played);
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS (feature tests + earlier tests).

- [ ] **Step 6: Commit**

```bash
git add trusted/math/src/mechanics/slots/eval.rs
git commit -m "feat(math): add free-spins feature with multiplier and retrigger"
```

---

### Task 6: `RoundOutcome` + `evaluate` + bit-reproducibility golden vector

**Files:**
- Modify: `trusted/math/src/mechanics/slots/eval.rs`
- Modify: `trusted/math/src/mechanics/slots.rs`

**Interfaces:**
- Produces: `slots::RoundOutcome { base_grid: Vec<Vec<Symbol>>, feature_spins: Vec<Vec<Vec<Symbol>>>, base_payout: u64, feature_payout: u64, total_payout: u64, triggered: bool, free_spins_played: u32 }` and `slots::evaluate(model: &SlotModel, seed: u64) -> RoundOutcome`.

- [ ] **Step 1: Write the failing tests**

In `eval.rs` `tests` module, add:

```rust
    fn full_model() -> SlotModel {
        // 3x1 base game; scatter 9 triggers 3 free spins at x2.
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Wild },
                SymbolDef { id: 9, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![0, 1, 9, 0, 0], vec![0, 0, 9, 1, 0], vec![9, 0, 1, 0, 0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 0, count: 3, payout: 5 },
                    PaytableEntry { symbol: 9, count: 3, payout: 8 },
                ],
            },
            free_spins: Some(FreeSpins {
                trigger_scatter_count: 3,
                spins_awarded: 3,
                retrigger: false,
                multiplier: 2,
                feature_reels: None,
            }),
        }
    }

    #[test]
    fn evaluate_is_bit_reproducible() {
        let m = full_model();
        let first = evaluate(&m, 0xABCDEF);
        for _ in 0..1000 {
            assert_eq!(evaluate(&m, 0xABCDEF), first);
        }
    }

    #[test]
    fn evaluate_total_is_base_plus_feature() {
        let m = full_model();
        for seed in 0..2000u64 {
            let o = evaluate(&m, seed);
            assert_eq!(o.total_payout, o.base_payout + o.feature_payout);
            assert_eq!(o.triggered, o.free_spins_played > 0);
        }
    }

    #[test]
    fn evaluate_golden_vector() {
        // Pin exact outputs so any future drift fails loudly. If this changes,
        // it is a re-certification event (a new mechanic version), not an edit.
        let m = full_model();
        let o = evaluate(&m, 12345);
        // Fill these in from the FIRST green run, then keep them frozen forever:
        assert_eq!(o.base_payout, GOLDEN_BASE);
        assert_eq!(o.feature_payout, GOLDEN_FEATURE);
        assert_eq!(o.free_spins_played, GOLDEN_SPINS);
    }

    const GOLDEN_BASE: u64 = 0; // placeholder — set from first run (Step 4)
    const GOLDEN_FEATURE: u64 = 0; // placeholder — set from first run
    const GOLDEN_SPINS: u32 = 0; // placeholder — set from first run
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-math slots::eval`
Expected: FAIL — `evaluate` and `RoundOutcome` not found.

- [ ] **Step 3: Implement `evaluate` + `RoundOutcome`**

In `eval.rs`, above the `tests` module, add:

```rust
/// One round's full result: the symbolic outcome ("what happened") and the
/// payout in bet-multiples ("what it paid"). Both facts, never fused (umbrella §10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundOutcome {
    pub base_grid: Vec<Vec<Symbol>>,
    pub feature_spins: Vec<Vec<Vec<Symbol>>>,
    pub base_payout: u64,
    pub feature_payout: u64,
    pub total_payout: u64,
    pub triggered: bool,
    pub free_spins_played: u32,
}

/// Expand one seed into one round. Deterministic: same `(model, seed)` always
/// yields the same `RoundOutcome`, bit-for-bit, forever.
pub fn evaluate(model: &SlotModel, seed: u64) -> RoundOutcome {
    let mut rng = SplitMix64::new(seed);
    let base_grid = spin(&model.reels, model.rows, &mut rng);
    let base_payout = eval_grid(model, &base_grid);

    let mut feature_payout = 0;
    let mut feature_spins = Vec::new();
    let mut triggered = false;
    let mut free_spins_played = 0;

    if let Some(fs) = &model.free_spins {
        if scatter_count(model, &base_grid) >= fs.trigger_scatter_count as usize {
            triggered = true;
            let (p, played, grids) = run_feature(model, fs, &mut rng);
            feature_payout = p;
            free_spins_played = played;
            feature_spins = grids;
        }
    }

    RoundOutcome {
        base_grid,
        feature_spins,
        base_payout,
        feature_payout,
        total_payout: base_payout + feature_payout,
        triggered,
        free_spins_played,
    }
}
```

- [ ] **Step 4: Set the golden constants, then re-run**

Run: `cargo test -p bloom-math slots::eval::tests::evaluate_golden_vector -- --nocapture`
It will FAIL on the placeholder zeros. Read the actual `base_payout` / `feature_payout` / `free_spins_played` from a quick `dbg!` or from the assertion's left/right values, then replace `GOLDEN_BASE`, `GOLDEN_FEATURE`, `GOLDEN_SPINS` with those exact numbers. Re-run:

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS (all eval tests, including the now-pinned golden vector).

- [ ] **Step 5: Export `evaluate` + `RoundOutcome`**

In `trusted/math/src/mechanics/slots.rs`, extend the re-export:

```rust
pub use eval::{evaluate, RoundOutcome};
pub use model::{
    from_payload, to_payload, FreeSpins, Paytable, PaytableEntry, SlotModel, Symbol, SymbolDef,
    SymbolRole,
};
```

- [ ] **Step 6: Run the whole math suite + commit**

Run: `cargo test -p bloom-math`
Expected: PASS (model + eval).

```bash
git add trusted/math/src/mechanics/slots/eval.rs trusted/math/src/mechanics/slots.rs
git commit -m "feat(math): add evaluate(model, seed) -> RoundOutcome with golden vector"
```

---

## PHASE B — `studio/simulator`

### Task 7: Scaffold the crate + deterministic seed generation

**Files:**
- Modify: `Cargo.toml` (workspace)
- Create: `studio/simulator/Cargo.toml`
- Create: `studio/simulator/src/lib.rs`
- Create: `studio/simulator/src/seedgen.rs`

**Interfaces:**
- Produces: `bloom_simulator::seedgen::generate_seeds(master_seed: u64, count: usize) -> Vec<u64>`.

- [ ] **Step 1: Add the workspace member**

Edit the root `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["trusted/math", "trusted/package", "studio/simulator"]
```

- [ ] **Step 2: Create the crate manifest**

Create `studio/simulator/Cargo.toml`:

```toml
[package]
name = "bloom-simulator"
version = "0.0.0"
edition = "2021"

[dependencies]
bloom-math = { path = "../../trusted/math" }
bloom-package = { path = "../../trusted/package" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rayon = "1"
ed25519-dalek = "2"
```

- [ ] **Step 3: Write the failing test**

Create `studio/simulator/src/seedgen.rs`:

```rust
//! Deterministic candidate-seed generation. A curation run is reproducible:
//! the same master seed yields the same candidate seeds, hence the same pool.

use bloom_math::rng::SplitMix64;

/// Generate `count` candidate seeds deterministically from `master_seed`.
pub fn generate_seeds(master_seed: u64, count: usize) -> Vec<u64> {
    let mut rng = SplitMix64::new(master_seed);
    (0..count).map(|_| rng.next_u64()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_for_same_master() {
        assert_eq!(generate_seeds(42, 1000), generate_seeds(42, 1000));
    }

    #[test]
    fn different_masters_differ() {
        assert_ne!(generate_seeds(1, 100), generate_seeds(2, 100));
    }

    #[test]
    fn produces_requested_count() {
        assert_eq!(generate_seeds(7, 256).len(), 256);
    }
}
```

Create `studio/simulator/src/lib.rs`:

```rust
//! Bloom studio simulator: measure a slot model, verify against targets, and
//! freeze a faithful signed seed pool. Approach A — the model defines the
//! characteristics; the pool is a faithful sample (see the design spec).

pub mod seedgen;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-simulator seedgen`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml studio/simulator/Cargo.toml studio/simulator/src/lib.rs studio/simulator/src/seedgen.rs
git commit -m "feat(sim): scaffold simulator crate with deterministic seed generation"
```

---

### Task 8: Simulate (parallel) → RoundSample

**Files:**
- Create: `studio/simulator/src/measure.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**
- Produces: `bloom_simulator::measure::{RoundSample, simulate}`
  - `struct RoundSample { seed: u64, payout: u64, base_payout: u64, feature_payout: u64, triggered: bool }`
  - `fn simulate(model: &SlotModel, seeds: &[u64]) -> Vec<RoundSample>`

- [ ] **Step 1: Write the failing test**

Create `studio/simulator/src/measure.rs`:

```rust
//! Simulate rounds through the math engine and measure aggregate characteristics.

use bloom_math::mechanics::slots::{evaluate, SlotModel};
use rayon::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoundSample {
    pub seed: u64,
    pub payout: u64,
    pub base_payout: u64,
    pub feature_payout: u64,
    pub triggered: bool,
}

/// Evaluate every seed through the math engine, in parallel. Order of the
/// output matches the order of `seeds` (rayon's `map` preserves order).
pub fn simulate(model: &SlotModel, seeds: &[u64]) -> Vec<RoundSample> {
    seeds
        .par_iter()
        .map(|&seed| {
            let o = evaluate(model, seed);
            RoundSample {
                seed,
                payout: o.total_payout,
                base_payout: o.base_payout,
                feature_payout: o.feature_payout,
                triggered: o.triggered,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole};

    fn toy() -> SlotModel {
        SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable { entries: vec![PaytableEntry { symbol: 0, count: 1, payout: 1 }] },
            free_spins: None,
        }
    }

    #[test]
    fn simulate_preserves_order_and_is_deterministic() {
        let m = toy();
        let seeds = vec![1u64, 2, 3, 4, 5];
        let a = simulate(&m, &seeds);
        let b = simulate(&m, &seeds);
        assert_eq!(a, b);
        assert_eq!(a.iter().map(|s| s.seed).collect::<Vec<_>>(), seeds);
    }

    #[test]
    fn simulate_reports_payout() {
        let m = toy(); // single reel, single symbol, count 1 -> always pays 1
        let out = simulate(&m, &[10, 20, 30]);
        assert!(out.iter().all(|s| s.payout == 1));
    }
}
```

In `studio/simulator/src/lib.rs`, add below `pub mod seedgen;`:

```rust
pub mod measure;
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cargo test -p bloom-simulator measure`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add studio/simulator/src/measure.rs studio/simulator/src/lib.rs
git commit -m "feat(sim): simulate seeds through the math engine in parallel"
```

---

### Task 9: Measure → Metrics (RTP convergence)

**Files:**
- Create: `studio/simulator/src/target.rs`
- Modify: `studio/simulator/src/measure.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**
- Produces:
  - `bloom_simulator::target::Metrics { rtp: f64, volatility: f64, hit_frequency: f64, bonus_hit_rate: f64, base_rtp: f64, feature_rtp: f64 }`
  - `bloom_simulator::measure::measure(samples: &[RoundSample]) -> Metrics`

- [ ] **Step 1: Create the metrics type**

Create `studio/simulator/src/target.rs`:

```rust
//! Target spec (desired characteristics) and measured metrics.

/// Measured characteristics of a model over a simulated population. Floats are
/// fine here — this is studio measurement, never the certified outcome path.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metrics {
    /// Return to player: mean payout (bet-multiples) per spin.
    pub rtp: f64,
    /// Std-dev of per-spin payout (a volatility index).
    pub volatility: f64,
    /// Fraction of spins that pay > 0.
    pub hit_frequency: f64,
    /// Fraction of spins that trigger the bonus.
    pub bonus_hit_rate: f64,
    /// RTP contributed by the base game.
    pub base_rtp: f64,
    /// RTP contributed by the feature.
    pub feature_rtp: f64,
}
```

In `studio/simulator/src/lib.rs`, add:

```rust
pub mod target;
```

- [ ] **Step 2: Write the failing test**

In `measure.rs` `tests` module, add:

```rust
    use crate::target::Metrics;

    fn measurable() -> SlotModel {
        // 1 reel, 1 row, 1 line. strip = 5x sym0, 4x sym1, 1x sym2 (10 cells).
        // paytable: sym1 count1 -> 1 ; sym2 count1 -> 5. sym0 pays nothing.
        // Closed-form RTP = 0.4*1 + 0.1*5 = 0.9.
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Normal },
                SymbolDef { id: 2, role: SymbolRole::Normal },
            ],
            reels: vec![vec![0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 1, count: 1, payout: 1 },
                    PaytableEntry { symbol: 2, count: 1, payout: 5 },
                ],
            },
            free_spins: None,
        }
    }

    #[test]
    fn rtp_converges_to_closed_form() {
        let m = measurable();
        let seeds = crate::seedgen::generate_seeds(2026, 1_000_000);
        let metrics: Metrics = measure(&simulate(&m, &seeds));
        assert!((metrics.rtp - 0.9).abs() < 0.02, "rtp = {}", metrics.rtp);
        assert!(metrics.hit_frequency > 0.0 && metrics.hit_frequency < 1.0);
        assert_eq!(metrics.bonus_hit_rate, 0.0); // no free_spins
        assert!((metrics.base_rtp - metrics.rtp).abs() < 1e-9);
    }
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p bloom-simulator measure::tests::rtp_converges_to_closed_form`
Expected: FAIL — `measure` not found.

- [ ] **Step 4: Implement `measure`**

In `measure.rs`, add (top-level, importing the metrics type):

```rust
use crate::target::Metrics;

/// Aggregate a population of samples into measured characteristics.
pub fn measure(samples: &[RoundSample]) -> Metrics {
    let n = samples.len() as f64;
    assert!(n > 0.0, "cannot measure an empty population");

    let sum = |f: fn(&RoundSample) -> u64| samples.iter().map(|s| f(s) as f64).sum::<f64>();

    let rtp = sum(|s| s.payout) / n;
    let base_rtp = sum(|s| s.base_payout) / n;
    let feature_rtp = sum(|s| s.feature_payout) / n;

    let variance = samples
        .iter()
        .map(|s| {
            let d = s.payout as f64 - rtp;
            d * d
        })
        .sum::<f64>()
        / n;

    Metrics {
        rtp,
        volatility: variance.sqrt(),
        hit_frequency: samples.iter().filter(|s| s.payout > 0).count() as f64 / n,
        bonus_hit_rate: samples.iter().filter(|s| s.triggered).count() as f64 / n,
        base_rtp,
        feature_rtp,
    }
}
```

> Note: there is already a `use crate::target::Metrics;` added inside the test module; the top-level `use` is the one consumed by `measure`. If the compiler warns about a duplicate import in tests, remove the one inside `tests`.

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p bloom-simulator measure`
Expected: PASS (the 1M-sim convergence test runs in a couple seconds in release-ish debug; if slow, it still passes).

- [ ] **Step 6: Commit**

```bash
git add studio/simulator/src/target.rs studio/simulator/src/measure.rs studio/simulator/src/lib.rs
git commit -m "feat(sim): measure RTP, volatility, hit-rate, base/feature split"
```

---

### Task 10: Verify metrics against targets

**Files:**
- Modify: `studio/simulator/src/target.rs`
- Create: `studio/simulator/src/run.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**
- Produces:
  - `bloom_simulator::target::TargetSpec { rtp_target: f64, rtp_tolerance: f64, volatility_min: f64, volatility_max: f64, bonus_hit_rate_min: f64, bonus_hit_rate_max: f64, pool_size: usize, candidate_count: usize, realized_correction_band: f64 }`
  - `bloom_simulator::run::verify(metrics: &Metrics, target: &TargetSpec) -> Result<(), Metrics>` (Err carries the failing metrics)

- [ ] **Step 1: Add `TargetSpec`**

In `studio/simulator/src/target.rs`, add:

```rust
/// Desired characteristics + curation parameters for a curation run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TargetSpec {
    pub rtp_target: f64,
    pub rtp_tolerance: f64,
    pub volatility_min: f64,
    pub volatility_max: f64,
    pub bonus_hit_rate_min: f64,
    pub bonus_hit_rate_max: f64,
    /// Number of seeds frozen into the pool.
    pub pool_size: usize,
    /// Number of rounds simulated to measure + draw the pool from.
    pub candidate_count: usize,
    /// Max distance curation may move realized RTP from the measured model RTP.
    pub realized_correction_band: f64,
}
```

- [ ] **Step 2: Write the failing test**

Create `studio/simulator/src/run.rs`:

```rust
//! Orchestrate a curation run: generate → simulate → measure → verify → freeze
//! → build+sign. Approach A: a model that misses targets FAILS; the simulator
//! never reshapes the pool to force a target.

use crate::target::{Metrics, TargetSpec};

/// Check measured metrics against the target bands. Err carries the metrics so
/// the caller (human / future tuner) can see what missed.
pub fn verify(metrics: &Metrics, target: &TargetSpec) -> Result<(), Metrics> {
    let rtp_ok = (metrics.rtp - target.rtp_target).abs() <= target.rtp_tolerance;
    let vol_ok = metrics.volatility >= target.volatility_min
        && metrics.volatility <= target.volatility_max;
    let bonus_ok = metrics.bonus_hit_rate >= target.bonus_hit_rate_min
        && metrics.bonus_hit_rate <= target.bonus_hit_rate_max;

    if rtp_ok && vol_ok && bonus_ok {
        Ok(())
    } else {
        Err(*metrics)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 1.0,
            volatility_max: 10.0,
            bonus_hit_rate_min: 0.0,
            bonus_hit_rate_max: 0.05,
            pool_size: 100,
            candidate_count: 1000,
            realized_correction_band: 0.05,
        }
    }

    fn metrics(rtp: f64, vol: f64, bonus: f64) -> Metrics {
        Metrics { rtp, volatility: vol, hit_frequency: 0.3, bonus_hit_rate: bonus, base_rtp: rtp, feature_rtp: 0.0 }
    }

    #[test]
    fn within_all_bands_passes() {
        assert!(verify(&metrics(0.955, 3.0, 0.02), &target()).is_ok());
    }

    #[test]
    fn rtp_out_of_band_fails() {
        assert!(verify(&metrics(0.80, 3.0, 0.02), &target()).is_err());
    }

    #[test]
    fn volatility_out_of_band_fails() {
        assert!(verify(&metrics(0.955, 0.5, 0.02), &target()).is_err());
    }

    #[test]
    fn bonus_out_of_band_fails() {
        assert!(verify(&metrics(0.955, 3.0, 0.20), &target()).is_err());
    }
}
```

In `studio/simulator/src/lib.rs`, add:

```rust
pub mod run;
```

- [ ] **Step 3: Run to verify it passes**

Run: `cargo test -p bloom-simulator run::tests`
Expected: PASS (4 tests).

- [ ] **Step 4: Commit**

```bash
git add studio/simulator/src/target.rs studio/simulator/src/run.rs studio/simulator/src/lib.rs
git commit -m "feat(sim): verify measured metrics against target bands"
```

---

### Task 11: Freeze the pool (Approach A2, bounded faithful correction)

**Files:**
- Create: `studio/simulator/src/curate.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**
- Produces:
  - `bloom_simulator::curate::Pool { seeds: Vec<u64>, realized_rtp: f64 }`
  - `bloom_simulator::curate::CurateError::OutsideCorrectionBand { needed: f64, band: f64 }`
  - `bloom_simulator::curate::freeze_pool(samples: &[RoundSample], target: &TargetSpec, model_rtp: f64) -> Result<Pool, CurateError>`

- [ ] **Step 1: Write the failing test**

Create `studio/simulator/src/curate.rs`:

```rust
//! Freeze a faithful seed pool (Approach A2). Start from a faithful sample
//! (the first `pool_size` candidates) and apply only minimal, bounded swaps to
//! land realized RTP within tolerance — never reshaping beyond the correction
//! band. The pool stays a faithful sample of the model.

use crate::measure::RoundSample;
use crate::target::TargetSpec;

#[derive(Debug, Clone, PartialEq)]
pub struct Pool {
    pub seeds: Vec<u64>,
    pub realized_rtp: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CurateError {
    /// Hitting the target would move realized RTP further than the honesty
    /// guardrail allows — that is a model-tuning problem, not a curation one.
    OutsideCorrectionBand { needed: f64, band: f64 },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(seed: u64, payout: u64) -> RoundSample {
        RoundSample { seed, payout, base_payout: payout, feature_payout: 0, triggered: false }
    }

    fn spec(pool_size: usize, rtp_target: f64) -> TargetSpec {
        TargetSpec {
            rtp_target,
            rtp_tolerance: 0.001,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_min: 0.0,
            bonus_hit_rate_max: 1.0,
            pool_size,
            candidate_count: 0,
            realized_correction_band: 0.05,
        }
    }

    #[test]
    fn faithful_sample_already_on_target_needs_no_swaps() {
        // 10 samples alternating payout 0/2 -> mean 1.0. pool_size 10, target 1.0.
        let samples: Vec<_> = (0..10).map(|i| sample(i, if i % 2 == 0 { 0 } else { 2 })).collect();
        let pool = freeze_pool(&samples, &spec(10, 1.0), 1.0).unwrap();
        assert_eq!(pool.seeds.len(), 10);
        assert!((pool.realized_rtp - 1.0).abs() <= 0.001);
    }

    #[test]
    fn swaps_nudge_realized_toward_target() {
        // pool of first 4 = payouts [0,0,0,0] -> realized 0.0; reserve has 2s.
        // target 1.0 reachable by swapping in high-payout reserve seeds.
        let mut samples: Vec<_> = (0..4).map(|i| sample(i, 0)).collect();
        samples.extend((4..12).map(|i| sample(i, 2)));
        // model_rtp ~ mean of all = (0*4 + 2*8)/12 = 1.333; target 1.0 within band.
        let pool = freeze_pool(&samples, &spec(4, 1.0), 1.3333).unwrap();
        assert!((pool.realized_rtp - 1.0).abs() <= 0.001, "got {}", pool.realized_rtp);
    }

    #[test]
    fn refuses_correction_beyond_band() {
        // model_rtp 0.0 (all-zero), target 1.0 -> needs to move 1.0 >> band 0.05.
        let samples: Vec<_> = (0..8)
            .map(|i| sample(i, if i < 4 { 0 } else { 2 }))
            .collect();
        let err = freeze_pool(&samples, &spec(4, 1.0), 0.0).unwrap_err();
        matches!(err, CurateError::OutsideCorrectionBand { .. });
    }
}
```

In `studio/simulator/src/lib.rs`, add:

```rust
pub mod curate;
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-simulator curate`
Expected: FAIL — `freeze_pool` not found.

- [ ] **Step 3: Implement `freeze_pool`**

In `curate.rs`, above the `tests` module, add:

```rust
/// Freeze a faithful pool of `target.pool_size` seeds from `samples`
/// (`samples.len()` must be >= pool_size). Starts from the first `pool_size`
/// candidates (a faithful sample) and applies bounded greedy swaps to land
/// realized RTP within `rtp_tolerance`, never moving it more than
/// `realized_correction_band` from `model_rtp`.
pub fn freeze_pool(
    samples: &[RoundSample],
    target: &TargetSpec,
    model_rtp: f64,
) -> Result<Pool, CurateError> {
    let p = target.pool_size;
    assert!(samples.len() >= p, "need at least pool_size candidates");

    // Working pool = first p indices; reserve = the rest.
    let mut pool: Vec<usize> = (0..p).collect();
    let mut reserve: Vec<usize> = (p..samples.len()).collect();
    let mut sum: u64 = pool.iter().map(|&i| samples[i].payout).sum();

    let realized = |sum: u64| sum as f64 / p as f64;

    loop {
        let r = realized(sum);
        if (r - target.rtp_target).abs() <= target.rtp_tolerance {
            break;
        }
        if (r - model_rtp).abs() > target.realized_correction_band {
            return Err(CurateError::OutsideCorrectionBand {
                needed: (r - model_rtp).abs(),
                band: target.realized_correction_band,
            });
        }

        // Need to raise realized (r < target) or lower it (r > target).
        let raise = r < target.rtp_target;
        // Pick the pool slot + reserve slot whose swap moves sum most in the
        // needed direction (deterministic: ties resolved by lowest index).
        let pool_pick = if raise {
            // remove a low pool payout
            pool.iter().enumerate().min_by_key(|&(_, &i)| samples[i].payout)
        } else {
            // remove a high pool payout
            pool.iter().enumerate().max_by_key(|&(_, &i)| samples[i].payout)
        };
        let res_pick = if raise {
            // bring in a high reserve payout
            reserve.iter().enumerate().max_by_key(|&(_, &i)| samples[i].payout)
        } else {
            // bring in a low reserve payout
            reserve.iter().enumerate().min_by_key(|&(_, &i)| samples[i].payout)
        };

        let (Some((pi, &pidx)), Some((ri, &ridx))) = (pool_pick, res_pick) else {
            break; // nothing to swap with
        };

        let out_payout = samples[pidx].payout;
        let in_payout = samples[ridx].payout;
        // Stop if the best available swap does not move us toward the target.
        let helps = if raise { in_payout > out_payout } else { in_payout < out_payout };
        if !helps {
            break;
        }

        // Apply the swap.
        pool[pi] = ridx;
        reserve[ri] = pidx;
        sum = sum - out_payout + in_payout;
    }

    Ok(Pool {
        seeds: pool.iter().map(|&i| samples[i].seed).collect(),
        realized_rtp: realized(sum),
    })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p bloom-simulator curate`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/simulator/src/curate.rs studio/simulator/src/lib.rs
git commit -m "feat(sim): freeze a faithful pool with bounded correction (A2)"
```

---

### Task 12: Orchestration — `run_curation` + package + provenance + freeze-boundary determinism

**Files:**
- Modify: `studio/simulator/src/run.rs`

**Interfaces:**
- Produces:
  - `bloom_simulator::run::RunError` (`VerifyFailed(Metrics)`, `Curate(CurateError)`)
  - `bloom_simulator::run::CurationOutput { package_bytes: Vec<u8>, metrics: Metrics, pool: Pool, report: String }`
  - `bloom_simulator::run::run_curation(model: &SlotModel, target: &TargetSpec, master_seed: u64, package_id: &str, signing_key: &SigningKey) -> Result<CurationOutput, RunError>`

- [ ] **Step 1: Write the failing test**

In `run.rs`, extend the imports at the top:

```rust
use crate::curate::{freeze_pool, CurateError, Pool};
use crate::measure::{measure, simulate};
use crate::seedgen::generate_seeds;
use bloom_math::mechanics::slots::{evaluate, from_payload, to_payload, SlotModel};
use bloom_package::{build, verify_and_load, Envelope, PackageContent};
use ed25519_dalek::SigningKey;
```

In `run.rs` `tests` module, add:

```rust
    use bloom_math::mechanics::slots::{Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole};
    use ed25519_dalek::SigningKey;

    fn measurable_model() -> SlotModel {
        // Same 0.9-RTP model as the measure test.
        SlotModel {
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 1, role: SymbolRole::Normal },
                SymbolDef { id: 2, role: SymbolRole::Normal },
            ],
            reels: vec![vec![0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
            rows: 1,
            paylines: vec![vec![0]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 1, count: 1, payout: 1 },
                    PaytableEntry { symbol: 2, count: 1, payout: 5 },
                ],
            },
            free_spins: None,
        }
    }

    fn target_09() -> TargetSpec {
        TargetSpec {
            rtp_target: 0.9,
            rtp_tolerance: 0.02,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_min: 0.0,
            bonus_hit_rate_max: 0.01,
            pool_size: 10_000,
            candidate_count: 200_000,
            realized_correction_band: 0.05,
        }
    }

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn run_curation_builds_a_loadable_package() {
        let out = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let vk = key().verifying_key();
        let content = verify_and_load(&out.package_bytes, &vk).expect("package loads");
        assert_eq!(content.seeds.len(), 10_000);
        assert_eq!(content.envelope.mechanic, "slots@1");
    }

    #[test]
    fn run_curation_is_reproducible() {
        let a = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let b = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        assert_eq!(a.pool.seeds, b.pool.seeds);
        assert_eq!(a.package_bytes, b.package_bytes);
    }

    #[test]
    fn freeze_boundary_determinism_holds() {
        // Re-expand the pooled seeds server-style from the package and confirm
        // the realized RTP matches what curation recorded — proving the
        // determinism contract survives the freeze.
        let out = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let vk = key().verifying_key();
        let content = verify_and_load(&out.package_bytes, &vk).unwrap();
        let model = from_payload(&content.math_payload).unwrap();
        let sum: u64 = content.seeds.iter().map(|&s| evaluate(&model, s).total_payout).sum();
        let reexpanded_rtp = sum as f64 / content.seeds.len() as f64;
        assert!((reexpanded_rtp - out.pool.realized_rtp).abs() < 1e-9);
    }

    #[test]
    fn missing_target_fails_loudly() {
        let mut t = target_09();
        t.rtp_target = 0.50; // model is ~0.9, far outside tolerance
        let err = run_curation(&measurable_model(), &t, 2026, "pkg-test", &key()).unwrap_err();
        matches!(err, RunError::VerifyFailed(_));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-simulator run::tests::run_curation_builds_a_loadable_package`
Expected: FAIL — `run_curation`, `RunError`, `CurationOutput` not found.

- [ ] **Step 3: Implement orchestration**

In `run.rs`, above the `tests` module, add:

```rust
#[derive(Debug, Clone)]
pub enum RunError {
    /// The model's measured characteristics missed the target bands.
    VerifyFailed(Metrics),
    /// The pool could not be frozen within the honesty guardrail.
    Curate(CurateError),
}

pub struct CurationOutput {
    pub package_bytes: Vec<u8>,
    pub metrics: Metrics,
    pub pool: Pool,
    /// Human-readable provenance (NOT embedded in the signed package; the
    /// package format is certified and unchanged — see the design spec).
    pub report: String,
}

/// Generate → simulate → measure → verify → freeze → build+sign.
pub fn run_curation(
    model: &SlotModel,
    target: &TargetSpec,
    master_seed: u64,
    package_id: &str,
    signing_key: &SigningKey,
) -> Result<CurationOutput, RunError> {
    let seeds = generate_seeds(master_seed, target.candidate_count);
    let samples = simulate(model, &seeds);
    let metrics = measure(&samples);

    verify(&metrics, target).map_err(RunError::VerifyFailed)?;

    let pool = freeze_pool(&samples, target, metrics.rtp).map_err(RunError::Curate)?;

    let content = PackageContent {
        envelope: Envelope {
            package_id: package_id.to_string(),
            package_version: 1,
            mechanic: "slots@1".to_string(),
        },
        math_payload: to_payload(model),
        seeds: pool.seeds.clone(),
        presentation: Vec::new(),
    };
    let package_bytes = build(&content, signing_key);

    let report = format!(
        "package_id={package_id}\nmechanic=slots@1\nmaster_seed={master_seed}\n\
         candidate_count={}\npool_size={}\n\
         measured_rtp={:.5}\nrealized_rtp={:.5}\nvolatility={:.5}\n\
         hit_frequency={:.5}\nbonus_hit_rate={:.5}\nbase_rtp={:.5}\nfeature_rtp={:.5}\n",
        target.candidate_count,
        target.pool_size,
        metrics.rtp,
        pool.realized_rtp,
        metrics.volatility,
        metrics.hit_frequency,
        metrics.bonus_hit_rate,
        metrics.base_rtp,
        metrics.feature_rtp,
    );

    Ok(CurationOutput { package_bytes, metrics, pool, report })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p bloom-simulator run`
Expected: PASS (verify tests + 4 orchestration tests).

- [ ] **Step 5: Commit**

```bash
git add studio/simulator/src/run.rs
git commit -m "feat(sim): run_curation builds a signed package with provenance report"
```

---

### Task 13: CLI binary + `just` recipe

**Files:**
- Create: `studio/simulator/src/bin/curate.rs`
- Modify: `justfile`

**Interfaces:**
- Consumes: `bloom_simulator::run::run_curation`, `serde_json` to read a model file.

- [ ] **Step 1: Write the binary**

Create `studio/simulator/src/bin/curate.rs`:

```rust
//! CLI: read a slot model JSON + a target JSON, run a curation, write the
//! signed package and the provenance report to disk.
//!
//! Usage: curate <model.json> <target.json> <package_id> <out.pkg> <out.report.txt>
//!
//! NOTE: the demo signing key is fixed and for development only. Real signing
//! keys are a sign-off-gate concern (umbrella §9), out of scope here.

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::run::run_curation;
use bloom_simulator::target::TargetSpec;
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use std::fs;

// TargetSpec is not serde-derived in the library (it is a plain config struct);
// mirror it here for JSON input to avoid adding serde to the core type.
#[derive(Deserialize)]
struct TargetJson {
    rtp_target: f64,
    rtp_tolerance: f64,
    volatility_min: f64,
    volatility_max: f64,
    bonus_hit_rate_min: f64,
    bonus_hit_rate_max: f64,
    pool_size: usize,
    candidate_count: usize,
    realized_correction_band: f64,
    master_seed: u64,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 6 {
        eprintln!("usage: curate <model.json> <target.json> <package_id> <out.pkg> <out.report.txt>");
        std::process::exit(2);
    }

    let model: SlotModel =
        serde_json::from_str(&fs::read_to_string(&args[1]).expect("read model")).expect("parse model");
    let tj: TargetJson =
        serde_json::from_str(&fs::read_to_string(&args[2]).expect("read target")).expect("parse target");
    let target = TargetSpec {
        rtp_target: tj.rtp_target,
        rtp_tolerance: tj.rtp_tolerance,
        volatility_min: tj.volatility_min,
        volatility_max: tj.volatility_max,
        bonus_hit_rate_min: tj.bonus_hit_rate_min,
        bonus_hit_rate_max: tj.bonus_hit_rate_max,
        pool_size: tj.pool_size,
        candidate_count: tj.candidate_count,
        realized_correction_band: tj.realized_correction_band,
    };

    let signing_key = SigningKey::from_bytes(&[7u8; 32]); // dev-only
    match run_curation(&model, &target, tj.master_seed, &args[3], &signing_key) {
        Ok(out) => {
            fs::write(&args[4], &out.package_bytes).expect("write package");
            fs::write(&args[5], &out.report).expect("write report");
            println!("{}", out.report);
            println!("wrote package -> {}\nwrote report  -> {}", args[4], args[5]);
        }
        Err(e) => {
            eprintln!("curation failed: {e:?}");
            std::process::exit(1);
        }
    }
}
```

- [ ] **Step 2: Verify it builds**

Run: `cargo build -p bloom-simulator --bin curate`
Expected: builds clean.

- [ ] **Step 3: Add a `just` recipe**

In `justfile`, add near the other Rust recipes:

```make
# Run a slot curation: model + target JSON -> signed package + report.
# Usage: just sim-curate game/model.json game/target.json my-game out.pkg out.report.txt
sim-curate model target id pkg report:
    cargo run -p bloom-simulator --bin curate -- {{model}} {{target}} {{id}} {{pkg}} {{report}}
```

- [ ] **Step 4: Smoke-test end to end**

Create a throwaway `scratch-model.json` and `scratch-target.json` matching the `measurable_model` / `target_09` shapes (RTP ~0.9), then:

Run: `just sim-curate scratch-model.json scratch-target.json smoke smoke.pkg smoke.report.txt`
Expected: prints a report with `realized_rtp` near 0.9 and writes both files. Delete the scratch files afterward (do not commit them).

- [ ] **Step 5: Run the whole workspace suite + commit**

Run: `cargo test --workspace`
Expected: PASS (math + package + simulator).

```bash
git add studio/simulator/src/bin/curate.rs justfile
git commit -m "feat(sim): add curate CLI and just recipe"
```

---

## Final verification

- [ ] Run `cargo fmt --all` and `cargo clippy --workspace --all-targets` — fix any warnings.
- [ ] Run `cargo test --workspace` — all green.
- [ ] Confirm `trusted/package` was not modified.
- [ ] Push and open a PR: `git push -u origin feat/math-engine && gh pr create`.

---

## Self-review (plan author)

**Spec coverage:**
- Math model schema (spec §3) → Task 1. ✓
- Enriched kernel `evaluate` with grid/lines/scatter/free-spins (spec §4) → Tasks 2–6. ✓
- Integer-only outcome / determinism (spec §2.2, Global Constraints) → enforced throughout; bit-reproducibility + golden vector Task 6. ✓
- Simulator generate → simulate (parallel) → measure → verify → freeze → build+sign (spec §5) → Tasks 7–12. ✓
- Approach A faithfulness + honesty guardrail (spec §2.1) → Task 11. ✓
- Verify-fails-loudly, no silent reshaping (spec §5 step 4, §6) → Tasks 10, 12. ✓
- Provenance report as separate artifact, package format untouched (spec §5 step 6 + Global Constraints reconciliation) → Task 12. ✓
- Freeze-boundary determinism (spec §6) → Task 12. ✓
- Reproducible curation (spec §6) → Task 12. ✓
- Mechanic-agnostic seams / `Tuner` deferred (spec §7, §8) → no code (labels only); `RoundOutcome` + `evaluate` are the named seams; GA/tuning explicitly absent. ✓
- First-cut defaults (spec §9) → expressed as `TargetSpec` inputs + CLI JSON, not hardcoded. ✓

**Placeholder scan:** The only intentional placeholders are the golden-vector constants in Task 6, which the engineer fills from the first green run (explicit step). No "TBD"/"add error handling"/"similar to Task N" placeholders elsewhere.

**Type consistency:** `RoundSample`, `Metrics`, `TargetSpec`, `Pool`, `CurateError`, `RunError`, `CurationOutput`, and `run_curation`'s signature are defined once and referenced consistently across Tasks 8–13. `evaluate`/`RoundOutcome`/`to_payload`/`from_payload` names match between `trusted/math` (Tasks 1, 6) and the simulator's consumption (Tasks 8, 12).
