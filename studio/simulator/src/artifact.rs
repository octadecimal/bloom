//! The family seam: one artifact type for everything upstream of the runtime
//! server, mirroring its `LoadedGame` dispatch (runtime/server/src/state.rs).
//! Enum dispatch, append-only — two families, a `match` at each seam point
//! (spec §2 decision 2). Composed is compiled ONCE at load; `evaluate` runs
//! per seed (spec §3.1).

use crate::constraints::{self, Violation};
use crate::measure::{sample_slots, RoundSample};
use crate::target::TargetSpec;
use bloom_math::mechanics::composed::mechanic::MechanicConfig;
use bloom_math::mechanics::composed::reels::ReelsConfig;
use bloom_math::mechanics::composed::{
    self, compile, CompiledGame, DefinitionError, GameDefinition, TraceEntry,
};
use bloom_math::mechanics::slots::{self, SlotModel};
use rayon::prelude::*;

#[derive(Debug, Clone, PartialEq)]
pub enum MathArtifact {
    Slots(SlotModel),
    Composed {
        def: GameDefinition,
        compiled: Box<CompiledGame>,
        /// Base config of the first `reels@1` instance — the surface pay
        /// constraints bind to (spec §3.3). None when the definition has no
        /// reels instance (or its base config only becomes complete after
        /// per-state overrides).
        reels: Option<ReelsConfig>,
    },
}

impl MathArtifact {
    /// Parse from the artifact's JSON payload, dispatching on the explicit
    /// top-level `family` field. Absent → slots (legacy default, spec §4).
    pub fn from_json_value(v: serde_json::Value) -> Result<MathArtifact, String> {
        match v.get("family").and_then(|f| f.as_str()) {
            Some(composed::FAMILY) => {
                let def: GameDefinition =
                    serde_json::from_value(v).map_err(|e| format!("definition parse: {e}"))?;
                MathArtifact::from_definition(def)
                    .map_err(|errs| format!("definition invalid: {errs:?}"))
            }
            None | Some("slots@1") => serde_json::from_value(v)
                .map(MathArtifact::Slots)
                .map_err(|e| format!("model parse: {e}")),
            Some(other) => Err(format!("unknown family: {other}")),
        }
    }

    /// Compile-validate a definition into an artifact (nothing downstream runs
    /// on an invalid definition).
    pub fn from_definition(def: GameDefinition) -> Result<MathArtifact, Vec<DefinitionError>> {
        let compiled = compile(&def)?;
        let reels = def
            .mechanics
            .iter()
            .find(|m| m.kind == "reels@1")
            .and_then(|m| serde_json::from_value::<ReelsConfig>(m.config.clone()).ok());
        Ok(MathArtifact::Composed {
            def,
            compiled: Box::new(compiled),
            reels,
        })
    }

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

