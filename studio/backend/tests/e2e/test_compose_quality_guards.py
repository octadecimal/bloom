"""Authoritative backend replay e2e for the compose quality guards (#item1-4 slice).

Proves end-to-end, with the real backend compositor and critics (no fakes):
  - a garbled-text logo is regenerated and converges (items 1 + 2)
  - an off-canvas credits bar is clamped back into frame (item 4)
"""
import asyncio

import httpx
import pytest
import socketio

PROMPT = (
    "build a pirate slot: a background, a logo at the top, and a credits bar, "
    "then tidy it"
)


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "Quality Guards E2E"})).json()
    return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_quality_guards_converge_and_keep_in_frame(live_server):
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
    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 60
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received within 60 s"
    assert run_completions[0]["status"] == "completed", run_completions

    async with httpx.AsyncClient(base_url=live_server) as http:
        runs = (await http.get(f"/rooms/{room_id}/runs")).json()
    summary = ""
    for run in runs:
        for step in run.get("steps", []):
            if step.get("toolName") == "compose_scene" and step.get("type") == "tool_result":
                summary = step.get("content", "")
    assert summary, f"no compose_scene tool_result found: {runs}"

    # item 2: the garbled logo regenerated and converged (1 asset regeneration).
    assert "asset regeneration(s)" in summary
    assert "1 asset regeneration(s)" in summary, summary
    assert "regenerated (attempt 1)" in summary, summary
    # converged, not "could not fix"
    assert "could not fix" not in summary, summary

    # item 4: the off-canvas credits bar was pulled back in.
    assert "in-frame correction(s)" in summary
    assert "0 in-frame correction(s)" not in summary, summary
    assert "into frame" in summary, summary

    # The credits sprite's final anchored position sits inside the 1280x720 canvas.
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received after re-join"
    nodes = scene_snapshots[-1]["document"]["nodes"]
    assert "spr.credits" in nodes, list(nodes)
    pos = nodes["spr.credits"]["props"]["position"]
    assert pos["x"] < 1280 and pos["y"] < 720, pos  # moved off the corner, into frame

    await client.disconnect()
