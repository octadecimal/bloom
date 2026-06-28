from app.gdd.router import build_design_router_spec


def test_router_binds_realize_symbol_and_explains_it():
    spec = build_design_router_spec()
    assert "realize_symbol" in spec.tools
    assert "realize_symbol" in spec.body


def test_router_binds_visual_compose_tools():
    spec = build_design_router_spec()
    for name in ("generate_asset", "add_sprite", "list_assets", "generate_and_place"):
        assert name in spec.tools


def test_router_compose_branch_routes_to_compose_scene():
    """Branch 4 (build/compose the scene) routes the whole build into the
    deterministic compose_scene orchestrator with an ordered `elements` list —
    NOT a series of bare generate_and_place calls (the loop discipline lives in
    code, not skippable prose)."""
    spec = build_design_router_spec()
    assert "compose_scene" in spec.tools
    body = spec.body
    low = body.lower()
    assert "compose_scene" in body
    # it hands the whole build list to the orchestrator, one entry per element
    assert "elements" in low
    assert "single `compose_scene` call" in body or "a single `compose_scene`" in body.lower()
    # still steers builds element-by-element (the orchestrator owns the loop)
    assert "one entry per element" in low or "in order" in low


def test_router_body_documents_visual_compose_branch():
    body = build_design_router_spec().body
    assert "add_sprite" in body
    assert "fit" in body
    assert "background" in body and "logo" in body
    # existing branches still present
    assert "set_gdd_fields" in body and "realize_symbol" in body


def test_router_body_guides_backgrounds_to_be_text_free():
    """Backgrounds must be prompted as text-free scenery and kept out of 'slot game
    title' framing — the image model otherwise bakes garbled titles into the background
    (observed: logo text rendered into a pirate background). Wordmarks belong to the logo
    asset, not the background."""
    low = build_design_router_spec().body.lower()
    assert "no text" in low
    assert "no words" in low or "no typography" in low or "no lettering" in low


def test_router_binds_regenerate_element():
    spec = build_design_router_spec()
    assert "regenerate_element" in spec.tools
    assert "regenerate_element" in spec.body


def test_router_regenerate_branch_replaces_in_place_not_duplicate():
    low = build_design_router_spec().body.lower()
    # routes fix/redo/regenerate to the in-place tool
    assert "regenerate_element" in low
    assert "in place" in low
    # explicitly steers away from adding a duplicate via generate_and_place
    assert "already in the scene" in low or "already on screen" in low
    assert "duplicate" in low


def test_router_binds_read_scene():
    spec = build_design_router_spec()
    assert "read_scene" in spec.tools
    assert "read_scene" in spec.body


def test_router_replace_uses_read_scene_to_target_then_regenerates_in_place():
    low = build_design_router_spec().body.lower()
    # "replace … with a new look" is handled as an in-place regenerate
    assert "replace" in low
    assert "regenerate_element" in low
    # the agent reads the scene to resolve which element (incl. a positional ref)
    assert "read_scene" in low
    assert "on the left" in low
    # branch 4 still warns against duplicating something already placed
    assert "duplicate" in low


def test_router_binds_adjust_element_for_layout_edits():
    spec = build_design_router_spec()
    assert "adjust_element" in spec.tools
    body = spec.body.lower()
    assert "adjust_element" in body
    # branch 5 must distinguish a pure layout change from an art regenerate
    assert "move" in body or "reposition" in body or "resize" in body
