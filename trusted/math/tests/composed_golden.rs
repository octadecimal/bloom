//! Golden vectors for `composed@1` — shared parity fixtures (spec §7).
//! The client (SP3) walks these same trace files; the server (SP2)
//! reproduces them per round. Changing a fixture is a re-certification
//! event (a new mechanic/type version), never an edit.

use bloom_math::mechanics::composed::{compile, evaluate, GameDefinition};
use std::fs;
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/composed")
        .join(name)
}

fn proof_game() -> bloom_math::mechanics::composed::CompiledGame {
    let raw = fs::read_to_string(fixture_path("proof_game.def.json")).expect("fixture exists");
    let def: GameDefinition = serde_json::from_str(&raw).expect("fixture parses");
    compile(&def).expect("fixture compiles")
}

/// Pinned scenario seeds, discovered with the scan test below and frozen
/// forever. Each exercises a distinct lifecycle shape.
const SEED_LOSE: u64 = 0; // enters base, no scatters trigger
const SEED_FS1: u64 = 292; // enters fs1, no retrigger, no fs2
const SEED_RETRIGGER: u64 = 3395; // fs1 with at least one steps:add effect
const SEED_FS2: u64 = 8; // reaches fs2 via meter:full

#[test]
#[ignore] // run once: cargo test -p bloom-math --test composed_golden -- --ignored --nocapture
fn scan_seeds_for_scenarios() {
    let game = proof_game();
    let mut found = std::collections::BTreeMap::new();
    for seed in 0..200_000u64 {
        let t = evaluate(&game, seed);
        let states: Vec<String> = t
            .entries
            .iter()
            .filter_map(|e| match e {
                bloom_math::mechanics::composed::TraceEntry::StateEnter { state } => {
                    Some(state.clone())
                }
                _ => None,
            })
            .collect();
        let retriggered = t.entries.iter().any(|e| {
            matches!(
                e,
                bloom_math::mechanics::composed::TraceEntry::Transition {
                    effect: Some(_),
                    ..
                }
            )
        });
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
        if found.len() == 4 {
            break;
        }
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
                .unwrap_or_else(|_| {
                    panic!("{name}: missing fixture {path:?} — run with BLOOM_REGEN_GOLDEN=1")
                })
                .replace("\r\n", "\n"); // Windows checkout may be CRLF-normalized
            assert_eq!(
                json, want,
                "{name} (seed {seed}) drifted from its golden fixture"
            );
        }
    }
}

#[test]
fn golden_scenarios_have_the_claimed_shapes() {
    use bloom_math::mechanics::composed::TraceEntry;
    let game = proof_game();
    let states = |seed: u64| -> Vec<String> {
        evaluate(&game, seed)
            .entries
            .iter()
            .filter_map(|e| match e {
                TraceEntry::StateEnter { state } => Some(state.clone()),
                _ => None,
            })
            .collect()
    };
    assert_eq!(states(SEED_LOSE), vec!["base"]);
    assert_eq!(states(SEED_FS1), vec!["base", "fs1"]);
    assert!(states(SEED_RETRIGGER).contains(&"fs1".to_string()));
    assert!(evaluate(&game, SEED_RETRIGGER)
        .entries
        .iter()
        .any(|e| matches!(
            e,
            TraceEntry::Transition {
                effect: Some(_),
                ..
            }
        )));
    assert!(states(SEED_FS2).contains(&"fs2".to_string()));
}
