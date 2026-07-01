import pytest

from app.agent_tools import ToolContext, _plan_for_game
from app.scene.layout.overrides import RegionOverride, RegionOverrideStore


@pytest.mark.asyncio
async def test_plan_for_game_applies_stored_overrides(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=123.0))
    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      gdd_store=None, region_override_store=store)
    plan = await _plan_for_game(ctx)
    assert plan.for_role("reels").x == 123.0


@pytest.mark.asyncio
async def test_plan_for_game_without_store_is_plain_bind(mongo_db):
    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      gdd_store=None)  # no override store
    plan = await _plan_for_game(ctx)
    assert plan.for_role("reels") is not None  # falls back to template defaults
