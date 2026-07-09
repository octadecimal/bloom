from app.math.models import SectionLocks
from app.math.shape import (
    affected_sections, is_shape_change, is_target_change, merge_sections,
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
