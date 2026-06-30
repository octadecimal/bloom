from app.gdd.schemas import ASPECT_SCHEMAS, field_catalog


def _keys(aspect):
    return {f.key for f in ASPECT_SCHEMAS[aspect]}


def test_ui_ux_has_blueprint_enums():
    assert {"orientation", "focal_emphasis", "framing_density"} <= _keys("ui-ux")


def test_blueprint_enums_have_expected_values():
    by_key = {f.key: f for f in ASPECT_SCHEMAS["ui-ux"]}
    assert by_key["orientation"].enum == ("portrait", "landscape")
    assert by_key["focal_emphasis"].enum == ("reels", "logo", "balanced")
    assert by_key["framing_density"].enum == ("clean", "moderate", "ornate")
    assert all(by_key[k].type == "enum" for k in
               ("orientation", "focal_emphasis", "framing_density"))


def test_catalog_exposes_blueprint_enums():
    ui = {f["key"]: f for f in field_catalog()["ui-ux"]}
    assert ui["orientation"]["enum"] == ["portrait", "landscape"]
    assert ui["framing_density"]["enum"] == ["clean", "moderate", "ornate"]
