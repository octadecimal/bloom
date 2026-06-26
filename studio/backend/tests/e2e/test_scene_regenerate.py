"""Backend non-browser e2e: regenerating a placed element replaces it IN PLACE.

Under PROVIDER_MODE=replay, "add a seaweed prop" composes one sprite, then
"regenerate the seaweed, it's cut off at the top" routes through the design-router
to the REAL regenerate_element tool. The element's art is re-rolled and its bound
Texture src is rewritten in place — so the scene ends with exactly ONE seaweed
sprite (the duplicate-sprite bug does not recur), and the asset has two generations.

Cassettes: run/compose-seaweed.json, run/regenerate-seaweed.json (prompt-keyed).
"""
import asyncio

import httpx
import pytest
import socketio

COMPOSE = "add a seaweed prop at the bottom of the scene"
REGEN = "regenerate the seaweed, it's cut off at the top"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "RegenE2E"})).json()
        return room["id"], room["gameId"]


async def _run_prompt(client, room_id, text, completions):
    completions.clear()
    await client.emit("send_prompt", {"roomId": room_id, "text": text})
    deadline = asyncio.get_running_loop().time() + 40
    while not completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert completions, f"run_completed not received for: {text}"
    assert completions[0]["status"] == "completed", f"run failed: {completions}"


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_regenerate_replaces_placed_element_in_place(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    run_completions: list[dict] = []
    scene_snapshots: list[dict] = []
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)

    # 1) compose a single seaweed prop
    await _run_prompt(client, room_id, COMPOSE, run_completions)

    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    seaweed = next(a for a in assets if a.get("slot") == "seaweed")
    assert len(seaweed.get("generations") or []) == 1, "expected one generation after compose"

    # 2) regenerate it
    await _run_prompt(client, room_id, REGEN, run_completions)

    # asset gained a SECOND generation (it regenerated, did not reuse)
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    seaweed = next(a for a in assets if a.get("slot") == "seaweed")
    gens = seaweed.get("generations") or []
    assert len(gens) == 2, f"expected two generations after regenerate: {seaweed}"
    newest_ref = gens[-1]["imageRef"]

    # scene has EXACTLY ONE seaweed sprite (no duplicate), src rewired to newest gen
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received"
    doc = scene_snapshots[-1]["document"]
    nodes = doc["nodes"]

    sprites = [nid for nid, n in nodes.items() if n["type"] == "Sprite"]
    assert sprites == ["spr.seaweed"], f"expected one seaweed sprite, got {sprites}"
    textures = [nid for nid, n in nodes.items() if n["type"] == "Texture"]
    assert textures == ["tex.seaweed"], f"expected one seaweed texture, got {textures}"
    assert nodes["tex.seaweed"]["props"]["src"] == newest_ref, "texture not repainted to newest gen"

    await client.disconnect()
