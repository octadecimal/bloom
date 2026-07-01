import pytest
from types import SimpleNamespace

from app.scene.layout.overrides import RegionOverride, RegionOverrideStore
from app.scene.override_rebuild import (
    set_override_and_rebuild, clear_override_and_rebuild, override_view,
)


@pytest.mark.asyncio
async def test_set_override_unknown_role_returns_none(mongo_db):
    state = SimpleNamespace(region_override_store=RegionOverrideStore(mongo_db))
    assert await set_override_and_rebuild(state, "g1", "nonsense", RegionOverride(x=1.0)) is None


@pytest.mark.asyncio
async def test_set_override_persists_even_when_rebuild_is_noop(mongo_db):
    # no critics/scene wired -> rebuild is a no-op (None), but the override must persist
    store = RegionOverrideStore(mongo_db)
    state = SimpleNamespace(region_override_store=store)
    result = await set_override_and_rebuild(state, "g1", "reel_frame", RegionOverride(x=77.0))
    assert result is None
    assert (await store.get("g1"))["reels"].x == 77.0  # canonicalized + stored


@pytest.mark.asyncio
async def test_clear_override_removes_it(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=5.0))
    state = SimpleNamespace(region_override_store=store)
    await clear_override_and_rebuild(state, "g1", "reels")
    assert "reels" not in await store.get("g1")


@pytest.mark.asyncio
async def test_override_view_shows_plan_defaults_and_overrides(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=99.0))
    state = SimpleNamespace(region_override_store=store, gdd_store=None)
    view = await override_view(state, "g1")
    assert view["canvas"] == [1280, 720]
    assert "reels" in view["plan"] and "region_w" in view["plan"]["reels"]
    assert view["overrides"]["reels"] == {"x": 99.0}
