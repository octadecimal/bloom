//! Single-round spin: evaluate one round of a SlotModel at a seed and emit the
//! base grid (+ payouts) as one JSON line on stdout. Deterministic.
//! Usage: spin_json <model.json> <seed>

use bloom_math::mechanics::slots::{evaluate, SlotModel};
use serde_json::json;
use std::fs;

fn spin_result_json(model: &SlotModel, seed: u64) -> String {
    let out = evaluate(model, seed);
    json!({
        "grid": out.base_grid,
        "basePayout": out.base_payout,
        "totalPayout": out.total_payout,
    })
    .to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: spin_json <model.json> <seed>");
        std::process::exit(2);
    }
    let model: SlotModel = match fs::read_to_string(&args[1])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(m) => m,
        Err(e) => {
            eprintln!("bad model json: {e}");
            std::process::exit(2);
        }
    };
    let seed: u64 = match args[2].parse() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("bad seed: {e}");
            std::process::exit(2);
        }
    };
    println!("{}", spin_result_json(&model, seed));
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{Paytable, SymbolDef, SymbolRole};

    fn tiny_model() -> SlotModel {
        // 3 reels, each strip [0], 3 rows -> every cell is symbol 0, deterministic.
        SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 3,
            paylines: vec![],
            paytable: Paytable { entries: vec![] },
            bonuses: vec![],
        }
    }

    #[test]
    fn grid_is_reel_by_row_shaped() {
        let v: serde_json::Value =
            serde_json::from_str(&spin_result_json(&tiny_model(), 42)).unwrap();
        let grid = v["grid"].as_array().unwrap();
        assert_eq!(grid.len(), 3); // 3 reels (cols)
        for col in grid {
            assert_eq!(col.as_array().unwrap().len(), 3); // 3 rows
        }
    }

    #[test]
    fn all_zero_strip_is_golden() {
        let v: serde_json::Value =
            serde_json::from_str(&spin_result_json(&tiny_model(), 7)).unwrap();
        assert_eq!(v["grid"], json!([[0, 0, 0], [0, 0, 0], [0, 0, 0]]));
        assert_eq!(v["basePayout"], 0);
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(spin_result_json(&tiny_model(), 123), spin_result_json(&tiny_model(), 123));
    }
}
