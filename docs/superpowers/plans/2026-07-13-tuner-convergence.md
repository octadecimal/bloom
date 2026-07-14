# SP-B Tuner Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `bloom-tuner` onto the `MathArtifact` family seam and add the composed genome variant, so `tune_json` can tune `composed@1` Game Definitions (numbers only, never structure) exactly like it tunes `SlotModel`s.

**Architecture:** `Genome` becomes a two-variant enum (`Slots` = today's struct, `Composed` = strip-count surfaces + reels paytable payouts + meter targets + awarded budgets). The GA loop (`genetic.rs`) flips from `SlotModel` to `MathArtifact`, reusing SP-A's `bloom_simulator::artifact::simulate` / `run::verify_artifact` / per-state `Metrics`. Mutation, crossover, repair, and pay-constraint clamps are shared helpers over the components types both families use. `tune_json` sniffs family from the artifact JSON (same as `curate_json`) and its NDJSON gains `family` + per-state-share fields.

**Tech Stack:** Rust (crates `bloom-tuner`, `bloom-simulator`, `bloom-math`), serde_json, NDJSON wire contract.

**Spec:** umbrella spec §3.4 (`docs/superpowers/specs/2026-07-11-tooling-convergence-composed-design.md` on the `docs/tooling-convergence-spec` branch, PR #194). Key §3.4 text, verbatim:

> `Genome` becomes a two-variant enum. The composed variant's genes:
>
> - **reels**: per-reels-binding strip counts — the instance base config plus each per-state override that defines strips (feature strips tune independently of base strips, which is how base-vs-feature RTP trade-off tuning works);
> - **paytable**: the reels instance's paytable payouts (instance-level, shared across states);
> - **features**: `meter@1` targets and `"awarded"` state initial budgets.
>
> Everything else is copied verbatim from the template definition at decode. Section locks keep the three-group shape (reels / paytable / features). Mutation, crossover, `repair()`, and the pay-constraint clamps reuse today's operators — strip and paytable math is identical on both sides. Bounds for meter targets and budgets ride `GeneBounds` like today's bonus genes.
>
> Tune telemetry (NDJSON) gains `family` and the per-state-share fields so analytics comes along for free.

## Global Constraints

- Work in worktree `C:\code\bloom.wt\tuner-convergence`, branch `feat/tuner-convergence` (BLOOM_PORT_OFFSET=1 — if any dev-stack port is ever needed, use :8001/:4201/:4301, never defaults).
- Semantic (Conventional Commits) format for every commit; imperative mood.
- TDD: write the failing test, watch it fail, minimal code, watch it pass, commit.
- Rust gates before any PR: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` (CI fails on fmt/clippy, not just tests).
- Determinism is sacred: no wall clock, no OS randomness in the search path; same master_seed ⇒ bit-identical outcome. Every new operator draws from the existing `SplitMix64` stream.
- Game **structure is never mutated** by the GA: states, transitions, event thresholds, scripts, paylines, symbols, rows, multipliers stay byte-identical through decode (spec §2 decision 3, §8).
- Wire compat: the existing slots `tune_json` input/output contract must not change shape (the Python backend `app/math/runners/tune.py` parses it). Composed additions are additive; a legacy slots model JSON (no top-level `family`) must keep parsing as slots.
- Follow-ups #195/#196 are already filed — do NOT re-fix them. Feature-level tuner bands are issue #160 — out of scope (composed targets with `bonus_hit_rate_bands` are rejected, which SP-A's `validate_constraints` already does).
- All commands below run from the worktree root `C:\code\bloom.wt\tuner-convergence`.

## Files (whole plan)

| File                                | Change                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `studio/simulator/src/artifact.rs`  | Add `PartialEq` derive + `as_slots()` / `composed_def()` accessors (Task 1)                                        |
| `studio/tuner/src/genome.rs`        | `Genome` enum, `ComposedGenome`, composed encode/decode (Task 1), shared repair helpers + composed repair (Task 2) |
| `studio/tuner/src/config.rs`        | `GeneBounds` gains `meter_target_min/max` (Task 2)                                                                 |
| `studio/tuner/src/outcome.rs`       | `TuneOutcome.model: MathArtifact`; `GenSnapshot.best_state_rtp` (Task 3)                                           |
| `studio/tuner/src/lib.rs`           | `Tuner` trait over `MathArtifact` (Task 3)                                                                         |
| `studio/tuner/src/validate.rs`      | `validate(&MathArtifact, …)` (Task 3)                                                                              |
| `studio/tuner/src/fitness.rs`       | `band_misses(&MathArtifact, …)` (Task 3)                                                                           |
| `studio/tuner/src/genetic.rs`       | Artifact-typed loop, composed mutate/crossover arms, family-aware gene columns (Task 3)                            |
| `studio/tuner/src/report.rs`        | Test fixture only (Task 3)                                                                                         |
| `studio/tuner/src/bin/tune.rs`      | Artifact parse + family-aware model write (Task 4)                                                                 |
| `studio/tuner/src/bin/tune_json.rs` | Artifact parse, `family` + `stateRtp`/`stateVisitFreq` NDJSON, meter bounds JSON (Task 4)                          |

---

### Task 1: Genome enum + composed encode/decode

**Files:**

- Modify: `studio/simulator/src/artifact.rs` (derive + accessors)
- Modify: `studio/tuner/src/genome.rs`

**Interfaces:**

- Consumes: `MathArtifact` (SP-A, `bloom_simulator::artifact`), `GameDefinition`/`BudgetSpec` (`bloom_math::mechanics::composed`), `SectionLocks` (`crate::config`).
- Produces (later tasks rely on these exact names):
  - `pub enum Genome { Slots(SlotsGenome), Composed(ComposedGenome) }` (derive `Debug, Clone, PartialEq`)
  - `pub struct SlotsGenome { pub reel_counts: Vec<Vec<u32>>, pub payouts: Vec<u64>, pub bonuses: Vec<BonusGenes> }` (today's `Genome`, renamed)
  - `pub struct ComposedGenome { pub surfaces: Vec<Vec<Vec<u32>>>, pub payouts: Vec<u64>, pub meter_targets: Vec<u32>, pub awarded_budgets: Vec<u32> }`
  - `pub fn encode_with_locks(artifact: &MathArtifact, locks: &SectionLocks) -> Genome`
  - `pub fn decode(genome: &Genome, template: &MathArtifact) -> MathArtifact`
  - `MathArtifact: PartialEq`; `MathArtifact::as_slots(&self) -> Option<&SlotModel>`; `MathArtifact::composed_def(&self) -> Option<&GameDefinition>`

- [ ] **Step 1: Simulator groundwork — derive + accessors**

In `studio/simulator/src/artifact.rs` change the derive on `MathArtifact` and add two accessors inside `impl MathArtifact` (right after `from_definition`):

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum MathArtifact {
```

```rust
    /// The slots model, when this is a slots artifact (test/CLI convenience).
    pub fn as_slots(&self) -> Option<&SlotModel> {
        match self {
            MathArtifact::Slots(m) => Some(m),
            _ => None,
        }
    }

    /// The composed definition, when this is a composed artifact.
    pub fn composed_def(&self) -> Option<&GameDefinition> {
        match self {
            MathArtifact::Composed { def, .. } => Some(def),
            _ => None,
        }
    }
```

- [ ] **Step 2: Verify the simulator still passes**

Run: `cargo test -p bloom-simulator`
Expected: PASS (derive is additive; `CompiledGame`, `GameDefinition`, `ReelsConfig`, `SlotModel` all already derive `PartialEq`).

- [ ] **Step 3: Write failing tests for the composed genome round-trip**

Append to `studio/tuner/src/genome.rs`'s test module (imports at the top of the test block):

```rust
    use bloom_math::mechanics::composed::GameDefinition;
    use bloom_simulator::artifact::MathArtifact;

    /// Composed template with everything the genome touches: two strip
    /// surfaces (base + an fs override that redefines strips), a paytable,
    /// one meter, one awarded budget. Mirrors the demo definition's shape.
    fn composed_def() -> GameDefinition {
        serde_json::from_value(serde_json::json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "main_reels", "type": "reels@1",
                  "config": {
                    "strips": [[0, 0, 0, 1, 1, 9], [0, 1, 0, 1, 0, 9]],
                    "rows": 1,
                    "symbols": [{"id":0,"role":"normal"},{"id":1,"role":"normal"},{"id":9,"role":"scatter"}],
                    "paylines": [[0, 0]],
                    "paytable": { "entries": [
                        {"symbol":0,"count":2,"payout":2},
                        {"symbol":1,"count":2,"payout":6} ] },
                    "events": [{ "symbol": 9, "min_count": 2, "emit": "scatters:2" }] } },
                { "id": "bonus_meter", "type": "meter@1",
                  "config": { "target": 4, "count_symbol": 9 } }
            ],
            "states": [
                { "id": "base",
                  "bindings": [{ "mechanic": "main_reels" }, { "mechanic": "bonus_meter" }],
                  "steps": { "budget": 1 },
                  "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }] },
                { "id": "fs",
                  "bindings": [
                    { "mechanic": "main_reels",
                      "override": { "multiplier": 2, "strips": [[0, 0, 1, 1, 1, 9], [1, 1, 0, 0, 1, 9]] } },
                    { "mechanic": "bonus_meter" }],
                  "steps": { "budget": "awarded", "initial": 5 },
                  "script": [{ "invoke": "main_reels.spin" }, { "invoke": "bonus_meter.accumulate" }] }
            ],
            "start": "base",
            "transitions": [
                { "from": "base", "on": "scatters:2", "to": "fs" },
                { "from": "base", "on": "meter:full", "to": "fs" }
            ],
            "caps": { "max_steps": 100 }
        }))
        .expect("fixture parses")
    }

    fn composed_artifact() -> MathArtifact {
        MathArtifact::from_definition(composed_def()).expect("fixture compiles")
    }

    #[test]
    fn composed_encode_reads_all_four_gene_groups() {
        let g = encode_composed(&composed_def());
        // two surfaces: base config strips, then the fs override strips
        assert_eq!(g.surfaces.len(), 2);
        // base strip 0 = [0,0,0,1,1,9] -> counts by ascending symbol (0,1,9)
        assert_eq!(g.surfaces[0][0], vec![3, 2, 1]);
        assert_eq!(g.surfaces[0][1], vec![3, 2, 1]);
        // fs strip 0 = [0,0,1,1,1,9]
        assert_eq!(g.surfaces[1][0], vec![2, 3, 1]);
        assert_eq!(g.payouts, vec![2, 6]);
        assert_eq!(g.meter_targets, vec![4]);
        assert_eq!(g.awarded_budgets, vec![5]);
    }

    #[test]
    fn composed_genome_round_trips_through_definition() {
        let def = composed_def();
        let g = encode_composed(&def);
        let back = encode_composed(&decode_composed(&g, &def));
        assert_eq!(g, back);
    }

    #[test]
    fn composed_decode_preserves_structure_verbatim() {
        let def = composed_def();
        let mut g = encode_composed(&def);
        // perturb every gene group
        g.surfaces[0][0] = vec![1, 4, 1];
        g.surfaces[1][1] = vec![4, 1, 1];
        g.payouts = vec![3, 9];
        g.meter_targets = vec![7];
        g.awarded_budgets = vec![11];
        let d = decode_composed(&g, &def);

        // tuned numbers landed where they should
        let strips: Vec<Vec<u8>> =
            serde_json::from_value(d.mechanics[0].config["strips"].clone()).unwrap();
        assert_eq!(strips[0].len(), 6);
        assert_eq!(strips[0].iter().filter(|&&s| s == 1).count(), 4);
        let fs_over = d.states[1].bindings[0].config_override.as_ref().unwrap();
        let fs_strips: Vec<Vec<u8>> = serde_json::from_value(fs_over["strips"].clone()).unwrap();
        assert_eq!(fs_strips[1].iter().filter(|&&s| s == 0).count(), 4);
        assert_eq!(d.mechanics[0].config["paytable"]["entries"][1]["payout"], 9);
        assert_eq!(d.mechanics[1].config["target"], 7);
        assert_eq!(d.states[1].steps.initial, Some(11));

        // structure untouched
        assert_eq!(d.states.len(), def.states.len());
        assert_eq!(d.transitions, def.transitions);
        assert_eq!(d.start, def.start);
        assert_eq!(d.caps, def.caps);
        assert_eq!(d.states[0].script, def.states[0].script);
        assert_eq!(
            d.mechanics[0].config["paylines"],
            def.mechanics[0].config["paylines"]
        );
        assert_eq!(
            d.mechanics[0].config["symbols"],
            def.mechanics[0].config["symbols"]
        );
        assert_eq!(
            d.mechanics[0].config["events"],
            def.mechanics[0].config["events"]
        );
        assert_eq!(fs_over["multiplier"], 2); // override's other keys survive
        assert_eq!(
            d.mechanics[0].config["paytable"]["entries"][1]["symbol"],
            def.mechanics[0].config["paytable"]["entries"][1]["symbol"]
        );
        // it still compiles
        assert!(MathArtifact::from_definition(d).is_ok());
    }

    #[test]
    fn artifact_encode_decode_dispatches_both_families() {
        // slots arm unchanged behavior
        let m = model();
        let art = MathArtifact::Slots(m.clone());
        let g = encode_with_locks(&art, &SectionLocks::default());
        assert!(matches!(g, Genome::Slots(_)));
        let d = decode(&g, &art);
        assert_eq!(encode_with_locks(&d, &SectionLocks::default()), g);

        // composed arm
        let art = composed_artifact();
        let g = encode_with_locks(&art, &SectionLocks::default());
        assert!(matches!(g, Genome::Composed(_)));
        let d = decode(&g, &art);
        assert_eq!(d.family(), "composed@1");
        assert_eq!(encode_with_locks(&d, &SectionLocks::default()), g);
    }

    #[test]
    fn composed_locks_map_to_the_three_groups() {
        let art = composed_artifact();
        let Genome::Composed(g) = encode_with_locks(
            &art,
            &SectionLocks {
                reels: true,
                paytable: false,
                bonus: true,
            },
        ) else {
            panic!("expected composed genome");
        };
        assert!(g.surfaces.is_empty());
        assert_eq!(g.payouts, vec![2, 6]); // unlocked group intact
        assert!(g.meter_targets.is_empty());
        assert!(g.awarded_budgets.is_empty());
    }

    #[test]
    fn composed_all_locked_decode_reproduces_the_template() {
        let art = composed_artifact();
        let locks = SectionLocks {
            reels: true,
            paytable: true,
            bonus: true,
        };
        let d = decode(&encode_with_locks(&art, &locks), &art);
        assert_eq!(d.composed_def().unwrap(), &composed_def());
    }
```

- [ ] **Step 4: Run to verify the new tests fail**

Run: `cargo test -p bloom-tuner genome`
Expected: FAIL — `encode_composed`, `decode_composed`, `ComposedGenome`, `Genome::Slots` etc. not defined.

- [ ] **Step 5: Implement the enum + composed encode/decode**

In `studio/tuner/src/genome.rs`:

1. Rename the existing `pub struct Genome` to `pub struct SlotsGenome` (same fields, same derives) and rename the existing functions: `encode` → `encode_slots` (`-> SlotsGenome`), `decode` → `decode_slots(genome: &SlotsGenome, template: &SlotModel) -> SlotModel`, `repair` → `repair_slots(genome: &mut SlotsGenome, …)` (body unchanged this task).
2. Add imports:

```rust
use bloom_math::mechanics::composed::{BudgetSpec, GameDefinition};
use bloom_simulator::artifact::MathArtifact;
```

(If `BudgetSpec`/`GameDefinition` aren't re-exported at `mechanics::composed`, check `trusted/math/src/mechanics/composed.rs` for the actual re-export list and import from the exact path it exposes — `definition.rs` defines both.)

3. Add the enum and composed genome:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum Genome {
    Slots(SlotsGenome),
    Composed(ComposedGenome),
}

/// Composed genes (spec §3.4): numbers only, never structure. A locked/absent
/// group is an empty vec — decode's zips then no-op and the template's values
/// survive verbatim (same convention as SlotsGenome).
#[derive(Debug, Clone, PartialEq)]
pub struct ComposedGenome {
    /// Per reels-surface, per strip: count of each distinct symbol id
    /// (ascending). Surface order = `strip_surfaces` order.
    pub surfaces: Vec<Vec<Vec<u32>>>,
    /// The reels instance's paytable payouts, entry order.
    pub payouts: Vec<u64>,
    /// One per `meter@1` instance, mechanics order.
    pub meter_targets: Vec<u32>,
    /// One per state with `"budget": "awarded"`, state order.
    pub awarded_budgets: Vec<u32>,
}
```

4. Surface map (module-private):

```rust
/// Where a tunable strip set lives in the definition.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SurfaceLoc {
    Base { mechanic: usize },
    Override { state: usize, binding: usize },
}

fn strips_from(v: &serde_json::Value) -> Option<Vec<Vec<Symbol>>> {
    serde_json::from_value(v.get("strips")?.clone()).ok()
}

/// Canonical surface enumeration (encode + decode + repair must agree): the
/// first `reels@1` instance's base strips, then every state-binding override
/// on that instance that defines `strips` (state order, binding order).
/// Feature strips tune independently of base strips (spec §3.4).
fn strip_surfaces(def: &GameDefinition) -> Vec<(SurfaceLoc, Vec<Vec<Symbol>>)> {
    let mut out = Vec::new();
    let Some(m_idx) = def.mechanics.iter().position(|m| m.kind == "reels@1") else {
        return out;
    };
    if let Some(strips) = strips_from(&def.mechanics[m_idx].config) {
        out.push((SurfaceLoc::Base { mechanic: m_idx }, strips));
    }
    let reels_id = def.mechanics[m_idx].id.clone();
    for (s_idx, s) in def.states.iter().enumerate() {
        for (b_idx, b) in s.bindings.iter().enumerate() {
            if b.mechanic == reels_id {
                if let Some(strips) = b.config_override.as_ref().and_then(strips_from) {
                    out.push((SurfaceLoc::Override { state: s_idx, binding: b_idx }, strips));
                }
            }
        }
    }
    out
}

fn strip_counts(strip: &[Symbol]) -> Vec<u32> {
    reel_symbols(strip)
        .iter()
        .map(|&sym| strip.iter().filter(|&&c| c == sym).count() as u32)
        .collect()
}

fn is_awarded(s: &bloom_math::mechanics::composed::StateDef) -> bool {
    matches!(&s.steps.budget, BudgetSpec::Keyword(k) if k == "awarded")
}
```

(`Symbol` is already imported via `bloom_math::mechanics::slots::{…}` — it is the shared `components::Symbol = u8`; add it to that import list if missing. Import `StateDef` alongside `BudgetSpec` if you prefer a shorter signature.)

5. Composed encode/decode:

```rust
pub fn encode_composed(def: &GameDefinition) -> ComposedGenome {
    let surfaces = strip_surfaces(def)
        .iter()
        .map(|(_, strips)| strips.iter().map(|s| strip_counts(s)).collect())
        .collect();
    let payouts = def
        .mechanics
        .iter()
        .find(|m| m.kind == "reels@1")
        .and_then(|m| m.config["paytable"]["entries"].as_array())
        .map(|es| es.iter().map(|e| e["payout"].as_u64().unwrap_or(0)).collect())
        .unwrap_or_default();
    let meter_targets = def
        .mechanics
        .iter()
        .filter(|m| m.kind == "meter@1")
        .map(|m| m.config["target"].as_u64().unwrap_or(0) as u32)
        .collect();
    let awarded_budgets = def
        .states
        .iter()
        .filter(|s| is_awarded(s))
        .map(|s| s.steps.initial.unwrap_or(0))
        .collect();
    ComposedGenome { surfaces, payouts, meter_targets, awarded_budgets }
}

/// Write the genes back into a clone of the template. JSON is edited in
/// place (never round-tripped through the typed configs), so keys the genome
/// doesn't own — events, paylines, symbols, multiplier, unknown fields —
/// survive byte-for-byte. Empty gene groups (locks) zip to no-ops.
pub fn decode_composed(genome: &ComposedGenome, template: &GameDefinition) -> GameDefinition {
    let mut def = template.clone();
    for ((loc, strips), counts) in strip_surfaces(template).iter().zip(&genome.surfaces) {
        let new_strips: Vec<Vec<Symbol>> = strips
            .iter()
            .zip(counts)
            .map(|(strip, c)| layout(&reel_symbols(strip), c))
            .collect();
        let v = serde_json::to_value(&new_strips).expect("strips serialize");
        match loc {
            SurfaceLoc::Base { mechanic } => def.mechanics[*mechanic].config["strips"] = v,
            SurfaceLoc::Override { state, binding } => {
                def.states[*state].bindings[*binding]
                    .config_override
                    .as_mut()
                    .expect("surface came from this override")["strips"] = v;
            }
        }
    }
    if !genome.payouts.is_empty() {
        if let Some(m) = def.mechanics.iter_mut().find(|m| m.kind == "reels@1") {
            if let Some(entries) = m.config["paytable"]["entries"].as_array_mut() {
                for (e, &p) in entries.iter_mut().zip(&genome.payouts) {
                    e["payout"] = serde_json::json!(p);
                }
            }
        }
    }
    for (m, &t) in def
        .mechanics
        .iter_mut()
        .filter(|m| m.kind == "meter@1")
        .zip(&genome.meter_targets)
    {
        m.config["target"] = serde_json::json!(t);
    }
    for (s, &b) in def
        .states
        .iter_mut()
        .filter(|s| is_awarded(s))
        .zip(&genome.awarded_budgets)
    {
        s.steps.initial = Some(b);
    }
    def
}
```

(Note: indexing a `serde_json::Value` with `["paytable"]["entries"]` returns `Value::Null` for missing keys — safe with `.as_array()`. For the mutable path, `Value`'s `IndexMut` inserts nulls into objects as needed; the template compiled, so `paytable.entries` exists.)

6. Enum-level dispatch (these keep the old public names — `genetic.rs` keeps calling `encode_with_locks`/`decode`):

```rust
pub fn encode_with_locks(artifact: &MathArtifact, locks: &SectionLocks) -> Genome {
    match artifact {
        MathArtifact::Slots(m) => {
            let mut g = encode_slots(m);
            if locks.reels {
                g.reel_counts.clear();
            }
            if locks.paytable {
                g.payouts.clear();
            }
            if locks.bonus {
                g.bonuses.clear();
            }
            Genome::Slots(g)
        }
        MathArtifact::Composed { def, .. } => {
            let mut g = encode_composed(def);
            if locks.reels {
                g.surfaces.clear();
            }
            if locks.paytable {
                g.payouts.clear();
            }
            if locks.bonus {
                g.meter_targets.clear();
                g.awarded_budgets.clear();
            }
            Genome::Composed(g)
        }
    }
}

pub fn decode(genome: &Genome, template: &MathArtifact) -> MathArtifact {
    match (genome, template) {
        (Genome::Slots(g), MathArtifact::Slots(m)) => MathArtifact::Slots(decode_slots(g, m)),
        (Genome::Composed(g), MathArtifact::Composed { def, .. }) => {
            MathArtifact::from_definition(decode_composed(g, def))
                .expect("decode only changes numbers; a valid template stays compiling")
        }
        _ => unreachable!("a genome is only ever decoded against its own template"),
    }
}
```

7. Keep the old slots-only `encode_with_locks(model, locks)` body merged into the enum version above (delete the standalone slots one). Update the existing slots tests mechanically: `encode(&m)` → `encode_slots(&m)`, `decode(&g, &m)` → `decode_slots(&g, &m)`, `repair(&mut g, &m, …)` → `repair_slots(&mut g, &m, …)`, and the three lock tests go through `encode_with_locks(&MathArtifact::Slots(m.clone()), &locks)` + destructure `Genome::Slots(g)` (or keep them on the slots internals by applying the clears inline — prefer routing through the enum so the dispatch is covered).

This will temporarily break `genetic.rs` (it calls the old names with `SlotModel`). To keep the tree green for this task's commit, update `genetic.rs` call sites mechanically to the slots internals: `encode_with_locks(seed_model, &cfg.locks)` → build via `encode_slots` + inline lock clears is churn — instead add at the bottom of `genome.rs` a temporary shim used only by `genetic.rs`:

```rust
/// Transitional slots-only shim; genetic.rs flips to the enum in Task 3.
pub fn encode_with_locks_slots(model: &SlotModel, locks: &SectionLocks) -> SlotsGenome {
    match encode_with_locks(&MathArtifact::Slots(model.clone()), locks) {
        Genome::Slots(g) => g,
        Genome::Composed(_) => unreachable!(),
    }
}
```

and in `genetic.rs` replace `encode_with_locks(seed_model, &cfg.locks)` with `encode_with_locks_slots(seed_model, &cfg.locks)`, `decode(` with `decode_slots(`, `repair(` with `repair_slots(`, and `Genome` with `SlotsGenome` in type positions. (Task 3 deletes the shim.)

- [ ] **Step 6: Run the crate tests**

Run: `cargo test -p bloom-tuner`
Expected: PASS (all existing slots tests + the six new composed tests).

- [ ] **Step 7: Commit**

```powershell
git add studio/simulator/src/artifact.rs studio/tuner/src/genome.rs studio/tuner/src/genetic.rs
git commit -m "feat(tuner): Genome enum with composed variant + encode/decode"
```

---

### Task 2: Composed repair + shared constraint clamps + GeneBounds

**Files:**

- Modify: `studio/tuner/src/config.rs`
- Modify: `studio/tuner/src/genome.rs`

**Interfaces:**

- Consumes: Task 1's `Genome`/`ComposedGenome`/`strip_surfaces`, `MathArtifact::Composed { reels, .. }` (the typed base `ReelsConfig` SP-A captures).
- Produces:
  - `GeneBounds` gains `pub meter_target_min: u32, pub meter_target_max: u32`
  - `pub fn repair(genome: &mut Genome, template: &MathArtifact, bounds: &GeneBounds, constraints: &[PayConstraint])`
  - private helpers `rescale_counts(counts: &mut Vec<u32>, target: u32)` and `clamp_payout_constraints(entries: &[PaytableEntry], payouts: &mut [u64], constraints: &[PayConstraint])` shared by both family arms

- [ ] **Step 1: Add the bounds fields**

In `studio/tuner/src/config.rs`, extend `GeneBounds`:

```rust
    pub min_count_min: u8,
    pub min_count_max: u8,
    /// Bounds for composed `meter@1` targets (the features gene group rides
    /// GeneBounds like slots' bonus genes; awarded budgets ride spins_min/max —
    /// a budget IS spins awarded).
    pub meter_target_min: u32,
    pub meter_target_max: u32,
```

Fix every `GeneBounds { … }` construction site to compile (tuner tests in `genome.rs`, `genetic.rs`, `validate.rs`; bins get their serde defaults in Task 4 — for now add literal `meter_target_min: 1, meter_target_max: 100` in `bin/tune.rs` and `bin/tune_json.rs` struct-construction sites with the same values so the crate builds). Use `meter_target_min: 1, meter_target_max: 100` in test fixtures.

- [ ] **Step 2: Write the failing repair tests**

Append to `genome.rs` tests:

```rust
    fn composed_bounds() -> GeneBounds {
        GeneBounds {
            payout_min: 0,
            payout_max: 100,
            spins_min: 1,
            spins_max: 50,
            multiplier_min: 1,
            multiplier_max: 10,
            min_count_min: 1,
            min_count_max: 5,
            meter_target_min: 1,
            meter_target_max: 100,
        }
    }

    #[test]
    fn composed_repair_rescales_every_surface_to_its_strip_length() {
        let art = composed_artifact();
        let mut g = Genome::Composed(encode_composed(&composed_def()));
        if let Genome::Composed(cg) = &mut g {
            cg.surfaces[0][0] = vec![999, 999, 999];
            cg.surfaces[1][1] = vec![0, 0, 0];
        }
        repair(&mut g, &art, &composed_bounds(), &[]);
        let Genome::Composed(cg) = &g else { panic!() };
        for surface in &cg.surfaces {
            for counts in surface {
                assert_eq!(counts.iter().sum::<u32>(), 6); // fixture strips are 6 long
            }
        }
        // and it still decodes + compiles
        let d = decode(&g, &art);
        assert_eq!(d.family(), "composed@1");
    }

    #[test]
    fn composed_repair_clamps_payouts_targets_and_budgets() {
        let art = composed_artifact();
        let mut g = Genome::Composed(encode_composed(&composed_def()));
        if let Genome::Composed(cg) = &mut g {
            cg.payouts = vec![u64::MAX, 0];
            cg.meter_targets = vec![0];
            cg.awarded_budgets = vec![9999];
        }
        repair(&mut g, &art, &composed_bounds(), &[]);
        let Genome::Composed(cg) = &g else { panic!() };
        assert_eq!(cg.payouts[0], 100); // payout_max
        assert_eq!(cg.meter_targets[0], 1); // meter_target_min floor
        assert_eq!(cg.awarded_budgets[0], 50); // spins_max
    }

    #[test]
    fn composed_repair_applies_pay_constraints_to_the_reels_paytable() {
        // fixture paytable: sym0@2 -> 2, sym1@2 -> 6
        let art = composed_artifact();
        let mut g = Genome::Composed(encode_composed(&composed_def()));
        if let Genome::Composed(cg) = &mut g {
            cg.payouts = vec![80, 30]; // sym0 outpays sym1
        }
        repair(
            &mut g,
            &art,
            &composed_bounds(),
            &[
                floor(1, None, 40),
                PayConstraint {
                    symbol: 1,
                    relation: PayRelation::TopPaying,
                    count: None,
                    value: 0,
                },
            ],
        );
        let Genome::Composed(cg) = &g else { panic!() };
        assert_eq!(cg.payouts[1], 40); // floored up to 40
        assert_eq!(cg.payouts[0], 40); // competitor capped at sym1's top pay
    }

    #[test]
    fn composed_repair_is_deterministic_and_skips_locked_groups() {
        let art = composed_artifact();
        let locks = SectionLocks {
            paytable: true,
            ..Default::default()
        };
        let mut a = encode_with_locks(&art, &locks);
        if let Genome::Composed(cg) = &mut a {
            cg.surfaces[0][0] = vec![7, 0, 2];
        }
        let mut b = a.clone();
        repair(&mut a, &art, &composed_bounds(), &[floor(0, None, 10)]);
        repair(&mut b, &art, &composed_bounds(), &[floor(0, None, 10)]);
        assert_eq!(a, b);
        let Genome::Composed(cg) = &a else { panic!() };
        assert!(cg.payouts.is_empty()); // locked group untouched (nothing to clamp)
    }
```

(The existing `floor(...)` helper and `PayConstraint`/`PayRelation` imports are already in this test module.)

- [ ] **Step 3: Run to verify they fail**

Run: `cargo test -p bloom-tuner genome`
Expected: FAIL — `repair` (enum version) and `meter_target_min` etc. not defined / not compiling.

- [ ] **Step 4: Implement**

In `genome.rs`:

1. Extract the two shared helpers out of `repair_slots` (move the existing loop bodies verbatim; `repair_slots` then calls them):

```rust
/// Rescale a count vector (deterministically) so it sums to `target`.
/// Extracted from the slots repair — strip math is identical on both sides
/// (spec §3.4).
fn rescale_counts(counts: &mut [u32], target: u32) {
    if counts.is_empty() {
        return;
    }
    let sum: u32 = counts.iter().sum();
    if sum == 0 {
        let n = counts.len() as u32;
        for (i, c) in counts.iter_mut().enumerate() {
            *c = target / n + if (i as u32) < target % n { 1 } else { 0 };
        }
    } else if sum != target {
        let mut acc = 0u32;
        let last = counts.len() - 1;
        for c in counts.iter_mut().take(last) {
            *c = ((*c as u64 * target as u64) / sum as u64) as u32;
            acc += *c;
        }
        counts[last] = target.saturating_sub(acc);
    }
}

/// GDD pay-constraint clamps over a paytable's entries — the exact block
/// from the slots repair, parameterized on the entry list so composed can
/// bind it to the reels instance's paytable (spec §3.3).
fn clamp_payout_constraints(
    entries: &[PaytableEntry],
    payouts: &mut [u64],
    constraints: &[PayConstraint],
) {
    if payouts.is_empty() {
        return;
    }
    for (e, p) in entries.iter().zip(payouts.iter_mut()) {
        for c in constraints {
            if c.symbol != e.symbol || c.count.is_some_and(|cc| cc != e.count) {
                continue;
            }
            match c.relation {
                PayRelation::Floor => *p = (*p).max(c.value),
                PayRelation::Ceiling => *p = (*p).min(c.value),
                PayRelation::TopPaying => {}
            }
        }
    }
    if let Some(top_sym) = constraints
        .iter()
        .find(|c| matches!(c.relation, PayRelation::TopPaying))
        .map(|c| c.symbol)
    {
        let top = entries
            .iter()
            .zip(payouts.iter())
            .filter(|(e, _)| e.symbol == top_sym)
            .map(|(_, &p)| p)
            .max()
            .unwrap_or(0);
        for (e, p) in entries.iter().zip(payouts.iter_mut()) {
            if e.symbol != top_sym && *p > top {
                *p = top;
            }
        }
    }
}
```

In `repair_slots`, replace the reel-counts normalization loop body with `rescale_counts(counts, reel.len() as u32)` (keep the `if counts.is_empty() { continue; }` guard) and the whole constraint block with `clamp_payout_constraints(&template.paytable.entries, &mut genome.payouts, constraints);`. **Run the slots repair tests after this refactor step alone** — they must stay green before adding the composed arm.

2. Composed repair + enum dispatch:

```rust
fn clamp_u32_range(v: u32, lo: u32, hi: u32) -> u32 {
    v.max(lo).min(hi)
}

fn repair_composed(
    genome: &mut ComposedGenome,
    def: &GameDefinition,
    reels: &Option<bloom_math::mechanics::composed::reels::ReelsConfig>,
    bounds: &GeneBounds,
    constraints: &[PayConstraint],
) {
    for ((_, strips), counts) in strip_surfaces(def).iter().zip(&mut genome.surfaces) {
        for (strip, c) in strips.iter().zip(counts.iter_mut()) {
            rescale_counts(c, strip.len() as u32);
        }
    }
    for p in &mut genome.payouts {
        *p = clamp_u64(*p, bounds.payout_min, bounds.payout_max);
    }
    if let Some(r) = reels {
        clamp_payout_constraints(&r.paytable.entries, &mut genome.payouts, constraints);
    }
    for t in &mut genome.meter_targets {
        *t = clamp_u32_range(*t, bounds.meter_target_min.max(1), bounds.meter_target_max);
    }
    for b in &mut genome.awarded_budgets {
        *b = clamp_u32_range(*b, bounds.spins_min.max(1), bounds.spins_max);
    }
}

pub fn repair(
    genome: &mut Genome,
    template: &MathArtifact,
    bounds: &GeneBounds,
    constraints: &[PayConstraint],
) {
    match (genome, template) {
        (Genome::Slots(g), MathArtifact::Slots(m)) => repair_slots(g, m, bounds, constraints),
        (Genome::Composed(g), MathArtifact::Composed { def, reels, .. }) => {
            repair_composed(g, def, reels, bounds, constraints)
        }
        _ => unreachable!("a genome is only ever repaired against its own template"),
    }
}
```

(Check the actual public path of `ReelsConfig` — `artifact.rs` imports `bloom_math::mechanics::composed::reels::ReelsConfig`; use the same.)

Note the slots arm's constraint clamp lives behind `if !genome.payouts.is_empty()` semantics — `clamp_payout_constraints` early-returns on empty payouts, so the locked-paytable behavior is preserved on both arms.

- [ ] **Step 5: Run the crate tests**

Run: `cargo test -p bloom-tuner`
Expected: PASS (existing slots repair/constraint tests via the extracted helpers + 4 new composed tests).

- [ ] **Step 6: Commit**

```powershell
git add studio/tuner/src/config.rs studio/tuner/src/genome.rs studio/tuner/src/bin/tune.rs studio/tuner/src/bin/tune_json.rs studio/tuner/src/genetic.rs studio/tuner/src/validate.rs
git commit -m "feat(tuner): composed repair + shared strip/paytable clamp helpers"
```

---

### Task 3: Artifact-typed tuner core (genetic loop, validate, fitness, outcome, trait)

This is the type flip: `SlotModel` → `MathArtifact` through the whole search path, plus the composed arms of mutate/crossover and family-aware telemetry columns. It's one coherent change — the pieces don't compile independently.

**Files:**

- Modify: `studio/tuner/src/outcome.rs`
- Modify: `studio/tuner/src/lib.rs`
- Modify: `studio/tuner/src/validate.rs`
- Modify: `studio/tuner/src/fitness.rs`
- Modify: `studio/tuner/src/genetic.rs`
- Modify: `studio/tuner/src/report.rs` (test fixture only)
- Modify: `studio/tuner/src/bin/tune.rs`, `studio/tuner/src/bin/tune_json.rs` (minimal compile fixes; full family-awareness is Task 4)
- Modify: `studio/tuner/src/genome.rs` (delete the Task-1 shim)

**Interfaces:**

- Consumes: SP-A's `bloom_simulator::artifact::simulate(&MathArtifact, &[u64]) -> Vec<RoundSample>`, `bloom_simulator::run::verify_artifact(&MathArtifact, &Metrics, &TargetSpec, usize) -> Result<(), Metrics>`, `artifact.static_violations(&TargetSpec)`, `artifact.validate_constraints(&TargetSpec)`, `Metrics.state_rtp: BTreeMap<String, f64>`; Tasks 1–2's `encode_with_locks`/`decode`/`repair`.
- Produces:
  - `pub trait Tuner { fn tune(&self, seed: &MathArtifact, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome; }`
  - `pub fn tune_with_progress(seed: &MathArtifact, target: &TargetSpec, cfg: &TunerConfig, on_progress: &mut dyn FnMut(&GenSnapshot)) -> TuneOutcome`
  - `TuneOutcome { pub model: MathArtifact, … }` (rest unchanged)
  - `GenSnapshot` gains `pub best_state_rtp: std::collections::BTreeMap<String, f64>`
  - `pub fn validate(seed: &MathArtifact, target: &TargetSpec, cfg: &TunerConfig) -> Result<(), String>`
  - `pub fn band_misses(artifact: &MathArtifact, m: &Metrics, t: &TargetSpec, n: usize) -> Vec<BandMiss>`

- [ ] **Step 1: Write the failing composed-GA tests**

Append to `studio/tuner/src/genetic.rs` tests:

```rust
    use bloom_simulator::artifact::MathArtifact;

    /// Composed twin of `toy()`: one reels instance, one base state, no
    /// features. strip = 5x sym0, 4x sym1, 1x sym2; sym1@1 -> 1,
    /// sym2@1 -> payout_sym2. Closed-form RTP = (4 + payout_sym2) / 10.
    fn composed_toy(payout_sym2: u64) -> MathArtifact {
        let def = serde_json::from_value(serde_json::json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "main", "type": "reels@1",
                  "config": {
                    "strips": [[0, 0, 0, 0, 0, 1, 1, 1, 1, 2]],
                    "rows": 1,
                    "symbols": [{"id":0,"role":"normal"},{"id":1,"role":"normal"},{"id":2,"role":"normal"}],
                    "paylines": [[0]],
                    "paytable": { "entries": [
                        {"symbol":1,"count":1,"payout":1},
                        {"symbol":2,"count":1,"payout":payout_sym2} ] } } }
            ],
            "states": [
                { "id": "base", "bindings": [{ "mechanic": "main" }],
                  "steps": { "budget": 1 }, "script": [{ "invoke": "main.spin" }] }
            ],
            "start": "base",
            "transitions": [],
            "caps": { "max_steps": 10 }
        }))
        .unwrap();
        MathArtifact::from_definition(def).expect("toy compiles")
    }

    /// Composed def whose RTP is driven by the awarded free-spins budget:
    /// base ev 0.4/spin, scatter (1 of 10 cells) sends base -> fs whose
    /// budget B is the tunable. RTP(B) ~ 0.4 + 0.1 * B * 0.4.
    fn composed_feature_toy() -> MathArtifact {
        let def = serde_json::from_value(serde_json::json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "main", "type": "reels@1",
                  "config": {
                    "strips": [[0, 0, 0, 0, 0, 1, 1, 1, 1, 9]],
                    "rows": 1,
                    "symbols": [{"id":0,"role":"normal"},{"id":1,"role":"normal"},{"id":9,"role":"scatter"}],
                    "paylines": [[0]],
                    "paytable": { "entries": [{"symbol":1,"count":1,"payout":1}] },
                    "events": [{ "symbol": 9, "min_count": 1, "emit": "scatter" }] } }
            ],
            "states": [
                { "id": "base", "bindings": [{ "mechanic": "main" }],
                  "steps": { "budget": 1 }, "script": [{ "invoke": "main.spin" }] },
                { "id": "fs", "bindings": [{ "mechanic": "main" }],
                  "steps": { "budget": "awarded", "initial": 2 },
                  "script": [{ "invoke": "main.spin" }] }
            ],
            "start": "base",
            "transitions": [ { "from": "base", "on": "scatter", "to": "fs" } ],
            "caps": { "max_steps": 200 }
        }))
        .unwrap();
        MathArtifact::from_definition(def).expect("feature toy compiles")
    }

    #[test]
    fn converges_a_detuned_composed_definition_into_band() {
        // payout_sym2 = 1 -> RTP 0.5; target 0.9 +/- 0.02 (sym2 -> 5 solves it).
        let out = GeneticTuner.tune(&composed_toy(1), &target_09(), &cfg(7));
        assert!(
            matches!(out.verdict, Verdict::Pass),
            "verdict was {:?}",
            out.verdict
        );
        assert!(
            (out.metrics.rtp - 0.9).abs() <= 0.02,
            "rtp = {}",
            out.metrics.rtp
        );
        assert_eq!(out.model.family(), "composed@1");
    }

    #[test]
    fn composed_tune_is_deterministic() {
        let a = GeneticTuner.tune(&composed_toy(1), &target_09(), &cfg(2026));
        let b = GeneticTuner.tune(&composed_toy(1), &target_09(), &cfg(2026));
        assert_eq!(a.model, b.model);
        assert_eq!(a.metrics.rtp, b.metrics.rtp);
        assert_eq!(a.trace.generations_run, b.trace.generations_run);
    }

    #[test]
    fn composed_tune_never_mutates_structure() {
        let seed = composed_toy(1);
        let out = GeneticTuner.tune(&seed, &target_09(), &cfg(7));
        let (t, d) = (
            seed.composed_def().unwrap(),
            out.model.composed_def().unwrap(),
        );
        assert_eq!(d.states, t.states); // no strips override in this toy -> identical
        assert_eq!(d.transitions, t.transitions);
        assert_eq!(d.start, t.start);
        assert_eq!(d.caps, t.caps);
        assert_eq!(
            d.mechanics[0].config["paylines"],
            t.mechanics[0].config["paylines"]
        );
        assert_eq!(
            d.mechanics[0].config["symbols"],
            t.mechanics[0].config["symbols"]
        );
        assert_eq!(d.mechanics[0].config["rows"], t.mechanics[0].config["rows"]);
        // strip length preserved
        let strips: Vec<Vec<u8>> =
            serde_json::from_value(d.mechanics[0].config["strips"].clone()).unwrap();
        assert_eq!(strips[0].len(), 10);
    }

    #[test]
    fn composed_features_group_tunes_the_awarded_budget() {
        // Reels + paytable locked: only meter targets / awarded budgets move.
        // RTP(B) ~ 0.4(1 + 0.1B): B=2 -> ~0.48; band 0.88..0.96 needs B ~ 12-13.
        let seed = composed_feature_toy();
        let mut t = target_09();
        t.rtp_tolerance = 0.04;
        let c = TunerConfig {
            locks: SectionLocks {
                reels: true,
                paytable: true,
                bonus: false,
            },
            ..cfg(7)
        };
        let out = GeneticTuner.tune(&seed, &t, &c);
        let (td, dd) = (
            seed.composed_def().unwrap(),
            out.model.composed_def().unwrap(),
        );
        // locked groups byte-identical
        assert_eq!(dd.mechanics[0].config["strips"], td.mechanics[0].config["strips"]);
        assert_eq!(
            dd.mechanics[0].config["paytable"],
            td.mechanics[0].config["paytable"]
        );
        // the budget moved off its seed value and the tune passed
        assert!(
            matches!(out.verdict, Verdict::Pass),
            "verdict was {:?} (rtp {})",
            out.verdict,
            out.metrics.rtp
        );
        assert_ne!(dd.states[1].steps.initial, Some(2));
    }

    #[test]
    fn composed_tuned_model_never_worse_than_seed_at_final_fidelity() {
        let seed = composed_toy(5); // already in-band (RTP 0.9)
        let t = tight_target();
        for master in 0..10 {
            let c = noisy_cfg(master);
            let out = GeneticTuner.tune(&seed, &t, &c);
            let final_seeds = generate_seeds(c.master_seed ^ FINAL_SALT, c.final_candidate_count);
            let fit = |a: &MathArtifact| {
                fitness(
                    &measure(&bloom_simulator::artifact::simulate(a, &final_seeds)),
                    &t,
                    &c.weights,
                )
            };
            assert!(
                fit(&out.model) >= fit(&seed) - 1e-12,
                "master {master}: worse than seed"
            );
        }
    }

    #[test]
    fn snapshots_carry_per_state_rtp_for_composed() {
        let out = GeneticTuner.tune(&composed_toy(1), &target_09(), &cfg(7));
        assert!(out
            .trace
            .snapshots
            .iter()
            .all(|s| s.best_state_rtp.contains_key("base")));
        assert!(out.metrics.state_rtp.contains_key("base"));
    }
