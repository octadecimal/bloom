from app.math.models import SectionLocks
from app.math.shape import (
    affected_sections, is_shape_change, is_target_change, merge_sections,
    composed_affected_groups, merge_composed_groups,
)


def test_shape_and_target_detection():
    assert is_shape_change("math-model", {"reels": 3})
    assert is_shape_change("symbols-reels", {"symbols": []})
    assert is_shape_change("bonus-features", {"features": []})
    assert not is_shape_change("math-model", {"rtp": "96%"})
    assert is_target_change("math-model", {"rtp": "96%"})
    assert is_target_change("math-model", {"max_win": 5000})
    assert not is_target_change("theme", {"name": "x"})


def test_affected_sections():
    assert affected_sections("math-model", {"reels": 3}) == {"reels", "paylines"}
    assert affected_sections("symbols-reels", {"symbols": []}) == {
        "symbols", "reels", "paytable"}
    assert affected_sections("bonus-features", {"features": []}) == {"bonuses"}
    assert affected_sections("math-model", {"rtp": "96%"}) == set()


def test_merge_sections_respects_locks():
    existing = {"symbols": [{"id": 0, "role": "normal"}], "reels": [[0]],
                "rows": 3, "paylines": [[0]],
                "paytable": {"entries": [{"symbol": 0, "count": 3, "payout": 7}]},
                "bonuses": []}
    realized = {"symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "wild"}],
                "reels": [[0, 1]], "rows": 4, "paylines": [[0], [1]],
                "paytable": {"entries": [{"symbol": 1, "count": 3, "payout": 1}]},
                "bonuses": [{"FreeSpins": {}}]}
    out = merge_sections(existing, realized,
                         {"symbols", "reels", "paytable", "bonuses"},
                         SectionLocks(paytable=True))
    assert out["symbols"] == realized["symbols"]          # never lockable
    assert out["reels"] == realized["reels"] and out["rows"] == 4
    assert out["paytable"] == existing["paytable"]        # locked
    assert out["bonuses"] == realized["bonuses"]
    assert out["paylines"] == existing["paylines"]        # not affected
    assert existing["paytable"]["entries"][0]["payout"] == 7  # no mutation


def _mini_def(reels_id="main_reels", payout=5):
    return {
        "family": "composed@1",
        "mechanics": [{"id": reels_id, "type": "reels@1", "config": {
            "strips": [[0, 1]], "rows": 1, "symbols": [{"id": 0, "role": "normal"}],
            "paylines": [[0]],
            "paytable": {"entries": [{"symbol": 0, "count": 1, "payout": payout}]},
            "events": [],
        }}],
        "states": [{"id": "base", "bindings": [{"mechanic": reels_id}],
                    "steps": {"budget": 1},
                    "script": [{"invoke": f"{reels_id}.spin"}]}],
        "start": "base", "transitions": [], "caps": {"max_steps": 1000},
    }


def test_game_family_is_a_shape_field():
    assert is_shape_change("math-model", {"game_family": "composed@1"})


def test_composed_affected_groups_mapping():
    assert composed_affected_groups("math-model", {"reels": 4}) == {"reels"}
    assert composed_affected_groups("symbols-reels", {"symbols": []}) == {"reels", "paytable"}
    assert composed_affected_groups("bonus-features", {"features": []}) == {"features"}
    assert composed_affected_groups("math-model", {"game_family": "x"}) == {
        "reels", "paytable", "features"}


def test_merge_grafts_only_requested_unlocked_groups():
    existing = _mini_def(payout=999)   # hand-tuned paytable
    realized = _mini_def(payout=5)
    realized["mechanics"][0]["config"]["strips"] = [[0, 0, 0]]
    out = merge_composed_groups(existing, realized, {"reels"}, SectionLocks())
    assert out["mechanics"][0]["config"]["strips"] == [[0, 0, 0]]      # grafted
    assert out["mechanics"][0]["config"]["paytable"]["entries"][0]["payout"] == 999


def test_merge_honors_locks():
    existing = _mini_def(payout=999)
    realized = _mini_def(payout=5)
    out = merge_composed_groups(existing, realized, {"paytable"},
                                SectionLocks(paytable=True))
    assert out["mechanics"][0]["config"]["paytable"]["entries"][0]["payout"] == 999


def test_features_graft_retargets_to_existing_reels_id():
    existing = _mini_def(reels_id="my_reels")
    realized = _mini_def()  # main_reels
    realized["states"].append({"id": "fs_1",
                               "bindings": [{"mechanic": "main_reels"}],
                               "steps": {"budget": "awarded", "initial": 8},
                               "script": [{"invoke": "main_reels.spin"}]})
    realized["transitions"] = [{"from": "base", "on": "scatters:3", "to": "fs_1"}]
    out = merge_composed_groups(existing, realized, {"features"}, SectionLocks())
    assert out["mechanics"][0]["id"] == "my_reels"                      # kept
    fs = next(s for s in out["states"] if s["id"] == "fs_1")
    assert fs["bindings"] == [{"mechanic": "my_reels"}]                 # retargeted
    assert fs["script"] == [{"invoke": "my_reels.spin"}]
