//! `meter@1` — counts a symbol on the step's grid into a persistent fill;
//! emits its configured event when full. Fill is instance state and flows
//! across Game States within a round (spec §2 decision 5).

use serde::{Deserialize, Serialize};

use crate::components::Symbol;

use super::mechanic::{InvokeOutcome, Mechanic, MechanicConfig, StepCtx, TriggerData};
use crate::components;
use crate::rng::SplitMix64;

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

impl Mechanic for MeterMechanic {
    fn invoke(
        &mut self,
        trigger: &str,
        config: &MechanicConfig,
        ctx: &mut StepCtx,
        _rng: &mut SplitMix64,
    ) -> InvokeOutcome {
        assert_eq!(
            trigger, "accumulate",
            "unknown meter trigger (compile validates)"
        );
        let cfg = match config {
            MechanicConfig::Meter(c) => c,
            _ => unreachable!("compile pairs configs with kinds"),
        };

        let added = ctx
            .grid
            .as_ref()
            .map(|g| components::count_symbol(g, cfg.count_symbol) as u32)
            .unwrap_or(0);
        // saturating: a crafted count_symbol/grid pairing near u32::MAX must
        // not wrap the fill counter (panics in debug, silently wraps in release).
        self.fill = self.fill.saturating_add(added);
        let reached = self.fill;

        let mut events = Vec::new();
        if reached >= cfg.target {
            events.push(cfg.on_full.clone());
            if cfg.reset_on_full {
                self.fill = 0;
            }
        }
        ctx.events.extend(events.iter().cloned());
        InvokeOutcome {
            events,
            data: TriggerData::Meter {
                fill: reached,
                target: cfg.target,
            },
        }
    }
}

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

    fn step(
        mech: &mut MeterMechanic,
        cfg: &MechanicConfig,
        grid: Option<Vec<Vec<Symbol>>>,
    ) -> (StepCtx, TriggerData) {
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
