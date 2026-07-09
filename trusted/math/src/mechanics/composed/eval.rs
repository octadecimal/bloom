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

fn match_row<'g>(
    game: &'g CompiledGame,
    from: usize,
    events: &[Event],
) -> Option<&'g CompiledTransition> {
    game.transitions
        .iter()
        .find(|t| t.from == from && events.iter().any(|e| e == &t.on))
}

fn transition_entry(game: &CompiledGame, row: &CompiledTransition) -> TraceEntry {
    TraceEntry::Transition {
        on: row.on.clone(),
        to: row.to.map(|i| game.states[i].id.clone()),
        effect: row
            .effect
            .map(|Effect::AddSteps(n)| format!("steps:add:{n}")),
    }
}

/// Expand one seed into one round. Same `(game, seed)` → the same trace,
/// bit-for-bit, forever. Mechanic instances are created fresh per call
/// (round-scoped state, spec §2 decision 4).
pub fn evaluate(game: &CompiledGame, seed: u64) -> RoundTrace {
    let mut rng = SplitMix64::new(seed);
    let mut mechs: Vec<Box<dyn Mechanic>> = game.kinds.iter().map(|k| k.instantiate()).collect();

    let mut entries = vec![TraceEntry::RoundStart {
        seed: seed.to_string(),
    }];
    let mut total_payout: u64 = 0;
    let mut steps_done: u32 = 0;
    let mut transitions_taken: u32 = 0;
    let mut current = game.start;

    'round: loop {
        let state = &game.states[current];
        entries.push(TraceEntry::StateEnter {
            state: state.id.clone(),
        });
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
        entries.push(TraceEntry::StateExit {
            state: state.id.clone(),
            payout: state_payout,
        });
        match exit_to {
            Some(to) => current = to,
            None => break 'round,
        }
    }

    entries.push(TraceEntry::RoundEnd { total_payout });
    RoundTrace {
        entries,
        total_payout,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mechanics::composed::compile::compile;
    use crate::mechanics::composed::definition::GameDefinition;
    use crate::mechanics::composed::mechanic::TriggerData;
    use crate::mechanics::composed::trace::TraceEntry;
    use serde_json::json;

    pub(crate) fn compile_json(
        v: serde_json::Value,
    ) -> crate::mechanics::composed::compile::CompiledGame {
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
        trace
            .entries
            .iter()
            .map(|e| match e {
                TraceEntry::RoundStart { .. } => "round_start",
                TraceEntry::StateEnter { .. } => "state_enter",
                TraceEntry::Step { .. } => "step",
                TraceEntry::Trigger { .. } => "trigger",
                TraceEntry::Transition { .. } => "transition",
                TraceEntry::StateExit { .. } => "state_exit",
                TraceEntry::RoundEnd { .. } => "round_end",
            })
            .collect()
    }

    #[test]
    fn single_state_round_shape_and_payout() {
        let trace = evaluate(&compile_json(single_state()), 7);
        assert_eq!(
            kinds(&trace),
            vec![
                "round_start",
                "state_enter",
                "step",
                "trigger",
                "state_exit",
                "round_end",
            ]
        );
        assert_eq!(trace.total_payout, 5);
        assert_eq!(
            trace.entries[0],
            TraceEntry::RoundStart { seed: "7".into() }
        );
        assert_eq!(
            *trace.entries.last().unwrap(),
            TraceEntry::RoundEnd { total_payout: 5 }
        );
        assert!(matches!(&trace.entries[4],
            TraceEntry::StateExit { state, payout: 5 } if state == "base"));
    }

    #[test]
    fn transition_enters_second_state_with_awarded_budget() {
        let trace = evaluate(&compile_json(two_states()), 7);
        // base: 1 step pays 8 and emits go:fs → fs: 2 steps, each pays 5*2=10.
        assert_eq!(
            kinds(&trace),
            vec![
                "round_start",
                "state_enter",
                "step",
                "trigger",
                "transition",
                "state_exit", // base
                "state_enter",
                "step",
                "trigger",
                "step",
                "trigger",
                "state_exit", // fs ×2 steps
                "round_end",
            ]
        );
        assert_eq!(trace.total_payout, 8 + 20);
        assert!(matches!(&trace.entries[4],
            TraceEntry::Transition { on, to: Some(t), effect: None } if on == "go:fs" && t == "fs"));
        assert!(matches!(&trace.entries[5],
            TraceEntry::StateExit { state, payout: 8 } if state == "base"));
        assert!(matches!(&trace.entries[11],
            TraceEntry::StateExit { state, payout: 20 } if state == "fs"));
        // fs exhausts with no matching row → round ends (NO return to base:
        // exactly one base step was played).
        let steps: Vec<u32> = trace
            .entries
            .iter()
            .filter_map(|e| match e {
                TraceEntry::Step { n } => Some(*n),
                _ => None,
            })
            .collect();
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
        let steps = trace
            .entries
            .iter()
            .filter(|e| matches!(e, TraceEntry::Step { .. }))
            .count();
        assert_eq!(steps, 5);
        let effects = trace
            .entries
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    TraceEntry::Transition {
                        effect: Some(_),
                        ..
                    }
                )
            })
            .count();
        assert_eq!(effects, 4); // one per completed fs step
                                // exactly one fs state visit — effects never re-enter:
        let enters = trace
            .entries
            .iter()
            .filter(|e| {
                matches!(e,
            TraceEntry::StateEnter { state } if state == "fs")
            })
            .count();
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
        let steps = trace
            .entries
            .iter()
            .filter(|e| matches!(e, TraceEntry::Step { .. }))
            .count();
        assert_eq!(steps, 40);
        assert!(matches!(
            trace.entries.last(),
            Some(TraceEntry::RoundEnd { .. })
        ));
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
        assert!(matches!(
            trace.entries.last(),
            Some(TraceEntry::RoundEnd { total_payout: 0 })
        ));
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
        let steps = trace
            .entries
            .iter()
            .filter(|e| matches!(e, TraceEntry::Step { .. }))
            .count();
        assert_eq!(steps, 7);
    }

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
        let fills: Vec<u32> = trace
            .entries
            .iter()
            .filter_map(|e| match e {
                TraceEntry::Trigger {
                    data: TriggerData::Meter { fill, .. },
                    ..
                } => Some(*fill),
                _ => None,
            })
            .collect();
        assert_eq!(fills, vec![1, 2, 3]); // carried across base → fs1, no reset
        let visited: Vec<&str> = trace
            .entries
            .iter()
            .filter_map(|e| match e {
                TraceEntry::StateEnter { state } => Some(state.as_str()),
                _ => None,
            })
            .collect();
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
        v["mechanics"][0]["config"]["strips"] =
            json!([[0, 9, 0, 0, 1], [9, 0, 0, 1, 0], [0, 0, 9, 0, 1]]);
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
            assert!(matches!(
                t.entries.first(),
                Some(TraceEntry::RoundStart { .. })
            ));
            assert!(matches!(
                t.entries.last(),
                Some(TraceEntry::RoundEnd { .. })
            ));
            let exit_sum: u64 = t
                .entries
                .iter()
                .filter_map(|e| match e {
                    TraceEntry::StateExit { payout, .. } => Some(*payout),
                    _ => None,
                })
                .sum();
            assert_eq!(t.total_payout, exit_sum);
            let steps: Vec<u32> = t
                .entries
                .iter()
                .filter_map(|e| match e {
                    TraceEntry::Step { n } => Some(*n),
                    _ => None,
                })
                .collect();
            assert_eq!(steps, (1..=steps.len() as u32).collect::<Vec<_>>());
            any_pay |= t.total_payout > 0;
            any_transition |= t
                .entries
                .iter()
                .any(|e| matches!(e, TraceEntry::Transition { .. }));
        }
        assert!(
            any_pay,
            "no seed paid in 3000 trials — an always-zero evaluate would pass"
        );
        assert!(any_transition, "no seed transitioned in 3000 trials");
    }
}
