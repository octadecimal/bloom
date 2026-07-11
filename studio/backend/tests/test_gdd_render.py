from app.gdd.schemas import schema_for
from app.gdd.render import render


def test_paytable_renders_concrete_table():
    schema = schema_for("paytable")
    data = {
        "pay_constraints": [
            {"symbol": "Wild", "relation": "top-paying", "count": 5, "value": 500},
            {"symbol": "Seven", "relation": "floor", "count": 3, "value": 10},
        ],
        "notes": "Wild carries the top end.",
    }
    out = render(schema, data)
    assert "| Symbol | Relation | Count | Value (x bet) |" in out
    assert "| Wild | top-paying | 5 | 500 |" in out
    assert "Wild carries the top end." in out


def test_percent_and_ratio_format_in_params_block():
    schema = schema_for("math-model")
    out = render(schema, {"rtp": 0.96, "bonus_hit_rate": "1:200", "max_win": 5000.0})
    assert "**RTP:** 96%" in out
    assert "**Bonus hit rate:** 1:200" in out
    assert "**Max win (x bet):** 5000" in out


def test_missing_required_field_marked_needs_input():
    schema = schema_for("bonus-features")
    out = render(schema, {"bonus_buy": "tbd"})
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
