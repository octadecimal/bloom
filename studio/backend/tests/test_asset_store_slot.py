import pytest
from app.assets.store import AssetStore


@pytest.mark.asyncio
async def test_create_with_slot_and_lookup(mongo_db):
    store = AssetStore(mongo_db)
    created = await store.create_asset(
        "g1", "High Symbol", "a raven", 512, 512, "schnell-transparent", slot="high1"
    )
    assert created.slot == "high1"
    found = await store.get_by_slot("g1", "high1")
    assert found is not None and found.id == created.id
    assert await store.get_by_slot("g1", "nope") is None
