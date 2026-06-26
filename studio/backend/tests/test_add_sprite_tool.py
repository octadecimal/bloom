import asyncio
import pytest
from datetime import datetime, timezone

from app.agent_tools import ToolContext, ToolFactory, build_add_sprite_tool
from app.assets.models import Asset, Generation
from app.scene.document import unreachable_nodes
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


def _asset(slot="background", width=1280, height=720, ref="/media/g/a/bg.png", id="a1"):
    return Asset(
        id=id, game_id="g1", name=slot.title(), prompt="p",
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


class _MultiAssetStore:
    def __init__(self, assets):
        self._by_slot = {a.slot: a for a in assets}
        self._by_id = {a.id: a for a in assets}
    async def get_by_slot(self, game_id, slot):
        return self._by_slot.get(slot)
    async def get_asset(self, asset_id):
        return self._by_id.get(asset_id)


class _RecordingHub:
    def __init__(self, existing_root_canvas=None):
        self.batches = []
        self._roots: dict[str, dict] = {}
        self._existing_root_canvas = existing_root_canvas
    async def ensure_root(self, game_id, canvas):
        # Mirror the real hub: a pre-existing Root's dims win over the default;
        # otherwise create+remember a root keyed by game (idempotent).
        info = self._roots.get(game_id)
        if info is None:
            seed = self._existing_root_canvas or canvas
            info = {"root_id": "root", "canvas": (int(seed[0]), int(seed[1]))}
            self._roots[game_id] = info
        return info
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
    # an existing Root (800x600) supplies the canvas via the hub's ensure_root
    hub = _RecordingHub(existing_root_canvas=(800, 600))
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
    # Root is now created via the hub's lock-held ensure_root, not inside the
    # sprite batch — the batch must NOT carry an addNode root op.
    assert hub._roots.get("g1") == {"root_id": "root", "canvas": (1280, 720)}
    ops = hub.batches[0]
    assert not any(o.get("type") == "Root" for o in ops)
    assert ops[0]["id"] == "spr.background"


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


@pytest.mark.asyncio
async def test_concurrent_add_sprite_into_empty_scene_keeps_both(mongo_db):
    """Two add_sprite calls in one turn (asyncio.gather) against an empty scene
    must each persist their own sprite, share ONE Root, and orphan nothing.

    Regression: the old code read the empty doc OUTSIDE the hub lock, so both
    calls set ensure_root=True and both emitted `addNode root`; the second batch
    was rejected on the duplicate Root id, silently dropping its sprite.
    """
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)

    class _SilentSio:
        async def emit(self, *a, **k): ...
        async def enter_room(self, *a, **k): ...

    hub = GameSceneHub(_SilentSio(), store)
    assets = _MultiAssetStore([
        _asset(slot="background", id="a1", ref="/media/g/a/bg.png"),
        _asset(slot="logo", width=768, height=512, id="a2", ref="/media/g/a/logo.png"),
    ])
    ctx = ToolContext("r1", "g1", assets, None, scene_store=store, scene_hub=hub)
    tool = build_add_sprite_tool(ctx)

    await asyncio.gather(
        tool.ainvoke({"slot": "background", "role": "background", "fit": "cover"}),
        tool.ainvoke({"slot": "logo", "role": "logo", "y": 0, "anchor_y": 0}),
    )

    doc = await store.get_document("g1")
    nodes = doc["nodes"]
    assert "spr.background" in nodes and "spr.logo" in nodes
    roots = [nid for nid, n in nodes.items() if n["type"] == "Root"]
    assert roots == ["root"]  # exactly one Root
    assert unreachable_nodes(doc) == []
    await mongo_db["game_scenes"].delete_many({})


def test_factory_registers_add_sprite():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "add_sprite" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["add_sprite"], ctx)[0].name == "add_sprite"
