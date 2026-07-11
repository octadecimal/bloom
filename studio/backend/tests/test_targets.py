import pytest
from app.math.models import default_params
from app.math.targets import TargetGap, derive_num_bonuses, derive_target


def test_num_bonuses_prefers_gdd_when_consistent():
    assert derive_num_bonuses({"features": [{"name": "FS"}]},
                              {"bonuses": [{"FreeSpins": {}}]}) == 1


def test_num_bonuses_falls_back_to_model_when_gdd_empty():
    assert derive_num_bonuses({}, {"bonuses": [{"FreeSpins": {}}]}) == 1
    assert derive_num_bonuses({"features": []}, {"bonuses": []}) == 0


def test_num_bonuses_raises_on_drift():
    with pytest.raises(TargetGap):
        derive_num_bonuses({"features": [{"name": "a"}, {"name": "b"}]},
                           {"bonuses": [{"FreeSpins": {}}]})


# Task 6: new bands + pay constraints (Plan 2)

_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high", "model_id": 0},
    {"slot": "wild", "name": "Rune", "kind": "wild", "model_id": 2},
]}


def _math_model(**extra):
    return {"rtp": 0.96, "volatility": "medium", **extra}


def test_new_bands_are_omitted_when_intent_is_absent():
    t = derive_target(_math_model(), default_params(), 0)
    assert "hit_frequency_band" not in t
    assert "max_win_band" not in t
    assert "pay_constraints" not in t


def test_hit_frequency_compiles_to_a_relative_band():
    p = default_params()  # bonus_rate_tolerance 0.25
    t = derive_target(_math_model(hit_frequency=0.3), p, 0)
    band = t["hit_frequency_band"]
    assert abs(band["min"] - 0.225) < 1e-9
    assert abs(band["max"] - 0.375) < 1e-9


def test_max_win_compiles_to_a_relative_band():
    p = default_params()  # max_win_tolerance 0.5
    t = derive_target(_math_model(max_win=5000), p, 0)
    assert t["max_win_band"] == {"min": 2500.0, "max": 7500.0}


def test_pay_constraints_compile_through_the_join_key():
    rows = {"pay_constraints": [
        {"symbol": "wild", "relation": "top-paying"},
        {"symbol": "Dragon", "relation": "floor", "count": "3", "value": "5"},
    ]}
    t = derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)
    assert t["pay_constraints"] == [
        {"symbol": 2, "relation": "top-paying"},
        {"symbol": 0, "relation": "floor", "count": 3, "value": 5},
    ]


def test_pay_constraint_without_join_key_raises_target_gap():
    rows = {"pay_constraints": [{"symbol": "kraken", "relation": "floor", "value": "5"}]}
    with pytest.raises(TargetGap, match="re-realize"):
        derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)


def test_floor_without_value_raises_target_gap():
    rows = {"pay_constraints": [{"symbol": "wild", "relation": "floor"}]}
    with pytest.raises(TargetGap, match="value"):
        derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)


def test_unknown_relation_raises_target_gap():
    rows = {"pay_constraints": [{"symbol": "wild", "relation": "biggest"}]}
    with pytest.raises(TargetGap, match="relation"):
        derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)


def test_value_with_x_suffix_compiles_for_a_floor():
    rows = {"pay_constraints": [
        {"symbol": "Dragon", "relation": "floor", "value": "500x"}]}
    t = derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)
    assert t["pay_constraints"] == [{"symbol": 0, "relation": "floor", "value": 500}]


def test_malformed_value_raises_target_gap():
    rows = {"pay_constraints": [
        {"symbol": "Dragon", "relation": "floor", "value": "lots"}]}
    with pytest.raises(TargetGap, match="Dragon|value"):
        derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)


def test_malformed_count_raises_target_gap():
    rows = {"pay_constraints": [
        {"symbol": "Dragon", "relation": "floor", "count": "many", "value": "5"}]}
    with pytest.raises(TargetGap, match="Dragon|count"):
        derive_target(_math_model(), default_params(), 0,
                      paytable_data=rows, symbols_data=_SYMBOLS)
