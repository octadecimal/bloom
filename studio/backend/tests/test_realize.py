from app.math.realize import (
    RealizeResult, _realize_symbols, _to_int, _to_bool, _KIND_TO_ROLE,
    _realize_reels, _all_patterns, _first_n_patterns, _realize_paylines,
    _realize_paytable, _realize_bonuses, realize_slot_model,
)

_GDD_MATH = {"rtp": "0.96", "volatility": "high", "reels": 5, "rows": 3,
             "payline_mode": "lines", "payline_count": 5, "bonus_hit_rate": "1:150"}
_GDD_SYMBOLS = {"symbols": [
    {"slot": "high1", "name": "Dragon", "kind": "high", "art_desc": "a dragon"},
    {"slot": "low1", "name": "Ten", "kind": "low", "art_desc": "a ten"},
    {"slot": "wild", "name": "Rune", "kind": "wild", "art_desc": "a rune"},
    {"slot": "scatter", "name": "Coin", "kind": "scatter", "art_desc": "a coin"},
], "strip_length": {"min": 30, "max": 40}}
_GDD_PAYTABLE = {"payouts": [
    {"symbol": "Dragon", "3oak": "5", "4oak": "20", "5oak": "100"},
    {"symbol": "Ten", "3oak": "2", "4oak": "8", "5oak": "40"},
]}
_GDD_BONUS = {"free_spins": [
    {"trigger": "3 scatters", "count": "10", "retrigger": "yes", "multiplier": "2"}]}


def test_realize_golden_vector():
    res = realize_slot_model(_GDD_MATH, _GDD_SYMBOLS, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.errors == []
    m = res.model
    assert m["symbols"] == [
        {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
        {"id": 2, "role": "wild"}, {"id": 3, "role": "scatter"}]
    assert m["rows"] == 3
    assert len(m["reels"]) == 5 and all(len(r) == 35 for r in m["reels"])
    assert m["paylines"] == [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2],
                             [0, 0, 0, 0, 1], [0, 0, 0, 0, 2]]
    assert m["paytable"]["entries"][0] == {"symbol": 0, "count": 3, "payout": 5}
    assert m["bonuses"] == [{"FreeSpins": {
        "trigger": {"symbol": 3, "min_count": 3},
        "config": {"spins_awarded": 10, "retrigger": True,
                   "multiplier": 2, "feature_reels": None}}}]


def test_realize_returns_none_on_hard_error():
    res = realize_slot_model(_GDD_MATH, {"symbols": []}, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is None
    assert any("no symbols" in e.lower() for e in res.errors)


def test_realize_defaults_reels_and_rows_with_warnings():
    res = realize_slot_model(
        {"payline_mode": "lines", "payline_count": 1}, _GDD_SYMBOLS, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is not None
    assert len(res.model["reels"]) == 5  # DEFAULT_REELS
    assert res.model["rows"] == 3        # DEFAULT_ROWS
    assert any("reels absent" in w for w in res.warnings)
    assert any("rows absent" in w for w in res.warnings)


def test_realize_aggregates_all_diagnostics_before_failing():
    # symbols OK, but BOTH a bad override AND strip_length.max < distinct count.
    # Both helpers run and both errors surface before the single None return.
    sr = {"symbols": _GDD_SYMBOLS["symbols"], "strip_length": {"min": 1, "max": 2}}
    res = realize_slot_model(
        {"payline_overrides": ["0,1"]}, sr, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is None
    assert any("reel count" in e for e in res.errors)             # override length
    assert any("distinct symbol count" in e for e in res.errors)  # strip_length.max

_DEFS = [
    {"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
    {"id": 2, "role": "wild"}, {"id": 3, "role": "scatter"},
]
_NAME_TO_ID = {"dragon": 0, "high1": 0, "ten": 1, "low1": 1,
               "rune": 2, "coin": 3}


def test_paytable_resolves_rows_to_oak_entries():
    pt = {"payouts": [
        {"symbol": "Dragon", "3oak": "5", "4oak": "20", "5oak": "100"},
        {"symbol": "Ten", "3oak": "2", "4oak": "8", "5oak": "40"},
    ]}
    out, errors, warnings = _realize_paytable(pt, _NAME_TO_ID, _DEFS)
    assert errors == []
    assert out == {"entries": [
        {"symbol": 0, "count": 3, "payout": 5},
        {"symbol": 0, "count": 4, "payout": 20},
        {"symbol": 0, "count": 5, "payout": 100},
        {"symbol": 1, "count": 3, "payout": 2},
        {"symbol": 1, "count": 4, "payout": 8},
        {"symbol": 1, "count": 5, "payout": 40},
    ]}


def test_paytable_unresolved_symbol_warns_and_skips():
    pt = {"payouts": [{"symbol": "Ghost", "3oak": "5"}]}
    out, errors, warnings = _realize_paytable(pt, _NAME_TO_ID, _DEFS)
    # nothing resolved -> falls back to placeholder; the skip is warned
    assert any("Ghost" in w for w in warnings)


def test_paytable_empty_seeds_placeholder_for_normal_symbols():
    out, errors, warnings = _realize_paytable({}, _NAME_TO_ID, _DEFS)
    assert errors == []
    # only the two normal symbols (ids 0,1) get placeholder entries
    syms = {e["symbol"] for e in out["entries"]}
    assert syms == {0, 1}
    assert any("placeholder" in w for w in warnings)


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


def _normals(n):
    return [{"id": i, "role": "normal"} for i in range(n)]


def test_realize_reels_seeds_midpoint_length_same_per_reel():
    # 3 paying (normal/wild) symbols + 1 scatter. Paying fill round-robin; the
    # scatter is sprinkled SPARSELY, not woven into the round-robin.
    defs = [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
            {"id": 2, "role": "wild"}, {"id": 3, "role": "scatter"}]
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 30, "max": 40}}, defs, reel_count=5)
    assert errors == []
    assert len(reels) == 5
    assert all(len(r) == 35 for r in reels)  # round(mid(30,40)) = 35
    # paying symbols laid round-robin over ids [0, 1, 2]
    assert reels[0][:3] == [0, 1, 2]
    from collections import Counter
    counts = Counter(reels[0])
    # scatter (id 3) is SPARSE: floor(35 / 20) = 1 occurrence, not ~8.
    assert counts[3] == 1
    assert reels[0] == reels[4]  # identical per reel in SP2


def test_realize_reels_scatter_is_sparse_not_round_robin_dense():
    # Regression guard for the OOM root cause: a flat round-robin would put the
    # scatter on ~1/distinct of cells (dense), driving the free-spins trigger.
    defs = [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
            {"id": 2, "role": "scatter"}]
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 40, "max": 40}}, defs, reel_count=3)
    assert errors == []
    from collections import Counter
    counts = Counter(reels[0])
    # 40 // 20 = 2 sparse occurrences, FAR below a round-robin's ~13 (40/3).
    assert counts[2] == 2
    assert counts[2] < len(reels[0]) // 4  # provably sparse


