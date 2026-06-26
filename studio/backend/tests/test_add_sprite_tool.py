import pytest
from datetime import datetime, timezone

from app.agent_tools import ToolContext, ToolFactory, build_add_sprite_tool
from app.assets.models import Asset, Generation
from app.scene.document import unreachable_nodes
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


def _asset(slot="background", width=1280, height=720, ref="/media/g/a/bg.png"):
    return Asset(
        id="a1", game_id="g1", name=slot.title(), prompt="p",
        width=width, height=height, workflow="schnell-opaque", slot=slot,
        generations=[Generation(id="gen1", seed=1, image_ref=ref,
                                 created_at=datetime.now(timezone.utc))],
        selected_generation_id="gen1",
    )


class _AssetStore:
    def __init__(self, asset):
        self._asset = asset
    async def get_by_slot(self, game_id, slot):
        return self._asset if (self._asset and self._asset.slot == slot) else None
    async def get_asset(self, asset_id):
        return self._asset if (self._asset and self._asset.id == asset_id) else None


class _RecordingHub:
    def __init__(self):
        self.batches = []
    async def apply_batch(self, game_id, ops):
        self.batches.append(ops)
        return {"version": 1, "nodes": {}, "edges": []}


class _EmptySceneStore:
    async def get_document(self, game_id):
        return None


class _RootSceneStore:
    async def get_document(self, game_id):
        return {"version": 1,
                "nodes": {"root": {"id": "root", "type": "Root",
                                   "props": {"width": 800, "height": 600}}},
                "edges": []}


@pytest.mark.asyncio
async def test_add_sprite_resolves_by_slot_and_applies_one_batch():
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=_RootSceneStore(), scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke(
        {"slot": "background", "role": "background", "fit": "cover", "z_index": 0})
    assert len(hub.batches) == 1
    ops = hub.batches[0]
    ids = [o.get("id") or o.get("edgeId") for o in ops]
    assert "spr.background" in ids and "tex.background" in ids
    # canvas came from the existing Root (800x600), not the default
    sprite = next(o for o in ops if o.get("id") == "spr.background")
    assert sprite["props"]["position"] == {"x": 400.0, "y": 300.0}
    assert "Placed" in out


@pytest.mark.asyncio
async def test_add_sprite_creates_root_when_scene_empty():
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=_EmptySceneStore(), scene_hub=hub)
    await build_add_sprite_tool(ctx).ainvoke({"slot": "background"})
    ops = hub.batches[0]
    assert ops[0] == {"kind": "addNode", "id": "root", "type": "Root",
                      "props": {"width": 1280, "height": 720}}


@pytest.mark.asyncio
async def test_add_sprite_unknown_slot_returns_friendly_error_no_batch():
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(None), None,
                      scene_store=_EmptySceneStore(), scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke({"slot": "ghost"})
    assert "ghost" in out and "generate" in out.lower()
    assert hub.batches == []


@pytest.mark.asyncio
async def test_add_sprite_no_image_yet_returns_error_no_batch():
    asset = _asset()
    asset.selected_generation_id = None  # generated record but no selected image
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(asset), None,
                      scene_store=_EmptySceneStore(), scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke({"slot": "background"})
    assert "no image yet" in out.lower()
    assert hub.batches == []


@pytest.mark.asyncio
async def test_add_sprite_requires_slot_or_asset_id():
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=_EmptySceneStore(), scene_hub=_RecordingHub())
    out = await build_add_sprite_tool(ctx).ainvoke({})
    assert "slot" in out.lower() and "asset_id" in out.lower()


@pytest.mark.asyncio
async def test_add_sprite_against_real_store_renders_a_parented_bound_sprite(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)

    class _SilentSio:
        async def emit(self, *a, **k): ...
        async def enter_room(self, *a, **k): ...

    hub = GameSceneHub(_SilentSio(), store)
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=store, scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke(
        {"slot": "background", "role": "background", "fit": "cover"})
    assert "not parented" not in out.lower()  # sprite reaches the auto-created root

    doc = await store.get_document("g1")
    assert unreachable_nodes(doc) == []  # nothing orphaned
    # the sprite is bound to its texture via a data edge
    data_edges = [e for e in doc["edges"] if e["type"] == "data"
                  and e["to"]["node"] == "spr.background"]
    assert data_edges and data_edges[0]["from"]["node"] == "tex.background"
    await mongo_db["game_scenes"].delete_many({})


def test_factory_registers_add_sprite():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "add_sprite" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["add_sprite"], ctx)[0].name == "add_sprite"
