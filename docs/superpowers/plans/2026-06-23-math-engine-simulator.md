# Math Engine (slots) + Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the certified slot math engine so one seed resolves to a full round _with payout_ (grid, paylines, a list of bonus features), then build a studio simulator that measures a model's RTP/volatility/per-feature hit-rates, verifies them against targets, and freezes a faithful, signed seed pool.

**Architecture:** Approach A — the math model (reel strips + paytable + bonus-feature list) _defines_ the characteristics; the seed pool is a faithful, bit-reproducible sample with only finite-sample correction. The kernel `slots::evaluate(model, seed) → RoundOutcome` is the shared core; the simulator and the future server are thin shells around it.

**Tech Stack:** Rust (edition 2021), Cargo workspace, `serde` + `postcard` (model serialization), `serde_json` (model authoring), `rayon` (parallel simulation), `ed25519-dalek` (package signing, via `bloom-package`).

## Global Constraints

- **Determinism is sacred.** Integer-only math in the outcome path: no floats, no clock/time, no I/O, no randomness beyond the injected seed. `slots::evaluate` MUST be bit-reproducible across platforms forever. (Floats are allowed only in the simulator's _measurement_ aggregation, never in the kernel outcome.)
- **Payouts are integer bet-multiples (`u64`)** everywhere in the kernel.
- **This is mechanic `slots@1`.** Append-only and immutable once shipped; any later behavior change is a new mechanic version, never an edit (`trusted/AGENTS.md`).
- **Frozen `slots@1` bonus composition rule (spec §3.1):** each feature checks its own trigger against the **base grid**; triggered features run in **list order**; their payouts **sum**; within a feature, retrigger re-checks **that same feature's** trigger against each feature-spin grid; **no nesting / cross-triggering**. Build **no** arbitration, precedence, exclusivity, nesting, or feature registry/loader — those wait for a second feature _type_.
- **Do NOT modify `trusted/package`'s format.** It is certified and already done. The simulator consumes its public `build` / `verify_and_load` API unchanged. Provenance is emitted as a _separate_ sim-report artifact, not stuffed into the signed package.
- **Nothing may depend on `studio/`.** `studio/simulator` may depend on `trusted/math` and `trusted/package`.
- **TDD mandatory:** failing test first, watch it fail, minimal code to pass, commit. Semantic (Conventional Commits) messages.
- **Work in the worktree** `C:\code\bloom.wt\math-engine` on branch `feat/math-engine`. Run all `cargo` commands from the worktree root.
- Run a single test with `cargo test -p <crate> <name>`; the whole suite with `cargo test --workspace`.

---

## File map

**`trusted/math` (enrich):**
- Modify `trusted/math/Cargo.toml` — add `serde`, `postcard`.
- Modify `trusted/math/src/mechanics/slots.rs` — module root: declares `model` + `eval`, re-exports them. (Old toy `SlotModel`/`expand` removed; `rng.rs`/`SplitMix64` unchanged and reused.)
- Create `trusted/math/src/mechanics/slots/model.rs` — model schema (incl. `bonuses: Vec<BonusFeature>`) + serde + `to_payload`/`from_payload`.
- Create `trusted/math/src/mechanics/slots/eval.rs` — `RoundOutcome` + `FeatureOutcome` + `evaluate` + payout/feature helpers.

**`studio/simulator` (new crate):**
- Modify root `Cargo.toml` — add `studio/simulator` member.
- Create `studio/simulator/Cargo.toml`.
- Create `studio/simulator/src/lib.rs` — module wiring.
- Create `studio/simulator/src/seedgen.rs` — deterministic candidate-seed generation.
- Create `studio/simulator/src/target.rs` — `TargetSpec`, `HitRateBand`, `Metrics`.
- Create `studio/simulator/src/measure.rs` — `RoundSample`, `simulate`, `measure`.
- Create `studio/simulator/src/curate.rs` — `Pool`, `CurateError`, `freeze_pool` (A2).
- Create `studio/simulator/src/run.rs` — `verify`, `run_curation`, `RunError`, `CurationOutput`.
- Create `studio/simulator/src/bin/curate.rs` — CLI: model JSON + target JSON → package + report.
- Modify `justfile` — add a `sim-curate` recipe.

---

## PHASE A — `trusted/math` kernel

### Task 1: Model schema (with bonus-feature list) + payload round-trip

**Files:**
- Modify: `trusted/math/Cargo.toml`
- Modify: `trusted/math/src/mechanics/slots.rs`
- Create: `trusted/math/src/mechanics/slots/model.rs`

**Interfaces:**
- Produces: `bloom_math::mechanics::slots::{Symbol, SymbolRole, SymbolDef, PaytableEntry, Paytable, TriggerSpec, FreeSpinsConfig, BonusFeature, SlotModel, to_payload, from_payload}`
  - `type Symbol = u8;`
  - `enum SymbolRole { Normal, Wild, Scatter }`
  - `struct SymbolDef { id: Symbol, role: SymbolRole }`
  - `struct PaytableEntry { symbol: Symbol, count: u8, payout: u64 }`
  - `struct Paytable { entries: Vec<PaytableEntry> }` with `fn lookup(&self, symbol: Symbol, count: u8) -> u64`
  - `struct TriggerSpec { symbol: Symbol, min_count: u8 }`
  - `struct FreeSpinsConfig { spins_awarded: u32, retrigger: bool, multiplier: u64, feature_reels: Option<Vec<Vec<Symbol>>> }`
  - `enum BonusFeature { FreeSpins { trigger: TriggerSpec, config: FreeSpinsConfig } }`
  - `struct SlotModel { symbols: Vec<SymbolDef>, reels: Vec<Vec<Symbol>>, rows: usize, paylines: Vec<Vec<usize>>, paytable: Paytable, bonuses: Vec<BonusFeature> }`
  - `fn to_payload(model: &SlotModel) -> Vec<u8>`
  - `fn from_payload(bytes: &[u8]) -> Result<SlotModel, postcard::Error>`

- [ ] **Step 1: Add dependencies**

Edit `trusted/math/Cargo.toml` so `[dependencies]` reads:

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

/// What triggers (or retriggers) a bonus feature: `min_count` of `symbol`
/// anywhere on the relevant grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerSpec {
    pub symbol: Symbol,
    pub min_count: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FreeSpinsConfig {
    /// Free spins granted per (re)trigger.
    pub spins_awarded: u32,
    /// Whether the trigger condition during the feature awards more spins.
    pub retrigger: bool,
    /// Win multiplier applied to each free-spin grid's payout (integer).
    pub multiplier: u64,
    /// Optional separate strips used during the feature; falls back to base.
    pub feature_reels: Option<Vec<Vec<Symbol>>>,
}

/// A bonus feature. ONE variant today (`slots@1`); a second feature type is a
/// new variant + one match arm + a `slots@2` bump — additive, no framework.
/// Each feature carries its OWN trigger (spec §3.1 composition rule).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BonusFeature {
    FreeSpins {
        trigger: TriggerSpec,
        config: FreeSpinsConfig,
    },
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
    /// The bonus features (the durable end-state shape). slots@1 composition is
    /// the frozen rule in spec §3.1: independent triggers vs base grid, list
    /// order, summed payouts, no nesting/arbitration.
    pub bonuses: Vec<BonusFeature>,
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
                SymbolDef { id: 9, role: SymbolRole::Scatter },
            ],
            reels: vec![vec![0, 1, 9, 0, 0], vec![0, 0, 1, 9, 0], vec![9, 0, 1, 0, 0]],
            rows: 3,
            paylines: vec![vec![0, 0, 0], vec![1, 1, 1]],
            paytable: Paytable {
                entries: vec![
                    PaytableEntry { symbol: 0, count: 3, payout: 5 },
                    PaytableEntry { symbol: 9, count: 3, payout: 2 },
                ],
            },
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec { symbol: 9, min_count: 3 },
                config: FreeSpinsConfig {
                    spins_awarded: 5,
                    retrigger: true,
                    multiplier: 2,
                    feature_reels: None,
                },
            }],
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

    #[test]
    fn empty_bonuses_round_trips() {
        let mut model = sample_model();
        model.bonuses = vec![];
        let back = from_payload(&to_payload(&model)).unwrap();
        assert_eq!(back, model);
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
    from_payload, to_payload, BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel,
    Symbol, SymbolDef, SymbolRole, TriggerSpec,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p bloom-math slots::model`
Expected: PASS (`payload_round_trips`, `payload_is_deterministic`, `empty_bonuses_round_trips`).

- [ ] **Step 5: Commit**

```bash
git add trusted/math/Cargo.toml trusted/math/src/mechanics/slots.rs trusted/math/src/mechanics/slots/model.rs
git commit -m "feat(math): add slots@1 model schema with bonus-feature list"
```

---

### Task 2: Base spin → grid

**Files:**
- Create: `trusted/math/src/mechanics/slots/eval.rs`
- Modify: `trusted/math/src/mechanics/slots.rs`

**Interfaces:**
- Consumes: `SlotModel`, `Symbol` (Task 1); `crate::rng::SplitMix64`.
- Produces (module-internal): `spin(reels: &[Vec<Symbol>], rows: usize, rng: &mut SplitMix64) -> Vec<Vec<Symbol>>` returning `grid[reel][row]`.

- [ ] **Step 1: Write the failing test**

Create `trusted/math/src/mechanics/slots/eval.rs`:

```rust
//! `slots@1` round evaluation: grid → line/scatter payout → bonus features →
//! outcome. Integer-only and deterministic.

use super::model::*;
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
        assert_eq!(grid.len(), 3);
        assert!(grid.iter().all(|col| col.len() == 2));
        for (r, col) in grid.iter().enumerate() {
            for sym in col {
                assert!(reels[r].contains(sym));
            }
        }
    }

    #[test]
    fn spin_wraps_consecutive_cells() {
        let reels = vec![vec![10, 20, 30]];
        let mut rng = SplitMix64::new(7);
        let grid = spin(&reels, 3, &mut rng);
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
Expected: PASS (3 tests). An "unused import" warning on the `model::*` glob is expected until Task 3.

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
- Produces (module-internal): `role_of(model, sym) -> SymbolRole`, `is_wild(model, sym) -> bool`, `line_payout(model, grid, line) -> u64`.

- [ ] **Step 1: Write the failing test**

In `eval.rs` `tests` module, add:

```rust
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
            bonuses: vec![],
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

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-math slots::eval`
Expected: FAIL — `line_payout`, `role_of` not found.

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

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS (line tests + spin tests).

- [ ] **Step 5: Commit**

```bash
git add trusted/math/src/mechanics/slots/eval.rs
git commit -m "feat(math): add payline evaluation with wild substitution"
```

---

### Task 4: Symbol counting, scatter pays, per-grid payout

**Files:**
- Modify: `trusted/math/src/mechanics/slots/eval.rs`

**Interfaces:**
- Produces (module-internal): `count_symbol(grid, sym) -> usize`, `scatter_symbol(model) -> Option<Symbol>`, `scatter_payout(model, grid) -> u64`, `eval_grid(model, grid) -> u64`.

- [ ] **Step 1: Write the failing test**

In `eval.rs` `tests` module, add:

```rust
    fn scatter_model() -> SlotModel {
        let mut m = lines_model();
        m.paytable.entries.push(PaytableEntry { symbol: 9, count: 2, payout: 4 });
        m.paytable.entries.push(PaytableEntry { symbol: 9, count: 3, payout: 20 });
        m
    }

    #[test]
    fn counts_a_symbol_across_the_grid() {
        let m = scatter_model();
        let grid = vec![vec![9], vec![0], vec![9]];
        assert_eq!(count_symbol(&grid, 9), 2);
        assert_eq!(count_symbol(&grid, 0), 1);
    }

    #[test]
    fn scatter_pays_by_total_count() {
        let m = scatter_model();
        let grid = vec![vec![9], vec![0], vec![9]];
        assert_eq!(scatter_payout(&m, &grid), 4);
    }

    #[test]
    fn eval_grid_sums_lines_and_scatter() {
        let m = scatter_model();
        let grid = vec![vec![0], vec![0], vec![0]]; // line pays 10, no scatters
        assert_eq!(eval_grid(&m, &grid), 10);
        let grid2 = vec![vec![9], vec![9], vec![9]]; // line 0, scatter 20
        assert_eq!(eval_grid(&m, &grid2), 20);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-math slots::eval`
Expected: FAIL — `count_symbol`, `scatter_payout`, `eval_grid` not found.

- [ ] **Step 3: Implement**

In `eval.rs`, above the `tests` module, add:

```rust
fn count_symbol(grid: &[Vec<Symbol>], sym: Symbol) -> usize {
    grid.iter().flatten().filter(|&&s| s == sym).count()
}

fn scatter_symbol(model: &SlotModel) -> Option<Symbol> {
    model
        .symbols
        .iter()
        .find(|s| s.role == SymbolRole::Scatter)
        .map(|s| s.id)
}

fn scatter_payout(model: &SlotModel, grid: &[Vec<Symbol>]) -> u64 {
    match scatter_symbol(model) {
        Some(sc) => model.paytable.lookup(sc, count_symbol(grid, sc) as u8),
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

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add trusted/math/src/mechanics/slots/eval.rs
git commit -m "feat(math): add scatter pays and per-grid payout"
```

---

### Task 5: Bonus-feature evaluation (per-feature, frozen composition rule)

**Files:**
- Modify: `trusted/math/src/mechanics/slots/eval.rs`

**Interfaces:**
- Produces:
  - `slots::FeatureOutcome { triggered: bool, spins_played: u32, payout: u64, spins: Vec<Vec<Vec<Symbol>>> }` (exported in Task 6)
  - module-internal: `run_bonus(model, bonus, base_grid, rng) -> FeatureOutcome`, `run_free_spins(model, trigger, config, rng) -> FeatureOutcome`.

- [ ] **Step 1: Write the failing test**

In `eval.rs` `tests` module, add:

```rust
    #[test]
    fn untriggered_feature_does_nothing() {
        // Trigger needs 3 of symbol 9, base grid has none.
        let m = lines_model();
        let bonus = BonusFeature::FreeSpins {
            trigger: TriggerSpec { symbol: 9, min_count: 3 },
            config: FreeSpinsConfig { spins_awarded: 5, retrigger: false, multiplier: 2, feature_reels: None },
        };
        let base = vec![vec![0], vec![0], vec![0]];
        let mut rng = SplitMix64::new(1);
        let out = run_bonus(&m, &bonus, &base, &mut rng);
        assert!(!out.triggered);
        assert_eq!(out.spins_played, 0);
        assert_eq!(out.payout, 0);
    }

    #[test]
    fn triggered_feature_runs_spins_with_multiplier() {
        // A model where every spin pays a fixed 2; feature multiplier 3 over 4 spins.
        let m = SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }, SymbolDef { id: 9, role: SymbolRole::Scatter }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable { entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 2 }] },
            bonuses: vec![],
        };
        let trigger = TriggerSpec { symbol: 9, min_count: 1 };
        let config = FreeSpinsConfig { spins_awarded: 4, retrigger: false, multiplier: 3, feature_reels: None };
        let mut rng = SplitMix64::new(1);
        let out = run_free_spins(&m, &trigger, &config, &mut rng);
        assert!(out.triggered);
        assert_eq!(out.spins_played, 4);
        assert_eq!(out.payout, 4 * 2 * 3); // 24
        assert_eq!(out.spins.len(), 4);
    }

    #[test]
    fn retrigger_adds_spins_and_terminates() {
        // Feature reel [9,0,0,0]: scatter sometimes appears, retriggering.
        let m = SlotModel {
            symbols: vec![SymbolDef { id: 9, role: SymbolRole::Scatter }, SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 1,
            paylines: vec![],
            paytable: Paytable { entries: vec![] },
            bonuses: vec![],
        };
        let trigger = TriggerSpec { symbol: 9, min_count: 3 };
        let config = FreeSpinsConfig {
            spins_awarded: 2,
            retrigger: true,
            multiplier: 1,
            feature_reels: Some(vec![vec![9, 0, 0, 0], vec![9, 0, 0, 0], vec![9, 0, 0, 0]]),
        };
        let mut rng = SplitMix64::new(99);
        let out = run_free_spins(&m, &trigger, &config, &mut rng);
        assert!(out.spins_played >= 2);
        assert_eq!(out.spins.len() as u32, out.spins_played);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-math slots::eval`
Expected: FAIL — `run_bonus`, `run_free_spins`, `FeatureOutcome` not found.

- [ ] **Step 3: Implement (define `FeatureOutcome` + the feature runners)**

In `eval.rs`, above the `tests` module, add:

```rust
/// One bonus feature's result within a round.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureOutcome {
    pub triggered: bool,
    pub spins_played: u32,
    pub payout: u64,
    pub spins: Vec<Vec<Vec<Symbol>>>,
}

impl FeatureOutcome {
    fn untriggered() -> Self {
        FeatureOutcome { triggered: false, spins_played: 0, payout: 0, spins: Vec::new() }
    }
}

/// Evaluate ONE bonus feature against the base grid (spec §3.1: each feature
/// checks its own trigger against the base grid only).
fn run_bonus(
    model: &SlotModel,
    bonus: &BonusFeature,
    base_grid: &[Vec<Symbol>],
    rng: &mut SplitMix64,
) -> FeatureOutcome {
    match bonus {
        BonusFeature::FreeSpins { trigger, config } => {
            if count_symbol(base_grid, trigger.symbol) >= trigger.min_count as usize {
                run_free_spins(model, trigger, config, rng)
            } else {
                FeatureOutcome::untriggered()
            }
        }
    }
}

/// Run a free-spins feature. Retrigger re-checks THIS feature's own trigger
/// against each feature-spin grid (spec §3.1 — no nesting/cross-triggering).
fn run_free_spins(
    model: &SlotModel,
    trigger: &TriggerSpec,
    config: &FreeSpinsConfig,
    rng: &mut SplitMix64,
) -> FeatureOutcome {
    let reels = config.feature_reels.as_ref().unwrap_or(&model.reels);
    let mut remaining = config.spins_awarded;
    let mut spins_played: u32 = 0;
    let mut payout: u64 = 0;
    let mut spins = Vec::new();

    while remaining > 0 {
        remaining -= 1;
        spins_played += 1;
        let grid = spin(reels, model.rows, rng);
        payout += eval_grid(model, &grid) * config.multiplier;
        if config.retrigger && count_symbol(&grid, trigger.symbol) >= trigger.min_count as usize {
            remaining += config.spins_awarded;
        }
        spins.push(grid);
    }

    FeatureOutcome { triggered: true, spins_played, payout, spins }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS (feature tests + earlier tests).

- [ ] **Step 5: Commit**

```bash
git add trusted/math/src/mechanics/slots/eval.rs
git commit -m "feat(math): add per-feature bonus evaluation (free spins, retrigger)"
```

---

### Task 6: `RoundOutcome` + `evaluate` + bit-reproducibility golden vector

**Files:**
- Modify: `trusted/math/src/mechanics/slots/eval.rs`
- Modify: `trusted/math/src/mechanics/slots.rs`

**Interfaces:**
- Produces:
  - `slots::RoundOutcome { base_grid: Vec<Vec<Symbol>>, base_payout: u64, features: Vec<FeatureOutcome>, feature_payout: u64, total_payout: u64 }` with `fn any_triggered(&self) -> bool`
  - `slots::evaluate(model: &SlotModel, seed: u64) -> RoundOutcome`
  - `slots::FeatureOutcome` (from Task 5)

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
            bonuses: vec![BonusFeature::FreeSpins {
                trigger: TriggerSpec { symbol: 9, min_count: 3 },
                config: FreeSpinsConfig { spins_awarded: 3, retrigger: false, multiplier: 2, feature_reels: None },
            }],
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
    fn evaluate_total_and_features_are_consistent() {
        let m = full_model();
        for seed in 0..3000u64 {
            let o = evaluate(&m, seed);
            assert_eq!(o.total_payout, o.base_payout + o.feature_payout);
            assert_eq!(o.features.len(), 1); // one per model bonus
            let summed: u64 = o.features.iter().map(|f| f.payout).sum();
            assert_eq!(o.feature_payout, summed);
            assert_eq!(o.any_triggered(), o.features.iter().any(|f| f.triggered));
        }
    }

    #[test]
    fn evaluate_golden_vector() {
        // Pin exact outputs so any future drift fails loudly. Changing these is a
        // re-certification event (a new mechanic version), never an edit.
        let m = full_model();
        let o = evaluate(&m, 12345);
        assert_eq!(o.base_payout, GOLDEN_BASE);
        assert_eq!(o.feature_payout, GOLDEN_FEATURE);
        assert_eq!(o.features[0].spins_played, GOLDEN_SPINS);
    }

    const GOLDEN_BASE: u64 = 0; // placeholder — set from first run (Step 4)
    const GOLDEN_FEATURE: u64 = 0; // placeholder — set from first run
    const GOLDEN_SPINS: u32 = 0; // placeholder — set from first run
```

> **As-built note (drift-detection gap):** seed `12345` on `full_model()` is a
> *losing* spin, so the placeholders above stay `0` after Step 4 — an all-zero
> golden vector that an always-zero `evaluate` would also satisfy, leaving the
> winning/triggering path unasserted. The shipped test was strengthened to keep
> the losing-seed zeros as a negative control **and** pin a winning+triggering
> seed (`53` → base `8`, feature `20`, total `28`, spins `3`), plus
> `any_pay`/`any_trigger` population guards over the 3000-seed consistency loop.
> A future re-derivation should pick a *triggering* golden seed, not rely on
> `12345`.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p bloom-math slots::eval`
Expected: FAIL — `evaluate`, `RoundOutcome` not found.

- [ ] **Step 3: Implement `evaluate` + `RoundOutcome`**

In `eval.rs`, above the `tests` module, add:

```rust
/// One round's full result: the symbolic outcome ("what happened") and the
/// payout in bet-multiples ("what it paid"). Both facts, never fused (umbrella §10).
/// `features` has one entry per `model.bonuses`, in order (spec §3.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundOutcome {
    pub base_grid: Vec<Vec<Symbol>>,
    pub base_payout: u64,
    pub features: Vec<FeatureOutcome>,
    pub feature_payout: u64,
    pub total_payout: u64,
}