def test_realize_reels_absent_strip_length_defaults_with_warning():
    reels, errors, warnings = _realize_reels({}, _normals(4), reel_count=3)
    assert errors == []
    assert all(len(r) == 30 for r in reels)  # max(4, DEFAULT_STRIP_LEN=30)
    # all-normal: pure round-robin over ids [0, 1, 2, 3]
    assert reels[0][:5] == [0, 1, 2, 3, 0]
    assert any("strip_length absent" in w for w in warnings)


def test_realize_reels_midpoint_below_distinct_clamps_up_with_warning():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 2, "max": 8}}, _normals(6), reel_count=2)
    assert errors == []
    assert all(len(r) == 6 for r in reels)  # midpoint 5 -> clamped up to 6
    assert any("clamped" in w for w in warnings)


def test_realize_reels_max_below_distinct_is_hard_error():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 2, "max": 3}}, _normals(6), reel_count=2)
    assert reels == []
    assert any("distinct symbol count" in e for e in errors)


def test_realize_reels_only_scatters_falls_back_with_warning():
    # Degenerate: no paying symbols at all. Strip still composed; warned.
    defs = [{"id": 0, "role": "scatter"}, {"id": 1, "role": "scatter"}]
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 30, "max": 30}}, defs, reel_count=2)
    assert errors == []
    assert all(len(r) == 30 for r in reels)
    assert any("no paying" in w for w in warnings)


def test_all_patterns_horizontals_first_then_lexicographic():
    pats = _all_patterns(rows=3, reel_count=5)
    assert len(pats) == 243  # 3 ** 5
    assert pats[0] == [0, 0, 0, 0, 0]
    assert pats[1] == [1, 1, 1, 1, 1]
    assert pats[2] == [2, 2, 2, 2, 2]
    assert pats[3] == [0, 0, 0, 0, 1]  # first non-constant, lexicographic
    assert pats[4] == [0, 0, 0, 0, 2]


