from app.gdd.router import build_design_router_spec


def test_router_binds_realize_symbol_and_explains_it():
    spec = build_design_router_spec()
    assert "realize_symbol" in spec.tools
    assert "realize_symbol" in spec.body
