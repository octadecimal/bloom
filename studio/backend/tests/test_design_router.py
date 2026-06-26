from app.gdd.router import build_design_router_spec


def test_router_binds_realize_symbol_and_explains_it():
    spec = build_design_router_spec()
    assert "realize_symbol" in spec.tools
    assert "realize_symbol" in spec.body


def test_router_binds_visual_compose_tools():
    spec = build_design_router_spec()
    for name in ("generate_asset", "add_sprite", "list_assets"):
        assert name in spec.tools


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
