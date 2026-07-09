//! Definition → CompiledGame: all validation and semantic resolution happens
//! here, once, before any evaluation. `evaluate` may then assume a
//! well-formed game (its `unreachable!`s lean on this).

use serde_json::Value;

use super::definition::{BudgetSpec, GameDefinition, FAMILY};
use super::mechanic::{MechanicConfig, MechanicKind};
use super::reels::ReelsConfig;

/// Hard kernel bound on `caps.max_steps`. Steps generalize `slots@1` free
/// spins here and this plays the same role as `MAX_FREE_SPINS`
/// (`mechanics::slots::eval`) — NOT a game-design knob, but the ceiling that
/// keeps a pathological definition (e.g. `max_steps: u32::MAX` plus a
/// self-refunding `steps:exhausted` effect row) from growing the trace
/// without bound. No honest composed@1 game plays anywhere near 10k steps in
/// one round, so this is invisible to legitimate models while making the
/// kernel incapable of unbounded memory/time for ANY input.
pub const MAX_STEPS_CEILING: u32 = 10_000;

/// Kernel bound on `rows`: it drives a per-reel `Vec` allocation sized `rows`
/// on every `spin` (component `components::spin`), so an unbounded value is
/// a multi-GB-allocation vector. 100 rows is far beyond any real slot layout
/// (typically 1-5) and costs nothing for honest games.
const MAX_REELS_ROWS: usize = 100;

