//! Per-generation population summaries for the analytics dashboard. Pure,
//! read-only over the GA's scored population; never affects the deterministic
//! search result (progress is cosmetic).

#[derive(Debug, Clone, PartialEq)]
pub struct PopulationStats {
    pub min: f64,
    pub q1: f64,
    pub median: f64,
    pub q3: f64,
    pub max: f64,
    pub mean: f64,
    pub diversity: f64,
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (q * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

fn stddev(xs: &[f64], mean: f64) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    (xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / xs.len() as f64).sqrt()
}

/// Fitness quantiles (nearest-rank on a sorted copy) plus a normalized
/// diversity scalar (std-dev / range, 0 when fully converged).
pub fn population_stats(fitnesses: &[f64]) -> PopulationStats {
    assert!(!fitnesses.is_empty(), "empty population");
    let mut s = fitnesses.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let mean = s.iter().sum::<f64>() / s.len() as f64;
    let (min, max) = (s[0], s[s.len() - 1]);
    PopulationStats {
        min,
        max,
        mean,
        q1: quantile(&s, 0.25),
        median: quantile(&s, 0.5),
        q3: quantile(&s, 0.75),
        diversity: stddev(&s, mean) / ((max - min).abs() + 1e-9),
    }
}

/// Per-gene-dimension agreement in `[0,1]` (1 = full consensus). Caller
/// supplies one inner `Vec<f64>` per gene dimension, each of length =
/// population size.
pub fn gene_agreement(values: &[Vec<f64>]) -> Vec<f64> {
    values
        .iter()
        .map(|col| {
            if col.is_empty() {
                return 1.0;
            }
            let mean = col.iter().sum::<f64>() / col.len() as f64;
            let range = col.iter().cloned().fold(f64::MIN, f64::max)
                - col.iter().cloned().fold(f64::MAX, f64::min);
            if range.abs() < 1e-12 {
                return 1.0;
            }
            (1.0 - stddev(col, mean) / (range.abs() + 1e-9)).clamp(0.0, 1.0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn population_stats_quantiles_and_zero_diversity_when_converged() {
        let same = vec![-0.5; 8];
        let st = population_stats(&same);
        assert_eq!(st.min, -0.5);
        assert_eq!(st.max, -0.5);
        assert!(st.diversity.abs() < 1e-9); // fully converged
    }

    #[test]
    fn population_stats_orders_quantiles() {
        let f = vec![-1.0, -0.8, -0.6, -0.4, -0.2, 0.0];
        let st = population_stats(&f);
        assert!(st.min <= st.q1 && st.q1 <= st.median && st.median <= st.q3 && st.q3 <= st.max);
        assert!((st.mean - (-0.5)).abs() < 1e-9);
        assert!(st.diversity > 0.0);
    }

    #[test]
    fn gene_agreement_is_one_when_all_equal_and_below_one_when_spread() {
        let converged = vec![vec![5.0, 5.0, 5.0]]; // one gene, all agree
        assert!((gene_agreement(&converged)[0] - 1.0).abs() < 1e-9);
        let spread = vec![vec![1.0, 5.0, 9.0]];
        assert!(gene_agreement(&spread)[0] < 1.0);
    }
}