def test_paylines_lines_mode_takes_first_n():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "lines", "payline_count": 5}, reel_count=5, rows=3)
    assert errors == []
    assert lines == [[0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2],
                     [0, 0, 0, 0, 1], [0, 0, 0, 0, 2]]


def test_paylines_ways_mode_takes_all():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "ways", "payline_count": 243}, reel_count=5, rows=3)
    assert errors == []
    assert len(lines) == 243


def test_paylines_overrides_bypass_generator():
    lines, errors, warnings = _realize_paylines(
        {"payline_overrides": ["0,1,2,1,0", "2,2,2,2,2"]}, reel_count=5, rows=3)
    assert errors == []
    assert lines == [[0, 1, 2, 1, 0], [2, 2, 2, 2, 2]]


def test_paylines_override_wrong_length_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_overrides": ["0,1,2,1"]}, reel_count=5, rows=3)
    assert lines == []
    assert any("positions but reel count" in e for e in errors)


def test_paylines_override_row_out_of_range_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_overrides": ["0,1,2,1,9"]}, reel_count=5, rows=3)
    assert lines == []
    assert any("outside" in e for e in errors)


def test_paylines_lines_count_exceeds_possible_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "lines", "payline_count": 999}, reel_count=2, rows=3)
    assert lines == []  # only 9 possible
    assert any("exceeds" in e for e in errors)


def test_paylines_ways_over_cap_is_hard_error():
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "ways"}, reel_count=8, rows=4)  # 4**8 = 65536 > 4096
    assert lines == []
    assert any("MAX_PAYLINES" in e for e in errors)


def test_bonuses_map_free_spins_to_external_tagged_freespins():
    bf = {"free_spins": [
        {"trigger": "3 scatters", "count": "10", "retrigger": "yes", "multiplier": "2"}]}
    out, errors, warnings = _realize_bonuses(bf, _DEFS)
    assert errors == []
    assert out == [{"FreeSpins": {
        "trigger": {"symbol": 3, "min_count": 3},
        "config": {"spins_awarded": 10, "retrigger": True,
                   "multiplier": 2, "feature_reels": None},
    }}]


def test_bonuses_without_trigger_symbol_warns_and_skips():
    defs_no_scatter = [{"id": 0, "role": "normal"}, {"id": 1, "role": "wild"}]
    out, errors, warnings = _realize_bonuses(
        {"free_spins": [{"count": "5"}]}, defs_no_scatter)
    assert out == []
    assert any("trigger symbol" in w for w in warnings)


def test_bonuses_absent_is_empty_no_warning():
    out, errors, warnings = _realize_bonuses({}, _DEFS)
    assert out == [] and errors == [] and warnings == []


def test_first_n_patterns_matches_all_patterns_ordering():
    # Lazy generator must produce exactly the same prefix as _all_patterns.
    full = _all_patterns(rows=3, reel_count=5)
    assert _first_n_patterns(3, 5, 5) == full[:5]
    assert _first_n_patterns(3, 5, 1) == full[:1]


def test_paylines_lines_mode_is_lazy_for_huge_geometry():
    import time
    # 12^12 ≈ 8.9e12 combos: a full materialization would OOM/hang. Lazy first-n
    # must return instantly with exactly n lines.
    t0 = time.perf_counter()
    lines, errors, warnings = _realize_paylines(
        {"payline_mode": "lines", "payline_count": 3}, reel_count=12, rows=12)
    assert errors == []
    assert lines == [[0] * 12, [1] * 12, [2] * 12]
    assert time.perf_counter() - t0 < 1.0  # never built 12^12


def test_realize_rejects_oversized_geometry_fast():
    res = realize_slot_model(
        {"reels": 999, "rows": 999, "payline_mode": "lines", "payline_count": 1},
        _GDD_SYMBOLS, _GDD_PAYTABLE, _GDD_BONUS)
    assert res.model is None
    assert any("MAX_REELS" in e for e in res.errors)


def test_realize_reels_clamps_oversized_strip_length():
    reels, errors, warnings = _realize_reels(
        {"strip_length": {"min": 1_000_000, "max": 1_000_000}}, _normals(4), reel_count=3)
    assert errors == []
    assert all(len(r) == 1000 for r in reels)  # clamped to MAX_STRIP_LEN
    assert any("MAX_STRIP_LEN" in w for w in warnings)
