import pytest
from app.math.models import default_params
from app.math.targets import (
    parse_ratio, normalize_percent, derive_target, TargetGap,
)

def test_parse_ratio_forms():
    assert parse_ratio("1:200") == pytest.approx(0.005)
    assert parse_ratio(0.005) == pytest.approx(0.005)
    assert parse_ratio("0.005") == pytest.approx(0.005)

def test_normalize_percent_string_bare_integer():
    # "96" (bare integer string) is treated as 96% → 0.96.
    assert normalize_percent("96") == pytest.approx(0.96)

def test_normalize_percent_string_percent_suffix():
    # "96%" (explicit suffix) → 0.96.
    assert normalize_percent("96%") == pytest.approx(0.96)

def test_normalize_percent_string_large_percent():
    # "5000%" → 50.0 (large sentinel; the string branch divides once).
    assert normalize_percent("5000%") == pytest.approx(50.0)

def test_normalize_percent_string_already_decimal():
    # "0.96" (already-decimal string) passes through as 0.96.
    assert normalize_percent("0.96") == pytest.approx(0.96)

def test_normalize_percent_nonstring_decimal_lt1():
    # Non-string float already in [0,1] range passes through unchanged.
    # GDD store normalises "90%" → 0.9 before writing; re-dividing would be a bug.
    assert normalize_percent(0.9) == pytest.approx(0.9)

def test_normalize_percent_nonstring_decimal_gt1():
    # Non-string float > 1 (e.g. 50.0 from "5000%") also passes through unchanged.
    # This ensures the near-miss e2e target of 50.0 is preserved end-to-end.
    assert normalize_percent(50.0) == pytest.approx(50.0)

def test_normalize_percent_nonstring_integer_passthrough():
    # Integer non-string inputs pass through as-is (returned as float).
    # Production code never sends a raw un-normalized integer; this assertion
    # documents the intentional contract: non-string inputs are already-normalized
    # GDD decimals and are NEVER divided by 100.
    assert normalize_percent(96) == pytest.approx(96.0)

def test_derive_target_maps_intent():
    md = {"rtp": "96%", "volatility": "high", "bonus_hit_rate": "1:200"}
    t = derive_target(md, default_params(), num_bonuses=1)
    assert t["rtp_target"] == pytest.approx(0.96)
    assert t["volatility_min"] < t["volatility_max"]
    assert len(t["bonus_hit_rate_bands"]) == 1
    band = t["bonus_hit_rate_bands"][0]
    assert band["min"] < 0.005 < band["max"]
    assert t["candidate_count"] == default_params().candidate_count
    assert t["master_seed"] == default_params().master_seed

def test_derive_target_zero_bonuses_has_no_bands():
    md = {"rtp": 0.96, "volatility": "medium"}
    t = derive_target(md, default_params(), num_bonuses=0)
    assert t["bonus_hit_rate_bands"] == []

def test_missing_rtp_is_a_gap():
    with pytest.raises(TargetGap):
        derive_target({"volatility": "high"}, default_params(), num_bonuses=0)

def test_missing_bonus_rate_with_bonus_is_a_gap():
    with pytest.raises(TargetGap):
        derive_target({"rtp": 0.96, "volatility": "high"}, default_params(), num_bonuses=1)
