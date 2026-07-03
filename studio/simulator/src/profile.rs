//! Turn a simulated sample population into presentation-ready summaries:
//! a log-binned win-distribution histogram and tail-risk metrics. Read-only
//! over `RoundSample`; never affects curation or determinism.

use crate::measure::RoundSample;

#[derive(Debug, Clone, PartialEq)]
pub struct HistogramBin { pub bin_lo: f64, pub bin_hi: f64, pub base: u64, pub feature: u64 }

#[derive(Debug, Clone, PartialEq)]
pub struct WinDistribution { pub bins: Vec<HistogramBin>, pub zero_count: u64 }

#[derive(Debug, Clone, PartialEq)]
pub struct TailMetrics {
    pub max_win: f64, pub p_ge_100x: f64, pub p_losing_spin: f64,
    pub longest_dead_streak: u32, pub bonus_trigger_rate: f64,
}

pub fn log_bins() -> Vec<f64> {
    vec![0.0, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, f64::INFINITY]
}

pub fn profile(samples: &[RoundSample], bet: u64) -> (WinDistribution, TailMetrics) {
    assert!(!samples.is_empty(), "cannot profile an empty population");
    let n = samples.len() as f64;
    let bet = bet.max(1) as f64;
    let edges = log_bins();
    let mut bins: Vec<HistogramBin> = edges.windows(2)
        .map(|w| HistogramBin { bin_lo: w[0], bin_hi: w[1], base: 0, feature: 0 })
        .collect();

    let mut zero_count = 0u64;
    let mut max_win = 0.0f64;
    let mut ge_100 = 0u64;
    let mut losing = 0u64;
    let mut bonus = 0u64;
    let mut streak = 0u32;
    let mut longest = 0u32;

    for smp in samples {
        let mult = smp.payout as f64 / bet;
        if smp.payout == 0 {
            zero_count += 1;
            losing += 1;
            streak += 1;
            longest = longest.max(streak);
        } else {
            streak = 0;
            let idx = bins.iter().position(|b| mult >= b.bin_lo && mult < b.bin_hi)
                .unwrap_or(bins.len() - 1);
            if smp.feature_payout > 0 { bins[idx].feature += 1 } else { bins[idx].base += 1 }
        }
        max_win = max_win.max(mult);
        if mult >= 100.0 { ge_100 += 1 }
        if smp.feature_triggers.iter().any(|&t| t) { bonus += 1 }
    }

    (
        WinDistribution { bins, zero_count },
        TailMetrics {
            max_win,
            p_ge_100x: ge_100 as f64 / n,
            p_losing_spin: losing as f64 / n,
            longest_dead_streak: longest,
            bonus_trigger_rate: bonus as f64 / n,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::measure::RoundSample;

    fn s(payout: u64, feature: u64, trig: bool) -> RoundSample {
        RoundSample { seed: 0, payout, base_payout: payout - feature, feature_payout: feature,
                      feature_triggers: vec![trig] }
    }

    #[test]
    fn histogram_buckets_by_multiplier_and_splits_base_vs_feature() {
        // multipliers: 0 (loss), 1x base, 7x base, 150x feature
        let pop = vec![s(0,0,false), s(1,0,false), s(7,0,false), s(150,150,true)];
        let (dist, _) = profile(&pop, 1);
        assert_eq!(dist.zero_count, 1);
        // 1x -> [1,2), 7x -> [5,10), 150x -> [100,200) as feature
        let bin = |lo: f64| dist.bins.iter().find(|b| b.bin_lo == lo).unwrap();
        assert_eq!(bin(1.0).base, 1);
        assert_eq!(bin(5.0).base, 1);
        assert_eq!(bin(100.0).feature, 1);
        assert_eq!(bin(100.0).base, 0);
    }

    #[test]
    fn tail_metrics_capture_max_streak_and_probabilities() {
        // 5 rounds: L, W(1x), L, L, W(120x, bonus)
        let pop = vec![s(0,0,false), s(1,0,false), s(0,0,false), s(0,0,false), s(120,120,true)];
        let (_, tail) = profile(&pop, 1);
        assert_eq!(tail.max_win, 120.0);
        assert!((tail.p_losing_spin - 0.6).abs() < 1e-9);
        assert!((tail.p_ge_100x - 0.2).abs() < 1e-9);
        assert_eq!(tail.longest_dead_streak, 2); // L,L before the last win
        assert!((tail.bonus_trigger_rate - 0.2).abs() < 1e-9);
    }
}
