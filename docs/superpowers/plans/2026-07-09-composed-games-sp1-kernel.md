# Composed Games SP1 — Kernel `composed@1` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `composed@1` mechanic family to `bloom-math`: composable Mechanics (`reels@1`, `meter@1`), Game States with step scripts, a game-level transition table, and a deterministic lifecycle trace — proven by golden vectors on a Base→FS1→FS2 proof game.

**Architecture:** A Game Definition (JSON) is `compile`d into a `CompiledGame` (typed configs, resolved indices, parsed effects — all validation up front), then `evaluate(&CompiledGame, seed)` walks states from `start`, running each state's ordered trigger script against a single SplitMix64 stream and consulting the transition table after each step, emitting a `RoundTrace`. Shared grid math is extracted from `slots@1` into a `components` module both families call; `slots@1` behavior is bit-frozen by its existing golden tests.

**Tech Stack:** Rust 2021, `bloom-math` crate only (`trusted/math`). Deps: existing `serde`/`postcard` + **new** `serde_json = "1"`.

**Spec:** `docs/superpowers/specs/2026-07-09-composed-games-mechanics-states-design.md`

## Global Constraints

- Work in worktree `C:\code\bloom.wt\composed-games`, branch `feat/composed-games`. Run all commands from that directory.
- Determinism is sacred (`trusted/AGENTS.md`): integer-only, `SplitMix64` is the only RNG, no floats, no HashMap iteration order dependence, same `(definition, seed)` → bit-identical trace forever.
- `slots@1` behavior and payload encoding MUST NOT change. Its existing tests — especially `evaluate_golden_vector` — pass unchanged in every task. Re-exports keep all public paths (`mechanics::slots::model::*`) identical.
- Append-only doctrine applies per mechanic type version: `reels@1`/`meter@1`/`composed@1` are frozen once merged (spec §4 doctrine amendment).
- `composed@1` payload is **JSON** (not postcard): mechanic configs are per-type schemas carried as `serde_json::Value`, and postcard is non-self-describing (cannot decode `Value`). `serde_json`'s default `Map` is a BTreeMap → sorted keys → deterministic bytes.
- Trace `seed` serializes as a **string** (u64 > 2^53 breaks JS consumers — runtime-server SP2 lesson).
- Gates before every commit: `cargo test -p bloom-math`, and in the final task `cargo fmt --all -- --check` + `cargo clippy -p bloom-math --all-targets -- -D warnings` (CI enforces fmt+clippy; run locally, not just tests).
- Windows gotcha: cargo error `os error 4551` on a build script = App Control blocked a stale artifact → `rm -rf target/*/build/<crate>-*` and rebuild.
- Commits use semantic format, e.g. `feat(math): ...`.

---

### Task 1: Extract shared grid components from `slots@1`

**Files:**

- Create: `trusted/math/src/components.rs`
- Modify: `trusted/math/src/lib.rs` (add `pub mod components;`)
- Modify: `trusted/math/src/mechanics/slots/model.rs` (types become re-exports)
- Modify: `trusted/math/src/mechanics/slots/eval.rs` (delegate to components)

**Interfaces:**

- Consumes: `crate::rng::SplitMix64` (existing).
- Produces (later tasks use these exact signatures):
  - `pub type Symbol = u8;` and types `SymbolRole`, `SymbolDef`, `PaytableEntry`, `Paytable` (moved verbatim from `slots/model.rs`, same serde derives — postcard is field-order-based, so `slots@1` payloads are unchanged).
  - `pub fn spin(reels: &[Vec<Symbol>], rows: usize, rng: &mut SplitMix64) -> Vec<Vec<Symbol>>`
  - `pub fn count_symbol(grid: &[Vec<Symbol>], sym: Symbol) -> usize`
  - `pub fn eval_grid(symbols: &[SymbolDef], paylines: &[Vec<usize>], paytable: &Paytable, grid: &[Vec<Symbol>]) -> u64`

- [ ] **Step 1: Create `components.rs` with moved code**

Move from `slots/model.rs`: `Symbol`, `SymbolRole`, `SymbolDef`, `PaytableEntry`, `Paytable` (+ `impl Paytable::lookup`) — bodies verbatim. Move from `slots/eval.rs`: `spin`, `count_symbol` — verbatim; and re-parameterize the model-taking helpers onto slices:

```rust
//! Shared slot-grid primitives — "components" in the composed-games sense
//! (spec §2): plain code, not registered units. Both `slots@1` and
//! `composed@1` call these. Behavior is frozen — the `slots@1` golden
//! vector pins it bit-for-bit.

use crate::rng::SplitMix64;
use serde::{Deserialize, Serialize};

// ... Symbol, SymbolRole, SymbolDef, PaytableEntry, Paytable moved verbatim ...

// spin() and count_symbol() moved verbatim from slots/eval.rs (make pub).

fn role_of(symbols: &[SymbolDef], sym: Symbol) -> SymbolRole {
    symbols
        .iter()
        .find(|s| s.id == sym)
        .map(|s| s.role)
        .unwrap_or(SymbolRole::Normal)
}

fn is_wild(symbols: &[SymbolDef], sym: Symbol) -> bool {
    role_of(symbols, sym) == SymbolRole::Wild
}

/// Left-aligned run payout for one payline. Wild substitutes; the paying
/// symbol is the first non-wild on the line (all-wild lines pay as that wild).
pub fn line_payout(
    symbols: &[SymbolDef],
    paytable: &Paytable,
    grid: &[Vec<Symbol>],
    line: &[usize],
) -> u64 {
    let syms: Vec<Symbol> = line
        .iter()
        .enumerate()
        .map(|(reel, &row)| grid[reel][row])
        .collect();

    let target = syms
        .iter()
        .copied()
        .find(|&s| !is_wild(symbols, s))
        .unwrap_or(syms[0]);

    if role_of(symbols, target) == SymbolRole::Scatter {
        return 0; // scatters never pay on lines
    }

    let mut count: u8 = 0;
    for &s in &syms {
        if s == target || is_wild(symbols, s) {
            count += 1;
        } else {
            break;
        }
    }
    paytable.lookup(target, count)
}

fn scatter_symbol(symbols: &[SymbolDef]) -> Option<Symbol> {
    symbols
        .iter()
        .find(|s| s.role == SymbolRole::Scatter)
        .map(|s| s.id)
}

fn scatter_payout(symbols: &[SymbolDef], paytable: &Paytable, grid: &[Vec<Symbol>]) -> u64 {
    match scatter_symbol(symbols) {
        Some(sc) => paytable.lookup(sc, count_symbol(grid, sc) as u8),
        None => 0,
    }
}

/// Total payout for one grid: all paylines plus scatter pays (bet-multiples).
pub fn eval_grid(
    symbols: &[SymbolDef],
    paylines: &[Vec<usize>],
    paytable: &Paytable,
    grid: &[Vec<Symbol>],
) -> u64 {
    let lines: u64 = paylines
        .iter()
        .map(|line| line_payout(symbols, paytable, grid, line))
        .sum();
    lines + scatter_payout(symbols, paytable, grid)
}
```

Move the pure-helper unit tests from `slots/eval.rs` (`spin_*`, `three_of_a_kind_pays`, `wild_substitutes_in_a_run`, `run_breaks_on_mismatch`, `scatter_does_not_pay_on_a_line`, `counts_a_symbol_across_the_grid`, `scatter_pays_by_total_count`, `eval_grid_sums_lines_and_scatter`) into `components.rs`'s test module, adapting `lines_model()`/`scatter_model()` helpers to build `(Vec<SymbolDef>, Vec<Vec<usize>>, Paytable)` tuples instead of a `SlotModel`. Move `Paytable`'s payload/lookup coverage stays where it is (slots model tests are unchanged).

- [ ] **Step 2: Slim `slots/model.rs` and `slots/eval.rs` to delegates**

`slots/model.rs`: delete the moved type definitions, add at top:

```rust
pub use crate::components::{Paytable, PaytableEntry, Symbol, SymbolDef, SymbolRole};
```

(All existing paths like `mechanics::slots::model::SlotModel`/`Paytable` keep working; `SlotModel`, `TriggerSpec`, `FreeSpinsConfig`, `BonusFeature`, `to_payload`, `from_payload` and the model tests stay put.)

`slots/eval.rs`: delete moved functions and their tests; replace with private wrappers so the rest of the file is textually unchanged:

```rust
use crate::components;

fn spin(reels: &[Vec<Symbol>], rows: usize, rng: &mut SplitMix64) -> Vec<Vec<Symbol>> {
    components::spin(reels, rows, rng)
}

fn count_symbol(grid: &[Vec<Symbol>], sym: Symbol) -> usize {
    components::count_symbol(grid, sym)
}

fn eval_grid(model: &SlotModel, grid: &[Vec<Symbol>]) -> u64 {
    components::eval_grid(&model.symbols, &model.paylines, &model.paytable, grid)
}
```

Add `pub mod components;` to `lib.rs`.

- [ ] **Step 3: Run the full suite — the frozen `slots@1` behavior is the test**

Run: `cargo test -p bloom-math`
Expected: ALL existing tests pass, including `evaluate_golden_vector` (seed 53 → base 8 / feature 20 / total 28) with **zero changes to any assertion**. If any golden value shifts, the extraction changed behavior — fix the extraction, never the test.

- [ ] **Step 4: Commit**

```bash
git add -A trusted/math
git commit -m "refactor(math): extract shared grid components from slots@1"
```

---

### Task 2: `composed` module scaffold + Game Definition wire types

**Files:**

- Modify: `trusted/math/Cargo.toml` (add `serde_json = "1"` to `[dependencies]`)
- Modify: `trusted/math/src/mechanics/mod.rs` (add `pub mod composed;`)
- Create: `trusted/math/src/mechanics/composed.rs`
- Create: `trusted/math/src/mechanics/composed/definition.rs`

**Interfaces:**

- Produces: `GameDefinition { family, mechanics: Vec<MechanicDecl>, states: Vec<StateDef>, start, transitions: Vec<TransitionRow>, caps: Caps }` and submembers exactly as below; `pub const FAMILY: &str = "composed@1"`; `to_payload(&GameDefinition) -> Vec<u8>`; `from_payload(&[u8]) -> Result<GameDefinition, serde_json::Error>`. Tasks 6/8/11 build definitions with these exact field names.