impl RoundOutcome {
    /// True if any bonus feature triggered this round.
    pub fn any_triggered(&self) -> bool {
        self.features.iter().any(|f| f.triggered)
    }
}

/// Expand one seed into one round. Deterministic: same `(model, seed)` always
/// yields the same `RoundOutcome`, bit-for-bit, forever. Bonus features run in
/// `model.bonuses` list order, each off the SAME PRNG stream (spec §3.1).
pub fn evaluate(model: &SlotModel, seed: u64) -> RoundOutcome {
    let mut rng = SplitMix64::new(seed);
    let base_grid = spin(&model.reels, model.rows, &mut rng);
    let base_payout = eval_grid(model, &base_grid);

    let mut features = Vec::with_capacity(model.bonuses.len());
    let mut feature_payout = 0;
    for bonus in &model.bonuses {
        let outcome = run_bonus(model, bonus, &base_grid, &mut rng);
        feature_payout += outcome.payout;
        features.push(outcome);
    }

    RoundOutcome {
        base_grid,
        base_payout,
        features,
        feature_payout,
        total_payout: base_payout + feature_payout,
    }
}
```

- [ ] **Step 4: Set the golden constants, then re-run**

Run: `cargo test -p bloom-math slots::eval::tests::evaluate_golden_vector -- --nocapture`
It FAILS on the placeholder zeros. Read the actual values from the assertion's left/right output, then replace `GOLDEN_BASE`, `GOLDEN_FEATURE`, `GOLDEN_SPINS` with those exact numbers. Re-run:

Run: `cargo test -p bloom-math slots::eval`
Expected: PASS (all eval tests, including the pinned golden vector).

- [ ] **Step 5: Export `evaluate`, `RoundOutcome`, `FeatureOutcome`**

In `trusted/math/src/mechanics/slots.rs`, extend the re-exports:

```rust
pub use eval::{evaluate, FeatureOutcome, RoundOutcome};
pub use model::{
    from_payload, to_payload, BonusFeature, FreeSpinsConfig, Paytable, PaytableEntry, SlotModel,
    Symbol, SymbolDef, SymbolRole, TriggerSpec,
};
```

- [ ] **Step 6: Run the whole math suite + commit**

Run: `cargo test -p bloom-math`
Expected: PASS.

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
- Produces:
  - `bloom_simulator::measure::RoundSample { seed: u64, payout: u64, base_payout: u64, feature_payout: u64, feature_triggers: Vec<bool> }` (derives `Clone, PartialEq` — NOT `Copy`, it holds a `Vec`)
  - `bloom_simulator::measure::simulate(model: &SlotModel, seeds: &[u64]) -> Vec<RoundSample>`

- [ ] **Step 1: Write the failing test**

Create `studio/simulator/src/measure.rs`:

```rust
//! Simulate rounds through the math engine and measure aggregate characteristics.

