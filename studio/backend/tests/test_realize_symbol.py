import pytest
from datetime import datetime, timezone
from app.agent_tools import ToolContext, build_realize_symbol_tool, _find_symbol_sprite
from app.assets.models import Asset, Generation


def _doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.high1": {"id": "spr.high1", "type": "Sprite", "props": {"slot": "high1"}},
            "tex.high1": {"id": "tex.high1", "type": "Texture", "props": {"src": "/media/g/a1/old.png"}},
        },
        "edges": [
            {"id": "c1", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.high1", "port": "parent"}},
            {"id": "d1", "type": "data", "from": {"node": "tex.high1", "port": "data"},
             "to": {"node": "spr.high1", "port": "texture"}},
        ],
    }


def test_find_symbol_sprite_resolves_sprite_and_texture():
    assert _find_symbol_sprite(_doc(), "high1") == ("spr.high1", "tex.high1")
    assert _find_symbol_sprite(_doc(), "missing") is None


class _Gdd:
    async def get_doc(self, game_id, aspect):
        class D:  # minimal stand-in
            data = {"symbols": [{"slot": "high1", "name": "Dragon", "art_desc": "a fierce dragon"}]}
        return D()


class _AssetStore:
    def __init__(self):
        self.updated = None
        self.selected = None
    async def get_by_slot(self, game_id, slot):
        return Asset(id="a1", game_id=game_id, name="High", prompt="raven",
                     width=512, height=512, workflow="schnell-transparent", slot=slot)
    async def update_asset(self, asset_id, **fields):
        self.updated = fields
        return None
    async def get_asset(self, asset_id):
        return Asset(id="a1", game_id="g1", name="High", prompt="a fierce dragon",
                     width=512, height=512, workflow="schnell-transparent", slot="high1",
                     generations=[Generation(id="genNEW", seed=2, image_ref="/media/g/a1/new.png",
                                             created_at=datetime.now(timezone.utc))])
    async def select_generation(self, asset_id, gen_id):
        self.selected = gen_id
        return None


class _AssetHub:
    async def generate_and_wait(self, game_id, asset_id):
        return None


class _SceneStore:
    async def get_document(self, game_id):
        return _doc()


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append(op)
        return None


@pytest.mark.asyncio
async def test_realize_symbol_regenerates_and_rebinds():
    astore, ahub, shub = _AssetStore(), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", astore, ahub, gdd_store=_Gdd(),
                      scene_store=_SceneStore(), scene_hub=shub)
    out = await build_realize_symbol_tool(ctx).ainvoke({"slot": "high1"})
    # regenerated with the new art_desc, then selected the newest generation
    assert astore.updated == {"prompt": "a fierce dragon"}
    assert astore.selected == "genNEW"
    # rewrote the bound texture's src atomically (one setProp op)
    assert shub.ops == [{
        "kind": "setProp", "id": "tex.high1", "path": "src", "value": "/media/g/a1/new.png",
    }]
    assert "high1" in out
