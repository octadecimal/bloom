//! Shared slot-grid primitives — "components" in the composed-games sense
//! (spec §2): plain code, not registered units. Both `slots@1` and
//! `composed@1` call these. Behavior is frozen — the `slots@1` golden
//! vector pins it bit-for-bit.

use crate::rng::SplitMix64;
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

/// Spin every reel: pick a stop, read `rows` consecutive cells (wrapping).
/// Returns `grid[reel][row]`.
pub fn spin(reels: &[Vec<Symbol>], rows: usize, rng: &mut SplitMix64) -> Vec<Vec<Symbol>> {
    reels
        .iter()
        .map(|reel| {
            let len = reel.len() as u64;
            let stop = (rng.next_u64() % len) as usize;
            (0..rows).map(|r| reel[(stop + r) % reel.len()]).collect()
        })
        .collect()
}

pub fn count_symbol(grid: &[Vec<Symbol>], sym: Symbol) -> usize {
    grid.iter().flatten().filter(|&&s| s == sym).count()
}

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

    fn lines_model() -> (Vec<SymbolDef>, Vec<Vec<usize>>, Paytable) {
        // 3 reels, 1 row, one payline across the single row.
        let symbols = vec![
            SymbolDef {
                id: 0,
                role: SymbolRole::Normal,
            },
            SymbolDef {
                id: 1,
                role: SymbolRole::Wild,
            },
            SymbolDef {
                id: 9,
                role: SymbolRole::Scatter,
            },
        ];
        let paylines = vec![vec![0, 0, 0]];
        let paytable = Paytable {
            entries: vec![
                PaytableEntry {
                    symbol: 0,
                    count: 2,
                    payout: 3,
                },
                PaytableEntry {
                    symbol: 0,
                    count: 3,
                    payout: 10,
                },
            ],
        };
        (symbols, paylines, paytable)
    }

    #[test]
    fn three_of_a_kind_pays() {
        let (symbols, paylines, paytable) = lines_model();
        let grid = vec![vec![0], vec![0], vec![0]];
        assert_eq!(line_payout(&symbols, &paytable, &grid, &paylines[0]), 10);
    }

    #[test]
    fn wild_substitutes_in_a_run() {
        let (symbols, paylines, paytable) = lines_model();
        let grid = vec![vec![0], vec![1], vec![0]]; // 0, wild, 0
        assert_eq!(line_payout(&symbols, &paytable, &grid, &paylines[0]), 10);
    }

    #[test]
    fn run_breaks_on_mismatch() {
        let (symbols, paylines, paytable) = lines_model();
        let grid = vec![vec![0], vec![0], vec![9]]; // 0, 0, scatter -> count 2
        assert_eq!(line_payout(&symbols, &paytable, &grid, &paylines[0]), 3);
    }

    #[test]
    fn scatter_does_not_pay_on_a_line() {
        let (symbols, paylines, paytable) = lines_model();
        let grid = vec![vec![9], vec![9], vec![9]];
        assert_eq!(line_payout(&symbols, &paytable, &grid, &paylines[0]), 0);
    }

    fn scatter_model() -> (Vec<SymbolDef>, Vec<Vec<usize>>, Paytable) {
        let (symbols, paylines, mut paytable) = lines_model();
        paytable.entries.push(PaytableEntry {
            symbol: 9,
            count: 2,
            payout: 4,
        });
        paytable.entries.push(PaytableEntry {
            symbol: 9,
            count: 3,
            payout: 20,
        });
        (symbols, paylines, paytable)
    }

    #[test]
    fn counts_a_symbol_across_the_grid() {
        let grid = vec![vec![9], vec![0], vec![9]];
        assert_eq!(count_symbol(&grid, 9), 2);
        assert_eq!(count_symbol(&grid, 0), 1);
    }

    #[test]
    fn scatter_pays_by_total_count() {
        let (symbols, _paylines, paytable) = scatter_model();
        let grid = vec![vec![9], vec![0], vec![9]];
        assert_eq!(scatter_payout(&symbols, &paytable, &grid), 4);
    }

    #[test]
    fn eval_grid_sums_lines_and_scatter() {
        let (symbols, paylines, paytable) = scatter_model();
        let grid = vec![vec![0], vec![0], vec![0]]; // line pays 10, no scatters
        assert_eq!(eval_grid(&symbols, &paylines, &paytable, &grid), 10);
        let grid2 = vec![vec![9], vec![9], vec![9]]; // line 0, scatter 20
        assert_eq!(eval_grid(&symbols, &paylines, &paytable, &grid2), 20);
    }
}