use bloom_math::mechanics::slots::{evaluate, SlotModel};
use rayon::prelude::*;

#[derive(Debug, Clone, PartialEq)]
pub struct RoundSample {
    pub seed: u64,
    pub payout: u64,
    pub base_payout: u64,
    pub feature_payout: u64,
    /// Whether each model bonus (in order) triggered this round.
    pub feature_triggers: Vec<bool>,
}

/// Evaluate every seed through the math engine, in parallel. Output order
/// matches `seeds` (rayon `map` preserves order).
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
                feature_triggers: o.features.iter().map(|f| f.triggered).collect(),
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
            bonuses: vec![],
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
    fn simulate_reports_payout_and_no_features() {
        let m = toy();
        let out = simulate(&m, &[10, 20, 30]);
        assert!(out.iter().all(|s| s.payout == 1));
        assert!(out.iter().all(|s| s.feature_triggers.is_empty()));
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

### Task 9: Measure → Metrics (per-feature hit-rates, RTP convergence)

**Files:**
- Create: `studio/simulator/src/target.rs`
- Modify: `studio/simulator/src/measure.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**
- Produces:
  - `bloom_simulator::target::Metrics { rtp: f64, volatility: f64, hit_frequency: f64, bonus_hit_rates: Vec<f64>, base_rtp: f64, feature_rtp: f64 }` (derives `Clone, PartialEq` — NOT `Copy`)
  - `bloom_simulator::measure::measure(samples: &[RoundSample]) -> Metrics`

- [ ] **Step 1: Create the metrics type**

Create `studio/simulator/src/target.rs`:

```rust
//! Target spec (desired characteristics) and measured metrics.

/// Measured characteristics over a simulated population. Floats are fine here —
/// this is studio measurement, never the certified outcome path.
#[derive(Debug, Clone, PartialEq)]
pub struct Metrics {
    /// Return to player: mean payout (bet-multiples) per spin.
    pub rtp: f64,
    /// Std-dev of per-spin payout (a volatility index).
    pub volatility: f64,
    /// Fraction of spins that pay > 0.
    pub hit_frequency: f64,
    /// Fraction of spins that trigger each bonus feature (one per model bonus).
    pub bonus_hit_rates: Vec<f64>,
    /// RTP contributed by the base game.
    pub base_rtp: f64,
    /// RTP contributed by all features.
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
        // paytable: sym1 count1 -> 1 ; sym2 count1 -> 5. Closed-form RTP = 0.9.
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
            bonuses: vec![],
        }
    }

    #[test]
    fn rtp_converges_to_closed_form() {
        let m = measurable();
        let seeds = crate::seedgen::generate_seeds(2026, 1_000_000);
        let metrics: Metrics = measure(&simulate(&m, &seeds));
        assert!((metrics.rtp - 0.9).abs() < 0.02, "rtp = {}", metrics.rtp);
        assert!(metrics.hit_frequency > 0.0 && metrics.hit_frequency < 1.0);
        assert!(metrics.bonus_hit_rates.is_empty()); // no bonuses
        assert!((metrics.base_rtp - metrics.rtp).abs() < 1e-9);
    }
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p bloom-simulator measure::tests::rtp_converges_to_closed_form`
Expected: FAIL — `measure` not found.

- [ ] **Step 4: Implement `measure`**

In `measure.rs`, add at the top level (below the existing imports add a metrics import, then the function):

```rust
use crate::target::Metrics;

