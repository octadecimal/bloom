from app.math.realize_composed import (
    DEFAULT_FS_SPINS, DEFAULT_METER_TARGET, METER_STATE_BUDGET,
    SCATTER_EVENT, realize_game_definition,
)

_MATH = {"rtp": "0.96", "volatility": "high", "reels": 3, "rows": 3,
         "payline_mode": "lines", "payline_count": 3}
_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high"},
    {"slot": "low1", "name": "Ten", "kind": "low"},
    {"slot": "scat", "name": "Coin", "kind": "scatter"},
], "strip_length": {"min": 20, "max": 20}}
_PAYTABLE = {"payouts": [{"symbol": "Dragon", "3oak": "5"}]}
_FEATURES = {"features": [
    {"name": "Free Spins", "trigger": "3 scatters", "kind": "free-spins",
     "retrigger": "yes", "budget": "10"},
    {"name": "Coin Meter", "trigger": "meter", "kind": "meter", "budget": "7"},
]}


def _realize(features=_FEATURES, math=_MATH, symbols=_SYMBOLS):
    return realize_game_definition(math, symbols, _PAYTABLE, features)


def test_golden_full_definition():
    res = _realize()
    assert res.errors == []
    d = res.model
    assert d["family"] == "composed@1"
    assert d["start"] == "base"
    assert d["caps"] == {"max_steps": 1000}
    # one reels mechanic + one meter mechanic
    reels = d["mechanics"][0]
    assert reels["id"] == "main_reels" and reels["type"] == "reels@1"
    cfg = reels["config"]
    assert len(cfg["strips"]) == 3 and cfg["rows"] == 3
    assert len(cfg["paylines"]) == 3
    assert cfg["symbols"] == [
        {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
        {"id": 2, "role": "scatter"}]
    assert cfg["events"] == [{"symbol": 2, "min_count": 3, "emit": SCATTER_EVENT}]
    meter = d["mechanics"][1]
    assert meter == {"id": "meter_2", "type": "meter@1",
                     "config": {"target": 7, "count_symbol": 2,
                                "on_full": "meter2:full", "reset_on_full": True}}
    # states: base + fs_1 + meter_2_bonus
    assert [s["id"] for s in d["states"]] == ["base", "fs_1", "meter_2_bonus"]
    base = d["states"][0]
    assert base["bindings"] == [{"mechanic": "main_reels"}, {"mechanic": "meter_2"}]
    assert base["script"] == [{"invoke": "main_reels.spin"},
                              {"invoke": "meter_2.accumulate"}]
    assert base["steps"] == {"budget": 1}
    fs = d["states"][1]
    assert fs["steps"] == {"budget": "awarded", "initial": 10}
    mb = d["states"][2]
    assert mb["steps"] == {"budget": METER_STATE_BUDGET}
    assert d["transitions"] == [
        {"from": "base", "on": SCATTER_EVENT, "to": "fs_1"},
        {"from": "base", "on": "meter2:full", "to": "meter_2_bonus"},
        {"from": "fs_1", "on": SCATTER_EVENT, "effect": "steps:add:10"},
    ]
    assert res.slot_ids == {"high1": 0, "low1": 1, "scat": 2}


def test_no_features_yields_single_base_state():
    res = _realize(features={})
    d = res.model
    assert [s["id"] for s in d["states"]] == ["base"]
    assert d["transitions"] == []
    assert d["mechanics"][0]["config"]["events"] == []


def test_defaults_for_blank_budget_and_no_retrigger():
    res = _realize(features={"features": [
        {"name": "FS", "trigger": "t", "kind": "free-spins", "budget": ""},
        {"name": "M", "trigger": "t", "kind": "meter", "budget": ""},
    ]})
    d = res.model
    assert d["states"][1]["steps"]["initial"] == DEFAULT_FS_SPINS
    assert d["mechanics"][1]["config"]["target"] == DEFAULT_METER_TARGET
    assert not any("effect" in t for t in d["transitions"])  # no retrigger


def test_blank_kind_defaults_to_free_spins():
    res = _realize(features={"features": [{"name": "FS", "trigger": "t"}]})
    assert res.model["states"][1]["id"] == "fs_1"


def test_features_without_scatter_are_skipped_with_warning():
    symbols = {"symbols": [{"slot": "a", "kind": "high"}]}
    res = _realize(symbols=symbols)
    assert res.model is not None
    assert [s["id"] for s in res.model["states"]] == ["base"]
    assert any("no scatter" in w for w in res.warnings)


def test_second_free_spins_chains_from_first():
    res = _realize(features={"features": [
        {"name": "FS1", "trigger": "t", "kind": "free-spins", "retrigger": "yes"},
        {"name": "FS2", "trigger": "t", "kind": "free-spins", "retrigger": "yes"},
    ]})
    d = res.model
    assert {"from": "base", "on": SCATTER_EVENT, "to": "fs_1"} in d["transitions"]
    assert {"from": "fs_1", "on": SCATTER_EVENT, "to": "fs_2"} in d["transitions"]
    # retrigger only on the LAST fs state (fs_1's scatter event is consumed
    # by the chain transition)
    effects = [t for t in d["transitions"] if "effect" in t]
    assert effects == [{"from": "fs_2", "on": SCATTER_EVENT,
                        "effect": f"steps:add:{DEFAULT_FS_SPINS}"}]
    assert any("chains from" in w for w in res.warnings)


def test_existing_ids_keep_join_keys_stable():
    res = _realize()
    # simulate a later realize where 'low1' was removed: surviving ids keep
    res2 = realize_game_definition(
        _MATH,
        {"symbols": [{"slot": "high1", "kind": "high"},
                     {"slot": "scat", "kind": "scatter"}]},
        _PAYTABLE, _FEATURES, existing_ids={"high1": 0, "low1": 1, "scat": 2})
    assert res2.slot_ids == {"high1": 0, "scat": 2}


def test_no_symbols_is_a_hard_error():
    res = _realize(symbols={"symbols": []})
    assert res.model is None and res.errors
