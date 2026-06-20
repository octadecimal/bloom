# studio/backend/tests/e2e/test_assets.py
import asyncio

import httpx
import pytest
import socketio


async def _make_game_and_asset(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as client:
        room = (await client.post("/rooms", json={"name": "AssetE2E"})).json()
        game_id = room["gameId"]
        asset = (await client.post(
            f"/games/{game_id}/assets",
            json={"name": "Wild", "prompt": "p", "width": 64, "height": 64, "workflow": "schnell-transparent", "seed": 3},
        )).json()
        return game_id, asset["id"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_generate_streams_status_progress_completed(live_server):
    game_id, asset_id = await _make_game_and_asset(live_server)
    client = socketio.AsyncClient()
    got = {"status": [], "progress": [], "completed": []}
    client.on("asset_status", lambda d: got["status"].append(d))
    client.on("asset_progress", lambda d: got["progress"].append(d))
    client.on("asset_completed", lambda d: got["completed"].append(d))

    await client.connect(live_server, auth={"displayName": "Artist"})
    await client.emit("join_game", {"gameId": game_id})
    await client.emit("generate_asset", {"gameId": game_id, "assetId": asset_id})

    for _ in range(100):
        if got["completed"]:
            break
        await asyncio.sleep(0.05)

    if not got["completed"]:
        pytest.fail(f"generation did not complete in time; got={got}")

    assert got["status"], f"no asset_status events; got={got}"
    assert got["progress"], f"no asset_progress events; got={got}"
    assert got["completed"], f"no asset_completed events; got={got}"
    asset = got["completed"][-1]["asset"]
    assert asset["status"] == "done"
    assert asset["generations"][0]["seed"] == 3

    # the served image is reachable
    async with httpx.AsyncClient(base_url=live_server) as http:
        img = await http.get(asset["generations"][0]["imageRef"])
        assert img.status_code == 200 and img.content.startswith(b"\x89PNG")

    await client.disconnect()
