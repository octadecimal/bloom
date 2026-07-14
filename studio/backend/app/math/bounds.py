"""Translate the studio's seed model + TuningParams into the snake_case JSON the
bloom-tuner `tune_json` binary reads. Pure; no IO. Gene bounds are DERIVED from
the seed model (not user-edited) — the payout ceiling scales to the model's own
payouts so the search can both raise and lower them."""
from app.math.models import SectionLocks, TuningParams


def _paytable_entries(model: dict) -> list:
    if (model or {}).get("family") == "composed@1":
        for m in model.get("mechanics") or []:
            if m.get("type") == "reels@1":
                return ((m.get("config") or {}).get("paytable") or {}).get("entries") or []
        return []
    return (model.get("paytable") or {}).get("entries") or []


def derive_bounds(model: dict) -> dict:
    entries = _paytable_entries(model)
    payouts = [int(e.get("payout", 0)) for e in entries]
    max_payout = max(payouts) if payouts else 0
    return {
        "payout_min": 0,
        "payout_max": max(20, max_payout * 4),
        "spins_min": 1,
        "spins_max": 50,
        "multiplier_min": 1,
        "multiplier_max": 10,
        "min_count_min": 1,
        "min_count_max": 5,
    }


def build_config(params: TuningParams, bounds: dict,
                 locks: SectionLocks | None = None) -> dict:
    lk = locks or SectionLocks()
    return {
        "master_seed": params.master_seed,
        "population": params.population,
        "max_generations": params.max_generations,
        "elitism": params.elitism,
        "mutation_rate": params.mutation_rate,
        "crossover_rate": params.crossover_rate,
        "stagnation_window": params.stagnation_window,
        "search_candidate_count": params.search_candidate_count,
        "final_candidate_count": params.final_candidate_count,
        "bounds": dict(bounds),
        "weights": {
            "rtp": params.weights.rtp,
            "volatility": params.weights.volatility,
            "hit_rate": params.weights.hit_rate,
            "hit_frequency": params.weights.hit_frequency,
        },
        "locks": {"reels": lk.reels, "paytable": lk.paytable, "bonus": lk.bonus},
    }
