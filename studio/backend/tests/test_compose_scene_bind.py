import pytest

from app.scene.layout.plan import ScenePlan
from app.agent_tools import _plan_for_game, ToolContext


class _Doc:
    def __init__(self, data):
        self.data = data


class _FakeGdd:
    def __init__(self, docs):
        self._docs = docs

    async def get_doc(self, game_id, aspect):
        d = self._docs.get(aspect)
        return _Doc(d) if d is not None else None


@pytest.mark.asyncio
async def test_plan_for_game_binds_from_gdd_intent():
    ctx = ToolContext(room_id="r", game_id="g", asset_store=None, asset_hub=None,
                      gdd_store=_FakeGdd({"ui-ux": {"orientation": "portrait"}}))
    plan = await _plan_for_game(ctx)
    assert isinstance(plan, ScenePlan)
    assert plan.canvas == (720, 1280)        # portrait from GDD intent
    assert plan.orientation == "portrait"


@pytest.mark.asyncio
async def test_plan_for_game_defaults_without_gdd():
    ctx = ToolContext(room_id="r", game_id="g", asset_store=None, asset_hub=None,
                      gdd_store=_FakeGdd({}))
    plan = await _plan_for_game(ctx)
    assert plan.canvas == (1280, 720)        # default landscape
