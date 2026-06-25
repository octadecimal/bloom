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
    assert f.known_tool_names() == {
        "generate_asset", "list_assets", "delete_asset",
        "list_gdd_docs", "read_gdd_doc", "set_gdd_fields",
        "set_doc_status", "ask_user_question",
        "scene_add_node", "scene_set_prop", "scene_connect",
        "scene_disconnect", "scene_remove_node", "scene_apply_batch",
    }


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


from app.agent_tools import build_delete_asset_tool
import app.agent_tools as agent_tools


class _DelStore:
    def __init__(self, asset):
        self._asset = asset
        self.deleted = []
    async def get_asset(self, asset_id):
        return self._asset if (self._asset and self._asset.id == asset_id) else None
    async def delete_asset(self, asset_id):
        self.deleted.append(asset_id)


class _DelHub:
    def __init__(self): self.notified = []
    async def notify_deleted(self, g, a): self.notified.append((g, a))


@pytest.mark.asyncio
async def test_delete_asset_approve_deletes_and_notifies(monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "approve")
    store = _DelStore(_Asset("a1", "knight", "sprite"))
    hub = _DelHub()
    tool = build_delete_asset_tool(ToolContext("r1", "g1", store, hub))
    out = await tool.ainvoke({"asset_id": "a1"})
    assert store.deleted == ["a1"]
    assert hub.notified == [("g1", "a1")]
    assert "knight" in out


@pytest.mark.asyncio
async def test_delete_asset_deny_does_not_delete(monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "deny")
    store = _DelStore(_Asset("a1", "knight", "sprite"))
    hub = _DelHub()
    tool = build_delete_asset_tool(ToolContext("r1", "g1", store, hub))
    out = await tool.ainvoke({"asset_id": "a1"})
    assert store.deleted == []
    assert hub.notified == []
    assert "denied" in out.lower()


@pytest.mark.asyncio
async def test_delete_asset_unknown_id_returns_not_found_without_interrupt(monkeypatch):
    def _boom(payload):
        raise AssertionError("interrupt must not be called for unknown asset")
    monkeypatch.setattr(agent_tools, "interrupt", _boom)
    store = _DelStore(None)
    tool = build_delete_asset_tool(ToolContext("r1", "g1", store, _DelHub()))
    out = await tool.ainvoke({"asset_id": "missing"})
    assert "not found" in out.lower()
    assert store.deleted == []


class _Gen:
    def __init__(self, id, image_ref):
        self.id, self.image_ref = id, image_ref


class _AssetWithGen:
    def __init__(self, id, name, category, selected_generation_id, generations):
        self.id, self.name, self.category = id, name, category
        self.selected_generation_id = selected_generation_id
        self.generations = generations


@pytest.mark.asyncio
async def test_list_assets_includes_selected_generation_media_path():
    asset = _AssetWithGen("a1", "knight", "sprite", "g2",
                          [_Gen("g1", "/media/x/a1/g1.png"), _Gen("g2", "/media/x/a1/g2.png")])
    tool = build_list_assets_tool(ToolContext("r1", "g1", _ListStore([asset]), None))
    out = await tool.ainvoke({})
    assert "/media/x/a1/g2.png" in out  # the SELECTED generation's path
    assert "/media/x/a1/g1.png" not in out


@pytest.mark.asyncio
async def test_list_assets_marks_assets_without_a_generation():
    asset = _AssetWithGen("a2", "sky", None, None, [])
    tool = build_list_assets_tool(ToolContext("r1", "g1", _ListStore([asset]), None))
    out = await tool.ainvoke({})
    assert "a2" in out and "no image yet" in out.lower()


from app.agent_tools import build_generate_asset_tool


class _RecordingAssetStore:
    def __init__(self):
        self.created = None
    async def create_asset(self, game_id, name, prompt, width, height, workflow, slot=None):
        from app.assets.models import Asset
        self.created = {"slot": slot, "name": name}
        return Asset(id="a1", game_id=game_id, name=name, prompt=prompt,
                     width=width, height=height, workflow=workflow, slot=slot)


class _NoopAssetHub:
    async def generate_and_wait(self, game_id, asset_id):
        return None


@pytest.mark.asyncio
async def test_generate_asset_passes_slot():
    store = _RecordingAssetStore()
    ctx = ToolContext("r1", "g1", store, _NoopAssetHub())
    tool = build_generate_asset_tool(ctx)
    await tool.ainvoke({"description": "a raven", "transparent": True, "slot": "high1"})
    assert store.created["slot"] == "high1"
