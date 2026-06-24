from app.config import Settings
from app.main import build


def test_build_wires_simulator_routes_and_state():
    ctx = build(Settings())
    app = ctx.fastapi_app
    paths = set(app.openapi()["paths"].keys())
    assert "/games/{game_id}/slot-model" in paths
    assert "/games/{game_id}/slot-model/curate" in paths
    assert hasattr(app.state, "sim_store")


def test_settings_has_simulator_bin():
    assert hasattr(Settings(), "simulator_bin")
