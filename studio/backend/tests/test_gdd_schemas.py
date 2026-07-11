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


def test_paytable_pay_constraints_is_optional_table_with_columns():
    pay_constraints = {f.key: f for f in schema_for("paytable")}["pay_constraints"]
    assert pay_constraints.type == "table" and not pay_constraints.required
    assert [c.key for c in pay_constraints.columns] == ["symbol", "relation", "count", "value"]


def test_required_param_keys_lists_only_required():
    assert required_param_keys("paytable") == []
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


def test_symbols_table_has_slot_column():
    symbols = next(f for f in schema_for("symbols-reels") if f.key == "symbols")
    cols = [c.key for c in symbols.columns]
    assert cols == ["slot", "name", "kind", "art_desc", "model_id"]


def test_math_model_payline_topology_is_structured():
    fields = {f.key: f for f in schema_for("math-model")}
    assert "paylines" not in fields  # old free-text field removed
    assert fields["payline_mode"].type == "enum"
    assert fields["payline_mode"].enum == ("lines", "ways")
    assert fields["payline_count"].type == "number"
    # all payline fields are optional
    assert not fields["payline_mode"].required
    assert not fields["payline_count"].required


def test_symbols_reels_has_strip_length_range_and_no_composition():
    fields = {f.key: f for f in schema_for("symbols-reels")}
    assert "reel_strips" not in fields  # free-text composition table removed
    assert fields["strip_length"].type == "range"
    assert not fields["strip_length"].required


def test_symbols_kind_column_is_enum_constrained():
    symbols = next(f for f in schema_for("symbols-reels") if f.key == "symbols")
    kind = next(c for c in symbols.columns if c.key == "kind")
    assert kind.enum == ("high", "low", "wild", "scatter", "bonus")


def test_field_catalog_emits_column_enums():
    from app.gdd.schemas import field_catalog
    cat = field_catalog()
    symbols = next(f for f in cat["symbols-reels"] if f["key"] == "symbols")
    kind = next(c for c in symbols["columns"] if c["key"] == "kind")
    assert kind["enum"] == ["high", "low", "wild", "scatter", "bonus"]
    # non-table fields carry columns=None
    rtp = next(f for f in cat["math-model"] if f["key"] == "rtp")
    assert rtp["columns"] is None


def _keys(aspect):
    return [f.key for f in ASPECT_SCHEMAS[aspect]]


def test_evicted_fields_gone():
    assert "payouts" not in _keys("paytable")
    assert "special_pays" not in _keys("paytable")
    assert "free_spins" not in _keys("bonus-features")
    assert "payline_overrides" not in _keys("math-model")
    assert "bet_range" not in _keys("math-model")


def test_pay_constraints_field():
    from app.gdd.schemas import field_catalog
    field = next(f for f in ASPECT_SCHEMAS["paytable"] if f.key == "pay_constraints")
    assert field.type == "table"
    assert field.required is False
    cols = {c.key: c for c in field.columns}
    assert set(cols) == {"symbol", "relation", "count", "value"}
    assert cols["relation"].enum == ("top-paying", "floor", "ceiling")


def test_symbols_table_has_model_id_column():
    field = next(f for f in ASPECT_SCHEMAS["symbols-reels"] if f.key == "symbols")
    assert "model_id" in {c.key for c in field.columns}


def test_paytable_no_longer_required():
    # payouts was the only required paytable field; after eviction the aspect
    # has no required params (derive_status: data present -> drafted).
    assert not [f for f in ASPECT_SCHEMAS["paytable"] if f.required]


def test_catalog_reflects_schema():
    from app.gdd.schemas import field_catalog
    cat = field_catalog()
    assert "pay_constraints" in [f["key"] for f in cat["paytable"]]
    assert "payouts" not in [f["key"] for f in cat["paytable"]]
