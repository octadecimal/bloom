import asyncio
import base64

import httpx
import pytest
import socketio

PROMPT = ("build a secretary office slot: a desk background and a secretary "
          "character, and tidy the composition")


async def _make_room(base_url: str) -> tuple[str, str]:
    """Create a room (a game is created with it — copied from test_scene_compose.py)."""
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "Compose Loop E2E"})).json()
    return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_compose_loop_captures_critiques_and_transforms(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    scene_ops: list[dict] = []
    run_completions: list[dict] = []
    scene_snapshots: list[dict] = []
    capture_requests: list[dict] = []

    client.on("scene_op", lambda d: scene_ops.append(d))
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    @client.on("scene_capture_request")
    async def _on_capture(data):
        capture_requests.append(data)
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNGframe").decode()
        await client.emit("scene_capture_result", {
            "gameId": data["gameId"], "captureId": data["captureId"], "png": png})

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)

    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 60
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received for compose-loop prompt"
    assert run_completions[0]["status"] == "completed"

    # The loop captured the real frame at least once per element.
    assert len(capture_requests) >= 2

    # Both elements were placed.
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    by_slot = {a.get("slot"): a for a in assets}
    assert "desk" in by_slot and "secretary" in by_slot

    # The critic's transforms landed: the secretary was scaled to 0.6 and moved.
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    doc = scene_snapshots[-1]["document"]
    secretary = doc["nodes"]["spr.secretary"]["props"]
    assert secretary["scale"] == {"x": 0.6, "y": 0.6}
    assert secretary["position"] == {"x": 320, "y": 540}

    # A setProp scale op streamed to the room (the scene visibly reflowed).
    scale_ops = [o for o in scene_ops
                 if o.get("op", {}).get("kind") == "setProp"
                 and o["op"].get("id") == "spr.secretary"
                 and o["op"].get("path") == "scale.x"]
    assert scale_ops, "expected a live scale op for the secretary"

    await client.disconnect()