    pub fn family(&self) -> &'static str {
        match self {
            MathArtifact::Slots(_) => "slots@1",
            MathArtifact::Composed { .. } => composed::FAMILY,
        }
    }

    /// The signed package payload, in the family's wire encoding
    /// (slots: postcard; composed: JSON).
    pub fn math_payload(&self) -> Vec<u8> {
        match self {
            MathArtifact::Slots(m) => slots::to_payload(m),
            MathArtifact::Composed { def, .. } => composed::to_payload(def),
        }
    }

    /// Evaluate one seed to the family-agnostic sample. Composed walks the
    /// trace: `StateExit` entries ARE the per-state attribution; base is the
    /// first state visit (always the start state).
    pub fn evaluate_seed(&self, seed: u64) -> RoundSample {
        match self {
            MathArtifact::Slots(m) => sample_slots(m, seed),
            MathArtifact::Composed { compiled, .. } => {
                let trace = composed::evaluate(compiled, seed);
                let state_payouts: Vec<(String, u64)> = trace
                    .entries
                    .iter()
                    .filter_map(|e| match e {
                        TraceEntry::StateExit { state, payout } => Some((state.clone(), *payout)),
                        _ => None,
                    })
                    .collect();
                let base_payout = state_payouts.first().map(|(_, p)| *p).unwrap_or(0);
                RoundSample {
                    seed,
                    total_payout: trace.total_payout,
                    base_payout,
                    feature_payout: trace.total_payout - base_payout,
                    feature_triggers: Vec::new(),
                    state_payouts,
                }
            }
        }
    }

    /// Theoretical max win in bet-multiples. Composed: top pay of the reels
    /// instance's paytable × the largest multiplier across every compiled
    /// state's effective reels config (per-state overrides raise it).
    /// ponytail: single-spin bound × top multiplier, mirroring slots —
    /// ignores multi-step accumulation; tighten alongside #160/#161.
    pub fn theoretical_max_win(&self) -> u64 {
        match self {
            MathArtifact::Slots(m) => constraints::theoretical_max_win(m),
            MathArtifact::Composed {
                compiled, reels, ..
            } => {
                let top_pay = reels
                    .as_ref()
                    .and_then(|r| r.paytable.entries.iter().map(|e| e.payout).max())
                    .unwrap_or(0);
                let top_mult = compiled
                    .states
                    .iter()
                    .flat_map(|s| &s.configs)
                    .filter_map(|c| match c {
                        MechanicConfig::Reels(r) => Some(r.multiplier),
                        _ => None,
                    })
                    .max()
                    .unwrap_or(1)
                    .max(1);
                top_pay.saturating_mul(top_mult)
            }
        }
    }

    /// Deterministic constraint violations — same checks both families; for
    /// composed they bind to the reels@1 instance's paytable (spec §3.3).
    pub fn static_violations(&self, target: &TargetSpec) -> Vec<Violation> {
        match self {
            MathArtifact::Slots(m) => constraints::static_violations(m, target),
            MathArtifact::Composed { reels, .. } => {
                let mut out = Vec::new();
                out.extend(constraints::max_win_violation(
                    self.theoretical_max_win(),
                    &target.max_win_band,
                ));
                if let Some(r) = reels {
                    out.extend(constraints::pay_violations(
                        &r.paytable,
                        &target.pay_constraints,
                    ));
                }
                out
            }
        }
    }

    /// Up-front target/constraint validation, family-aware.
    pub fn validate_constraints(&self, target: &TargetSpec) -> Result<(), String> {
        match self {
            MathArtifact::Slots(m) => constraints::validate_constraints(m, target),
            MathArtifact::Composed { reels, .. } => {
                if !target.bonus_hit_rate_bands.is_empty() {
                    return Err("composed targets take no bonus_hit_rate_bands \
                         (feature-level bands are issue #160)"
                        .into());
                }
                match reels {
                    Some(r) => {
                        constraints::validate_constraints_core(&r.symbols, &r.paytable, target)
                    }
                    None if target.pay_constraints.is_empty() => Ok(()),
                    None => Err(
                        "pay constraints given but the definition has no reels@1 instance".into(),
                    ),
                }
            }
        }
    }
}

