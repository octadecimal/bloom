from app.gdd.router import build_design_router_spec, DESIGN_ROUTER_NAME
from app.gdd.models import GDD_TOOL_NAMES


def test_router_spec_binds_gdd_tools():
    spec = build_design_router_spec()
    assert spec.name == DESIGN_ROUTER_NAME
    # GDD tools are all present; realize_symbol is also bound for symbol reshapes
    assert GDD_TOOL_NAMES <= set(spec.tools)
    assert "realize_symbol" in spec.tools
    assert spec.args == []


def test_router_spec_seeds_field_catalog_into_prompt():
    body = build_design_router_spec().body
    # addressable surface: aspects, field keys, types, the routing tools
    assert "math-model" in body
    assert "bonus_hit_rate" in body and "ratio" in body
    assert "set_gdd_fields" in body and "ask_user_question" in body
    # disambiguation discipline is stated
    assert "ambiguous" in body.lower()


def test_router_tools_are_a_subset_of_the_real_tool_universe():
    # The router spec must only reference tools the ToolFactory can build,
    # otherwise TurnRunner could not assemble it.
    from app.agent_tools import ToolFactory
    known = ToolFactory(None, None).known_tool_names()
    assert set(build_design_router_spec().tools) <= known
