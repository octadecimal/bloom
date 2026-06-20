import httpx
import pytest
from fastapi import FastAPI

from app.assets.rest import router as assets_router
from app.assets.store import AssetStore
from app.games import GameStore


def _app(mongo_db):
    app = FastAPI()
    app.state.game_store = GameStore(mongo_db)
    app.state.asset_store = AssetStore(mongo_db)
    app.include_router(assets_router)
    return app


def _client(app):
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_games_and_asset_crud_flow(mongo_db):
    app = _app(mongo_db)
    game = await GameStore(mongo_db).create_game("Slots")

    async with _client(app) as client:
        # GET /games returns the seeded game
        games_resp = await client.get("/games")
        assert games_resp.status_code == 200
        assert [g["id"] for g in games_resp.json()] == [game.id]

        # POST /games/{game_id}/assets creates with status "idle"
        created = await client.post(
            f"/games/{game.id}/assets",
            json={
                "name": "Wild",
                "prompt": "a wild",
                "width": 512,
                "height": 512,
                "workflow": "schnell-transparent",
            },
        )
        assert created.status_code == 201
        asset = created.json()
        assert asset["status"] == "idle"
        assert asset["gameId"] == game.id

        # GET /games/{game_id}/assets lists the created asset
        listed = await client.get(f"/games/{game.id}/assets")
        assert listed.status_code == 200
        assert [a["id"] for a in listed.json()] == [asset["id"]]

        # PATCH /assets/{asset_id} updates authoring fields
        patched = await client.patch(
            f"/assets/{asset['id']}", json={"prompt": "edited", "seed": 9}
        )
        assert patched.status_code == 200
        patched_body = patched.json()
        assert patched_body["prompt"] == "edited"
        assert patched_body["seed"] == 9

        # DELETE /assets/{asset_id} returns 204 and list becomes empty
        deleted = await client.delete(f"/assets/{asset['id']}")
        assert deleted.status_code == 204

        after_delete = await client.get(f"/games/{game.id}/assets")
        assert after_delete.json() == []