```

Also update the existing slots tests mechanically in the same file: wherever a test calls `GeneticTuner.tune(&toy(1), …)` pass `&MathArtifact::Slots(toy(1))` — cleanest is a tiny helper at the top of the test module:

```rust
    fn slots(m: SlotModel) -> MathArtifact {
        MathArtifact::Slots(m)
    }
```

then `GeneticTuner.tune(&slots(toy(1)), …)`. Assertions on `out.model.reels` / `out.model.paytable` become `out.model.as_slots().unwrap().reels` etc. The `tuned_model_never_worse_than_seed_at_final_fidelity` slots test switches its `fit` closure to `bloom_simulator::artifact::simulate` the same way as the composed twin above.

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p bloom-tuner genetic`
Expected: FAIL to compile — `tune` takes `&SlotModel`, no `best_state_rtp`, etc.

- [ ] **Step 3: Flip the types**

**`outcome.rs`:**

```rust
use bloom_simulator::artifact::MathArtifact;
use std::collections::BTreeMap;
```

- `TuneOutcome.model: MathArtifact` (replace the `SlotModel` import/type).
- `GenSnapshot` gains `pub best_state_rtp: BTreeMap<String, f64>,` (after `best_bonus_hit_rates`).

**`lib.rs`:**

```rust
use bloom_simulator::artifact::MathArtifact;

pub trait Tuner {
    fn tune(&self, seed: &MathArtifact, target: &TargetSpec, cfg: &TunerConfig) -> TuneOutcome;
}
```

