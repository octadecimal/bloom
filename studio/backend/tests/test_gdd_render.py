from app.gdd.schemas import schema_for
from app.gdd.render import render


def test_paytable_renders_concrete_table():
    schema = schema_for("paytable")
    data = {
        "payouts": [
            {"symbol": "Wild", "3oak": 10, "4oak": 50, "5oak": 500},
            {"symbol": "Seven", "3oak": 5, "4oak": 25, "5oak": 200},
        ],
        "notes": "Wild carries the top end.",
    }
    out = render(schema, data)
    assert "| Symbol | 3 OAK | 4 OAK | 5 OAK |" in out
    assert "| Wild | 10 | 50 | 500 |" in out
    assert "Wild carries the top end." in out


def test_percent_and_ratio_format_in_params_block():
    schema = schema_for("math-model")
    out = render(schema, {"rtp": 0.96, "bonus_hit_rate": "1:200", "max_win": 5000.0})
    assert "**RTP:** 96%" in out
    assert "**Bonus hit rate:** 1:200" in out
    assert "**Max win (x bet):** 5000" in out


def test_missing_required_field_marked_needs_input():
    schema = schema_for("paytable")
    out = render(schema, {"notes": "tbd"})
    assert "needs input" in out.lower()


def test_render_is_deterministic():
    schema = schema_for("math-model")
    data = {"rtp": 0.96, "volatility": "high", "bonus_hit_rate": "1:200"}
    assert render(schema, data) == render(schema, data)


def test_range_renders_as_min_dash_max():
    schema = schema_for("symbols-reels")
    out = render(schema, {
        "symbols": [{"slot": "high1", "name": "Dragon", "kind": "high", "art_desc": "a dragon"}],
        "strip_length": {"min": 8, "max": 20},
    })
    assert "**Strip length:** 8–20" in out
