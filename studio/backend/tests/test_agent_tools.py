import pytest

from app.agent_tools import ToolContext, ToolFactory
from app.assets.store import AssetStore


class FakeHub:
    def __init__(self, store):
        self._store = store
        self.calls = []

    async def generate_and_wait(self, game_id, asset_id):
        self.calls.append((game_id, asset_id))
        await self._store.add_generation(asset_id, "gen1", 7, "g1/asset/gen1.png")


async def test_known_tool_names():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert f.known_tool_names() == {"generate_asset"}


@pytest.mark.asyncio
async def test_generate_asset_creates_and_attaches(mongo_db):
    store = AssetStore(mongo_db)
    hub = FakeHub(store)
    factory = ToolFactory(store, hub)
    ctx = ToolContext(room_id="r1", game_id="g1", asset_store=store, asset_hub=hub)
    tools = factory.build(["generate_asset"], ctx)
    assert [t.name for t in tools] == ["generate_asset"]
    result = await tools[0].ainvoke({"description": "a knight", "style": "pixel"})
    assets = await store.list_assets("g1")
    assert len(assets) == 1 and assets[0].status == "done"
    assert assets[0].id in result and hub.calls == [("g1", assets[0].id)]


@pytest.mark.asyncio
async def test_build_filters_to_allowlist(mongo_db):
    store = AssetStore(mongo_db)
    factory = ToolFactory(store, FakeHub(store))
    ctx = ToolContext("r1", "g1", store, FakeHub(store))
    assert factory.build([], ctx) == []