(drop the now-unused `SlotModel` import).

**`validate.rs`** — signature + family dispatch; bounds checks shared:

```rust
use bloom_simulator::artifact::MathArtifact;

pub fn validate(seed: &MathArtifact, target: &TargetSpec, cfg: &TunerConfig) -> Result<(), String> {
    if let MathArtifact::Slots(m) = seed {
        if target.bonus_hit_rate_bands.len() != m.bonuses.len() {
            return Err(format!(
                "target has {} bonus_hit_rate_bands but model has {} bonuses (must match)",
                target.bonus_hit_rate_bands.len(),
                m.bonuses.len()
            ));
        }
    }
    // (composed: bonus bands are rejected by validate_constraints below — #160)
    let b = &cfg.bounds;
    …existing bound checks unchanged…
    if b.meter_target_min > b.meter_target_max {
        return Err(format!(
            "meter_target_min ({}) > meter_target_max ({})",
            b.meter_target_min, b.meter_target_max
        ));
    }
    …existing population/generation/candidate ceilings unchanged…
    seed.validate_constraints(target)?;
    Ok(())
}
```

Update its tests: `validate(&model(1), …)` → `validate(&MathArtifact::Slots(model(1)), …)` (add a local `use bloom_simulator::artifact::MathArtifact;`), plus two new tests:

