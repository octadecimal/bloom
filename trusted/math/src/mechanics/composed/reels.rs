//! `reels@1` — strips → grid → payline/scatter payout, plus configurable
//! grid events (e.g. 3+ scatters → "scatters:3").

use serde::{Deserialize, Serialize};

use crate::components::{self, Paytable, Symbol, SymbolDef};

use super::mechanic::{Event, InvokeOutcome, Mechanic, MechanicConfig, StepCtx, TriggerData};
use crate::rng::SplitMix64;

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
        let payout = components::eval_grid(&cfg.symbols, &cfg.paylines, &cfg.paytable, &grid)
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
        InvokeOutcome {
            events,
            data: TriggerData::Reels { grid, payout },
        }
    }
}

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
                SymbolDef {
                    id: 0,
                    role: SymbolRole::Normal,
                },
                SymbolDef {
                    id: 9,
                    role: SymbolRole::Scatter,
                },
            ],
            paylines: vec![vec![0, 0, 0]],
            paytable: Paytable {
                entries: vec![PaytableEntry {
                    symbol: 0,
                    count: 3,
                    payout: 5,
                }],
            },
            multiplier,
            events: vec![GridEvent {
                symbol: 9,
                min_count: 3,
                emit: "scatters:3".into(),
            }],
        })
    }

    fn invoke(
        config: &MechanicConfig,
        seed: u64,
    ) -> (StepCtx, super::super::mechanic::InvokeOutcome) {
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
