import pytest
from app.simulator.models import default_params
from app.simulator.targets import (
    parse_ratio, normalize_percent, derive_target, TargetGap,
)

def test_parse_ratio_forms():
    assert parse_ratio("1:200") == pytest.approx(0.005)
    assert parse_ratio(0.005) == pytest.approx(0.005)
    assert parse_ratio("0.005") == pytest.approx(0.005)

def test_normalize_percent_forms():
    assert normalize_percent(96) == pytest.approx(0.96)
    assert normalize_percent("96%") == pytest.approx(0.96)
    assert normalize_percent(0.96) == pytest.approx(0.96)

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
