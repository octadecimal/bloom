import pytest
from datetime import datetime, timezone

from app.agent_tools import ToolContext, ToolFactory, build_read_scene_tool
from app.assets.models import Asset, Generation


def _bg_doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.background": {"id": "spr.background", "type": "Sprite",
                               "props": {"role": "background", "position": {"x": 640, "y": 360},
                                         "scale": {"x": 1, "y": 1}, "zIndex": 0}},
            "tex.background": {"id": "tex.background", "type": "Texture",
                               "props": {"src": "/media/g1/a1/bg.png"}},
        },
        "edges": [
            {"id": "c1", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.background", "port": "parent"}},
            {"id": "d1", "type": "data", "from": {"node": "tex.background", "port": "data"},
             "to": {"node": "spr.background", "port": "texture"}},
        ],
    }


def _bg_asset():
    return Asset(
        id="a1", game_id="g1", name="Mystic Mountains", prompt="p", width=1280, height=720,
        workflow="schnell-opaque", slot="background",
        generations=[Generation(id="gen1", seed=1, image_ref="/media/g1/a1/bg.png",
                                created_at=datetime.now(timezone.utc))],
        selected_generation_id="gen1",
    )


class _Assets:
    def __init__(self, asset):
        self._asset = asset
    async def list_assets(self, game_id):
        return [self._asset]


class _SceneStore:
    def __init__(self, doc):
        self._doc = doc
    async def get_document(self, game_id):
        return self._doc


def _ctx(doc, asset):
    return ToolContext("r1", "g1", _Assets(asset), None, scene_store=_SceneStore(doc))


@pytest.mark.asyncio
async def test_read_scene_lists_placed_sprite_with_name_position_size():
    out = await build_read_scene_tool(_ctx(_bg_doc(), _bg_asset())).ainvoke({})
    assert "background" in out            # the handle (== regenerate_element ref)
    assert "Mystic Mountains" in out      # bound asset name
    assert "640" in out and "360" in out  # position
    assert "1280x720" in out              # size from the bound asset


@pytest.mark.asyncio
async def test_read_scene_empty_scene_is_friendly():
    out = await build_read_scene_tool(_ctx({"version": 1, "nodes": {}, "edges": []}, _bg_asset())).ainvoke({})
    assert "empty" in out.lower() or "nothing" in out.lower()


def test_factory_registers_read_scene():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "read_scene" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["read_scene"], ctx)[0].name == "read_scene"