```rust
    fn composed() -> MathArtifact {
        // reuse the smallest valid composed definition
        let def = serde_json::from_value(serde_json::json!({
            "family": "composed@1",
            "mechanics": [
                { "id": "main", "type": "reels@1",
                  "config": { "strips": [[0, 1]], "rows": 1,
                    "symbols": [{"id":0,"role":"normal"},{"id":1,"role":"normal"}],
                    "paylines": [[0]],
                    "paytable": { "entries": [{"symbol":1,"count":1,"payout":1}] } } }
            ],
            "states": [ { "id": "base", "bindings": [{ "mechanic": "main" }],
                "steps": { "budget": 1 }, "script": [{ "invoke": "main.spin" }] } ],
            "start": "base", "transitions": [], "caps": { "max_steps": 10 }
        })).unwrap();
        MathArtifact::from_definition(def).unwrap()
    }

    #[test]
    fn composed_rejects_bonus_bands_via_constraints() {
        let err = validate(&composed(), &target(1), &cfg()).unwrap_err();
        assert!(err.contains("#160"), "got: {err}");
    }

    #[test]
    fn rejects_inverted_meter_target_bounds() {
        let mut c = cfg();
        c.bounds.meter_target_min = 50;
        c.bounds.meter_target_max = 1;
        assert!(validate(&composed(), &target(0), &c)
            .unwrap_err()
            .contains("meter_target"));
    }
```

