from app.simulator.realize import (
    RealizeResult, _realize_symbols, _to_int, _to_bool, _KIND_TO_ROLE,
    _realize_reels,
)


def test_kind_to_role_map():
    assert _KIND_TO_ROLE == {
        "wild": "wild", "scatter": "scatter", "bonus": "scatter",
        "high": "normal", "low": "normal",
    }


def test_to_int_and_to_bool():
    assert _to_int("10", 0) == 10
    assert _to_int("", 5) == 5
    assert _to_int(None, 5) == 5
    assert _to_int("nope", 7) == 7
    assert _to_bool("yes") is True
    assert _to_bool("TRUE") is True
    assert _to_bool("no") is False
    assert _to_bool("") is False


def test_realize_symbols_assigns_ids_roles_and_name_map():
    sr = {"symbols": [
        {"slot": "high1", "name": "Dragon", "kind": "high"},
        {"slot": "low1", "name": "Ten", "kind": "low"},
        {"slot": "wild", "name": "Rune", "kind": "wild"},
        {"slot": "scatter", "name": "Coin", "kind": "scatter"},
        {"slot": "bonusx", "name": "Chest", "kind": "bonus"},
    ]}
    defs, name_to_id, errors, warnings = _realize_symbols(sr)
    assert errors == []
    assert defs == [
        {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
        {"id": 2, "role": "wild"}, {"id": 3, "role": "scatter"},
        {"id": 4, "role": "scatter"},  # bonus -> scatter
    ]
    assert name_to_id["high1"] == 0 and name_to_id["dragon"] == 0
    assert name_to_id["coin"] == 3


def test_realize_symbols_unknown_kind_defaults_normal_with_warning():
    defs, _, errors, warnings = _realize_symbols(
        {"symbols": [{"slot": "x", "name": "X", "kind": "sparkly"}]})
    assert errors == []
    assert defs == [{"id": 0, "role": "normal"}]
    assert any("sparkly" in w for w in warnings)


def test_realize_symbols_empty_is_hard_error():
    defs, _, errors, _ = _realize_symbols({"symbols": []})
    assert defs == []
    assert any("no symbols" in e.lower() for e in errors)


def test_realize_reels_seeds_midpoint_length_same_per_reel():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 30, "max": 40}}, distinct_count=4, reel_count=5)
    assert errors == []
    assert len(reels) == 5
    assert all(len(r) == 35 for r in reels)  # round(mid(30,40)) = 35
    # round-robin pos % 4 over 35 positions
    assert reels[0][:5] == [0, 1, 2, 3, 0]
    from collections import Counter
    assert Counter(reels[0]) == {0: 9, 1: 9, 2: 9, 3: 8}
    assert reels[0] == reels[4]  # identical per reel in SP2


def test_realize_reels_absent_strip_length_defaults_with_warning():
    reels, errors, warnings = _realize_reels({}, distinct_count=4, reel_count=3)
    assert errors == []
    assert all(len(r) == 30 for r in reels)  # max(4, DEFAULT_STRIP_LEN=30)
    assert any("strip_length absent" in w for w in warnings)


def test_realize_reels_midpoint_below_distinct_clamps_up_with_warning():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 2, "max": 8}}, distinct_count=6, reel_count=2)
    assert errors == []
    assert all(len(r) == 6 for r in reels)  # midpoint 5 -> clamped up to 6
    assert any("clamped" in w for w in warnings)


def test_realize_reels_max_below_distinct_is_hard_error():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 2, "max": 3}}, distinct_count=6, reel_count=2)
    assert reels == []
    assert any("distinct symbol count" in e for e in errors)