/// Semantic validation of a resolved `ReelsConfig` — beyond what serde's
/// shape check catches. Compile calls this at every site that produces a
/// `ReelsConfig` (base declaration and per-binding merged override) so
/// `evaluate` can assume: strips are non-empty (no mod-by-zero in `spin`),
/// `rows` is in bounds (no OOM, no empty grid), and every payline indexes
/// cells that actually exist on the grid (no OOB panic in `line_payout`).
fn validate_reels(cfg: &ReelsConfig) -> Result<(), String> {
    if cfg.strips.is_empty() {
        return Err("reels: strips must not be empty".into());
    }
    if cfg.strips.iter().any(|strip| strip.is_empty()) {
        return Err("reels: every strip must be non-empty".into());
    }
    if cfg.rows == 0 {
        return Err("reels: rows must be >= 1".into());
    }
    if cfg.rows > MAX_REELS_ROWS {
        return Err(format!("reels: rows must be <= {MAX_REELS_ROWS}"));
    }
    for (i, line) in cfg.paylines.iter().enumerate() {
        if line.len() != cfg.strips.len() {
            return Err(format!(
                "reels: payline {i} has {} entries, expected {} (one per strip)",
                line.len(),
                cfg.strips.len()
            ));
        }
        if line.iter().any(|&row| row >= cfg.rows) {
            return Err(format!(
                "reels: payline {i} references a row out of bounds (rows={})",
                cfg.rows
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CompiledBudget {
    Fixed(u32),
    Awarded { initial: u32 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledInvoke {
    pub binding: usize,
    pub trigger: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledState {
    pub id: String,
    pub instances: Vec<usize>,        // binding idx -> game instance idx
    pub configs: Vec<MechanicConfig>, // binding idx -> effective config
    pub budget: CompiledBudget,
    pub script: Vec<CompiledInvoke>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Effect {
    AddSteps(u32),
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompiledTransition {
    pub from: usize,
    pub on: String,
    pub to: Option<usize>,
    pub effect: Option<Effect>,
}

#[derive(Debug, Clone, PartialEq)]
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
    WrongFamily {
        found: String,
    },
    DuplicateId {
        id: String,
    },
    UnknownMechanicType {
        instance: String,
        kind: String,
    },
    BadConfig {
        instance: String,
        state: Option<String>,
        message: String,
    },
    UnknownBinding {
        state: String,
        mechanic: String,
    },
    BadInvoke {
        state: String,
        invoke: String,
    },
    UnknownTrigger {
        state: String,
        invoke: String,
    },
    UnknownState {
        referenced: String,
    },
    UnreachableState {
        state: String,
    },
    BadSteps {
        state: String,
        message: String,
    },
    BadTransition {
        index: usize,
        message: String,
    },
    BadCaps {
        message: String,
    },
}

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
    if n >= 1 {
        Some(Effect::AddSteps(n))
    } else {
        None
    }
}

pub fn compile(def: &GameDefinition) -> Result<CompiledGame, Vec<DefinitionError>> {
    let mut errs: Vec<DefinitionError> = Vec::new();

    if def.family != FAMILY {
        errs.push(DefinitionError::WrongFamily {
            found: def.family.clone(),
        });
    }

    if def.caps.max_steps > MAX_STEPS_CEILING {
        errs.push(DefinitionError::BadCaps {
            message: format!(
                "max_steps {} exceeds kernel ceiling {MAX_STEPS_CEILING}",
                def.caps.max_steps
            ),
        });
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
                match kind.parse_config(&m.config) {
                    Ok(MechanicConfig::Reels(rc)) => {
                        if let Err(message) = validate_reels(&rc) {
                            errs.push(DefinitionError::BadConfig {
                                instance: m.id.clone(),
                                state: None,
                                message,
                            });
                        }
                    }
                    Ok(_) => {}
                    Err(message) => errs.push(DefinitionError::BadConfig {
                        instance: m.id.clone(),
                        state: None,
                        message,
                    }),
                }
                instance_ids.push(m.id.clone());
                kinds.push(kind);
            }
            None => errs.push(DefinitionError::UnknownMechanicType {
                instance: m.id.clone(),
                kind: m.kind.clone(),
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
    let mut seen_state_ids: Vec<String> = Vec::new();
    for s in &def.states {
        if seen_state_ids.contains(&s.id) {
            // Duplicate id already reported above; skip so `states` stays
            // index-aligned with the deduped `state_ids` (and thus `state_idx`).
            continue;
        }
        seen_state_ids.push(s.id.clone());

        let mut instances: Vec<usize> = Vec::new();
        let mut configs: Vec<MechanicConfig> = Vec::new();
        let mut bound_ids: Vec<&str> = Vec::new();
        for b in &s.bindings {
            let Some(idx) = instance_idx(&b.mechanic) else {
                errs.push(DefinitionError::UnknownBinding {
                    state: s.id.clone(),
                    mechanic: b.mechanic.clone(),
                });
                continue;
            };
            // `idx` is a position in the filtered instance_ids/kinds lists (skipped
            // mechanics don't occupy a slot there), so it must NOT be used to index
            // the raw, unfiltered `def.mechanics`. Resolve the declaration by id
            // instead; instance_idx already proved it exists.
            let decl = def
                .mechanics
                .iter()
                .find(|m| m.id == b.mechanic)
                .expect("instance_idx found it, so it exists in def.mechanics");
            let effective = match &b.config_override {
                Some(over) => merge_json(&decl.config, over),
                None => decl.config.clone(),
            };
            match kinds[idx].parse_config(&effective) {
                Ok(cfg) => {
                    let geometry_ok = match &cfg {
                        MechanicConfig::Reels(rc) => validate_reels(rc),
                        _ => Ok(()),
                    };
                    match geometry_ok {
                        Ok(()) => {
                            instances.push(idx);
                            configs.push(cfg);
                            bound_ids.push(&decl.id);
                        }
                        Err(message) => errs.push(DefinitionError::BadConfig {
                            instance: decl.id.clone(),
                            state: Some(s.id.clone()),
                            message,
                        }),
                    }
                }
                Err(message) => errs.push(DefinitionError::BadConfig {
                    instance: decl.id.clone(),
                    state: Some(s.id.clone()),
                    message,
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
                    state: s.id.clone(),
                    invoke: entry.invoke.clone(),
                });
                continue;
            };
            let Some(binding) = bound_ids.iter().position(|x| *x == mech_id) else {
                errs.push(DefinitionError::UnknownBinding {
                    state: s.id.clone(),
                    mechanic: mech_id.to_string(),
                });
                continue;
            };
            if !kinds[instances[binding]].triggers().contains(&trigger) {
                errs.push(DefinitionError::UnknownTrigger {
                    state: s.id.clone(),
                    invoke: entry.invoke.clone(),
                });
                continue;
            }
            script.push(CompiledInvoke {
                binding,
                trigger: trigger.to_string(),
            });
        }

        states.push(CompiledState {
            id: s.id.clone(),
            instances,
            configs,
            budget,
            script,
        });
    }

    // --- start + transitions ---
    let start = match state_idx(&def.start) {
        Some(i) => i,
        None => {
            errs.push(DefinitionError::UnknownState {
                referenced: def.start.clone(),
            });
            0
        }
    };

    let mut transitions: Vec<CompiledTransition> = Vec::new();
    for (index, row) in def.transitions.iter().enumerate() {
        let from = match state_idx(&row.from) {
            Some(i) => i,
            None => {
                errs.push(DefinitionError::UnknownState {
                    referenced: row.from.clone(),
                });
                continue;
            }
        };
        let to = match &row.to {
            Some(id) => match state_idx(id) {
                Some(i) => Some(i),
                None => {
                    errs.push(DefinitionError::UnknownState {
                        referenced: id.clone(),
                    });
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
                        index,
                        message: format!("bad effect: {s}"),
                    });
                    continue;
                }
            },
            None => None,
        };
        if to.is_some() == effect.is_some() {
            errs.push(DefinitionError::BadTransition {
                index,
                message: "exactly one of to/effect".into(),
            });
            continue;
        }
        transitions.push(CompiledTransition {
            from,
            on: row.on.clone(),
            to,
            effect,
        });
    }

    // --- reachability (DFS from start over `to` edges) ---
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
                errs.push(DefinitionError::UnreachableState {
                    state: state_ids[i].clone(),
                });
            }
        }
    }

    if errs.is_empty() {
        Ok(CompiledGame {
            instance_ids,
            kinds,
            states,
            start,
            transitions,
            max_steps: def.caps.max_steps,
        })
    } else {
        Err(errs)
    }
}

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
        assert_eq!(
            game.states[1].budget,
            CompiledBudget::Awarded { initial: 3 }
        );
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

    fn expect_error(
        mut v: serde_json::Value,
        mutate: impl FnOnce(&mut serde_json::Value),
        want: DefinitionError,
    ) {
        mutate(&mut v);
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.contains(&want), "expected {:?} in {:?}", want, errs);
    }

    #[test]
    fn rejects_wrong_family() {
        expect_error(
            sample_def_json(),
            |v| v["family"] = json!("slots@1"),
            DefinitionError::WrongFamily {
                found: "slots@1".into(),
            },
        );
    }

    #[test]
    fn rejects_duplicate_ids() {
        expect_error(
            sample_def_json(),
            |v| v["mechanics"][1]["id"] = json!("main_reels"),
            DefinitionError::DuplicateId {
                id: "main_reels".into(),
            },
        );
        expect_error(
            sample_def_json(),
            |v| v["states"][1]["id"] = json!("base"),
            DefinitionError::DuplicateId { id: "base".into() },
        );
    }

    #[test]
    fn rejects_unknown_mechanic_type() {
        expect_error(
            sample_def_json(),
            |v| v["mechanics"][1]["type"] = json!("tower@1"),
            DefinitionError::UnknownMechanicType {
                instance: "bonus_meter".into(),
                kind: "tower@1".into(),
            },
        );
    }

    #[test]
    fn rejects_bad_base_config_and_bad_merged_config() {
        // Base config missing a required field:
        let mut v = sample_def_json();
        v["mechanics"][1]["config"] = json!({ "count_symbol": 9 }); // no target
        let errs = compile_json(v).expect_err("must not compile");
        assert!(
            errs.iter().any(|e| matches!(e,
            DefinitionError::BadConfig { instance, state: None, .. } if instance == "bonus_meter"))
        );
        // Override that breaks the schema (wrong type):
        let mut v = sample_def_json();
        v["states"][1]["bindings"][0]["override"] = json!({ "rows": "three" });
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.iter().any(|e| matches!(e,
            DefinitionError::BadConfig { instance, state: Some(s), .. }
                if instance == "main_reels" && s == "fs1")));
    }

    #[test]
    fn bad_mechanic_before_valid_one_keeps_diagnostics_aligned() {
        // A skipped mechanic (unknown kind) ahead of valid ones must not shift
        // which declaration later bindings resolve against.
        let mut v = sample_def_json();
        v["mechanics"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!({ "id": "ghost", "type": "tower@1", "config": {} }));
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.contains(&DefinitionError::UnknownMechanicType {
            instance: "ghost".into(),
            kind: "tower@1".into(),
        }));
        assert!(
            !errs.iter().any(|e| matches!(e,
                DefinitionError::BadConfig { instance, .. }
                    if instance == "main_reels" || instance == "bonus_meter")),
            "valid mechanics' own configs must not be misattributed as bad: {errs:?}"
        );
    }

    #[test]
    fn rejects_binding_to_undeclared_instance() {
        expect_error(
            sample_def_json(),
            |v| v["states"][0]["bindings"][0]["mechanic"] = json!("ghost"),
            DefinitionError::UnknownBinding {
                state: "base".into(),
                mechanic: "ghost".into(),
            },
        );
    }

    #[test]
    fn rejects_bad_script_entries() {
        expect_error(
            sample_def_json(),
            |v| v["states"][0]["script"][0]["invoke"] = json!("nodot"),
            DefinitionError::BadInvoke {
                state: "base".into(),
                invoke: "nodot".into(),
            },
        );
        // Script targeting a mechanic not bound in this state:
        expect_error(
            sample_def_json(),
            |v| v["states"][0]["script"][0]["invoke"] = json!("ghost.spin"),
            DefinitionError::UnknownBinding {
                state: "base".into(),
                mechanic: "ghost".into(),
            },
        );
        expect_error(
            sample_def_json(),
            |v| v["states"][0]["script"][0]["invoke"] = json!("main_reels.dance"),
            DefinitionError::UnknownTrigger {
                state: "base".into(),
                invoke: "main_reels.dance".into(),
            },
        );
    }

    #[test]
    fn rejects_unknown_start_and_transition_states() {
        expect_error(
            sample_def_json(),
            |v| v["start"] = json!("lobby"),
            DefinitionError::UnknownState {
                referenced: "lobby".into(),
            },
        );
        expect_error(
            sample_def_json(),
            |v| v["transitions"][0]["to"] = json!("fs9"),
            DefinitionError::UnknownState {
                referenced: "fs9".into(),
            },
        );
    }

    #[test]
    fn rejects_unreachable_state() {
        expect_error(
            sample_def_json(),
            |v| {
                v["transitions"].as_array_mut().unwrap().remove(0); // fs1 now unreachable
            },
            DefinitionError::UnreachableState {
                state: "fs1".into(),
            },
        );
    }

    #[test]
    fn rejects_bad_steps() {
        expect_error(
            sample_def_json(),
            |v| {
                v["states"][1]["steps"] = json!({ "budget": "awarded" }); // no initial
            },
            DefinitionError::BadSteps {
                state: "fs1".into(),
                message: "awarded budget requires initial".into(),
            },
        );
        expect_error(
            sample_def_json(),
            |v| {
                v["states"][1]["steps"] = json!({ "budget": "granted", "initial": 3 });
            },
            DefinitionError::BadSteps {
                state: "fs1".into(),
                message: "unknown budget keyword: granted".into(),
            },
        );
    }

    #[test]
    fn rejects_bad_transitions() {
        // both to and effect:
        expect_error(
            sample_def_json(),
            |v| v["transitions"][1]["to"] = json!("base"),
            DefinitionError::BadTransition {
                index: 1,
                message: "exactly one of to/effect".into(),
            },
        );
        // neither:
        expect_error(
            sample_def_json(),
            |v| {
                let row = v["transitions"][1].as_object_mut().unwrap();
                row.remove("effect");
            },
            DefinitionError::BadTransition {
                index: 1,
                message: "exactly one of to/effect".into(),
            },
        );
        // bad effect grammar:
        expect_error(
            sample_def_json(),
            |v| v["transitions"][1]["effect"] = json!("steps:add:zero"),
            DefinitionError::BadTransition {
                index: 1,
                message: "bad effect: steps:add:zero".into(),
            },
        );
    }

    #[test]
    fn errors_are_collected_not_first_only() {
        let mut v = sample_def_json();
        v["family"] = json!("slots@1");
        v["start"] = json!("lobby");
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.len() >= 2);
    }

    #[test]
    fn rejects_max_steps_over_kernel_ceiling() {
        expect_error(
            sample_def_json(),
            |v| v["caps"]["max_steps"] = json!(MAX_STEPS_CEILING + 1),
            DefinitionError::BadCaps {
                message: format!(
                    "max_steps {} exceeds kernel ceiling {MAX_STEPS_CEILING}",
                    MAX_STEPS_CEILING + 1
                ),
            },
        );
    }

    #[test]
    fn rejects_empty_reels_strip() {
        let mut v = sample_def_json();
        v["mechanics"][0]["config"]["strips"][0] = json!([]);
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.iter().any(|e| matches!(e,
            DefinitionError::BadConfig { instance, state: None, .. }
                if instance == "main_reels")));
    }

    #[test]
    fn rejects_payline_row_out_of_bounds() {
        // rows: 1, so row index 1 is out of bounds.
        let mut v = sample_def_json();
        v["mechanics"][0]["config"]["paylines"] = json!([[0, 0, 1]]);
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.iter().any(|e| matches!(e,
            DefinitionError::BadConfig { instance, state: None, .. }
                if instance == "main_reels")));
    }

    #[test]
    fn rejects_payline_length_mismatch() {
        // 3 strips, but this payline only names 2 entries.
        let mut v = sample_def_json();
        v["mechanics"][0]["config"]["paylines"] = json!([[0, 0]]);
        let errs = compile_json(v).expect_err("must not compile");
        assert!(errs.iter().any(|e| matches!(e,
            DefinitionError::BadConfig { instance, state: None, .. }
                if instance == "main_reels")));
    }
}
