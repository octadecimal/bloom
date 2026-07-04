from app.math import templates
from app.math.models import SectionLocks


def _structurally_valid(model: dict) -> None:
    ids = {s["id"] for s in model["symbols"]}
    assert len(model["reels"]) >= 3
    for strip in model["reels"]:
        assert set(strip) <= ids, "reel strip references unknown symbol"
    assert model["rows"] >= 3
    assert len(model["paylines"]) >= 1
    for line in model["paylines"]:
        assert len(line) == len(model["reels"])
        assert all(0 <= r < model["rows"] for r in line)
    assert len(model["paytable"]["entries"]) >= 1
    for e in model["paytable"]["entries"]:
        assert e["symbol"] in ids
    for b in model.get("bonuses", []):
        assert b["FreeSpins"]["trigger"]["symbol"] in ids


def test_all_templates_are_complete_playable_models():
    names = {t["name"] for t in templates.list_templates()}
    assert names == {"classic-3x3", "video-5x3", "high-vol-5x4"}
    for name in names:
        _structurally_valid(templates.get_model(name))


def test_default_is_video_5x3():
    assert templates.DEFAULT_TEMPLATE == "video-5x3"
    m = templates.default_model()
    assert len(m["reels"]) == 5 and m["rows"] == 3
    assert len(m["bonuses"]) == 1


def test_high_vol_is_5x4():
    m = templates.get_model("high-vol-5x4")
    assert len(m["reels"]) == 5 and m["rows"] == 4


def test_get_model_returns_fresh_copies():
    a = templates.get_model("video-5x3")
    a["rows"] = 99
    assert templates.get_model("video-5x3")["rows"] == 3


def test_get_model_unknown_raises_key_error():
    import pytest
    with pytest.raises(KeyError):
        templates.get_model("nope")


def test_apply_template_unlocked_takes_template_wholesale():
    current = templates.get_model("classic-3x3")
    tpl = templates.get_model("video-5x3")
    merged = templates.apply_template(current, tpl, SectionLocks())
    assert merged == tpl


def test_apply_template_locked_sections_keep_current_values():
    current = templates.get_model("classic-3x3")
    tpl = templates.get_model("video-5x3")
    locks = SectionLocks(reels=True, paytable=True, bonus=True)
    merged = templates.apply_template(current, tpl, locks)
    assert merged["reels"] == current["reels"]
    assert merged["rows"] == current["rows"]          # rows travel with reels
    assert merged["paytable"] == current["paytable"]
    assert merged["bonuses"] == current["bonuses"]
    assert merged["symbols"] == tpl["symbols"]        # symbols are not lockable


def test_apply_template_empty_current_ignores_locks():
    tpl = templates.get_model("video-5x3")
    merged = templates.apply_template({}, tpl, SectionLocks(reels=True))
    assert merged == tpl
