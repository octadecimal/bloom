from app.math.bounds import derive_bounds, build_config
from app.math.models import default_tuning_params


def test_derive_bounds_scales_payout_ceiling_to_existing_payouts():
    model = {"paytable": {"entries": [
        {"symbol": 1, "count": 1, "payout": 1},
        {"symbol": 2, "count": 1, "payout": 30},
    ]}}
    b = derive_bounds(model)
    assert b["payout_min"] == 0
    assert b["payout_max"] == 120  # 30 * 4
    assert b["spins_min"] == 1 and b["min_count_min"] == 1


def test_derive_bounds_floor_for_tiny_payouts():
    model = {"paytable": {"entries": [{"symbol": 1, "count": 1, "payout": 1}]}}
    assert derive_bounds(model)["payout_max"] == 20  # max(20, 1*4)


def test_derive_bounds_handles_empty_model():
    assert derive_bounds({})["payout_max"] == 20


def test_build_config_emits_snake_case_rust_contract():
    p = default_tuning_params()
    p.population = 16
    cfg = build_config(p, derive_bounds({}))
    assert cfg["population"] == 16
    assert cfg["search_candidate_count"] == p.search_candidate_count
    assert cfg["weights"]["hit_rate"] == p.weights.hit_rate
    assert cfg["bounds"]["payout_max"] == 20
    # exactly the keys tune_json's ConfigJson expects
    assert set(cfg) == {
        "master_seed", "population", "max_generations", "elitism",
        "mutation_rate", "crossover_rate", "stagnation_window",
        "search_candidate_count", "final_candidate_count", "bounds", "weights",
    }
