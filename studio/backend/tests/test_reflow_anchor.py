import pytest

from app.agent_tools import _place_in_scene, ToolContext


class _RecordingHub:
    def __init__(self):
        self.batches = []

    async def ensure_root(self, game_id, canvas):
        return {"root_id": "root", "canvas": canvas}

    async def apply_batch(self, game_id, ops):
        self.batches.append(ops)
        return {"nodes": {}, "edges": [], "modules": []}


class _StoreWithSprite:
    async def get_document(self, game_id):
        # a Root plus an already-placed reels sprite -> forces the reflow branch
        return {"nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.reels": {"id": "spr.reels", "type": "Sprite", "props": {}},
        }}


@pytest.mark.asyncio
async def test_reflow_emits_anchor_setprops():
    hub = _RecordingHub()
    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      scene_store=_StoreWithSprite(), scene_hub=hub)
    await _place_in_scene(
        ctx, handle="reels", src="/media/x.png", role="reels", parent="root",
        x=100.0, y=200.0, anchor_x=0.1, anchor_y=0.9, fit="region", z_index=20,
        tex_size=(512, 512), region_w=400, region_h=300,
    )
    ops = hub.batches[0]
    paths = {(o["path"], o["value"]) for o in ops if o["kind"] == "setProp"}
    assert ("anchor.x", 0.1) in paths
    assert ("anchor.y", 0.9) in paths
