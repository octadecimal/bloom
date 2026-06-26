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
