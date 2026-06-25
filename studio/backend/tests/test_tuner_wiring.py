from app.config import Settings
from app.main import build


def test_build_wires_tuner_routes_and_state():
    ctx = build(Settings())
    app = ctx.fastapi_app
    paths = set(app.openapi()["paths"].keys())
    assert "/games/{game_id}/tuner" in paths
    assert "/games/{game_id}/tuner/tune" in paths
    assert "/games/{game_id}/tuner/apply" in paths
    assert hasattr(app.state, "tuner_store")
    assert hasattr(app.state, "tuner_hub")


def test_settings_has_tuner_bin():
    assert hasattr(Settings(), "tuner_bin")
