from app.gdd.schemas import (
    ASPECT_SCHEMAS, schema_for, required_param_keys, Field,
)


def test_all_seven_aspects_have_schemas():
    assert set(ASPECT_SCHEMAS) == {
        "theme", "math-model", "symbols-reels", "paytable",
        "bonus-features", "ui-ux", "audio",
    }
    for fields in ASPECT_SCHEMAS.values():
        assert fields and all(isinstance(f, Field) for f in fields)


def test_math_model_has_required_bonus_hit_rate_ratio():
    fields = {f.key: f for f in schema_for("math-model")}
    assert fields["bonus_hit_rate"].type == "ratio"
    assert fields["bonus_hit_rate"].required is True
    assert fields["rtp"].type == "percent" and fields["rtp"].required
    assert fields["volatility"].type == "enum"
    assert "medium-high" in fields["volatility"].enum


def test_paytable_payouts_is_required_table_with_columns():
    payouts = {f.key: f for f in schema_for("paytable")}["payouts"]
    assert payouts.type == "table" and payouts.required
    assert [c.key for c in payouts.columns] == ["symbol", "3oak", "4oak", "5oak"]


def test_required_param_keys_lists_only_required():
    assert required_param_keys("paytable") == ["payouts"]
    assert set(required_param_keys("math-model")) == {
        "rtp", "volatility", "bonus_hit_rate",
    }


def test_field_catalog_covers_all_aspects_with_field_metadata():
    from app.gdd.schemas import field_catalog
    cat = field_catalog()
    assert set(cat) == set(ASPECT_SCHEMAS)
    mm = {f["key"]: f for f in cat["math-model"]}
    assert mm["bonus_hit_rate"]["type"] == "ratio"
    assert mm["bonus_hit_rate"]["required"] is True
    assert mm["volatility"]["enum"] == ["low", "medium", "medium-high", "high"]
    # text/number fields carry enum=None, not a missing key
    assert mm["rtp"]["enum"] is None
    for fields in cat.values():
        for f in fields:
            assert {"key", "label", "type", "role", "required", "enum"} <= set(f)
