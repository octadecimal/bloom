"""Backend service e2e for the scene socket layer (replay, no LLM).

Verifies that joining a game's scene room delivers a scene_snapshot for a
freshly-created empty document over a real live server + socket.io client.
"""
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "SceneE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_join_scene_delivers_empty_snapshot(live_server):
    _room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    seen = {"snapshots": []}
    client.on("scene_snapshot", lambda d: seen["snapshots"].append(d))

    await client.connect(live_server, auth={"displayName": "SceneViewer"})
    await client.emit("join_scene", {"gameId": game_id})

    deadline = asyncio.get_event_loop().time() + 10
    while not seen["snapshots"] and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert seen["snapshots"], "expected a scene_snapshot on join"
    snap = seen["snapshots"][0]
    assert snap["gameId"] == game_id
    assert snap["document"] == {"version": 1, "nodes": {}, "edges": []}

    await client.disconnect()