(note `target(1)` carries one bonus band — the composed arm must hit the `#160` rejection, and `target(0)` carries none so the meter-bounds error surfaces.)

**`fitness.rs`** — `band_misses` first parameter becomes the artifact:

```rust
use bloom_simulator::artifact::MathArtifact;

pub fn band_misses(artifact: &MathArtifact, m: &Metrics, t: &TargetSpec, n: usize) -> Vec<BandMiss> {
    …identical body, except the static-violations loop becomes:
    for v in artifact.static_violations(t) { … }
}
```

(drop the `use bloom_simulator::constraints::static_violations;` and `SlotModel` imports). In its tests, wrap: `band_misses(&toy_model(), …)` → `band_misses(&MathArtifact::Slots(toy_model()), …)`, and `verify(&toy_model(), …)` → `verify_artifact(&MathArtifact::Slots(toy_model()), …)` in the agreement test (import `bloom_simulator::run::verify_artifact`).

**`genetic.rs`** — the loop. Imports change to:

```rust
use bloom_simulator::artifact::{simulate, MathArtifact};
use bloom_simulator::measure::measure;
use bloom_simulator::run::verify_artifact;
```

(drop `measure::simulate` and `run::verify`; `SlotModel` stays only if a helper still needs it — it shouldn't.)

Mechanical renames in `tune_with_progress` (delete the Task-1 shim usage):

- signature: `pub fn tune_with_progress(seed: &MathArtifact, target: &TargetSpec, cfg: &TunerConfig, on_progress: &mut dyn FnMut(&GenSnapshot)) -> TuneOutcome`
- `encode_with_locks_slots(seed_model, &cfg.locks)` → `encode_with_locks(seed, &cfg.locks)`
- every `decode_slots(genome, seed_model)` → `decode(genome, seed)` (type `MathArtifact`)
- every `simulate(&model, &seeds)` stays literally `simulate(&model, &seeds)` (now the artifact version)
- `verify(&best_model, &bm, target, …)` → `verify_artifact(&best_model, &bm, target, …)`, same for the confirmation + final verdict calls
- `repair_slots(` → `repair(` in `mutate`/`crossover` (their `template: &SlotModel` params become `template: &MathArtifact`)
- `feasible: Option<(SlotModel, …)>` → `Option<(MathArtifact, …)>`; `candidates: Vec<SlotModel>` → `Vec<MathArtifact>`; `*seed_model != model` → `*seed != model`; `candidates.contains(seed_model)` → `candidates.contains(seed)`
- `band_misses(&model, &metrics, target, …)` — unchanged call, now artifact-typed.

**`mutate` gets a composed arm** (wrap the existing body in a `match`):

```rust
fn mutate(
    g: &mut Genome,
    template: &MathArtifact,
    cfg: &TunerConfig,
    rng: &mut SplitMix64,
    constraints: &[PayConstraint],
) {
    let b = &cfg.bounds;
    match g {
        Genome::Slots(g) => {
            …existing three loops verbatim (reel_counts / payouts / bonuses)…
        }
        Genome::Composed(g) => {
            // strips: same one-unit bucket move, per strip on every surface
            for counts in g.surfaces.iter_mut().flatten() {
                if counts.len() >= 2 && unit(rng) < cfg.mutation_rate {
                    let from = (rng.next_u64() as usize) % counts.len();
                    let to = (rng.next_u64() as usize) % counts.len();
                    if from != to && counts[from] > 0 {
                        counts[from] -= 1;
                        counts[to] += 1;
                    }
                }
            }
            // payouts: same step-don't-resample op as slots
            for p in &mut g.payouts {
                if unit(rng) < cfg.mutation_rate {
                    let step_max = ((b.payout_max - b.payout_min) / 10).max(1);
                    let step = 1 + rng.next_u64() % step_max;
                    *p = if unit(rng) < 0.5 {
                        p.saturating_sub(step).max(b.payout_min)
                    } else {
                        p.saturating_add(step).min(b.payout_max)
                    };
                }
            }
            // features: resample within bounds, like slots' bonus genes
            for t in &mut g.meter_targets {
                if unit(rng) < cfg.mutation_rate {
                    let lo = b.meter_target_min.max(1);
                    *t = lo + (rng.next_u64() as u32 % (b.meter_target_max - lo + 1));
                }
            }
            for a in &mut g.awarded_budgets {
                if unit(rng) < cfg.mutation_rate {
                    let lo = b.spins_min.max(1);
                    *a = lo + (rng.next_u64() as u32 % (b.spins_max - lo + 1));
                }
            }
        }
    }
    repair(g, template, &cfg.bounds, constraints);
}
```

**`crossover` gets a composed arm** (same shape — uniform gene-wise coin flips; keep the `crossover_rate` early-return and the trailing `repair` outside the match):

```rust
    match (&mut child, p2) {
        (Genome::Slots(c), Genome::Slots(p2)) => {
            …existing three loops verbatim…
        }
        (Genome::Composed(c), Genome::Composed(p2)) => {
            for (surface, src) in c.surfaces.iter_mut().zip(&p2.surfaces) {
                for (strip, s) in surface.iter_mut().zip(src) {
                    if unit(rng) < 0.5 {
                        *strip = s.clone();
                    }
                }
            }
            for (i, v) in c.payouts.iter_mut().enumerate() {
                if unit(rng) < 0.5 {
                    *v = p2.payouts[i];
                }
            }
            for (i, v) in c.meter_targets.iter_mut().enumerate() {
                if unit(rng) < 0.5 {
                    *v = p2.meter_targets[i];
                }
            }
            for (i, v) in c.awarded_budgets.iter_mut().enumerate() {
                if unit(rng) < 0.5 {
                    *v = p2.awarded_budgets[i];
                }
            }
        }
        _ => unreachable!("population is single-family"),
    }
```

**Gene-agreement columns** — replace the inline `col_payout`/bonus-columns block with a helper and call it with the scored genomes (the decoded artifacts are no longer needed for columns; delete the `decoded` vec):

```rust
/// One column per tunable gene dimension for the agreement telemetry.
/// Columns must be well-defined even under locks: a locked group is simply
/// absent (no column), mirroring how the search space shrinks.
fn gene_columns(scored: &[(Genome, f64)]) -> Vec<Vec<f64>> {
    let mut cols: Vec<Vec<f64>> = Vec::new();
    match &scored[0].0 {
        Genome::Slots(first) => {
            if !first.payouts.is_empty() {
                cols.push(
                    scored
                        .iter()
                        .map(|(g, _)| match g {
                            Genome::Slots(g) => {
                                g.payouts.iter().map(|&p| p as f64).sum::<f64>()
                                    / g.payouts.len().max(1) as f64
                            }
                            _ => unreachable!(),
                        })
                        .collect(),
                );
            }
            for dim in 0..first.bonuses.len() * 3 {
                cols.push(
                    scored
                        .iter()
                        .map(|(g, _)| match g {
                            Genome::Slots(g) => {
                                let b = &g.bonuses[dim / 3];
                                match dim % 3 {
                                    0 => b.spins_awarded as f64,
                                    1 => b.multiplier as f64,
                                    _ => b.min_count as f64,
                                }
                            }
                            _ => unreachable!(),
                        })
                        .collect(),
                );
            }
        }
        Genome::Composed(first) => {
            if !first.payouts.is_empty() {
                cols.push(
                    scored
                        .iter()
                        .map(|(g, _)| match g {
                            Genome::Composed(g) => {
                                g.payouts.iter().map(|&p| p as f64).sum::<f64>()
                                    / g.payouts.len().max(1) as f64
                            }
                            _ => unreachable!(),
                        })
                        .collect(),
                );
            }
            for i in 0..first.meter_targets.len() {
                cols.push(
                    scored
                        .iter()
                        .map(|(g, _)| match g {
                            Genome::Composed(g) => g.meter_targets[i] as f64,
                            _ => unreachable!(),
                        })
                        .collect(),
                );
            }
            for i in 0..first.awarded_budgets.len() {
                cols.push(
                    scored
                        .iter()
                        .map(|(g, _)| match g {
                            Genome::Composed(g) => g.awarded_budgets[i] as f64,
                            _ => unreachable!(),
                        })
                        .collect(),
                );
            }
        }
    }
    if cols.is_empty() {
        // reels-only search: emit a constant column so the snapshot shape
        // (non-empty agreement) is preserved.
        cols.push(vec![1.0; scored.len()]);
    }
    cols
}
```

Note this changes the slots columns from decoded-model means to genome means — identical values when unlocked (the genome IS the model's payouts), and locked groups now drop their column instead of emitting a constant one. The existing test `snapshots_carry_population_stats_and_profile_is_present` only asserts non-emptiness, which the fallback column guarantees.

**Snapshot construction** gains the state field:

```rust
        let snap = GenSnapshot {
            generation: g,
            best_fitness: scored[0].1,
            best_rtp: bm.rtp,
            best_volatility: bm.volatility,
            best_bonus_hit_rates: bm.bonus_hit_rates.clone(),
            best_state_rtp: bm.state_rtp.clone(),
            population: population_stats(&fitnesses),
            gene_agreement: gene_agreement(&gene_columns(&scored)),
        };
```

**`impl Tuner for GeneticTuner`** — signature follows the trait.

**`report.rs`** — only the test fixture: `model: SlotModel { … }` → `model: bloom_simulator::artifact::MathArtifact::Slots(SlotModel { … })`, and add `best_state_rtp: Default::default(),` to its `GenSnapshot`.

**Bins (minimal compile fix, full rework in Task 4):** in `bin/tune.rs` and `bin/tune_json.rs`, wrap at the call sites: `bloom_tuner::validate(&MathArtifact::Slots(model.clone()), …)`, `GeneticTuner.tune(&MathArtifact::Slots(model), …)` / `tune_with_progress(&MathArtifact::Slots(model), …)`, and where they serialize `out.model` use `out.model.as_slots().expect("slots input")`. In `tune_json.rs`'s `result_line`/fixtures add `best_state_rtp: Default::default(),` to `GenSnapshot` constructions and serialize `"model": out.model.as_slots()` temporarily (Task 4 replaces this).

Delete `encode_with_locks_slots` from `genome.rs`.

- [ ] **Step 4: Run the full crate**

Run: `cargo test -p bloom-tuner`
Expected: PASS — all existing slots tests (artifact-wrapped) + the 6 new composed GA tests. The composed convergence tests are the slow ones (~same order as the slots `converges_a_detuned_model_back_into_band`); if `composed_features_group_tunes_the_awarded_budget` can't reach `Pass` with `cfg(7)`'s budget, widen `rtp_tolerance` to 0.05 or raise `max_generations` for that test only — the assertion that matters is locked-groups-untouched + budget-moved + in-band.

- [ ] **Step 5: Commit**

```powershell
git add studio/tuner/src studio/simulator/src/artifact.rs
git commit -m "feat(tuner): artifact-typed GA core with composed mutate/crossover"
```

---

### Task 4: Family-aware CLIs (`tune_json`, `tune`)

**Files:**

- Modify: `studio/tuner/src/bin/tune_json.rs`
- Modify: `studio/tuner/src/bin/tune.rs`

**Interfaces:**

- Consumes: `MathArtifact::from_json_value` (SP-A; slots default when no top-level `family`), Task 3's artifact-typed `validate`/`tune_with_progress`/`Tuner`, `MathArtifact::as_slots`/`composed_def`/`family()`.
- Produces (wire contract, additive):
  - progress lines gain `"family"` and `"stateRtp"`
  - result line gains `"family"`, `"metrics.stateRtp"`, `"metrics.stateVisitFreq"`; `"model"` is the `SlotModel` JSON for slots (unchanged shape) or the `GameDefinition` JSON for composed
  - config JSON `bounds` accepts optional `meter_target_min`/`meter_target_max` (defaults 1 / 100)

- [ ] **Step 1: Write the failing wire-contract tests**

In `bin/tune_json.rs` tests: the `outcome()` fixture's `metrics` gains state maps and the model becomes an artifact —

```rust
            metrics: Metrics {
                rtp: 0.901,
                volatility: 3.2,
                hit_frequency: 0.41,
                bonus_hit_rates: vec![],
                base_rtp: 0.901,
                feature_rtp: 0.0,
                state_rtp: [("base".to_string(), 0.901)].into(),
                state_visit_freq: [("base".to_string(), 1.0)].into(),
                ..Default::default()
            },
```

Add tests:

```rust
    #[test]
    fn result_line_carries_family_and_state_shares() {
        let v: serde_json::Value =
            serde_json::from_str(&result_line(&outcome(Verdict::Pass))).unwrap();
        assert_eq!(v["family"], "slots@1");
        assert_eq!(v["metrics"]["stateRtp"]["base"], 0.901);
        assert_eq!(v["metrics"]["stateVisitFreq"]["base"], 1.0);
        // slots "model" keeps its legacy shape (an object with "reels")
        assert!(v["model"]["reels"].is_array());
    }

    #[test]
    fn composed_result_line_model_is_the_definition() {
        let mut o = outcome(Verdict::Pass);
        let def: bloom_math::mechanics::composed::GameDefinition = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../runtime/server/demo/composed.definition.json"
            ))
            .unwrap(),
        )
        .unwrap();
        o.model = bloom_simulator::artifact::MathArtifact::from_definition(def).unwrap();
        let v: serde_json::Value = serde_json::from_str(&result_line(&o)).unwrap();
        assert_eq!(v["family"], "composed@1");
        assert_eq!(v["model"]["family"], "composed@1");
        assert!(v["model"]["states"].is_array());
        assert!(v["model"]["reels"].is_null()); // not a SlotModel shape
    }

    #[test]
    fn progress_line_carries_family_and_state_rtp() {
        let mut snap = GenSnapshot {
            generation: 3,
            best_fitness: -0.25,
            best_rtp: 0.85,
            best_volatility: 2.1,
            best_bonus_hit_rates: vec![],
            best_state_rtp: [("base".to_string(), 0.7), ("fs".to_string(), 0.15)].into(),
            population: population_stats(&[-0.25]),
            gene_agreement: vec![1.0],
        };
        let v: serde_json::Value =
            serde_json::from_str(&progress_line(&snap, 40, "composed@1")).unwrap();
        assert_eq!(v["family"], "composed@1");
        assert_eq!(v["stateRtp"]["fs"], 0.15);
        snap.best_state_rtp.clear();
        let v: serde_json::Value =
            serde_json::from_str(&progress_line(&snap, 40, "slots@1")).unwrap();
        assert_eq!(v["family"], "slots@1");
    }

    #[test]
    fn bounds_json_meter_target_defaults() {
        let cj: ConfigJson = serde_json::from_str(&format!("{FULL_CONFIG}}}")).unwrap();
        assert_eq!(cj.bounds.meter_target_min, 1);
        assert_eq!(cj.bounds.meter_target_max, 100);
    }
```

(update the two existing `progress_line(&snap, 40)` call sites to `progress_line(&snap, 40, "slots@1")` and add `best_state_rtp: Default::default(),` where fixtures construct `GenSnapshot` — done partially in Task 3; keep them compiling.)

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p bloom-tuner --bin tune_json`
Expected: FAIL — `progress_line` arity, missing `family`/`stateRtp` keys, `meter_target_min` unknown.

- [ ] **Step 3: Implement `tune_json`**

1. `BoundsJson` gains:

```rust
    #[serde(default = "default_meter_target_min")]
    meter_target_min: u32,
    #[serde(default = "default_meter_target_max")]
    meter_target_max: u32,
```

```rust
fn default_meter_target_min() -> u32 {
    1
}
fn default_meter_target_max() -> u32 {
    100
}
```

and the `GeneBounds { … }` construction copies both through (replacing Task 2's literals).

2. `progress_line(snap: &GenSnapshot, max_generations: usize, family: &str) -> String` — add to the json:

```rust
        "family": family,
        "stateRtp": snap.best_state_rtp,
```

3. `result_line` — add family + model dispatch + state shares:

```rust
    let model_json = match &out.model {
        bloom_simulator::artifact::MathArtifact::Slots(m) => serde_json::to_value(m),
        a => serde_json::to_value(a.composed_def().expect("two families")),
    }
    .expect("model serializes");
```

then in the `json!` body: `"family": out.model.family(), "model": model_json,` and inside `"metrics"`: `"stateRtp": out.metrics.state_rtp, "stateVisitFreq": out.metrics.state_visit_freq,`.

4. `main`: replace the `SlotModel` parse with the artifact sniff (mirrors `curate_json`):

```rust
    let artifact = match fs::read_to_string(&args[1])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string()))
        .and_then(bloom_simulator::artifact::MathArtifact::from_json_value)
    {
        Ok(a) => a,
        Err(e) => {
            eprintln!("bad model json: {e}");
            std::process::exit(2);
        }
    };
