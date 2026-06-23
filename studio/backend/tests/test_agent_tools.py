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
    assert f.known_tool_names() == {"generate_asset", "list_assets"}


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
async def test_generate_asset_size_and_opaque(mongo_db):
    store = AssetStore(mongo_db)
    hub = FakeHub(store)
    factory = ToolFactory(store, hub)
    ctx = ToolContext("r1", "g1", store, hub)
    tool = factory.build(["generate_asset"], ctx)[0]
    await tool.ainvoke({"description": "a forest", "size": "1024x576", "transparent": False})
    asset = (await store.list_assets("g1"))[0]
    assert (asset.width, asset.height) == (1024, 576)
    assert asset.workflow == "schnell-opaque"


@pytest.mark.asyncio
async def test_generate_asset_defaults_unchanged(mongo_db):
    store = AssetStore(mongo_db)
    factory = ToolFactory(store, FakeHub(store))
    ctx = ToolContext("r1", "g1", store, store and FakeHub(store))
    tool = factory.build(["generate_asset"], ctx)[0]
    await tool.ainvoke({"description": "a knight"})
    asset = (await store.list_assets("g1"))[0]
    assert (asset.width, asset.height) == (512, 512)
    assert asset.workflow == "schnell-transparent"


@pytest.mark.asyncio
async def test_build_filters_to_allowlist(mongo_db):
    store = AssetStore(mongo_db)
    factory = ToolFactory(store, FakeHub(store))
    ctx = ToolContext("r1", "g1", store, FakeHub(store))
    assert factory.build([], ctx) == []


from app.agent_tools import build_list_assets_tool


class _Asset:
    def __init__(self, id, name, category):
        self.id, self.name, self.category = id, name, category


class _ListStore:
    def __init__(self, assets):
        self._assets = assets
    async def list_assets(self, game_id):
        assert game_id == "g1"
        return self._assets


@pytest.mark.asyncio
async def test_list_assets_returns_id_name_category_summary():
    store = _ListStore([_Asset("a1", "knight", "sprite"), _Asset("a2", "sky", None)])
    tool = build_list_assets_tool(ToolContext("r1", "g1", store, None))
    out = await tool.ainvoke({})
    assert "a1" in out and "knight" in out and "sprite" in out
    assert "a2" in out and "sky" in out
