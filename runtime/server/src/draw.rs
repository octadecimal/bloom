//! The index-draw seam. The runtime RNG's ONLY job is to pick an index into the
//! curated seed pool (architecture §4). SP1 uses the OS CSPRNG; the
//! certification-appropriate CSPRNG choice (§18) can be swapped behind this seam.

use rand::Rng;

pub trait Draw: Send + Sync {
    /// Return a uniform index in `[0, pool_size)`. `pool_size` must be > 0.
    fn index(&self, pool_size: usize) -> usize;
}

/// Production draw: OS-backed CSPRNG (`getrandom` via `rand`).
pub struct OsRngDraw;

impl Draw for OsRngDraw {
    fn index(&self, pool_size: usize) -> usize {
        rand::thread_rng().gen_range(0..pool_size)
    }
}

/// Deterministic draw for tests: always returns `index` (clamped into range).
pub struct FixedDraw {
    pub index: usize,
}

impl Draw for FixedDraw {
    fn index(&self, pool_size: usize) -> usize {
        self.index % pool_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_draw_is_always_in_range() {
        let d = OsRngDraw;
        for _ in 0..10_000 {
            let i = d.index(7);
            assert!(i < 7);
        }
    }

    #[test]
    fn os_draw_covers_the_whole_range() {
        // With 10k draws over a 7-slot pool, every index should appear.
        let d = OsRngDraw;
        let mut seen = [false; 7];
        for _ in 0..10_000 {
            seen[d.index(7)] = true;
        }
        assert!(seen.iter().all(|&s| s), "every index must be reachable");
    }

    #[test]
    fn fixed_draw_returns_configured_index() {
        let d = FixedDraw { index: 3 };
        assert_eq!(d.index(5), 3);
        assert_eq!(d.index(2), 1); // wraps via modulo
    }
}