```

`validate(&artifact, …)`, `let family = artifact.family();`, `tune_with_progress(&artifact, …)` with `|s| emit(progress_line(s, max_generations, family))`. Remove the Task-3 `as_slots()` stopgap.

- [ ] **Step 4: Implement `tune` (legacy CLI)**

Same artifact parse for `args[1]` (`expect`-style is fine, it already panics on bad input — keep its existing error style), `validate(&artifact, …)`, `GeneticTuner.tune(&artifact, …)`, and the model write becomes:

```rust
    let model_json = match &out.model {
        bloom_simulator::artifact::MathArtifact::Slots(m) => serde_json::to_string_pretty(m),
        a => serde_json::to_string_pretty(a.composed_def().expect("two families")),
    }
    .expect("serialize tuned model");
```

`BoundsJson` in `tune.rs` gets the same two defaulted fields (copy the four lines).

- [ ] **Step 5: Run**

Run: `cargo test -p bloom-tuner`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add studio/tuner/src/bin
git commit -m "feat(tuner): family-aware tune_json/tune CLIs with per-state telemetry"
```

---

### Task 5: Full gates + golden demo run

**Files:** none new — verification only (plus any fixes it forces).

- [ ] **Step 1: Full Rust gates**

Run, from the worktree root:

```powershell
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all clean. (`cargo fmt` without `--check` to fix, then re-run. Windows note: if a build-script exe hits `os error 4551`, delete `target/*/build/<crate>-*` and rebuild — App Control blocks stale artifacts.)

- [ ] **Step 2: Golden run — composed demo definition through tune_json**

Write two scratch inputs (PowerShell, from the worktree root):

```powershell
'{ "spec": null, "master_seed": 7, "rtp_target": 0.9, "rtp_tolerance": 0.05, "volatility_min": 0.0, "volatility_max": 1000000000.0, "bonus_hit_rate_bands": [], "pool_size": 0, "candidate_count": 0, "realized_correction_band": 0.05 }' | Out-File -Encoding utf8 tmp-target.json
'{ "master_seed": 7, "population": 12, "max_generations": 10, "elitism": 2, "mutation_rate": 0.25, "crossover_rate": 0.9, "stagnation_window": 4, "search_candidate_count": 4000, "final_candidate_count": 20000, "bounds": { "payout_min": 0, "payout_max": 50, "spins_min": 1, "spins_max": 50, "multiplier_min": 1, "multiplier_max": 10, "min_count_min": 1, "min_count_max": 5 }, "weights": { "rtp": 1.0, "volatility": 1.0, "hit_rate": 1.0 } }' | Out-File -Encoding utf8 tmp-config.json
cargo run --release -p bloom-tuner --bin tune_json -- runtime/server/demo/composed.definition.json tmp-target.json tmp-config.json
```

**Check the target-file shape first:** `tune_json` deserializes `args[2]` straight into `TargetSpec` (serde ignores unknown keys; look at `TargetSpec`'s serde attributes in `studio/simulator/src/target.rs` and mirror an existing target fixture from the repo, e.g. whatever `app/math` writes — if `TargetSpec` uses a flattened/`TargetFile` shape adjust the scratch JSON accordingly). Expected output: NDJSON progress lines each carrying `"family":"composed@1"` and a `"stateRtp"` object with real state ids (`base`, `fs1`, `fs2`), then one result line with `"verdict"` pass/near_miss, a `"model"` that is a full `GameDefinition`, and `"metrics"."stateRtp"`/`"stateVisitFreq"`. Exit code 0.

Then the slots regression golden: run the same config against any repo slots model fixture (e.g. the model JSON used by existing e2e cassettes or a hand-written toy) and eyeball that the result line still has the legacy keys (`model.reels`, `metrics.rtp`, `profile`, `stopReason`) so the Python runner's contract is intact. Delete `tmp-target.json`/`tmp-config.json` afterward.

- [ ] **Step 3: Frontend/backend untouched sanity**

`git status` — confirm only `studio/simulator` + `studio/tuner` (+ this plan doc) changed. No TS/Python edits means no prettier/nx/pytest gates needed this branch. (The Playwright suite doesn't exercise composed tuning yet — SP-C wires the studio; per repo policy run `just e2e` before the PR only if the backend/frontend were touched. They weren't.)

- [ ] **Step 4: Commit any fix-ups + plan doc**

```powershell
git add -A
git commit -m "test(tuner): SP-B gates + golden composed demo run"
```

(If nothing to commit beyond the plan doc, commit the plan doc with `docs(plans): SP-B tuner convergence plan`.)

---

## Self-Review (done at plan time)

- **Spec §3.4 coverage:** two-variant `Genome` enum ✓ (Task 1); per-binding strips incl. per-state overrides tuning independently ✓ (Task 1 fixture has a strips-redefining override); instance-level paytable ✓; meter targets + awarded budgets ✓; structure copied verbatim at decode ✓ (Task 1/3 structure tests); three-group section locks ✓ (Task 1); operators/repair/clamps reused ✓ (Task 2 shared helpers, Task 3 mirrored arms); meter/budget bounds ride `GeneBounds` ✓ (Task 2 — budgets reuse `spins_min/max` since a budget IS spins-awarded; meter targets get the two new fields); telemetry gains `family` + per-state shares ✓ (Tasks 3–4).
- **§3.1 family seam:** artifact parse dispatches on top-level `family` exactly like SP-A's `curate_json` (no separate job-JSON field needed — the artifact payload carries it; legacy slots JSON unchanged) ✓.
- **Out of scope honored:** no feature-level bands (#160 rejection preserved via `validate_constraints`), no structural mutation, no GDD/realizer work (SP-D), no backend/pane work (SP-C).
- **Compile-greenness per task:** Task 1 keeps `genetic.rs` on a temporary slots shim; Task 3 deletes it. Bins get literal bounds in Task 2, serde defaults in Task 4.
- **Type consistency:** `encode_with_locks(&MathArtifact, &SectionLocks) -> Genome`, `decode(&Genome, &MathArtifact) -> MathArtifact`, `repair(&mut Genome, &MathArtifact, &GeneBounds, &[PayConstraint])`, `verify_artifact`, `band_misses(&MathArtifact, …)`, `validate(&MathArtifact, …)`, `Tuner::tune(&MathArtifact, …)`, `TuneOutcome.model: MathArtifact`, `GenSnapshot.best_state_rtp: BTreeMap<String, f64>` — used identically across Tasks 1–4.