/// Aggregate a population of samples into measured characteristics.
pub fn measure(samples: &[RoundSample]) -> Metrics {
    let n = samples.len() as f64;
    assert!(n > 0.0, "cannot measure an empty population");

    let mean = |f: fn(&RoundSample) -> u64| samples.iter().map(|s| f(s) as f64).sum::<f64>() / n;

    let rtp = mean(|s| s.payout);
    let base_rtp = mean(|s| s.base_payout);
    let feature_rtp = mean(|s| s.feature_payout);

    let variance = samples
        .iter()
        .map(|s| {
            let d = s.payout as f64 - rtp;
            d * d
        })
        .sum::<f64>()
        / n;

    let feature_count = samples[0].feature_triggers.len();
    let bonus_hit_rates = (0..feature_count)
        .map(|i| samples.iter().filter(|s| s.feature_triggers[i]).count() as f64 / n)
        .collect();

    Metrics {
        rtp,
        volatility: variance.sqrt(),
        hit_frequency: samples.iter().filter(|s| s.payout > 0).count() as f64 / n,
        bonus_hit_rates,
        base_rtp,
        feature_rtp,
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p bloom-simulator measure`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/simulator/src/target.rs studio/simulator/src/measure.rs studio/simulator/src/lib.rs
git commit -m "feat(sim): measure RTP, volatility, per-feature hit-rate, RTP split"
```

---

### Task 10: Verify metrics against targets

**Files:**
- Modify: `studio/simulator/src/target.rs`
- Create: `studio/simulator/src/run.rs`
- Modify: `studio/simulator/src/lib.rs`

**Interfaces:**
- Produces:
  - `bloom_simulator::target::HitRateBand { min: f64, max: f64 }`
  - `bloom_simulator::target::TargetSpec { rtp_target: f64, rtp_tolerance: f64, volatility_min: f64, volatility_max: f64, bonus_hit_rate_bands: Vec<HitRateBand>, pool_size: usize, candidate_count: usize, realized_correction_band: f64 }` (derives `Clone` — NOT `Copy`)
  - `bloom_simulator::run::verify(metrics: &Metrics, target: &TargetSpec) -> Result<(), Metrics>` (Err carries the failing metrics; asserts band/feature count match)

- [ ] **Step 1: Add `HitRateBand` + `TargetSpec`**

In `studio/simulator/src/target.rs`, add:

```rust
/// An acceptable inclusive range for one feature's hit-rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitRateBand {
    pub min: f64,
    pub max: f64,
}

/// Desired characteristics + curation parameters for a curation run.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetSpec {
    pub rtp_target: f64,
    pub rtp_tolerance: f64,
    pub volatility_min: f64,
    pub volatility_max: f64,
    /// One band per feature in `model.bonuses`, in order.
    pub bonus_hit_rate_bands: Vec<HitRateBand>,
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

use crate::target::{HitRateBand, Metrics, TargetSpec};

/// Check measured metrics against the target bands (RTP, volatility, and EACH
/// feature's hit-rate). Err carries the metrics so the caller (human / future
/// tuner) can see what missed. The band count must equal the feature count.
pub fn verify(metrics: &Metrics, target: &TargetSpec) -> Result<(), Metrics> {
    assert_eq!(
        target.bonus_hit_rate_bands.len(),
        metrics.bonus_hit_rates.len(),
        "target must provide one hit-rate band per model bonus"
    );

    let rtp_ok = (metrics.rtp - target.rtp_target).abs() <= target.rtp_tolerance;
    let vol_ok =
        metrics.volatility >= target.volatility_min && metrics.volatility <= target.volatility_max;
    let bonuses_ok = target
        .bonus_hit_rate_bands
        .iter()
        .zip(&metrics.bonus_hit_rates)
        .all(|(band, &rate)| rate >= band.min && rate <= band.max);

    if rtp_ok && vol_ok && bonuses_ok {
        Ok(())
    } else {
        Err(metrics.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(bands: Vec<HitRateBand>) -> TargetSpec {
        TargetSpec {
            rtp_target: 0.96,
            rtp_tolerance: 0.01,
            volatility_min: 1.0,
            volatility_max: 10.0,
            bonus_hit_rate_bands: bands,
            pool_size: 100,
            candidate_count: 1000,
            realized_correction_band: 0.05,
        }
    }

    fn metrics(rtp: f64, vol: f64, bonus: Vec<f64>) -> Metrics {
        Metrics { rtp, volatility: vol, hit_frequency: 0.3, bonus_hit_rates: bonus, base_rtp: rtp, feature_rtp: 0.0 }
    }

    #[test]
    fn within_all_bands_passes() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.02]), &t).is_ok());
    }

    #[test]
    fn rtp_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.80, 3.0, vec![]), &t).is_err());
    }

    #[test]
    fn volatility_out_of_band_fails() {
        let t = target(vec![]);
        assert!(verify(&metrics(0.955, 0.5, vec![]), &t).is_err());
    }

    #[test]
    fn feature_hit_rate_out_of_band_fails() {
        let t = target(vec![HitRateBand { min: 0.0, max: 0.05 }]);
        assert!(verify(&metrics(0.955, 3.0, vec![0.20]), &t).is_err());
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
git commit -m "feat(sim): verify metrics against RTP, volatility, per-feature bands"
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
//! Freeze a faithful seed pool (Approach A2). Start from a faithful sample (the
//! first `pool_size` candidates) and apply only minimal, bounded swaps to land
//! realized RTP within tolerance — never reshaping beyond the correction band.

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
        RoundSample { seed, payout, base_payout: payout, feature_payout: 0, feature_triggers: vec![] }
    }

    fn spec(pool_size: usize, rtp_target: f64) -> TargetSpec {
        TargetSpec {
            rtp_target,
            rtp_tolerance: 0.001,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![],
            pool_size,
            candidate_count: 0,
            realized_correction_band: 0.05,
        }
    }

    #[test]
    fn faithful_sample_already_on_target_needs_no_swaps() {
        let samples: Vec<_> = (0..10).map(|i| sample(i, if i % 2 == 0 { 0 } else { 2 })).collect();
        let pool = freeze_pool(&samples, &spec(10, 1.0), 1.0).unwrap();
        assert_eq!(pool.seeds.len(), 10);
        assert!((pool.realized_rtp - 1.0).abs() <= 0.001);
    }

    #[test]
    fn swaps_nudge_realized_toward_target() {
        // pool of first 4 = payouts [0,0,0,0] -> realized 0.0; reserve has 2s.
        let mut samples: Vec<_> = (0..4).map(|i| sample(i, 0)).collect();
        samples.extend((4..12).map(|i| sample(i, 2)));
        // model_rtp ~ (0*4 + 2*8)/12 = 1.333; target 1.0 within band 0.05? |1.0-1.333|=0.333 > 0.05
        // so use a model_rtp close to target to allow correction:
        let pool = freeze_pool(&samples, &spec(4, 1.0), 1.0).unwrap();
        assert!((pool.realized_rtp - 1.0).abs() <= 0.001, "got {}", pool.realized_rtp);
    }

    #[test]
    fn refuses_correction_beyond_band() {
        // model_rtp 0.0, target 1.0 -> needs to move 1.0 >> band 0.05.
        let samples: Vec<_> = (0..8).map(|i| sample(i, if i < 4 { 0 } else { 2 })).collect();
        let err = freeze_pool(&samples, &spec(4, 1.0), 0.0).unwrap_err();
        assert!(matches!(err, CurateError::OutsideCorrectionBand { .. }));
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

    let mut pool: Vec<usize> = (0..p).collect();
    let mut reserve: Vec<usize> = (p..samples.len()).collect();
    let mut sum: u64 = pool.iter().map(|&i| samples[i].payout).sum();

    let realized = |sum: u64| sum as f64 / p as f64;

    // Honesty guardrail (Approach A2): curation may only correct toward a target
    // that is itself within `realized_correction_band` of the model's measured RTP.
    // Checked against the TARGET (not the moving realized `r`) so a faithful sample
    // whose starting RTP is far from model_rtp can still be corrected *toward*
    // honesty. (An earlier draft checked `(r - model_rtp)` inside the loop, which
    // spuriously failed before any corrective swap when the faithful sample started
    // far from model_rtp.)
    if (target.rtp_target - model_rtp).abs() > target.realized_correction_band {
        return Err(CurateError::OutsideCorrectionBand {
            needed: (target.rtp_target - model_rtp).abs(),
            band: target.realized_correction_band,
        });
    }

    loop {
        let r = realized(sum);
        if (r - target.rtp_target).abs() <= target.rtp_tolerance {
            break;
        }

        let raise = r < target.rtp_target;
        // Pick the pool slot + reserve slot whose swap moves sum most in the
        // needed direction (deterministic: ties resolved by lowest index).
        let pool_pick = if raise {
            pool.iter().enumerate().min_by_key(|&(_, &i)| samples[i].payout)
        } else {
            pool.iter().enumerate().max_by_key(|&(_, &i)| samples[i].payout)
        };
        let res_pick = if raise {
            reserve.iter().enumerate().max_by_key(|&(_, &i)| samples[i].payout)
        } else {
            reserve.iter().enumerate().min_by_key(|&(_, &i)| samples[i].payout)
        };

        let (Some((pi, &pidx)), Some((ri, &ridx))) = (pool_pick, res_pick) else {
            break;
        };

        let out_payout = samples[pidx].payout;
        let in_payout = samples[ridx].payout;
        let helps = if raise { in_payout > out_payout } else { in_payout < out_payout };
        if !helps {
            break;
        }

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

- [ ] **Step 1: Extend imports + write the failing test**

At the top of `run.rs`, replace the import line with:

```rust
use crate::curate::{freeze_pool, CurateError, Pool};
use crate::measure::{measure, simulate};
use crate::seedgen::generate_seeds;
use crate::target::{HitRateBand, Metrics, TargetSpec};
use bloom_math::mechanics::slots::{to_payload, SlotModel};
use bloom_package::{build, Envelope, PackageContent};
use ed25519_dalek::SigningKey;
```

In `run.rs` `tests` module, add:

```rust
    use bloom_math::mechanics::slots::{
        evaluate, from_payload, Paytable, PaytableEntry, SlotModel, SymbolDef, SymbolRole,
    };
    use bloom_package::verify_and_load;
    use ed25519_dalek::SigningKey;

    fn measurable_model() -> SlotModel {
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
            bonuses: vec![],
        }
    }

    fn target_09() -> TargetSpec {
        TargetSpec {
            rtp_target: 0.9,
            rtp_tolerance: 0.02,
            volatility_min: 0.0,
            volatility_max: 1e9,
            bonus_hit_rate_bands: vec![], // no bonuses in this model
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
        let content = verify_and_load(&out.package_bytes, &key().verifying_key()).expect("loads");
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
        let out = run_curation(&measurable_model(), &target_09(), 2026, "pkg-test", &key()).unwrap();
        let content = verify_and_load(&out.package_bytes, &key().verifying_key()).unwrap();
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
        assert!(matches!(err, RunError::VerifyFailed(_)));
    }
```

> Note: the `HitRateBand` import in the top-level `use` is consumed by callers/tests that build bands; if the compiler flags it unused in `run.rs` itself, drop it from the top-level `use` (it remains available via `crate::target`).

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

    let bonus_rates = metrics
        .bonus_hit_rates
        .iter()
        .enumerate()
        .map(|(i, r)| format!("bonus_hit_rate[{i}]={r:.5}"))
        .collect::<Vec<_>>()
        .join("\n");

    let report = format!(
        "package_id={package_id}\nmechanic=slots@1\nmaster_seed={master_seed}\n\
         candidate_count={}\npool_size={}\n\
         measured_rtp={:.5}\nrealized_rtp={:.5}\nvolatility={:.5}\n\
         hit_frequency={:.5}\nbase_rtp={:.5}\nfeature_rtp={:.5}\n{}\n",
        target.candidate_count,
        target.pool_size,
        metrics.rtp,
        pool.realized_rtp,
        metrics.volatility,
        metrics.hit_frequency,
        metrics.base_rtp,
        metrics.feature_rtp,
        bonus_rates,
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
- Consumes: `bloom_simulator::run::run_curation`, `bloom_simulator::target::{TargetSpec, HitRateBand}`, `serde_json`.

- [ ] **Step 1: Write the binary**

Create `studio/simulator/src/bin/curate.rs`:

```rust
//! CLI: read a slot model JSON + a target JSON, run a curation, write the
//! signed package and the provenance report to disk.
//!
//! Usage: curate <model.json> <target.json> <package_id> <out.pkg> <out.report.txt>
//!
//! The model JSON matches `SlotModel` (serde). Bonus features use serde's
//! external tagging, e.g.:
//!   "bonuses": [ { "FreeSpins": { "trigger": {"symbol":9,"min_count":3},
//!                                 "config": {"spins_awarded":10,"retrigger":true,
//!                                            "multiplier":2,"feature_reels":null} } } ]
//!
//! NOTE: the demo signing key is fixed and for development only. Real signing
//! keys are a sign-off-gate concern (umbrella §9), out of scope here.

use bloom_math::mechanics::slots::SlotModel;
use bloom_simulator::run::run_curation;
use bloom_simulator::target::{HitRateBand, TargetSpec};
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use std::fs;

#[derive(Deserialize)]
struct BandJson {
    min: f64,
    max: f64,
}

#[derive(Deserialize)]
struct TargetJson {
    rtp_target: f64,
    rtp_tolerance: f64,
    volatility_min: f64,
    volatility_max: f64,
    bonus_hit_rate_bands: Vec<BandJson>,
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
        bonus_hit_rate_bands: tj
            .bonus_hit_rate_bands
            .iter()
            .map(|b| HitRateBand { min: b.min, max: b.max })
            .collect(),
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

Create a throwaway `scratch-model.json` (the `measurable_model` shape: `"bonuses": []`, RTP ~0.9) and `scratch-target.json` (the `target_09` shape with `"bonus_hit_rate_bands": []` and a `"master_seed"`), then:

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
- Model schema incl. `bonuses: Vec<BonusFeature>` + per-feature trigger (spec §3) → Task 1. ✓
- Frozen §3.1 composition rule (independent triggers, list order, sum, retrigger-same-feature, no nesting) → Tasks 5–6 + Global Constraints. ✓
- Enriched kernel `evaluate` with grid/lines/scatter/per-feature bonuses + per-feature breakdown (spec §4) → Tasks 2–6. ✓
- Integer-only / determinism + bit-reproducibility golden vector (spec §2.2, §6) → Task 6. ✓
- Simulator generate → simulate (parallel) → measure (per-feature hit-rates) → verify (per-feature bands) → freeze → build+sign (spec §5) → Tasks 7–12. ✓
- Approach A faithfulness + honesty guardrail (spec §2.1) → Task 11. ✓
- Verify-fails-loudly, no silent reshaping (spec §5 step 4, §6) → Tasks 10, 12. ✓
- Provenance report as separate artifact, package untouched (spec §5 step 6 + Global Constraints) → Task 12. ✓
- Freeze-boundary + reproducible curation (spec §6) → Task 12. ✓
- `BonusFeature` enum seam / no arbitration machinery (spec §7, §8) → labels only; one variant, one match arm; arbitration explicitly absent. ✓
- First-cut defaults (spec §9) → `TargetSpec` inputs + CLI JSON, not hardcoded. ✓

**Placeholder scan:** The only intentional placeholders are the golden-vector constants in Task 6, filled from the first green run (explicit step). No other "TBD"/"add error handling"/"similar to Task N" placeholders.

**Type consistency:** `RoundSample` (with `feature_triggers: Vec<bool>`), `Metrics` (with `bonus_hit_rates: Vec<f64>`), `TargetSpec` (with `bonus_hit_rate_bands: Vec<HitRateBand>`), `HitRateBand`, `Pool`, `CurateError`, `RunError`, `CurationOutput`, `FeatureOutcome`, `RoundOutcome` are each defined once and referenced consistently. `Copy` is intentionally dropped from `RoundSample`/`Metrics`/`TargetSpec` (they hold `Vec`s); `verify` clones `Metrics` on the error path. Kernel names (`evaluate`, `RoundOutcome.features`, `to_payload`, `from_payload`) match between `trusted/math` (Tasks 1, 5, 6) and simulator consumption (Tasks 8, 9, 12).