/// Family-dispatched batch evaluation; order matches `seeds` (rayon `map`
/// preserves order), identical to `measure::simulate` on the slots arm.
pub fn simulate(artifact: &MathArtifact, seeds: &[u64]) -> Vec<RoundSample> {
    seeds
        .par_iter()
        .map(|&s| artifact.evaluate_seed(s))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::composed::{evaluate, TraceEntry};
    use serde_json::json;

    fn demo_def_value() -> serde_json::Value {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime/server/demo/composed.definition.json"
        ))
        .expect("read demo definition");
        serde_json::from_str(&json).expect("parse demo definition")
    }

    fn slots_model_value() -> serde_json::Value {
        // no top-level "family" key — the legacy slots wire shape
        json!({
            "symbols": [{"id": 0, "role": "normal"}],
            "reels": [[0]],
            "rows": 1,
            "paylines": [[0]],
            "paytable": {"entries": [{"symbol": 0, "count": 1, "payout": 1}]},
            "bonuses": []
        })
    }

    #[test]
    fn family_sniff_dispatches_slots_composed_and_rejects_unknown() {
        assert!(matches!(
            MathArtifact::from_json_value(slots_model_value()).unwrap(),
            MathArtifact::Slots(_)
        ));
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        assert!(matches!(art, MathArtifact::Composed { .. }));
        assert_eq!(art.family(), "composed@1");
        let err = MathArtifact::from_json_value(json!({"family": "tower@9"})).unwrap_err();
        assert!(err.contains("unknown family"));
    }

    #[test]
    fn composed_artifact_that_fails_compile_is_an_error() {
        let mut v = demo_def_value();
        v["start"] = json!("no-such-state");
        assert!(MathArtifact::from_json_value(v).is_err());
    }

    #[test]
    fn composed_artifact_captures_the_reels_constraint_surface() {
        let MathArtifact::Composed { reels, .. } =
            MathArtifact::from_json_value(demo_def_value()).unwrap()
        else {
            panic!("expected composed");
        };
        let r = reels.expect("demo has a reels@1 instance");
        assert_eq!(r.paytable.entries.len(), 4);
        assert_eq!(r.symbols.len(), 4);
    }

    #[test]
    fn composed_sample_attribution_matches_the_trace() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let MathArtifact::Composed { ref compiled, .. } = art else {
            panic!()
        };
        // seeds scanned against this demo definition (not the trusted/math
        // proof_game fixture — a different game, different seed mapping):
        // 0=LOSE, 656=FS1, 328=RETRIGGER, 46=FS2.
        for seed in [0u64, 46, 656, 328] {
            let s = art.evaluate_seed(seed);
            let trace = evaluate(compiled, seed);
            assert_eq!(s.total_payout, trace.total_payout);
            let exits: Vec<(String, u64)> = trace
                .entries
                .iter()
                .filter_map(|e| match e {
                    TraceEntry::StateExit { state, payout } => Some((state.clone(), *payout)),
                    _ => None,
                })
                .collect();
            assert_eq!(s.state_payouts, exits);
            assert_eq!(
                s.state_payouts.iter().map(|(_, p)| p).sum::<u64>(),
                s.total_payout
            );
            assert_eq!(
                s.base_payout,
                s.state_payouts.first().map(|(_, p)| *p).unwrap_or(0)
            );
            assert_eq!(s.feature_payout, s.total_payout - s.base_payout);
            assert!(s.feature_triggers.is_empty());
        }
        // a feature seed visits more than one state
        assert!(art.evaluate_seed(656).state_payouts.len() >= 2);
    }

    #[test]
    fn artifact_simulate_matches_the_slots_path_and_is_deterministic() {
        let model: bloom_math::mechanics::slots::SlotModel =
            serde_json::from_value(slots_model_value()).unwrap();
        let art = MathArtifact::Slots(model.clone());
        let seeds = crate::seedgen::generate_seeds(7, 50);
        assert_eq!(
            simulate(&art, &seeds),
            crate::measure::simulate(&model, &seeds)
        );

        let composed = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let a = simulate(&composed, &seeds);
        let b = simulate(&composed, &seeds);
        assert_eq!(a, b);
        assert_eq!(a.iter().map(|s| s.seed).collect::<Vec<_>>(), seeds);
    }

    #[test]
    fn math_payload_round_trips_per_family() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let def = bloom_math::mechanics::composed::from_payload(&art.math_payload()).unwrap();
        assert_eq!(def.start, "base");
        let slots = MathArtifact::from_json_value(slots_model_value()).unwrap();
        assert!(bloom_math::mechanics::slots::from_payload(&slots.math_payload()).is_ok());
    }

    use crate::target::{HitRateBand, PayConstraint, PayRelation, TargetSpec};

    #[test]
    fn composed_theoretical_max_win_is_top_pay_times_top_state_multiplier() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        // demo: top pay 20 (sym2@3); fs2 overrides multiplier to 3 → 60
        assert_eq!(art.theoretical_max_win(), 60);
    }

    #[test]
    fn composed_static_violations_check_max_win_and_the_reels_paytable() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let t = TargetSpec {
            max_win_band: Some(HitRateBand {
                min: 100.0,
                max: 200.0,
            }), // 60 < 100
            pay_constraints: vec![PayConstraint {
                symbol: 0,
                relation: PayRelation::Floor,
                count: Some(3),
                value: 50, // sym0@3 pays 5 → violated
            }],
            ..Default::default()
        };
        let v = art.static_violations(&t);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].metric, "max_win");
        assert_eq!(v[1].metric, "pay_floor[0@3]");
        assert!(art.static_violations(&TargetSpec::default()).is_empty());
    }

    #[test]
    fn composed_validate_rejects_bonus_bands_and_unknown_symbols() {
        let art = MathArtifact::from_json_value(demo_def_value()).unwrap();
        let t = TargetSpec {
            bonus_hit_rate_bands: vec![HitRateBand { min: 0.0, max: 1.0 }],
            ..Default::default()
        };
        assert!(art.validate_constraints(&t).unwrap_err().contains("#160"));
        let t = TargetSpec {
            pay_constraints: vec![PayConstraint {
                symbol: 42,
                relation: PayRelation::Floor,
                count: None,
                value: 1,
            }],
            ..Default::default()
        };
        assert!(art
            .validate_constraints(&t)
            .unwrap_err()
            .contains("unknown model symbol"));
        assert!(art.validate_constraints(&TargetSpec::default()).is_ok());
    }
}
