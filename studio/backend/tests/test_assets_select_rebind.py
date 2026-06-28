import httpx
import pytest
from httpx import ASGITransport


@pytest.mark.asyncio
async def test_select_generation_rebinds_bound_scene_texture(ctx, mongo_db):
    app = ctx.fastapi_app
    # the mongo_db fixture does not clean the scene collection — clear it so the
    # placement batch below starts from an empty scene on every run.
    await mongo_db["game_scenes"].delete_many({})

    asset_store = app.state.asset_store
    scene_store = app.state.scene_store
    scene_hub = app.state.scene_hub

    game_id = "g_rebind"
    asset = await asset_store.create_asset(
        game_id, "Wild", "p", 64, 64, "schnell-transparent", slot="wild"
    )
    # first add auto-selects gen1; second is just appended (selection stays gen1)
    await asset_store.add_generation(asset.id, "gen1", 1, "/media/g/a1/gen1.png")
    await asset_store.add_generation(asset.id, "gen2", 2, "/media/g/a1/gen2.png")

    # place a Sprite bound to a Texture(assetId) under the root, showing gen1
    await scene_hub.ensure_root(game_id, (640, 480))
    await scene_hub.apply_batch(game_id, [
        {"kind": "addNode", "id": "spr.wild", "type": "Sprite", "props": {}},
        {"kind": "addNode", "id": "tex.wild", "type": "Texture",
         "props": {"src": "/media/g/a1/gen1.png", "assetId": asset.id}},
        {"kind": "connect", "edgeId": "e.data.wild", "type": "data",
         "from": {"node": "tex.wild", "port": "data"},
         "to": {"node": "spr.wild", "port": "texture"}},
        {"kind": "connect", "edgeId": "e.child.wild", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": "spr.wild", "port": "parent"}},
    ])

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(f"/assets/{asset.id}/select", json={"generationId": "gen2"})

    assert resp.status_code == 200
    assert resp.json()["selectedGenerationId"] == "gen2"

    doc = await scene_store.get_document(game_id)
    assert doc["nodes"]["tex.wild"]["props"]["src"] == "/media/g/a1/gen2.png"
