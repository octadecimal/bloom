"""Backend service e2e: a client-emitted scene_apply_op (setProp) is applied,
broadcast back as scene_op, and persisted. Replay backend, no browser."""
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "MutateE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_client_setprop_is_applied_and_persisted(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    seen = {"ops": [], "snapshots": []}
    client.on("scene_op", lambda d: seen["ops"].append(d))
    client.on("scene_snapshot", lambda d: seen["snapshots"].append(d))

    await client.connect(live_server, auth={"displayName": "Mutator"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.2)

    # Seed a real persisted scene via the deterministic replay agent.
    await client.emit("run_skill", {
        "roomId": room_id, "skillName": "design-scene", "args": {},
        "text": "Build a basic slot scene.",
    })

    deadline = asyncio.get_running_loop().time() + 15
    def _sprite_id():
        for o in seen["ops"]:
            op = o["op"]
            if op["kind"] == "addNode" and op["type"] == "Sprite":
                return op["id"]
        return None
    while _sprite_id() is None and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    sprite_id = _sprite_id()
    assert sprite_id, f"expected a Sprite node; saw {[o['op'] for o in seen['ops']]}"

    # Emit a client setProp on the new sprite.
    seen["ops"].clear()
    await client.emit("scene_apply_op", {
        "gameId": game_id,
        "op": {"kind": "setProp", "id": sprite_id, "path": "position.x", "value": 42},
    })

    # 1. The op is broadcast back to the room as scene_op.
    deadline = asyncio.get_running_loop().time() + 10
    def _saw_setprop():
        return any(o["op"]["kind"] == "setProp" and o["op"]["id"] == sprite_id for o in seen["ops"])
    while not _saw_setprop() and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert _saw_setprop(), f"expected setProp broadcast; saw {[o['op'] for o in seen['ops']]}"

    # 2. The value is persisted: re-join for a fresh snapshot.
    seen["snapshots"].clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not seen["snapshots"] and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    doc = seen["snapshots"][-1]["document"]
    assert doc["nodes"][sprite_id]["props"]["position"]["x"] == 42, doc

    await client.disconnect()
