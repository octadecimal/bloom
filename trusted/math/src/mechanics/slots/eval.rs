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
