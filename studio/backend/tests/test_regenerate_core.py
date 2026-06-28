import pytest
from datetime import datetime, timezone

from app.agent_tools import ToolContext, _regenerate_and_rebind
from app.assets.models import Asset, Generation


def _asset_with_two_gens():
    return Asset(
        id="a1", game_id="g1", name="Seaweed", prompt="old prompt",
        width=512, height=512, workflow="schnell-transparent", slot="seaweed",
        generations=[
            Generation(id="gen1", seed=1, image_ref="/media/g1/a1/old.png",
                       created_at=datetime.now(timezone.utc)),
            Generation(id="gen2", seed=2, image_ref="/media/g1/a1/new.png",
                       created_at=datetime.now(timezone.utc)),
        ],
        selected_generation_id="gen1",
    )


class _AssetStore:
    def __init__(self, asset):
        self._asset = asset
        self.updated = None
        self.selected = None
    async def update_asset(self, asset_id, **fields):
        self.updated = fields
        return None
    async def get_asset(self, asset_id):
        return self._asset
    async def select_generation(self, asset_id, gen_id):
        self.selected = gen_id
        self._asset.selected_generation_id = gen_id  # re-read reflects selection
        return self._asset


class _SceneStore:
    def __init__(self, document):
        self._document = document
    async def get_document(self, game_id):
        return self._document


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append(op)
        return None


def _doc(tex_id="tex.seaweed", asset_id="a1"):
    return {"version": 1, "nodes": {tex_id: {"id": tex_id, "type": "Texture",
            "props": {"src": "/media/g1/a1/old.png", "assetId": asset_id}}}, "edges": []}


class _NoImageStore(_AssetStore):
    async def get_asset(self, asset_id):
        return None


class _AssetHub:
    def __init__(self):
        self.calls = []
    async def generate_and_wait(self, game_id, asset_id):
        self.calls.append(asset_id)


@pytest.mark.asyncio
async def test_core_regenerates_selects_newest_and_rewrites_texture():
    asset = _asset_with_two_gens()
    store, hub, shub = _AssetStore(asset), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", store, hub, scene_store=_SceneStore(_doc()), scene_hub=shub)

    ref = await _regenerate_and_rebind(
        ctx, asset=asset, texture_id="tex.seaweed", new_prompt="fresh seaweed")

    assert ref == "/media/g1/a1/new.png"
    assert store.updated == {"prompt": "fresh seaweed"}
    assert hub.calls == ["a1"]
    assert store.selected == "gen2"
    assert shub.ops == [{"kind": "setProp", "id": "tex.seaweed", "path": "src",
                         "value": "/media/g1/a1/new.png"}]


@pytest.mark.asyncio
async def test_core_skips_setprop_when_texture_is_none():
    asset = _asset_with_two_gens()
    store, hub, shub = _AssetStore(asset), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", store, hub, scene_store=_SceneStore(_doc()), scene_hub=shub)

    ref = await _regenerate_and_rebind(
        ctx, asset=asset, texture_id=None, new_prompt=None)

    assert ref == "/media/g1/a1/new.png"
    assert store.updated is None                    # new_prompt falsy -> no prompt update
    assert store.selected == "gen2"
    assert shub.ops == []                           # no scene write when no texture


@pytest.mark.asyncio
async def test_core_returns_none_when_no_image():
    asset = _asset_with_two_gens()
    store, hub, shub = _NoImageStore(asset), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", store, hub, scene_store=_SceneStore(_doc()), scene_hub=shub)

    ref = await _regenerate_and_rebind(
        ctx, asset=asset, texture_id="tex.seaweed", new_prompt="x")

    assert ref is None
    assert shub.ops == []                           # scene untouched
