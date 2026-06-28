import pytest
from datetime import datetime, timezone

from app.assets.models import Asset, Generation
from app.scene.rebind import selected_image_ref, bound_texture_ids, rebind_asset_textures


def _asset(selected="gen2"):
    return Asset(
        id="a1", game_id="g1", name="Wild", prompt="p", width=64, height=64,
        workflow="schnell-transparent", slot="wild",
        generations=[
            Generation(id="gen1", seed=1, image_ref="/media/g1/a1/old.png", created_at=datetime.now(timezone.utc)),
            Generation(id="gen2", seed=2, image_ref="/media/g1/a1/new.png", created_at=datetime.now(timezone.utc)),
        ],
        selected_generation_id=selected,
    )


def _doc_with_texture(tex_id, props):
    return {"version": 1, "nodes": {tex_id: {"id": tex_id, "type": "Texture", "props": props}}, "edges": []}


class _SceneStore:
    def __init__(self, doc):
        self._doc = doc
    async def get_document(self, game_id):
        return self._doc


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append((game_id, op))
        return None


def test_selected_image_ref_returns_selected():
    assert selected_image_ref(_asset("gen2")) == "/media/g1/a1/new.png"
    assert selected_image_ref(_asset(None)) is None


def test_bound_texture_ids_prefers_explicit_asset_id():
    doc = _doc_with_texture("tex.wild", {"src": "x", "assetId": "a1"})
    assert bound_texture_ids(doc, asset_id="a1", slot="wild") == ["tex.wild"]


def test_bound_texture_ids_falls_back_to_id_convention():
    doc = _doc_with_texture("tex.wild", {"src": "x"})  # legacy: no assetId
    assert bound_texture_ids(doc, asset_id="a1", slot="wild") == ["tex.wild"]


def test_bound_texture_ids_empty_when_unbound():
    doc = _doc_with_texture("tex.other", {"src": "x", "assetId": "zzz"})
    assert bound_texture_ids(doc, asset_id="a1", slot="wild") == []


@pytest.mark.asyncio
async def test_rebind_rewrites_bound_texture_src():
    doc = _doc_with_texture("tex.wild", {"src": "/media/g1/a1/old.png", "assetId": "a1"})
    store, hub = _SceneStore(doc), _SceneHub()
    ids = await rebind_asset_textures(store, hub, "g1", _asset("gen2"))
    assert ids == ["tex.wild"]
    assert hub.ops == [("g1", {"kind": "setProp", "id": "tex.wild", "path": "src", "value": "/media/g1/a1/new.png"})]


@pytest.mark.asyncio
async def test_rebind_noop_when_no_selection_or_no_texture():
    hub = _SceneHub()
    # no selection
    assert await rebind_asset_textures(_SceneStore(_doc_with_texture("tex.wild", {"assetId": "a1"})), hub, "g1", _asset(None)) == []
    # not placed
    assert await rebind_asset_textures(_SceneStore({"version": 1, "nodes": {}, "edges": []}), hub, "g1", _asset("gen2")) == []
    assert hub.ops == []
