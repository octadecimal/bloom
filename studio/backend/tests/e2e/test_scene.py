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

    deadline = asyncio.get_running_loop().time() + 10
    while not seen["snapshots"] and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert seen["snapshots"], "expected a scene_snapshot on join"
    snap = seen["snapshots"][0]
    assert snap["gameId"] == game_id
    assert snap["document"] == {"version": 1, "nodes": {}, "edges": []}

    await client.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_design_scene_agent_builds_root_and_nodes(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    seen = {"ops": [], "snapshots": []}
    client.on("scene_op", lambda d: seen["ops"].append(d))
    client.on("scene_snapshot", lambda d: seen["snapshots"].append(d))

    await client.connect(live_server, auth={"displayName": "SceneAgent"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("run_skill", {
        "roomId": room_id,
        "skillName": "design-scene",
        "args": {},
        "text": "Build a basic slot scene.",
    })

    # Poll until a Root node op is broadcast (deadline ~15 s).
    deadline = asyncio.get_running_loop().time() + 15
    def _has_root():
        return any(o["op"].get("type") == "Root" for o in seen["ops"] if o["op"]["kind"] == "addNode")
    while not _has_root() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)

    # 1. scene_op broadcasts were observed, including the Root.
    assert _has_root(), f"expected a Root addNode op; saw {[o['op'] for o in seen['ops']]}"
    child_ops = [o for o in seen["ops"] if o["op"]["kind"] == "addNode" and o["op"]["type"] != "Root"]
    assert child_ops, "expected at least one non-Root node op"

    # 2. The persisted document reflects the build: re-join for a fresh snapshot.
    seen["snapshots"].clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not seen["snapshots"] and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    doc = seen["snapshots"][-1]["document"]
    assert any(n["type"] == "Root" for n in doc["nodes"].values()), doc
    assert len(doc["nodes"]) >= 4, doc  # root + reels + >=2 sprites
    assert doc["edges"], "expected child edges in the persisted scene"

    await client.disconnect()
