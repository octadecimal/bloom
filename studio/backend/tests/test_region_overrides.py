import pytest

from app.scene.layout.overrides import RegionOverride, RegionOverrideStore


def test_as_set_fields_drops_none():
    assert RegionOverride(x=10.0, region_w=200).as_set_fields() == {"x": 10.0, "region_w": 200}
    assert RegionOverride().as_set_fields() == {}


@pytest.mark.asyncio
async def test_set_get_roundtrip(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=100.0, region_w=300))
    got = await store.get("g1")
    assert got["reels"].x == 100.0 and got["reels"].region_w == 300
    assert got["reels"].y is None


@pytest.mark.asyncio
async def test_set_role_merges_fields(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=100.0))
    await store.set_role("g1", "reels", RegionOverride(y=50.0))
    got = (await store.get("g1"))["reels"]
    assert (got.x, got.y) == (100.0, 50.0)  # x survives the second write


@pytest.mark.asyncio
async def test_clear_role_removes_only_that_role(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=1.0))
    await store.set_role("g1", "logo", RegionOverride(y=2.0))
    await store.clear_role("g1", "reels")
    got = await store.get("g1")
    assert "reels" not in got and got["logo"].y == 2.0


@pytest.mark.asyncio
async def test_get_missing_game_is_empty(mongo_db):
    assert await RegionOverrideStore(mongo_db).get("nope") == {}
