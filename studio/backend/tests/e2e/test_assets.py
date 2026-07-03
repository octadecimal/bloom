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
        assert img.status_code == 200 and img.content.startswith(b"\x89PNG") and len(img.content) > 5000

    await client.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_direct_generate_logo_regenerates_via_the_floor(live_server):
    """A direct agent 'generate a logo' runs the MANDATORY asset floor end-to-end:
    the logo critic cassette (asset/logo.json) flags the first generation 'regenerate'
    and keeps the regenerated one, so the board's logo asset ends with 2 generations
    (dud + keep). Proves the C2.4 direct-path gate fires in the real agent run."""
    async with httpx.AsyncClient(base_url=live_server) as http:
        room = (await http.post("/rooms", json={"name": "Asset Floor E2E"})).json()
    room_id, game_id = room["id"], room["gameId"]

    client = socketio.AsyncClient()
    run_completions: list[dict] = []
    client.on("run_completed", lambda d: run_completions.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)
    await client.emit("send_prompt", {
        "roomId": room_id,
        "text": "generate a pirate logo and run it through the asset floor",
    })

    deadline = asyncio.get_running_loop().time() + 60
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received within 60 s"
    assert run_completions[0]["status"] == "completed", run_completions

    # the board's logo asset went through the floor: dud + regenerated keep = 2 generations
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    logo = next((a for a in assets if a.get("slot") == "logo"), None)
    assert logo is not None, f"no logo asset on the board: {assets}"
    assert len(logo["generations"]) == 2, logo

    await client.disconnect()
