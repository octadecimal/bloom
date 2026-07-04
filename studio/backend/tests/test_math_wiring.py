from app.config import Settings
from app.main import build


def test_math_wiring_exposes_unified_state_and_routes():
    ctx = build(Settings(provider_mode="replay", mongo_db="bloom_studio_test"))
    app = ctx.fastapi_app
    assert app.state.math_store is not None
    assert app.state.math_hub is not None
    assert app.state.math_run_store is not None
    for legacy in ("sim_store", "sim_hub", "tuner_store", "tuner_hub", "analytics_hub"):
        assert not hasattr(app.state, legacy)
    # app.routes entries are lazy _IncludedRouter proxies on this FastAPI version
    # (no .path until resolved) — the OpenAPI schema is the flattened, effective
    # route table, so read paths from there instead.
    paths = set(app.openapi()["paths"].keys())
    for p in ("/games/{game_id}/slot-model", "/games/{game_id}/slot-model/curate",
              "/games/{game_id}/tuner",
              "/games/{game_id}/tuner/apply", "/analytics/runs",
              "/slot-model/templates",
              "/games/{game_id}/slot-model/apply-template",
              "/games/{game_id}/math/generate"):
        assert p in paths, p
