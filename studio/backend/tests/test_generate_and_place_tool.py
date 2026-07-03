"""Tests for the combined `generate_and_place` tool.

It generates one element's art and immediately places it into the live scene as a
sprite — the atomic per-element verb branch 4 of the design-router uses so a scene
visibly builds up element-by-element. Mirrors test_add_sprite_tool.py for the
placement assertions and adds the generate + reuse paths.
"""
import pytest
from datetime import datetime, timezone

from app.agent_tools import (
    ToolContext, ToolFactory, build_generate_and_place_tool,
)
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


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


class _GeneratingAssetStore:
    """Simulates create_asset -> (hub generates) -> get_asset returning a selected image."""
    def __init__(self):
        self.created = []
        self._by_id: dict[str, Asset] = {}
        self._by_slot: dict[str, Asset] = {}

    def seed(self, asset: Asset):
        self._by_id[asset.id] = asset
        if asset.slot:
            self._by_slot[asset.slot] = asset

    async def create_asset(self, game_id, name, prompt, width, height, workflow, slot=None, params=None):
        asset = Asset(
            id=f"a{len(self.created) + 1}", game_id=game_id, name=name, prompt=prompt,
            width=width, height=height, workflow=workflow, slot=slot,
            params=params,
            generations=[], selected_generation_id=None,
        )
        self.created.append(asset)
        self.seed(asset)
        return asset

    async def get_asset(self, asset_id):
        return self._by_id.get(asset_id)

    async def get_by_slot(self, game_id, slot):
        return self._by_slot.get(slot)


class _FakeAssetHub:
    """Stands in for the real asset hub: 'generating' an asset gives it a selected image."""
    def __init__(self, store: _GeneratingAssetStore):
        self._store = store
        self.calls = []

    async def generate_and_wait(self, game_id, asset_id):
        self.calls.append(asset_id)
        asset = self._store._by_id[asset_id]
        gen = Generation(id="gen1", seed=1,
                         image_ref=f"/media/{game_id}/{asset_id}/img.png",
                         created_at=datetime.now(timezone.utc))
        asset.generations.append(gen)
        asset.selected_generation_id = gen.id


@pytest.mark.asyncio
async def test_generate_and_place_generates_then_places_one_element(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    assets = _GeneratingAssetStore()
    asset_hub = _FakeAssetHub(assets)
    ctx = ToolContext("r1", "g1", assets, asset_hub, scene_store=store, scene_hub=hub)

    out = await build_generate_and_place_tool(ctx).ainvoke(
        {"description": "neon skyline", "slot": "background", "role": "background",
         "size": "1280x720", "transparent": False, "fit": "cover", "z_index": 0})

    # generated exactly once, then placed in the SAME call
    assert asset_hub.calls == ["a1"]
    assert "Generated" in out and "background" in out

    doc = await store.get_document("g1")
    assert unreachable_nodes(doc) == []  # sprite reaches the auto-created root
    data_edges = [e for e in doc["edges"] if e["type"] == "data"
                  and e["to"]["node"] == "spr.background"]
    assert data_edges and data_edges[0]["from"]["node"] == "tex.background"
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_generate_and_place_reuses_existing_slot_without_regenerating(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    assets = _GeneratingAssetStore()
    assets.seed(_asset(slot="logo", width=768, height=512, id="a9", ref="/media/g/a/logo.png"))
    asset_hub = _FakeAssetHub(assets)
    ctx = ToolContext("r1", "g1", assets, asset_hub, scene_store=store, scene_hub=hub)

    out = await build_generate_and_place_tool(ctx).ainvoke(
        {"description": "ignored — slot already has art", "slot": "logo",
         "role": "logo", "y": 0, "anchor_y": 0})

    assert asset_hub.calls == []   # did NOT regenerate
    assert assets.created == []    # no new asset created
    assert "Reused" in out and "logo" in out

    doc = await store.get_document("g1")
    assert "spr.logo" in doc["nodes"]
    assert unreachable_nodes(doc) == []
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_generate_and_place_no_image_after_generation_places_nothing(mongo_db):
    """If generation yields no selected image, place nothing and say so plainly."""
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)

    class _NoImageHub(_FakeAssetHub):
        async def generate_and_wait(self, game_id, asset_id):
            self.calls.append(asset_id)  # ran, but produced no selected generation

    assets = _GeneratingAssetStore()
    asset_hub = _NoImageHub(assets)
    ctx = ToolContext("r1", "g1", assets, asset_hub, scene_store=store, scene_hub=hub)

    out = await build_generate_and_place_tool(ctx).ainvoke(
        {"description": "broken gen", "slot": "background"})

    assert "no image" in out.lower()
    doc = await store.get_document("g1")
    assert doc is None or "spr.background" not in doc.get("nodes", {})
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_generate_and_place_uses_dev_workflow_and_role_params(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    assets = _GeneratingAssetStore()
    asset_hub = _FakeAssetHub(assets)
    ctx = ToolContext("r1", "g1", assets, asset_hub, scene_store=store, scene_hub=hub)

    await build_generate_and_place_tool(ctx).ainvoke(
        {"description": 'wordmark "AI"', "role": "logo", "transparent": True, "slot": "logo"})

    asset = await assets.get_by_slot("g1", "logo")
    assert asset.workflow == "dev-transparent"
    assert asset.params is not None and asset.params.cfg == 2.0        # logo profile
    assert asset.params.negative != ""
    assert "legible" in asset.prompt.lower()                          # role boilerplate folded in
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_generate_and_place_opaque_selects_dev_opaque(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    assets = _GeneratingAssetStore()
    asset_hub = _FakeAssetHub(assets)
    ctx = ToolContext("r1", "g1", assets, asset_hub, scene_store=store, scene_hub=hub)

    await build_generate_and_place_tool(ctx).ainvoke(
        {"description": "a graveyard", "role": "background", "transparent": False,
         "slot": "bg", "fit": "cover", "z_index": 0})

    asset = await assets.get_by_slot("g1", "bg")
    assert asset.workflow == "dev-opaque"
    assert asset.params.upscale is True                              # background is a hero role
    await mongo_db["game_scenes"].delete_many({})


def test_factory_registers_generate_and_place():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "generate_and_place" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["generate_and_place"], ctx)[0].name == "generate_and_place"
