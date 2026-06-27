"""Backend non-browser e2e: replacing the background swaps it IN PLACE.

Under PROVIDER_MODE=replay, "add a misty mountain background" composes one
background sprite, then "replace the background with something sunnier" routes
through the design-router: the agent calls read_scene to find the placed
background, then regenerate_element to re-roll its art and rewrite the bound
Texture src in place. The scene ends with exactly ONE background sprite (the
duplicate-sprite bug does not recur) and the asset has two generations.

Cassettes: run/compose-background.json, run/replace-background.json (prompt-keyed).
"""
import asyncio

import httpx
import pytest
import socketio

COMPOSE = "add a misty mountain background"
REPLACE = "replace the background with something sunnier"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "ReplaceBgE2E"})).json()
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
async def test_replace_background_swaps_in_place(live_server):
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

    # 1) compose a single background
    await _run_prompt(client, room_id, COMPOSE, run_completions)
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    bg = next(a for a in assets if a.get("slot") == "background")
    assert len(bg.get("generations") or []) == 1, "expected one generation after compose"

    # 2) replace it with a sunnier version
    await _run_prompt(client, room_id, REPLACE, run_completions)
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    bg = next(a for a in assets if a.get("slot") == "background")
    gens = bg.get("generations") or []
    assert len(gens) == 2, f"expected two generations after replace: {bg}"
    newest_ref = gens[-1]["imageRef"]

    # scene has EXACTLY ONE background sprite (no duplicate), repainted to newest gen
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received"
    nodes = scene_snapshots[-1]["document"]["nodes"]

    sprites = [nid for nid, n in nodes.items() if n["type"] == "Sprite"]
    assert sprites == ["spr.background"], f"expected one background sprite, got {sprites}"
    textures = [nid for nid, n in nodes.items() if n["type"] == "Texture"]
    assert textures == ["tex.background"], f"expected one background texture, got {textures}"
    assert nodes["tex.background"]["props"]["src"] == newest_ref, "texture not repainted to newest gen"

    await client.disconnect()