- [ ] **Step 1: Write the failing test** (in `definition.rs`'s test module)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub fn sample_def_json() -> serde_json::Value {
        json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "main_reels", "type": "reels@1",
                  "config": { "strips": [[0,1,9,0,0],[0,0,9,1,0],[9,0,1,0,0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"},{"id":1,"role":"wild"},{"id":9,"role":"scatter"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [{"symbol":0,"count":3,"payout":5},{"symbol":9,"count":3,"payout":8}] },
                              "events": [{"symbol":9,"min_count":3,"emit":"scatters:3"}] } },
                { "id": "bonus_meter", "type": "meter@1",
                  "config": { "target": 4, "count_symbol": 9 } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [ { "mechanic": "main_reels" }, { "mechanic": "bonus_meter" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" } ] },
                { "id": "fs1",
                  "bindings": [ { "mechanic": "main_reels", "override": { "multiplier": 2 } },
                                { "mechanic": "bonus_meter" } ],
                  "steps": { "budget": "awarded", "initial": 3 },
                  "script": [ { "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" } ] }
            ],
            "start": "base",
            "transitions": [
                { "from": "base", "on": "scatters:3", "to": "fs1" },
                { "from": "fs1", "on": "scatters:3", "effect": "steps:add:2" }
            ],
            "caps": { "max_steps": 50 }
        })
    }

    #[test]
    fn definition_json_round_trips() {
        let def: GameDefinition = serde_json::from_value(sample_def_json()).expect("parses");
        assert_eq!(def.family, FAMILY);
        assert_eq!(def.mechanics.len(), 2);
        assert_eq!(def.mechanics[0].kind, "reels@1");
        assert_eq!(def.states[1].steps.budget, BudgetSpec::Keyword("awarded".into()));
        assert_eq!(def.states[1].steps.initial, Some(3));
        assert_eq!(def.transitions[1].effect.as_deref(), Some("steps:add:2"));
        assert_eq!(def.transitions[1].to, None);
        let back: GameDefinition =
            serde_json::from_value(serde_json::to_value(&def).unwrap()).unwrap();
        assert_eq!(back, def);
    }

    #[test]
    fn payload_round_trips_and_is_deterministic() {
        let def: GameDefinition = serde_json::from_value(sample_def_json()).unwrap();
        let bytes = to_payload(&def);
        assert_eq!(bytes, to_payload(&def));
        let back = from_payload(&bytes).expect("round-trips");
        assert_eq!(back, def);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-math composed`
Expected: FAIL to compile — module and types don't exist.

- [ ] **Step 3: Write the wire types**

`trusted/math/src/mechanics/composed.rs`:

```rust
//! Mechanic family #2: composed games (`composed@1`).
//!
//! Doctrine amendment (spec §4, 2026-07-09-composed-games): inside this
//! family, composition IS the framework. Append-only applies per mechanic
//! type version — `reels@1`/`meter@1` are frozen once shipped; a behavior
//! change is a new type version. `slots@1` is untouched.

pub mod definition;

pub use definition::{from_payload, to_payload, GameDefinition, FAMILY};
```

Add `pub mod composed;` to `mechanics/mod.rs` (keep its append-only doc comment; it now also covers per-type versions inside `composed`).

`definition.rs` — pure wire shapes; ALL semantics live in `compile` (Task 6):

```rust
//! The `composed@1` Game Definition — shared artifact #1 (spec §3).
//! Pure serde wire shapes; all validation/semantics live in `compile`.
//! Payload is JSON, not postcard: per-mechanic configs travel as
//! `serde_json::Value`, which postcard (non-self-describing) cannot decode.
//! serde_json maps are BTreeMaps → sorted keys → deterministic bytes.

use serde::{Deserialize, Serialize};

pub const FAMILY: &str = "composed@1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameDefinition {
    pub family: String,
    pub mechanics: Vec<MechanicDecl>,
    pub states: Vec<StateDef>,
    pub start: String,
    pub transitions: Vec<TransitionRow>,
    pub caps: Caps,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MechanicDecl {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateDef {
    pub id: String,
    pub bindings: Vec<Binding>,
    pub steps: StepsSpec,
    pub script: Vec<ScriptEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub mechanic: String,
    #[serde(rename = "override", default, skip_serializing_if = "Option::is_none")]
    pub config_override: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StepsSpec {
    pub budget: BudgetSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial: Option<u32>,
}

/// `"budget": 1` or `"budget": "awarded"` — resolved/validated in compile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BudgetSpec {
    Fixed(u32),
    Keyword(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScriptEntry {
    pub invoke: String, // "<instance_id>.<trigger>"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionRow {
    pub from: String,
    pub on: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caps {
    pub max_steps: u32,
}

/// Serialize a definition into the package `math_payload` (JSON, deterministic).
pub fn to_payload(def: &GameDefinition) -> Vec<u8> {
    serde_json::to_vec(def).expect("GameDefinition is always serializable")
}

/// Deserialize a definition from a package `math_payload`.
pub fn from_payload(bytes: &[u8]) -> Result<GameDefinition, serde_json::Error> {
    serde_json::from_slice(bytes)
}
```

Add to `trusted/math/Cargo.toml` `[dependencies]`: `serde_json = "1"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-math composed`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): composed@1 game-definition wire types + JSON payload"
```

---

### Task 3: Mechanic contract — trait, StepCtx, TriggerData, registry

**Files:**

- Create: `trusted/math/src/mechanics/composed/mechanic.rs`
- Create: `trusted/math/src/mechanics/composed/reels.rs` (config struct only, this task)
- Create: `trusted/math/src/mechanics/composed/meter.rs` (config struct only, this task)
- Modify: `trusted/math/src/mechanics/composed.rs` (add `pub mod mechanic; pub mod meter; pub mod reels;`)

**Interfaces:**

- Consumes: `crate::components::{Symbol, SymbolDef, Paytable}`, `crate::rng::SplitMix64`.
- Produces (exact — Tasks 4–10 depend on these):
  - `pub type Event = String;`
  - `pub struct StepCtx { pub grid: Option<Vec<Vec<Symbol>>>, pub events: Vec<Event>, pub payout: u64 }` with `StepCtx::new()`
  - `pub enum TriggerData { Reels { grid: Vec<Vec<Symbol>>, payout: u64 }, Meter { fill: u32, target: u32 } }` (serde: `#[serde(tag = "kind", rename_all = "lowercase")]`)
  - `pub struct InvokeOutcome { pub events: Vec<Event>, pub data: TriggerData }`
  - `pub trait Mechanic { fn invoke(&mut self, trigger: &str, config: &MechanicConfig, ctx: &mut StepCtx, rng: &mut SplitMix64) -> InvokeOutcome; }`
  - `pub enum MechanicConfig { Reels(ReelsConfig), Meter(MeterConfig) }`
  - `pub enum MechanicKind { Reels, Meter }` with `parse(&str) -> Option<Self>`, `triggers(self) -> &'static [&'static str]`, `instantiate(self) -> Box<dyn Mechanic>`, `parse_config(self, &serde_json::Value) -> Result<MechanicConfig, String>`
  - `reels.rs`: `pub struct ReelsConfig { pub strips: Vec<Vec<Symbol>>, pub rows: usize, pub symbols: Vec<SymbolDef>, pub paylines: Vec<Vec<usize>>, pub paytable: Paytable, pub multiplier: u64 /* serde default 1 */, pub events: Vec<GridEvent> /* serde default */ }`, `pub struct GridEvent { pub symbol: Symbol, pub min_count: u8, pub emit: String }`, `pub struct ReelsMechanic;`
  - `meter.rs`: `pub struct MeterConfig { pub target: u32, pub count_symbol: Symbol, pub on_full: String /* serde default "meter:full" */, pub reset_on_full: bool /* serde default */ }`, `pub struct MeterMechanic { pub fill: u32 }`

- [ ] **Step 1: Write the failing tests** (in `mechanic.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kind_parses_type_strings() {
        assert_eq!(MechanicKind::parse("reels@1"), Some(MechanicKind::Reels));
        assert_eq!(MechanicKind::parse("meter@1"), Some(MechanicKind::Meter));
        assert_eq!(MechanicKind::parse("tower@1"), None);
        assert_eq!(MechanicKind::parse("reels@2"), None); // append-only: future version
    }

    #[test]
    fn kind_declares_triggers() {
        assert_eq!(MechanicKind::Reels.triggers(), ["spin"]);
        assert_eq!(MechanicKind::Meter.triggers(), ["accumulate"]);
    }

    #[test]
    fn parse_config_applies_serde_defaults() {
        let cfg = MechanicKind::Meter
            .parse_config(&json!({ "target": 4, "count_symbol": 9 }))
            .expect("valid meter config");
        match cfg {
            MechanicConfig::Meter(m) => {
                assert_eq!(m.on_full, "meter:full");
                assert!(!m.reset_on_full);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_config_rejects_bad_shape() {
        assert!(MechanicKind::Reels.parse_config(&json!({ "rows": 1 })).is_err());
    }

    #[test]
    fn trigger_data_serializes_tagged() {
        let d = TriggerData::Meter { fill: 3, target: 4 };
        assert_eq!(
            serde_json::to_value(&d).unwrap(),
            json!({ "kind": "meter", "fill": 3, "target": 4 })
        );
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bloom-math mechanic`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

`mechanic.rs`:

```rust
//! The Mechanic contract: named triggers invoked by a Game State's step
//! script. The client module system mirrors this trigger vocabulary
//! (spec §2 decision 8, §7).

use crate::components::Symbol;
use crate::rng::SplitMix64;
use serde::{Deserialize, Serialize};

use super::meter::{MeterConfig, MeterMechanic};
use super::reels::{ReelsConfig, ReelsMechanic};

pub type Event = String;

/// Shared per-step context. Mechanics read what earlier triggers in the same
/// step produced (e.g. the meter counts symbols on the reels' grid).
#[derive(Debug, Default)]
pub struct StepCtx {
    pub grid: Option<Vec<Vec<Symbol>>>,
    pub events: Vec<Event>,
    pub payout: u64,
}

impl StepCtx {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Presentation-facing result data carried in the trace (spec §6): what the
/// client needs to animate this trigger — never re-computed client-side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TriggerData {
    Reels { grid: Vec<Vec<Symbol>>, payout: u64 },
    Meter { fill: u32, target: u32 },
}

#[derive(Debug)]
pub struct InvokeOutcome {
    pub events: Vec<Event>,
    pub data: TriggerData,
}

/// Contract: an implementation appends its emitted events to `ctx.events`
/// AND returns them in the outcome (the evaluator records them in the
/// trace). All randomness comes from `rng`; all instance state lives in
/// `self` (round-scoped: instances are created fresh per `evaluate`).
pub trait Mechanic {
    fn invoke(
        &mut self,
        trigger: &str,
        config: &MechanicConfig,
        ctx: &mut StepCtx,
        rng: &mut SplitMix64,
    ) -> InvokeOutcome;
}

/// Effective (post-override) config for one binding, typed per mechanic.
#[derive(Debug, Clone, PartialEq)]
pub enum MechanicConfig {
    Reels(ReelsConfig),
    Meter(MeterConfig),
}

/// The mechanic-type catalog: `type@version` → kind. Closed set; adding a
/// type (or version) is a new variant + match arms — append-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MechanicKind {
    Reels,
    Meter,
}

impl MechanicKind {
    pub fn parse(type_str: &str) -> Option<MechanicKind> {
        match type_str {
            "reels@1" => Some(MechanicKind::Reels),
            "meter@1" => Some(MechanicKind::Meter),
            _ => None,
        }
    }

    pub fn triggers(self) -> &'static [&'static str] {
        match self {
            MechanicKind::Reels => &["spin"],
            MechanicKind::Meter => &["accumulate"],
        }
    }

    pub fn instantiate(self) -> Box<dyn Mechanic> {
        match self {
            MechanicKind::Reels => Box::new(ReelsMechanic),
            MechanicKind::Meter => Box::new(MeterMechanic { fill: 0 }),
        }
    }

    pub fn parse_config(self, json: &serde_json::Value) -> Result<MechanicConfig, String> {
        match self {
            MechanicKind::Reels => serde_json::from_value::<ReelsConfig>(json.clone())
                .map(MechanicConfig::Reels)
                .map_err(|e| e.to_string()),
            MechanicKind::Meter => serde_json::from_value::<MeterConfig>(json.clone())
                .map(MechanicConfig::Meter)
                .map_err(|e| e.to_string()),
        }
    }
}
```

`reels.rs` (this task: config + inert struct; `invoke` body comes in Task 4):

```rust
//! `reels@1` — strips → grid → payline/scatter payout, plus configurable
//! grid events (e.g. 3+ scatters → "scatters:3").

use serde::{Deserialize, Serialize};

use crate::components::{Paytable, Symbol, SymbolDef};

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
```

`meter.rs` (this task: config + struct; `invoke` in Task 5):

```rust
//! `meter@1` — counts a symbol on the step's grid into a persistent fill;
//! emits its configured event when full. Fill is instance state and flows
//! across Game States within a round (spec §2 decision 5).

use serde::{Deserialize, Serialize};

use crate::components::Symbol;

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
```

For this task only, give both structs a temporary `impl Mechanic` that
`unimplemented!()`s, so `instantiate` compiles (Tasks 4/5 replace them):

```rust
// reels.rs and meter.rs (temporary, replaced in Tasks 4/5):
use super::mechanic::{InvokeOutcome, Mechanic, MechanicConfig, StepCtx};
use crate::rng::SplitMix64;

impl Mechanic for ReelsMechanic {
    fn invoke(&mut self, _: &str, _: &MechanicConfig, _: &mut StepCtx, _: &mut SplitMix64) -> InvokeOutcome {
        unimplemented!("Task 4")
    }
}
```

Update `composed.rs` module list:

```rust
pub mod definition;
pub mod mechanic;
pub mod meter;
pub mod reels;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-math mechanic`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): composed mechanic contract, trigger catalog, typed configs"
```

---

### Task 4: `reels@1` — the `spin` trigger

**Files:**

- Modify: `trusted/math/src/mechanics/composed/reels.rs`

**Interfaces:**

- Consumes: `components::{spin, eval_grid, count_symbol}` (Task 1), the Task 3 contract.
- Produces: working `impl Mechanic for ReelsMechanic` — trigger `"spin"`: draws a grid from `config.strips`, pays `eval_grid * multiplier` into `ctx.payout`, sets `ctx.grid`, emits configured `GridEvent`s, returns `TriggerData::Reels { grid, payout }`.

- [ ] **Step 1: Write the failing tests** (in `reels.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{PaytableEntry, SymbolRole};
    use crate::mechanics::composed::mechanic::{Mechanic, MechanicConfig, StepCtx, TriggerData};
    use crate::rng::SplitMix64;

    fn cfg(strips: Vec<Vec<Symbol>>, multiplier: u64) -> MechanicConfig {
        MechanicConfig::Reels(ReelsConfig {
            strips,
            rows: 1,
            symbols: vec![
                SymbolDef { id: 0, role: SymbolRole::Normal },
                SymbolDef { id: 9, role: SymbolRole::Scatter },
            ],
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry { symbol: 0, count: 3, payout: 5 }],
            },
            multiplier,
            events: vec![GridEvent { symbol: 9, min_count: 3, emit: "scatters:3".into() }],
        })
    }

    fn invoke(config: &MechanicConfig, seed: u64) -> (StepCtx, super::super::mechanic::InvokeOutcome) {
        let mut ctx = StepCtx::new();
        let mut rng = SplitMix64::new(seed);
        let out = ReelsMechanic.invoke("spin", config, &mut ctx, &mut rng);
        (ctx, out)
    }

    #[test]
    fn spin_pays_and_fills_ctx() {
        // Single-symbol strips: outcome is forced regardless of seed.
        let config = cfg(vec![vec![0], vec![0], vec![0]], 1);
        let (ctx, out) = invoke(&config, 7);
        assert_eq!(ctx.payout, 5);
        assert_eq!(ctx.grid, Some(vec![vec![0], vec![0], vec![0]]));
        assert!(ctx.events.is_empty());
        match out.data {
            TriggerData::Reels { grid, payout } => {
                assert_eq!(payout, 5);
                assert_eq!(grid, vec![vec![0], vec![0], vec![0]]);
            }
            _ => panic!("wrong data"),
        }
    }

    #[test]
    fn multiplier_scales_payout() {
        let config = cfg(vec![vec![0], vec![0], vec![0]], 3);
        let (ctx, _) = invoke(&config, 7);
        assert_eq!(ctx.payout, 15);
    }

    #[test]
    fn grid_events_fire_on_min_count_and_land_in_ctx() {
        let config = cfg(vec![vec![9], vec![9], vec![9]], 1);
        let (ctx, out) = invoke(&config, 7);
        assert_eq!(out.events, vec!["scatters:3".to_string()]);
        assert_eq!(ctx.events, vec!["scatters:3".to_string()]);
    }

    #[test]
    fn spin_is_deterministic() {
        let config = cfg(vec![vec![0, 9, 0, 0], vec![9, 0, 0], vec![0, 0, 9]], 2);
        let (a, _) = invoke(&config, 123);
        let (b, _) = invoke(&config, 123);
        assert_eq!(a.grid, b.grid);
        assert_eq!(a.payout, b.payout);
        assert_eq!(a.events, b.events);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bloom-math reels`
Expected: FAIL — `unimplemented!("Task 4")` panics.

- [ ] **Step 3: Replace the temporary impl**

```rust
use super::mechanic::{Event, InvokeOutcome, Mechanic, MechanicConfig, StepCtx, TriggerData};
use crate::components;
use crate::rng::SplitMix64;

impl Mechanic for ReelsMechanic {
    fn invoke(
        &mut self,
        trigger: &str,
        config: &MechanicConfig,
        ctx: &mut StepCtx,
        rng: &mut SplitMix64,
    ) -> InvokeOutcome {
        // compile() validates triggers and config variants up front; a
        // mismatch here is a kernel bug, not bad data.
        assert_eq!(trigger, "spin", "unknown reels trigger (compile validates)");
        let cfg = match config {
            MechanicConfig::Reels(c) => c,
            _ => unreachable!("compile pairs configs with kinds"),
        };

        let grid = components::spin(&cfg.strips, cfg.rows, rng);
        let payout =
            components::eval_grid(&cfg.symbols, &cfg.paylines, &cfg.paytable, &grid)
                * cfg.multiplier;
        let events: Vec<Event> = cfg
            .events
            .iter()
            .filter(|e| components::count_symbol(&grid, e.symbol) >= e.min_count as usize)
            .map(|e| e.emit.clone())
            .collect();

        ctx.grid = Some(grid.clone());
        ctx.payout += payout;
        ctx.events.extend(events.iter().cloned());
        InvokeOutcome { events, data: TriggerData::Reels { grid, payout } }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-math reels`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): reels@1 mechanic spin trigger"
```

---

### Task 5: `meter@1` — the `accumulate` trigger

**Files:**

- Modify: `trusted/math/src/mechanics/composed/meter.rs`

**Interfaces:**

- Consumes: Task 3 contract, `components::count_symbol`.
- Produces: working `impl Mechanic for MeterMechanic` — trigger `"accumulate"`: adds the count of `config.count_symbol` on `ctx.grid` (0 if no grid yet) to `self.fill`; when `fill >= target`, emits `config.on_full` (and resets fill if `reset_on_full`); returns `TriggerData::Meter { fill, target }` where `fill` is the pre-reset value.

- [ ] **Step 1: Write the failing tests** (in `meter.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mechanics::composed::mechanic::{Mechanic, MechanicConfig, StepCtx, TriggerData};
    use crate::rng::SplitMix64;

    fn config(target: u32, reset_on_full: bool) -> MechanicConfig {
        MechanicConfig::Meter(MeterConfig {
            target,
            count_symbol: 9,
            on_full: "meter:full".into(),
            reset_on_full,
        })
    }

    fn step(mech: &mut MeterMechanic, cfg: &MechanicConfig, grid: Option<Vec<Vec<Symbol>>>) -> (StepCtx, TriggerData) {
        let mut ctx = StepCtx::new();
        ctx.grid = grid;
        let mut rng = SplitMix64::new(1); // meter never draws; passed per the trait
        let out = mech.invoke("accumulate", cfg, &mut ctx, &mut rng);
        (ctx, out.data)
    }

    #[test]
    fn accumulates_symbol_count_across_invocations() {
        let cfg = config(4, false);
        let mut mech = MeterMechanic { fill: 0 };
        let (ctx, data) = step(&mut mech, &cfg, Some(vec![vec![9], vec![0], vec![9]]));
        assert_eq!(mech.fill, 2);
        assert!(ctx.events.is_empty());
        assert_eq!(data, TriggerData::Meter { fill: 2, target: 4 });
        step(&mut mech, &cfg, Some(vec![vec![9], vec![0], vec![0]]));
        assert_eq!(mech.fill, 3); // state persisted across invocations
    }

    #[test]
    fn emits_on_full_and_keeps_fill_without_reset() {
        let cfg = config(2, false);
        let mut mech = MeterMechanic { fill: 1 };
        let (ctx, data) = step(&mut mech, &cfg, Some(vec![vec![9], vec![9], vec![0]]));
        assert_eq!(ctx.events, vec!["meter:full".to_string()]);
        assert_eq!(data, TriggerData::Meter { fill: 3, target: 2 });
        assert_eq!(mech.fill, 3);
    }

    #[test]
    fn reset_on_full_zeroes_fill_but_reports_pre_reset() {
        let cfg = config(2, true);
        let mut mech = MeterMechanic { fill: 1 };
        let (_, data) = step(&mut mech, &cfg, Some(vec![vec![9], vec![0], vec![0]]));
        assert_eq!(data, TriggerData::Meter { fill: 2, target: 2 });
        assert_eq!(mech.fill, 0);
    }

    #[test]
    fn no_grid_adds_zero() {
        let cfg = config(2, false);
        let mut mech = MeterMechanic { fill: 1 };
        let (ctx, _) = step(&mut mech, &cfg, None);
        assert_eq!(mech.fill, 1);
        assert!(ctx.events.is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bloom-math meter`
Expected: FAIL — `unimplemented!("Task 5")` panics (or missing impl).

- [ ] **Step 3: Replace the temporary impl**

```rust
use super::mechanic::{InvokeOutcome, Mechanic, MechanicConfig, StepCtx, TriggerData};
use crate::components;
use crate::rng::SplitMix64;

impl Mechanic for MeterMechanic {
    fn invoke(
        &mut self,
        trigger: &str,
        config: &MechanicConfig,
        ctx: &mut StepCtx,
        _rng: &mut SplitMix64,
    ) -> InvokeOutcome {
        assert_eq!(trigger, "accumulate", "unknown meter trigger (compile validates)");
        let cfg = match config {
            MechanicConfig::Meter(c) => c,
            _ => unreachable!("compile pairs configs with kinds"),
        };

        let added = ctx
            .grid
            .as_ref()
            .map(|g| components::count_symbol(g, cfg.count_symbol) as u32)
            .unwrap_or(0);
        self.fill += added;
        let reached = self.fill;

        let mut events = Vec::new();
        if reached >= cfg.target {
            events.push(cfg.on_full.clone());
            if cfg.reset_on_full {
                self.fill = 0;
            }
        }
        ctx.events.extend(events.iter().cloned());
        InvokeOutcome { events, data: TriggerData::Meter { fill: reached, target: cfg.target } }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-math meter`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): meter@1 mechanic accumulate trigger"
```

---

### Task 6: `compile` — validation, override merge, typed resolution

**Files:**

- Create: `trusted/math/src/mechanics/composed/compile.rs`
- Modify: `trusted/math/src/mechanics/composed.rs` (add `pub mod compile;` + re-exports)

**Interfaces:**

- Consumes: `definition::*` (Task 2), `mechanic::{MechanicKind, MechanicConfig}` (Task 3).
- Produces (exact — Tasks 8–11 use these):

```rust
pub enum CompiledBudget { Fixed(u32), Awarded { initial: u32 } }
pub struct CompiledInvoke { pub binding: usize, pub trigger: String }
pub struct CompiledState {
    pub id: String,
    pub instances: Vec<usize>,          // binding idx -> game instance idx
    pub configs: Vec<MechanicConfig>,   // binding idx -> effective config
    pub budget: CompiledBudget,
    pub script: Vec<CompiledInvoke>,
}
pub enum Effect { AddSteps(u32) }
pub struct CompiledTransition { pub from: usize, pub on: String, pub to: Option<usize>, pub effect: Option<Effect> }
pub struct CompiledGame {
    pub instance_ids: Vec<String>,
    pub kinds: Vec<MechanicKind>,
    pub states: Vec<CompiledState>,
    pub start: usize,
    pub transitions: Vec<CompiledTransition>,
    pub max_steps: u32,
}
#[derive(Debug, PartialEq)]
pub enum DefinitionError {
    WrongFamily { found: String },
    DuplicateId { id: String },
    UnknownMechanicType { instance: String, kind: String },
    BadConfig { instance: String, state: Option<String>, message: String },
    UnknownBinding { state: String, mechanic: String },
    BadInvoke { state: String, invoke: String },
    UnknownTrigger { state: String, invoke: String },
    UnknownState { referenced: String },
    UnreachableState { state: String },
    BadSteps { state: String, message: String },
    BadTransition { index: usize, message: String },
}
pub fn compile(def: &GameDefinition) -> Result<CompiledGame, Vec<DefinitionError>>
```

Normative rules implemented here (spec §3):

- Base configs must parse on their own (`BadConfig { state: None }`); each binding's merged config must parse too (`state: Some(..)`).
- Override merge: JSON objects merge recursively per key; any other value replaces.
- `budget`: `Fixed(n)` stands alone; `Keyword("awarded")` requires `initial`; any other keyword is `BadSteps`.
- A transition row carries exactly one of `to`/`effect`; v1 effect grammar is `steps:add:<n>` with `n ≥ 1`.
- `script` entries are `<bound-instance-id>.<trigger>`; the trigger must be in the kind's catalog.
- Reachability: BFS from `start` over `to` edges; unreached states are errors.
- All errors are collected, not first-error-only.

- [ ] **Step 1: Write the failing tests** (in `compile.rs`; reuse `definition::tests::sample_def_json` by making it `pub(crate)` under `#[cfg(test)]`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mechanics::composed::definition::tests::sample_def_json;
    use crate::mechanics::composed::mechanic::{MechanicConfig, MechanicKind};
    use serde_json::json;

    fn compile_json(v: serde_json::Value) -> Result<CompiledGame, Vec<DefinitionError>> {
        compile(&serde_json::from_value(v).expect("wire shape parses"))
    }

    #[test]
    fn sample_definition_compiles() {
        let game = compile_json(sample_def_json()).expect("compiles");
        assert_eq!(game.instance_ids, vec!["main_reels", "bonus_meter"]);
        assert_eq!(game.kinds, vec![MechanicKind::Reels, MechanicKind::Meter]);
        assert_eq!(game.start, 0);
        assert_eq!(game.states[1].budget, CompiledBudget::Awarded { initial: 3 });
        assert_eq!(game.transitions[0].to, Some(1));
        assert_eq!(game.transitions[1].effect, Some(Effect::AddSteps(2)));
        // fs1 overrides multiplier=2 while base keeps 1 (deep-merge, not replace):
        match (&game.states[0].configs[0], &game.states[1].configs[0]) {
            (MechanicConfig::Reels(base), MechanicConfig::Reels(fs)) => {
                assert_eq!(base.multiplier, 1);
                assert_eq!(fs.multiplier, 2);
                assert_eq!(base.strips, fs.strips); // untouched fields survive the merge
            }
            _ => panic!("wrong config variants"),
        }
    }

    #[test]
    fn merge_json_is_recursive_for_objects_and_replaces_otherwise() {
        let base = json!({ "a": { "x": 1, "y": 2 }, "b": [1, 2], "c": 3 });
        let over = json!({ "a": { "y": 9 }, "b": [7] });
        assert_eq!(
            merge_json(&base, &over),
            json!({ "a": { "x": 1, "y": 9 }, "b": [7], "c": 3 })
        );
    }

    fn expect_error(mut v: serde_json::Value, mutate: impl FnOnce(&mut serde_json::Value), want: DefinitionError) {
        mutate(&mut v);
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.contains(&want), "expected {:?} in {:?}", want, errs);
    }

    #[test]
    fn rejects_wrong_family() {
        expect_error(sample_def_json(), |v| v["family"] = json!("slots@1"),
            DefinitionError::WrongFamily { found: "slots@1".into() });
    }

    #[test]
    fn rejects_duplicate_ids() {
        expect_error(sample_def_json(), |v| v["mechanics"][1]["id"] = json!("main_reels"),
            DefinitionError::DuplicateId { id: "main_reels".into() });
        expect_error(sample_def_json(), |v| v["states"][1]["id"] = json!("base"),
            DefinitionError::DuplicateId { id: "base".into() });
    }

    #[test]
    fn rejects_unknown_mechanic_type() {
        expect_error(sample_def_json(), |v| v["mechanics"][1]["type"] = json!("tower@1"),
            DefinitionError::UnknownMechanicType { instance: "bonus_meter".into(), kind: "tower@1".into() });
    }

    #[test]
    fn rejects_bad_base_config_and_bad_merged_config() {
        // Base config missing a required field:
        let mut v = sample_def_json();
        v["mechanics"][1]["config"] = json!({ "count_symbol": 9 }); // no target
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.iter().any(|e| matches!(e,
            DefinitionError::BadConfig { instance, state: None, .. } if instance == "bonus_meter")));
        // Override that breaks the schema (wrong type):
        let mut v = sample_def_json();
        v["states"][1]["bindings"][0]["override"] = json!({ "rows": "three" });
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.iter().any(|e| matches!(e,
            DefinitionError::BadConfig { instance, state: Some(s), .. }
                if instance == "main_reels" && s == "fs1")));
    }

    #[test]
    fn rejects_binding_to_undeclared_instance() {
        expect_error(sample_def_json(), |v| v["states"][0]["bindings"][0]["mechanic"] = json!("ghost"),
            DefinitionError::UnknownBinding { state: "base".into(), mechanic: "ghost".into() });
    }

    #[test]
    fn rejects_bad_script_entries() {
        expect_error(sample_def_json(), |v| v["states"][0]["script"][0]["invoke"] = json!("nodot"),
            DefinitionError::BadInvoke { state: "base".into(), invoke: "nodot".into() });
        // Script targeting a mechanic not bound in this state:
        expect_error(sample_def_json(), |v| v["states"][0]["script"][0]["invoke"] = json!("ghost.spin"),
            DefinitionError::UnknownBinding { state: "base".into(), mechanic: "ghost".into() });
        expect_error(sample_def_json(), |v| v["states"][0]["script"][0]["invoke"] = json!("main_reels.dance"),
            DefinitionError::UnknownTrigger { state: "base".into(), invoke: "main_reels.dance".into() });
    }

    #[test]
    fn rejects_unknown_start_and_transition_states() {
        expect_error(sample_def_json(), |v| v["start"] = json!("lobby"),
            DefinitionError::UnknownState { referenced: "lobby".into() });
        expect_error(sample_def_json(), |v| v["transitions"][0]["to"] = json!("fs9"),
            DefinitionError::UnknownState { referenced: "fs9".into() });
    }

    #[test]
    fn rejects_unreachable_state() {
        expect_error(sample_def_json(), |v| {
            v["transitions"].as_array_mut().unwrap().remove(0); // fs1 now unreachable
        }, DefinitionError::UnreachableState { state: "fs1".into() });
    }

    #[test]
    fn rejects_bad_steps() {
        expect_error(sample_def_json(), |v| {
            v["states"][1]["steps"] = json!({ "budget": "awarded" }); // no initial
        }, DefinitionError::BadSteps { state: "fs1".into(), message: "awarded budget requires initial".into() });
        expect_error(sample_def_json(), |v| {
            v["states"][1]["steps"] = json!({ "budget": "granted", "initial": 3 });
        }, DefinitionError::BadSteps { state: "fs1".into(), message: "unknown budget keyword: granted".into() });
    }

    #[test]
    fn rejects_bad_transitions() {
        // both to and effect:
        expect_error(sample_def_json(), |v| v["transitions"][1]["to"] = json!("base"),
            DefinitionError::BadTransition { index: 1, message: "exactly one of to/effect".into() });
        // neither:
        expect_error(sample_def_json(), |v| {
            let row = v["transitions"][1].as_object_mut().unwrap();
            row.remove("effect");
        }, DefinitionError::BadTransition { index: 1, message: "exactly one of to/effect".into() });
        // bad effect grammar:
        expect_error(sample_def_json(), |v| v["transitions"][1]["effect"] = json!("steps:add:zero"),
            DefinitionError::BadTransition { index: 1, message: "bad effect: steps:add:zero".into() });
    }

    #[test]
    fn errors_are_collected_not_first_only() {
        let mut v = sample_def_json();
        v["family"] = json!("slots@1");
        v["start"] = json!("lobby");
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.len() >= 2);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bloom-math compile`
Expected: FAIL to compile.

- [ ] **Step 3: Implement `compile.rs`**

```rust
//! Definition → CompiledGame: all validation and semantic resolution happens
//! here, once, before any evaluation. `evaluate` may then assume a
//! well-formed game (its `unreachable!`s lean on this).

use serde_json::Value;

use super::definition::{BudgetSpec, GameDefinition, FAMILY};
use super::mechanic::{MechanicConfig, MechanicKind};

// ... types exactly as in the Interfaces block above, all pub, with
// #[derive(Debug, Clone, PartialEq)] (Copy where trivial: CompiledBudget, Effect) ...

/// Recursive object merge; non-objects replace (spec §3 shape notes).
pub(crate) fn merge_json(base: &Value, over: &Value) -> Value {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            let mut out = b.clone();
            for (k, v) in o {
                let merged = match b.get(k) {
                    Some(existing) => merge_json(existing, v),
                    None => v.clone(),
                };
                out.insert(k.clone(), merged);
            }
            Value::Object(out)
        }
        _ => over.clone(),
    }
}

fn parse_effect(s: &str) -> Option<Effect> {
    let n = s.strip_prefix("steps:add:")?.parse::<u32>().ok()?;
    if n >= 1 { Some(Effect::AddSteps(n)) } else { None }
}

pub fn compile(def: &GameDefinition) -> Result<CompiledGame, Vec<DefinitionError>> {
    let mut errs: Vec<DefinitionError> = Vec::new();

    if def.family != FAMILY {
        errs.push(DefinitionError::WrongFamily { found: def.family.clone() });
    }

    // --- instances: ids unique, kinds known, base configs parse ---
    let mut instance_ids: Vec<String> = Vec::new();
    let mut kinds: Vec<MechanicKind> = Vec::new();
    for m in &def.mechanics {
        if instance_ids.contains(&m.id) {
            errs.push(DefinitionError::DuplicateId { id: m.id.clone() });
            continue;
        }
        match MechanicKind::parse(&m.kind) {
            Some(kind) => {
                if let Err(message) = kind.parse_config(&m.config) {
                    errs.push(DefinitionError::BadConfig {
                        instance: m.id.clone(), state: None, message,
                    });
                }
                instance_ids.push(m.id.clone());
                kinds.push(kind);
            }
            None => errs.push(DefinitionError::UnknownMechanicType {
                instance: m.id.clone(), kind: m.kind.clone(),
            }),
        }
    }
    let instance_idx = |id: &str| instance_ids.iter().position(|x| x == id);

    // --- states: ids unique, bindings resolve+merge+parse, budget, script ---
    let mut state_ids: Vec<String> = Vec::new();
    for s in &def.states {
        if state_ids.contains(&s.id) {
            errs.push(DefinitionError::DuplicateId { id: s.id.clone() });
        } else {
            state_ids.push(s.id.clone());
        }
    }
    let state_idx = |id: &str| state_ids.iter().position(|x| x == id);

    let mut states: Vec<CompiledState> = Vec::new();
    for s in &def.states {
        let mut instances: Vec<usize> = Vec::new();
        let mut configs: Vec<MechanicConfig> = Vec::new();
        let mut bound_ids: Vec<&str> = Vec::new();
        for b in &s.bindings {
            let Some(idx) = instance_idx(&b.mechanic) else {
                errs.push(DefinitionError::UnknownBinding {
                    state: s.id.clone(), mechanic: b.mechanic.clone(),
                });
                continue;
            };
            let decl = &def.mechanics[idx];
            let effective = match &b.config_override {
                Some(over) => merge_json(&decl.config, over),
                None => decl.config.clone(),
            };
            match kinds[idx].parse_config(&effective) {
                Ok(cfg) => {
                    instances.push(idx);
                    configs.push(cfg);
                    bound_ids.push(&decl.id);
                }
                Err(message) => errs.push(DefinitionError::BadConfig {
                    instance: decl.id.clone(), state: Some(s.id.clone()), message,
                }),
            }
        }

        let budget = match (&s.steps.budget, s.steps.initial) {
            (BudgetSpec::Fixed(n), _) => CompiledBudget::Fixed(*n),
            (BudgetSpec::Keyword(k), initial) if k == "awarded" => match initial {
                Some(initial) => CompiledBudget::Awarded { initial },
                None => {
                    errs.push(DefinitionError::BadSteps {
                        state: s.id.clone(),
                        message: "awarded budget requires initial".into(),
                    });
                    CompiledBudget::Fixed(0)
                }
            },
            (BudgetSpec::Keyword(k), _) => {
                errs.push(DefinitionError::BadSteps {
                    state: s.id.clone(),
                    message: format!("unknown budget keyword: {k}"),
                });
                CompiledBudget::Fixed(0)
            }
        };

        let mut script: Vec<CompiledInvoke> = Vec::new();
        for entry in &s.script {
            let Some((mech_id, trigger)) = entry.invoke.split_once('.') else {
                errs.push(DefinitionError::BadInvoke {
                    state: s.id.clone(), invoke: entry.invoke.clone(),
                });
                continue;
            };
            let Some(binding) = bound_ids.iter().position(|x| *x == mech_id) else {
                errs.push(DefinitionError::UnknownBinding {
                    state: s.id.clone(), mechanic: mech_id.to_string(),
                });
                continue;
            };
            if !kinds[instances[binding]].triggers().contains(&trigger) {
                errs.push(DefinitionError::UnknownTrigger {
                    state: s.id.clone(), invoke: entry.invoke.clone(),
                });
                continue;
            }
            script.push(CompiledInvoke { binding, trigger: trigger.to_string() });
        }

        states.push(CompiledState { id: s.id.clone(), instances, configs, budget, script });
    }

    // --- start + transitions ---
    let start = match state_idx(&def.start) {
        Some(i) => i,
        None => {
            errs.push(DefinitionError::UnknownState { referenced: def.start.clone() });
            0
        }
    };

    let mut transitions: Vec<CompiledTransition> = Vec::new();
    for (index, row) in def.transitions.iter().enumerate() {
        let from = match state_idx(&row.from) {
            Some(i) => i,
            None => {
                errs.push(DefinitionError::UnknownState { referenced: row.from.clone() });
                continue;
            }
        };
        let to = match &row.to {
            Some(id) => match state_idx(id) {
                Some(i) => Some(i),
                None => {
                    errs.push(DefinitionError::UnknownState { referenced: id.clone() });
                    continue;
                }
            },
            None => None,
        };
        let effect = match &row.effect {
            Some(s) => match parse_effect(s) {
                Some(e) => Some(e),
                None => {
                    errs.push(DefinitionError::BadTransition {
                        index, message: format!("bad effect: {s}"),
                    });
                    continue;
                }
            },
            None => None,
        };
        if to.is_some() == effect.is_some() {
            errs.push(DefinitionError::BadTransition {
                index, message: "exactly one of to/effect".into(),
            });
            continue;
        }
        transitions.push(CompiledTransition { from, on: row.on.clone(), to, effect });
    }

    // --- reachability (BFS from start over `to` edges) ---
    if state_idx(&def.start).is_some() {
        let mut reached = vec![false; state_ids.len()];
        let mut queue = vec![start];
        reached[start] = true;
        while let Some(cur) = queue.pop() {
            for t in transitions.iter().filter(|t| t.from == cur) {
                if let Some(to) = t.to {
                    if !reached[to] {
                        reached[to] = true;
                        queue.push(to);
                    }
                }
            }
        }
        for (i, r) in reached.iter().enumerate() {
            if !r {
                errs.push(DefinitionError::UnreachableState { state: state_ids[i].clone() });
            }
        }
    }

    if errs.is_empty() {
        Ok(CompiledGame {
            instance_ids, kinds, states, start, transitions,
            max_steps: def.caps.max_steps,
        })
    } else {
        Err(errs)
    }
}
```

Make `definition::tests` reusable: change its module header to

```rust
#[cfg(test)]
pub(crate) mod tests {
```

and `pub fn sample_def_json()` stays `pub`. Add to `composed.rs`:

```rust
pub mod compile;
pub use compile::{compile, CompiledGame, DefinitionError};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-math compile`
Expected: all Task 6 tests PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): compile composed game definitions with full validation"
```

---

### Task 7: Lifecycle trace types — shared artifact #2

**Files:**

- Create: `trusted/math/src/mechanics/composed/trace.rs`
- Modify: `trusted/math/src/mechanics/composed.rs` (add `pub mod trace;` + re-exports)

**Interfaces:**

- Consumes: `mechanic::TriggerData` (Task 3).
- Produces (exact — Tasks 8–11 and SP3 fixtures depend on this JSON shape):

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum TraceEntry {
    RoundStart { seed: String },  // string: u64 > 2^53 breaks JS consumers
    StateEnter { state: String },
    Step { n: u32 },
    Trigger { mechanic: String, name: String, events: Vec<String>, data: TriggerData },
    Transition { on: String,
        #[serde(default, skip_serializing_if = "Option::is_none")] to: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] effect: Option<String> },
    StateExit { state: String, payout: u64 },
    RoundEnd { total_payout: u64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundTrace {
    pub entries: Vec<TraceEntry>,
    pub total_payout: u64,
}
```

- [ ] **Step 1: Write the failing test** (in `trace.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mechanics::composed::mechanic::TriggerData;
    use serde_json::json;

    #[test]
    fn trace_serializes_to_the_spec_shape_and_round_trips() {
        let trace = RoundTrace {
            entries: vec![
                TraceEntry::RoundStart { seed: u64::MAX.to_string() },
                TraceEntry::StateEnter { state: "base".into() },
                TraceEntry::Step { n: 1 },
                TraceEntry::Trigger {
                    mechanic: "main_reels".into(),
                    name: "spin".into(),
                    events: vec!["scatters:3".into()],
                    data: TriggerData::Reels { grid: vec![vec![9], vec![9], vec![9]], payout: 8 },
                },
                TraceEntry::Transition { on: "scatters:3".into(), to: Some("fs1".into()), effect: None },
                TraceEntry::StateExit { state: "base".into(), payout: 8 },
                TraceEntry::RoundEnd { total_payout: 8 },
            ],
            total_payout: 8,
        };
        let v = serde_json::to_value(&trace).unwrap();
        assert_eq!(v["entries"][0], json!({ "t": "round_start", "seed": "18446744073709551615" }));
        assert_eq!(v["entries"][2], json!({ "t": "step", "n": 1 }));
        assert_eq!(
            v["entries"][3]["data"],
            json!({ "kind": "reels", "grid": [[9],[9],[9]], "payout": 8 })
        );
        assert_eq!(v["entries"][4], json!({ "t": "transition", "on": "scatters:3", "to": "fs1" })); // effect omitted
        let back: RoundTrace = serde_json::from_value(v).unwrap();
        assert_eq!(back, trace);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bloom-math trace`
Expected: FAIL to compile.

- [ ] **Step 3: Implement** — the types exactly as the Interfaces block, with module doc:

```rust
//! The lifecycle trace — shared artifact #2 (spec §6). The server emits it
//! in one deterministic pass; the client walks it with animation. Entries
//! are a flat, walkable sequence (resumable-steps seam: a future
//! interactive state ends a partial trace with an await-input entry —
//! nothing in v1 emits one, but nesting is forbidden so that stays possible).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bloom-math trace`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): composed lifecycle trace types"
```

---

### Task 8: Evaluator — state walk, step scripts, transitions, budgets

**Files:**

- Create: `trusted/math/src/mechanics/composed/eval.rs`
- Modify: `trusted/math/src/mechanics/composed.rs` (add `pub mod eval;` + `pub use eval::evaluate; pub use trace::{RoundTrace, TraceEntry};`)

**Interfaces:**

- Consumes: everything above.
- Produces: `pub fn evaluate(game: &CompiledGame, seed: u64) -> RoundTrace`.

Normative evaluation algorithm (spec §3 round-end rules + §4):

1. Fresh `SplitMix64::new(seed)`; fresh mechanic instances via `kind.instantiate()` (round-scoped state).
2. Enter `start`. On every state entry the budget resets: `Fixed(n)` → n, `Awarded { initial }` → initial.
3. While budget > 0 and `steps_done < max_steps`: consume 1 budget, `steps_done += 1`, emit `Step { n: steps_done }`, run the state's script in order against one fresh `StepCtx` — each invoke gets the binding's effective config and the single round RNG; emit a `Trigger` entry per invoke.
4. After the script, match transition rows: first row (definition order) with `from == current` and `on ∈ ctx.events` wins; at most one row applies per step. `to` → emit `Transition`, exit state, enter target. `effect: AddSteps(n)` → emit `Transition`, `budget += n`, keep stepping.
5. When budget hits 0: synthesize the built-in `steps:exhausted` event and match rows against it the same way (`to` chains states; `effect` re-funds the budget and stepping resumes). No match → the round ends.
6. `steps_done >= max_steps` OR more than `max_steps` transitions taken (guards a zero-budget `to` cycle, which consumes no steps) → force round end. The trace stays valid.
7. Every state exit emits `StateExit { payout: <that visit's payout> }`; `RoundEnd { total_payout }` closes the trace; `total_payout` = sum of all visit payouts.

- [ ] **Step 1: Write the failing tests** (in `eval.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mechanics::composed::compile::compile;
    use crate::mechanics::composed::definition::GameDefinition;
    use crate::mechanics::composed::mechanic::TriggerData;
    use crate::mechanics::composed::trace::TraceEntry;
    use serde_json::json;

    pub(crate) fn compile_json(v: serde_json::Value) -> crate::mechanics::composed::compile::CompiledGame {
        compile(&serde_json::from_value::<GameDefinition>(v).unwrap()).unwrap()
    }

    /// Forced-outcome single state: strips are single-symbol so every spin
    /// pays 5, regardless of seed. No transitions.
    fn single_state() -> serde_json::Value {
        json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "reels", "type": "reels@1",
                  "config": { "strips": [[0],[0],[0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [{"symbol":0,"count":3,"payout":5}] } } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "reels.spin" } ] }
            ],
            "start": "base",
            "transitions": [],
            "caps": { "max_steps": 50 }
        })
    }

    /// base (1 step) --sym9-full-grid--> fs (2 steps) with retrigger effect.
    /// Reels: base strips force symbol 9 everywhere; fs strips force symbol 0.
    /// So base always emits "go:fs" and fs never re-emits it.
    fn two_states() -> serde_json::Value {
        json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "reels", "type": "reels@1",
                  "config": { "strips": [[9],[9],[9]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"},{"id":9,"role":"scatter"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [{"symbol":9,"count":3,"payout":8},
                                                         {"symbol":0,"count":3,"payout":5}] },
                              "events": [{"symbol":9,"min_count":3,"emit":"go:fs"}] } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "reels.spin" } ] },
                { "id": "fs",
                  "bindings": [ { "mechanic": "reels",
                                  "override": { "strips": [[0],[0],[0]], "multiplier": 2 } } ],
                  "steps": { "budget": "awarded", "initial": 2 },
                  "script": [ { "invoke": "reels.spin" } ] }
            ],
            "start": "base",
            "transitions": [
                { "from": "base", "on": "go:fs", "to": "fs" }
            ],
            "caps": { "max_steps": 50 }
        })
    }

    fn kinds(trace: &RoundTrace) -> Vec<&'static str> {
        trace.entries.iter().map(|e| match e {
            TraceEntry::RoundStart { .. } => "round_start",
            TraceEntry::StateEnter { .. } => "state_enter",
            TraceEntry::Step { .. } => "step",
            TraceEntry::Trigger { .. } => "trigger",
            TraceEntry::Transition { .. } => "transition",
            TraceEntry::StateExit { .. } => "state_exit",
            TraceEntry::RoundEnd { .. } => "round_end",
        }).collect()
    }

    #[test]
    fn single_state_round_shape_and_payout() {
        let trace = evaluate(&compile_json(single_state()), 7);
        assert_eq!(kinds(&trace), vec![
            "round_start", "state_enter", "step", "trigger", "state_exit", "round_end",
        ]);
        assert_eq!(trace.total_payout, 5);
        assert_eq!(trace.entries[0], TraceEntry::RoundStart { seed: "7".into() });
        assert_eq!(*trace.entries.last().unwrap(), TraceEntry::RoundEnd { total_payout: 5 });
        assert!(matches!(&trace.entries[4],
            TraceEntry::StateExit { state, payout: 5 } if state == "base"));
    }

    #[test]
    fn transition_enters_second_state_with_awarded_budget() {
        let trace = evaluate(&compile_json(two_states()), 7);
        // base: 1 step pays 8 and emits go:fs → fs: 2 steps, each pays 5*2=10.
        assert_eq!(kinds(&trace), vec![
            "round_start",
            "state_enter", "step", "trigger", "transition", "state_exit", // base
            "state_enter", "step", "trigger", "step", "trigger", "state_exit", // fs ×2 steps
            "round_end",
        ]);
        assert_eq!(trace.total_payout, 8 + 20);
        assert!(matches!(&trace.entries[4],
            TraceEntry::Transition { on, to: Some(t), effect: None } if on == "go:fs" && t == "fs"));
        assert!(matches!(&trace.entries[5],
            TraceEntry::StateExit { state, payout: 8 } if state == "base"));
        assert!(matches!(&trace.entries[11],
            TraceEntry::StateExit { state, payout: 20 } if state == "fs"));
        // fs exhausts with no matching row → round ends (NO return to base:
        // exactly one base step was played).
        let steps: Vec<u32> = trace.entries.iter().filter_map(|e| match e {
            TraceEntry::Step { n } => Some(*n), _ => None }).collect();
        assert_eq!(steps, vec![1, 2, 3]);
    }

    #[test]
    fn effect_row_adds_steps_without_state_change() {
        // fs strips force 9s so the retrigger row fires every fs step.
        let mut v = two_states();
        v["states"][1]["bindings"][0]["override"] = json!({ "multiplier": 2 }); // keep 9-strips
        v["states"][1]["steps"] = json!({ "budget": "awarded", "initial": 1 });
        v["transitions"].as_array_mut().unwrap().push(json!(
            { "from": "fs", "on": "go:fs", "effect": "steps:add:1" }
        ));
        v["caps"] = json!({ "max_steps": 5 });
        let trace = evaluate(&compile_json(v), 7);
        // Every fs spin retriggers +1 → runs until the global cap (5 steps total).
        let steps = trace.entries.iter().filter(|e| matches!(e, TraceEntry::Step { .. })).count();
        assert_eq!(steps, 5);
        let effects = trace.entries.iter().filter(|e| matches!(e,
            TraceEntry::Transition { effect: Some(_), .. })).count();
        assert_eq!(effects, 4); // one per completed fs step
        // exactly one fs state visit — effects never re-enter:
        let enters = trace.entries.iter().filter(|e| matches!(e,
            TraceEntry::StateEnter { state } if state == "fs")).count();
        assert_eq!(enters, 1);
    }

    #[test]
    fn first_matching_row_wins_in_definition_order() {
        let mut v = two_states();
        // Add a second state and a second row for the SAME event, later in the list.
        v["states"].as_array_mut().unwrap().push(json!(
            { "id": "other",
              "bindings": [ { "mechanic": "reels" } ],
              "steps": { "budget": 1 },
              "script": [ { "invoke": "reels.spin" } ] }
        ));
        v["transitions"].as_array_mut().unwrap().push(json!(
            { "from": "base", "on": "go:fs", "to": "other" }
        ));
        let trace = evaluate(&compile_json(v), 7);
        assert!(trace.entries.iter().any(|e| matches!(e,
            TraceEntry::StateEnter { state } if state == "fs")));
        assert!(!trace.entries.iter().any(|e| matches!(e,
            TraceEntry::StateEnter { state } if state == "other")));
    }
}
```

Note: the `first_matching_row_wins` test makes `other` reachable via the added row, so reachability validation passes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p bloom-math eval`
Expected: FAIL to compile — `evaluate` doesn't exist.

- [ ] **Step 3: Implement `eval.rs`**

```rust
//! `composed@1` evaluation: walk Game States from `start`, run each state's
//! ordered trigger script per step against the single round PRNG, consult
//! the game-level transition table after each step. Deterministic by
//! construction: draw order == trigger order == script order (spec §4).

use crate::rng::SplitMix64;

use super::compile::{CompiledBudget, CompiledGame, CompiledTransition, Effect};
use super::mechanic::{Event, Mechanic, StepCtx};
use super::trace::{RoundTrace, TraceEntry};

/// Built-in event synthesized by the state loop when its budget empties.
pub const STEPS_EXHAUSTED: &str = "steps:exhausted";

fn match_row<'g>(game: &'g CompiledGame, from: usize, events: &[Event]) -> Option<&'g CompiledTransition> {
    game.transitions
        .iter()
        .find(|t| t.from == from && events.iter().any(|e| e == &t.on))
}

fn transition_entry(game: &CompiledGame, row: &CompiledTransition) -> TraceEntry {
    TraceEntry::Transition {
        on: row.on.clone(),
        to: row.to.map(|i| game.states[i].id.clone()),
        effect: row.effect.map(|Effect::AddSteps(n)| format!("steps:add:{n}")),
    }
}

/// Expand one seed into one round. Same `(game, seed)` → the same trace,
/// bit-for-bit, forever. Mechanic instances are created fresh per call
/// (round-scoped state, spec §2 decision 4).
pub fn evaluate(game: &CompiledGame, seed: u64) -> RoundTrace {
    let mut rng = SplitMix64::new(seed);
    let mut mechs: Vec<Box<dyn Mechanic>> =
        game.kinds.iter().map(|k| k.instantiate()).collect();

    let mut entries = vec![TraceEntry::RoundStart { seed: seed.to_string() }];
    let mut total_payout: u64 = 0;
    let mut steps_done: u32 = 0;
    let mut transitions_taken: u32 = 0;
    let mut current = game.start;

    'round: loop {
        let state = &game.states[current];
        entries.push(TraceEntry::StateEnter { state: state.id.clone() });
        // Budget resets on every entry (spec §3).
        let mut budget = match state.budget {
            CompiledBudget::Fixed(n) => n,
            CompiledBudget::Awarded { initial } => initial,
        };
        let mut state_payout: u64 = 0;

        let exit_to: Option<usize> = loop {
            if budget == 0 {
                // Synthesized exhaustion event; no matching row ends the round.
                let exhausted = vec![STEPS_EXHAUSTED.to_string()];
                match match_row(game, current, &exhausted) {
                    Some(row) => {
                        transitions_taken += 1;
                        if transitions_taken > game.max_steps {
                            break None; // zero-budget to-cycle guard
                        }
                        entries.push(transition_entry(game, row));
                        match (row.to, row.effect) {
                            (Some(to), None) => break Some(to),
                            (None, Some(Effect::AddSteps(n))) => {
                                budget += n;
                                continue;
                            }
                            _ => unreachable!("compile enforces exactly one of to/effect"),
                        }
                    }
                    None => break None,
                }
            }
            if steps_done >= game.max_steps {
                break None; // global step cap: round still valid, loop stops
            }

            budget -= 1;
            steps_done += 1;
            entries.push(TraceEntry::Step { n: steps_done });

            let mut ctx = StepCtx::new();
            for inv in &state.script {
                let instance = state.instances[inv.binding];
                let out = mechs[instance].invoke(
                    &inv.trigger,
                    &state.configs[inv.binding],
                    &mut ctx,
                    &mut rng,
                );
                entries.push(TraceEntry::Trigger {
                    mechanic: game.instance_ids[instance].clone(),
                    name: inv.trigger.clone(),
                    events: out.events,
                    data: out.data,
                });
            }
            state_payout += ctx.payout;

            if let Some(row) = match_row(game, current, &ctx.events) {
                transitions_taken += 1;
                if transitions_taken > game.max_steps {
                    break None;
                }
                entries.push(transition_entry(game, row));
                match (row.to, row.effect) {
                    (Some(to), None) => break Some(to),
                    (None, Some(Effect::AddSteps(n))) => budget += n,
                    _ => unreachable!("compile enforces exactly one of to/effect"),
                }
            }
        };

        total_payout += state_payout;
        entries.push(TraceEntry::StateExit { state: state.id.clone(), payout: state_payout });
        match exit_to {
            Some(to) => current = to,
            None => break 'round,
        }
    }

    entries.push(TraceEntry::RoundEnd { total_payout });
    RoundTrace { entries, total_payout }
}
```

Update `composed.rs` re-exports:

```rust
pub mod eval;
pub mod trace;

pub use eval::evaluate;
pub use trace::{RoundTrace, TraceEntry};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p bloom-math eval`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): composed evaluator - state walk, scripts, transitions"
```

---

### Task 9: Evaluator safety — caps and pathological definitions

**Files:**

- Modify: `trusted/math/src/mechanics/composed/eval.rs` (tests; implementation should already satisfy them — fix if not)

**Interfaces:** none new. These tests pin the kernel-guardrail behavior (umbrella rule: the kernel must not be OOM-able or loopable by any input).

- [ ] **Step 1: Write the tests**

```rust
    // (append inside eval.rs tests module)

    #[test]
    fn supercritical_retrigger_stops_at_max_steps() {
        // Every fs spin retriggers +2 while budget only spends 1 → unbounded
        // without the cap. Mirrors slots@1's supercritical free-spins test.
        let mut v = two_states();
        v["states"][1]["bindings"][0]["override"] = json!({ "multiplier": 1 }); // keep 9-strips
        v["transitions"].as_array_mut().unwrap().push(json!(
            { "from": "fs", "on": "go:fs", "effect": "steps:add:2" }
        ));
        v["caps"] = json!({ "max_steps": 40 });
        let trace = evaluate(&compile_json(v), 99);
        let steps = trace.entries.iter().filter(|e| matches!(e, TraceEntry::Step { .. })).count();
        assert_eq!(steps, 40);
        assert!(matches!(trace.entries.last(), Some(TraceEntry::RoundEnd { .. })));
    }

    #[test]
    fn zero_budget_to_cycle_terminates() {
        // Two zero-budget states that chain to each other on steps:exhausted:
        // no step is ever consumed, so the transition guard must end the round.
        let v = json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "reels", "type": "reels@1",
                  "config": { "strips": [[0],[0],[0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"}],
                              "paylines": [[0,0,0]],
                              "paytable": { "entries": [] } } }
            ],
            "states": [
                { "id": "a", "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 0 }, "script": [ { "invoke": "reels.spin" } ] },
                { "id": "b", "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 0 }, "script": [ { "invoke": "reels.spin" } ] }
            ],
            "start": "a",
            "transitions": [
                { "from": "a", "on": "steps:exhausted", "to": "b" },
                { "from": "b", "on": "steps:exhausted", "to": "a" }
            ],
            "caps": { "max_steps": 10 }
        });
        let trace = evaluate(&compile_json(v), 1);
        assert!(matches!(trace.entries.last(), Some(TraceEntry::RoundEnd { total_payout: 0 })));
        // Bounded: at most max_steps transitions were taken before the guard fired.
        assert!(trace.entries.len() < 100);
    }

    #[test]
    fn exhausted_effect_row_refunds_budget_and_is_capped() {
        // A state that re-funds itself on exhaustion loops until the step cap.
        let mut v = single_state();
        v["transitions"].as_array_mut().unwrap().push(json!(
            { "from": "base", "on": "steps:exhausted", "effect": "steps:add:1" }
        ));
        v["caps"] = json!({ "max_steps": 7 });
        let trace = evaluate(&compile_json(v), 3);
        let steps = trace.entries.iter().filter(|e| matches!(e, TraceEntry::Step { .. })).count();
        assert_eq!(steps, 7);
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p bloom-math eval`
Expected: PASS if Task 8's implementation is correct; if any fail, fix `evaluate` (the guards are already in the Task 8 listing) — never weaken the assertions.

- [ ] **Step 3: Commit**

```bash
git add -A trusted/math
git commit -m "test(math): pin composed evaluator safety caps and pathological inputs"
```

---

### Task 10: Determinism, consistency sweep, cross-state meter flow

**Files:**

- Modify: `trusted/math/src/mechanics/composed/eval.rs` (tests only)

**Interfaces:** none new. Pins spec §2 decisions 4/5 (instance state flows across states) and the determinism doctrine.

- [ ] **Step 1: Write the tests**

```rust
    // (append inside eval.rs tests module)

    /// Deterministic full-chain game (single-cell strips force every grid):
    /// only the FIRST reel carries a 9, so every spin adds exactly 1 to the
    /// meter (target 3). base fills 1 → fs1 fills 2 then 3 = full →
    /// meter:full inside fs1 chains to fs2. Exercises multi-state carry.
    fn meter_chain() -> serde_json::Value {
        json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "reels", "type": "reels@1",
                  "config": { "strips": [[9],[0],[0]], "rows": 1,
                              "symbols": [{"id":0,"role":"normal"},{"id":9,"role":"scatter"}],
                              "paylines": [],
                              "paytable": { "entries": [] },
                              "events": [{"symbol":9,"min_count":1,"emit":"seen:9"}] } },
                { "id": "meter", "type": "meter@1",
                  "config": { "target": 3, "count_symbol": 9 } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [ { "mechanic": "reels" }, { "mechanic": "meter" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "reels.spin" }, { "invoke": "meter.accumulate" } ] },
                { "id": "fs1",
                  "bindings": [ { "mechanic": "reels" }, { "mechanic": "meter" } ],
                  "steps": { "budget": "awarded", "initial": 5 },
                  "script": [ { "invoke": "reels.spin" }, { "invoke": "meter.accumulate" } ] },
                { "id": "fs2",
                  "bindings": [ { "mechanic": "reels" } ],
                  "steps": { "budget": 1 },
                  "script": [ { "invoke": "reels.spin" } ] }
            ],
            "start": "base",
            "transitions": [
                { "from": "base", "on": "seen:9", "to": "fs1" },
                { "from": "fs1", "on": "meter:full", "to": "fs2" }
            ],
            "caps": { "max_steps": 50 }
        })
    }

    #[test]
    fn meter_fill_flows_across_states_and_chains_to_fs2() {
        let trace = evaluate(&compile_json(meter_chain()), 42);
        // base step: meter 0→1. fs1 step1: 1→2. fs1 step2: 2→3 = full → fs2.
        let fills: Vec<u32> = trace.entries.iter().filter_map(|e| match e {
            TraceEntry::Trigger { data: TriggerData::Meter { fill, .. }, .. } => Some(*fill),
            _ => None,
        }).collect();
        assert_eq!(fills, vec![1, 2, 3]); // carried across base → fs1, no reset
        let visited: Vec<&str> = trace.entries.iter().filter_map(|e| match e {
            TraceEntry::StateEnter { state } => Some(state.as_str()),
            _ => None,
        }).collect();
        assert_eq!(visited, vec!["base", "fs1", "fs2"]);
    }

    #[test]
    fn evaluate_is_bit_reproducible() {
        let game = compile_json(proofish());
        let first = evaluate(&game, 0xABCDEF);
        for _ in 0..1000 {
            assert_eq!(evaluate(&game, 0xABCDEF), first);
        }
    }

    /// A stochastic mixed-strips game for sweeps (not forced outcomes).
    pub(crate) fn proofish() -> serde_json::Value {
        let mut v = two_states();
        v["mechanics"][0]["config"]["strips"] = json!([[0,9,0,0,1],[9,0,0,1,0],[0,0,9,0,1]]);
        v["mechanics"][0]["config"]["symbols"] = json!([
            {"id":0,"role":"normal"},{"id":1,"role":"wild"},{"id":9,"role":"scatter"}]);
        v["mechanics"][0]["config"]["events"] = json!([{"symbol":9,"min_count":3,"emit":"go:fs"}]);
        v["states"][1]["bindings"][0]["override"] = json!({ "multiplier": 2 });
        v["transitions"].as_array_mut().unwrap().push(json!(
            { "from": "fs", "on": "go:fs", "effect": "steps:add:2" }
        ));
        v
    }

    #[test]
    fn sweep_traces_are_internally_consistent() {
        let game = compile_json(proofish());
        let mut any_pay = false;
        let mut any_transition = false;
        for seed in 0..3000u64 {
            let t = evaluate(&game, seed);
            assert!(matches!(t.entries.first(), Some(TraceEntry::RoundStart { .. })));
            assert!(matches!(t.entries.last(), Some(TraceEntry::RoundEnd { .. })));
            let exit_sum: u64 = t.entries.iter().filter_map(|e| match e {
                TraceEntry::StateExit { payout, .. } => Some(*payout), _ => None }).sum();
            assert_eq!(t.total_payout, exit_sum);
            let steps: Vec<u32> = t.entries.iter().filter_map(|e| match e {
                TraceEntry::Step { n } => Some(*n), _ => None }).collect();
            assert_eq!(steps, (1..=steps.len() as u32).collect::<Vec<_>>());
            any_pay |= t.total_payout > 0;
            any_transition |= t.entries.iter().any(|e| matches!(e, TraceEntry::Transition { .. }));
        }
        assert!(any_pay, "no seed paid in 3000 trials — an always-zero evaluate would pass");
        assert!(any_transition, "no seed transitioned in 3000 trials");
    }
```

(Both helpers live in the same `tests` module as the earlier eval tests; item order within a module doesn't matter to Rust.)

- [ ] **Step 2: Run tests**

Run: `cargo test -p bloom-math eval`
Expected: all PASS. `meter_fill_flows_across_states_and_chains_to_fs2` failing means instance state is not flowing across states — that breaks spec decision 5; fix `evaluate` (instances must be created once per round, indexed by game instance, never per state).

- [ ] **Step 3: Commit**

```bash
git add -A trusted/math
git commit -m "test(math): pin composed determinism, consistency, cross-state meter flow"
```

---

### Task 11: Proof game fixture + golden vectors

**Files:**

- Create: `trusted/math/fixtures/composed/proof_game.def.json`
- Create: `trusted/math/fixtures/composed/trace_seed_<N>.json` (4 files; exact seeds pinned in this task)
- Create: `trusted/math/tests/composed_golden.rs` (integration test — exercises the public API exactly as the server will)

**Interfaces:**

- Consumes: the full public surface: `composed::{from_payload/GameDefinition via serde_json, compile, evaluate, RoundTrace}`.
- Produces: the checked-in fixtures SP3's client golden-walk tests will consume verbatim.

- [ ] **Step 1: Write the proof-game definition fixture**

`trusted/math/fixtures/composed/proof_game.def.json` — the spec §9 proof game: Base (reels + meter) → FS1 (scatter-triggered, retriggers) → FS2 (meter-full-triggered). Mixed strips so outcomes vary by seed:

```json
{
  "family": "composed@1",
  "mechanics": [
    {
      "id": "main_reels",
      "type": "reels@1",
      "config": {
        "strips": [
          [0, 1, 9, 0, 0],
          [0, 0, 9, 1, 0],
          [9, 0, 1, 0, 0]
        ],
        "rows": 1,
        "symbols": [
          { "id": 0, "role": "normal" },
          { "id": 1, "role": "wild" },
          { "id": 9, "role": "scatter" }
        ],
        "paylines": [[0, 0, 0]],
        "paytable": {
          "entries": [
            { "symbol": 0, "count": 3, "payout": 5 },
            { "symbol": 9, "count": 3, "payout": 8 }
          ]
        },
        "events": [{ "symbol": 9, "min_count": 3, "emit": "scatters:3" }]
      }
    },
    {
      "id": "bonus_meter",
      "type": "meter@1",
      "config": { "target": 4, "count_symbol": 9 }
    }
  ],
  "states": [
    {
      "id": "base",
      "bindings": [{ "mechanic": "main_reels" }, { "mechanic": "bonus_meter" }],
      "steps": { "budget": 1 },
      "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }]
    },
    {
      "id": "fs1",
      "bindings": [{ "mechanic": "main_reels", "override": { "multiplier": 2 } }, { "mechanic": "bonus_meter" }],
      "steps": { "budget": "awarded", "initial": 3 },
      "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }]
    },
    {
      "id": "fs2",
      "bindings": [{ "mechanic": "main_reels", "override": { "multiplier": 3 } }],
      "steps": { "budget": "awarded", "initial": 2 },
      "script": [{ "invoke": "main_reels.spin" }]
    }
  ],
  "start": "base",
  "transitions": [
    { "from": "base", "on": "scatters:3", "to": "fs1" },
    { "from": "base", "on": "meter:full", "to": "fs2" },
    { "from": "fs1", "on": "scatters:3", "effect": "steps:add:2" },
    { "from": "fs1", "on": "meter:full", "to": "fs2" }
  ],
  "caps": { "max_steps": 100 }
}
```

(Row order matters — first match wins. The fs1 retrigger row sits BEFORE `fs1 meter:full → fs2`: entering fs1 means the base grid had 3 scatters, so the meter is already ≥3, and any 3-scatter fs1 step also fills it — if meter:full were first, the retrigger could never fire. Ordered this way, a 3-scatter fs1 step retriggers, and meter:full chains to fs2 on a later 1–2-scatter step. `base meter:full → fs2` can never actually fire — max 3 scatters on a base grid < target 4 — but it keeps fs2 graph-reachable from base and documents the shape.)

- [ ] **Step 2: Write the failing golden test with a seed scanner**

`trusted/math/tests/composed_golden.rs`:

```rust
//! Golden vectors for `composed@1` — shared parity fixtures (spec §7).
//! The client (SP3) walks these same trace files; the server (SP2)
//! reproduces them per round. Changing a fixture is a re-certification
//! event (a new mechanic/type version), never an edit.

use bloom_math::mechanics::composed::{compile, evaluate, GameDefinition};
use std::fs;
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/composed").join(name)
}

fn proof_game() -> bloom_math::mechanics::composed::CompiledGame {
    let raw = fs::read_to_string(fixture_path("proof_game.def.json")).expect("fixture exists");
    let def: GameDefinition = serde_json::from_str(&raw).expect("fixture parses");
    compile(&def).expect("fixture compiles")
}

/// Pinned scenario seeds, discovered with the scan test below and frozen
/// forever. Each exercises a distinct lifecycle shape.
const SEED_LOSE: u64 = 0;      // placeholder — pin from scan output
const SEED_FS1: u64 = 0;       // enters fs1, no retrigger, no fs2
const SEED_RETRIGGER: u64 = 0; // fs1 with at least one steps:add effect
const SEED_FS2: u64 = 0;       // reaches fs2 via meter:full

#[test]
#[ignore] // run once: cargo test -p bloom-math --test composed_golden -- --ignored --nocapture
fn scan_seeds_for_scenarios() {
    let game = proof_game();
    let mut found = std::collections::BTreeMap::new();
    for seed in 0..200_000u64 {
        let t = evaluate(&game, seed);
        let states: Vec<String> = t.entries.iter().filter_map(|e| match e {
            bloom_math::mechanics::composed::TraceEntry::StateEnter { state } => Some(state.clone()),
            _ => None,
        }).collect();
        let retriggered = t.entries.iter().any(|e| matches!(e,
            bloom_math::mechanics::composed::TraceEntry::Transition { effect: Some(_), .. }));
        let fs1 = states.contains(&"fs1".to_string());
        let fs2 = states.contains(&"fs2".to_string());
        // Independent predicates — scenarios may overlap (a retrigger round
        // usually reaches fs2 too; that's fine, the shape test only asserts
        // what each seed MUST contain).
        let preds = [
            ("lose", states == vec!["base".to_string()]),
            ("fs1", fs1 && !fs2 && !retriggered),
            ("retrigger", retriggered),
            ("fs2", fs2),
        ];
        for (key, hit) in preds {
            if hit {
                found.entry(key).or_insert(seed);
            }
        }
        if found.len() == 4 { break; }
    }
    println!("pin these: {found:?}");
}

#[test]
fn golden_traces_match_fixtures() {
    let game = proof_game();
    for (name, seed) in [
        ("lose", SEED_LOSE),
        ("fs1", SEED_FS1),
        ("retrigger", SEED_RETRIGGER),
        ("fs2", SEED_FS2),
    ] {
        let trace = evaluate(&game, seed);
        let json = serde_json::to_string_pretty(&trace).unwrap() + "\n";
        let path = fixture_path(&format!("trace_seed_{seed}.json"));
        if std::env::var("BLOOM_REGEN_GOLDEN").is_ok() {
            fs::write(&path, &json).unwrap();
        } else {
            let want = fs::read_to_string(&path)
                .unwrap_or_else(|_| panic!("{name}: missing fixture {path:?} — run with BLOOM_REGEN_GOLDEN=1"))
                .replace("\r\n", "\n"); // Windows checkout may be CRLF-normalized
            assert_eq!(json, want, "{name} (seed {seed}) drifted from its golden fixture");
        }
    }
}

#[test]
fn golden_scenarios_have_the_claimed_shapes() {
    use bloom_math::mechanics::composed::TraceEntry;
    let game = proof_game();
    let states = |seed: u64| -> Vec<String> {
        evaluate(&game, seed).entries.iter().filter_map(|e| match e {
            TraceEntry::StateEnter { state } => Some(state.clone()),
            _ => None,
        }).collect()
    };
    assert_eq!(states(SEED_LOSE), vec!["base"]);
    assert_eq!(states(SEED_FS1), vec!["base", "fs1"]);
    assert!(states(SEED_RETRIGGER).contains(&"fs1".to_string()));
    assert!(evaluate(&game, SEED_RETRIGGER).entries.iter().any(|e| matches!(e,
        TraceEntry::Transition { effect: Some(_), .. })));
    assert!(states(SEED_FS2).contains(&"fs2".to_string()));
}
```

Export `CompiledGame` from `composed.rs` if not already (`pub use compile::CompiledGame;` — done in Task 6).

- [ ] **Step 3: Scan, pin, regenerate**

1. Run: `cargo test -p bloom-math --test composed_golden -- --ignored --nocapture`
2. Copy the four printed seeds into the `SEED_*` constants (replace the `0` placeholders). If any scenario is missing in 200k seeds, tune the proof game minimally (e.g. lower meter target to 3) and update `proof_game.def.json` + this note — then rescan.
3. Run: `BLOOM_REGEN_GOLDEN=1 cargo test -p bloom-math --test composed_golden golden_traces_match_fixtures` (PowerShell: `$env:BLOOM_REGEN_GOLDEN="1"; cargo test ...; Remove-Item Env:BLOOM_REGEN_GOLDEN`)
4. Inspect the four generated `trace_seed_*.json` files by eye: entry order must read like spec §6 (round_start → state_enter → step → trigger... → round_end).

- [ ] **Step 4: Run the full suite clean**

Run: `cargo test -p bloom-math`
Expected: everything PASSES, including `golden_traces_match_fixtures` WITHOUT the env var (fixtures now checked in) and `golden_scenarios_have_the_claimed_shapes`.

- [ ] **Step 5: Commit**

```bash
git add -A trusted/math
git commit -m "feat(math): composed@1 proof-game fixture and golden trace vectors"
```

---

### Task 12: Final gates — fmt, clippy, full workspace suite

**Files:**

- Possibly modify: any file clippy flags.

- [ ] **Step 1: Format and lint**

Run:

```bash
cargo fmt --all
cargo fmt --all -- --check
cargo clippy -p bloom-math --all-targets -- -D warnings
```

Expected: fmt clean; clippy zero warnings. Fix anything flagged (CI runs `cargo fmt --check` and clippy — a local `cargo test` pass alone is NOT the bar).

- [ ] **Step 2: Full workspace test run** (proves `slots@1` consumers — server, simulator, tuner — still build and pass against the refactored crate)

Run: `cargo test --workspace`
Expected: ALL PASS, zero changes outside `trusted/math`.

- [ ] **Step 3: Commit (if fmt/clippy changed anything)**

```bash
git add -A
git commit -m "chore(math): fmt + clippy cleanup for composed@1"
```

---

## Self-review notes

- Spec §3 validation list → Task 6 covers every named error class (unknown types, unbound instances, unknown states, unreachable states, missing/unknown start, unbound script targets, unknown triggers) plus budget/effect/family/duplicate rules.
- Spec §4 kernel requirements → trait (T3), registry-as-match (T3), single-PRNG order (T4/T8), reels@1 (T4), meter@1 (T5), free-spins-as-state (T8 `two_states`, T11 proof game), cap generalizing MAX_FREE_SPINS (T9).
- Spec §6 trace → T7 exact JSON shape incl. string seed; resumable-steps seam = flat walkable sequence (doc note, nothing consumes it — matches §10 out-of-scope).
- Spec §2 decision 5 (instance state across states) → T10 `meter_fill_flows_across_states_and_chains_to_fs2`.
- Golden vectors → T11; `slots@1` untouched → T1 gate + T12 workspace run.
- Out of scope here (later SPs): package build/dispatch (SP2), TS types/TraceWalker (SP3), studio authoring (SP4).
