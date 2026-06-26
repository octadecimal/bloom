import pytest
from datetime import datetime, timezone

from app.agent_tools import (
    ToolContext, ToolFactory, build_regenerate_element_tool,
)
from app.assets.models import Asset, Generation


def _seaweed_doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.seaweed": {"id": "spr.seaweed", "type": "Sprite",
                            "props": {"role": "prop", "position": {"x": 640, "y": 720},
                                      "scale": {"x": 1, "y": 1}, "zIndex": 2}},
            "tex.seaweed": {"id": "tex.seaweed", "type": "Texture",
                            "props": {"src": "/media/g1/a1/old.png"}},
        },
        "edges": [
            {"id": "c2", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.seaweed", "port": "parent"}},
            {"id": "d2", "type": "data", "from": {"node": "tex.seaweed", "port": "data"},
             "to": {"node": "spr.seaweed", "port": "texture"}},
        ],
    }


def _seaweed_asset():
    return Asset(
        id="a1", game_id="g1", name="Seaweed", prompt="old", width=512, height=512,
        workflow="schnell-transparent", slot="seaweed",
        generations=[Generation(id="gen1", seed=1, image_ref="/media/g1/a1/old.png",
                                created_at=datetime.now(timezone.utc))],
        selected_generation_id="gen1",
    )


class _Assets:
    def __init__(self, asset):
        self._asset = asset
        self.updated = None
        self.selected = None
    async def list_assets(self, game_id):
        return [self._asset]
    async def get_by_slot(self, game_id, slot):
        return self._asset if slot == self._asset.slot else None
    async def get_asset(self, asset_id):
        return self._asset
    async def update_asset(self, asset_id, **fields):
        self.updated = fields
        return None
    async def select_generation(self, asset_id, gen_id):
        self.selected = gen_id
        return None


class _Hub:
    async def generate_and_wait(self, game_id, asset_id):
        # "generate" appends a fresh selected generation
        self._asset.generations.append(
            Generation(id="gen2", seed=2, image_ref="/media/g1/a1/new.png",
                       created_at=datetime.now(timezone.utc)))
    def bind(self, asset):
        self._asset = asset
        return self


class _SceneStore:
    def __init__(self, doc):
        self._doc = doc
    async def get_document(self, game_id):
        return self._doc


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append(op)
        return None


def _ctx(doc, asset):
    assets = _Assets(asset)
    hub = _Hub().bind(asset)
    return ToolContext("r1", "g1", assets, hub,
                       scene_store=_SceneStore(doc), scene_hub=_SceneHub()), assets


@pytest.mark.asyncio
async def test_regenerate_element_swaps_src_in_place_without_new_nodes():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    ctx, assets = _ctx(doc, asset)
    before_nodes = set(doc["nodes"])

    out = await build_regenerate_element_tool(ctx).ainvoke(
        {"ref": "seaweed", "description": "full seaweed, not cropped"})

    # regenerated (prompt updated, newest selected), rewrote the SAME texture
    assert assets.updated == {"prompt": "full seaweed, not cropped"}
    assert assets.selected == "gen2"
    assert ctx.scene_hub.ops == [{
        "kind": "setProp", "id": "tex.seaweed", "path": "src",
        "value": "/media/g1/a1/new.png",
    }]
    # NO new nodes added (the duplicate-sprite bug cannot recur)
    assert set(doc["nodes"]) == before_nodes
    assert "Regenerated" in out and "seaweed" in out


@pytest.mark.asyncio
async def test_regenerate_element_without_description_rerolls_same_prompt():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    ctx, assets = _ctx(doc, asset)

    await build_regenerate_element_tool(ctx).ainvoke({"ref": "seaweed"})

    assert assets.updated is None          # no prompt change
    assert assets.selected == "gen2"       # still re-rolled + rebound
    assert ctx.scene_hub.ops[0]["id"] == "tex.seaweed"


@pytest.mark.asyncio
async def test_regenerate_element_no_match_lists_placed_and_changes_nothing():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    ctx, _ = _ctx(doc, asset)

    out = await build_regenerate_element_tool(ctx).ainvoke({"ref": "treasure chest"})

    assert "no placed element" in out.lower()
    assert "seaweed" in out.lower()        # tells the agent what IS placed
    assert ctx.scene_hub.ops == []


@pytest.mark.asyncio
async def test_regenerate_element_ambiguous_returns_candidates_with_exact_handles():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    doc["nodes"]["spr.seaweed_left"] = {"id": "spr.seaweed_left", "type": "Sprite",
                                        "props": {"role": "prop"}}
    doc["nodes"]["spr.seaweed_right"] = {"id": "spr.seaweed_right", "type": "Sprite",
                                         "props": {"role": "prop"}}
    ctx, _ = _ctx(doc, asset)

    out = await build_regenerate_element_tool(ctx).ainvoke({"ref": "seaweed"})

    low = out.lower()
    assert "seaweed_left" in low and "seaweed_right" in low
    assert ctx.scene_hub.ops == []         # nothing regenerated until disambiguated


@pytest.mark.asyncio
async def test_regenerate_element_empty_scene_is_friendly():
    ctx, _ = _ctx({"version": 1, "nodes": {}, "edges": []}, _seaweed_asset())
    out = await build_regenerate_element_tool(ctx).ainvoke({"ref": "seaweed"})
    assert "empty" in out.lower() or "nothing" in out.lower()
    assert ctx.scene_hub.ops == []


def test_factory_registers_regenerate_element():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "regenerate_element" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["regenerate_element"], ctx)[0].name == "regenerate_element"
