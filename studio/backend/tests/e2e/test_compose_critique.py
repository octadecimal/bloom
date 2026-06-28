"""Authoritative backend replay e2e: the compose-loop critic ACTUALLY runs.

Gate that would have caught the shipped bug: a real compose run through the live
replay backend that composites for real (backend SceneCompositor — no fake
capture responder) and proves:
  - passes > 0  (the critic actually ran)
  - a degenerate reel-frame asset was regenerated
  - the composition transform (scale=0.8) landed on the reel-frame sprite
  - the loop converged

Cassettes used:
  run/compose-critique-loop.json — compose_scene call with background + reel_frame
  asset/reel_frame.json          — role "reel frame" -> regenerate
  asset/default.json             — other roles -> keep
  critic/reel_frame.json         — target "reel_frame" -> scale 0.8 then done
  critic/default.json            — other targets -> done immediately (pre-existing)
"""
import asyncio

import httpx
import pytest
import socketio

PROMPT = (
    "build a pirate slot: a background and a reel frame in the center, "
    "and tidy it"
)


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "Compose Critique E2E"})).json()
    return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_compose_loop_critiques_for_real_and_regenerates_bad_asset(live_server):
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

    # Wait for the run to complete (generous timeout: replay backend is fast
    # but the loop places 2 elements + asset critique + 2 composition passes).
    deadline = asyncio.get_running_loop().time() + 60
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received within 60 s"
    assert run_completions[0]["status"] == "completed", (
        f"compose run ended in non-completed status: {run_completions}"
    )

    # --- Load the persisted run from the REST API ---
    # GET /rooms/{room_id}/runs returns a list of Run objects, each with a
    # `steps` list.  Each step has: type (tool_call|tool_result|final|...),
    # toolName, content, status.  We look for the tool_result step whose
    # toolName is "compose_scene" — its content is the format_compose_summary
    # string that encodes every measurable outcome of the loop.
    async with httpx.AsyncClient(base_url=live_server) as http:
        runs = (await http.get(f"/rooms/{room_id}/runs")).json()

    # The REST API serialises RunStep with camelCase aliases (via _WireModel /
    # to_camel alias generator): tool_name -> toolName, created_at -> createdAt.
    # type/content/status/index have no underscores so stay as-is.
    summary = ""
    for run in runs:
        for step in run.get("steps", []):
            if (step.get("toolName") == "compose_scene"
                    and step.get("type") == "tool_result"):
                summary = step.get("content", "")

    assert summary, (
        "No compose_scene tool_result step found in persisted run steps. "
        f"Runs: {runs}"
    )

    # The critic MUST have run — if passes==0 the loop did nothing.
    assert "0 critique pass(es)" not in summary, (
        f"critic did not run (0 passes): {summary}"
    )

    # The degenerate reel-frame asset MUST have been regenerated.
    assert "1 asset regeneration(s)" in summary, (
        f"expected 1 asset regeneration in summary: {summary}"
    )
    assert "regenerated" in summary.lower(), (
        f"'regenerated' not in notes: {summary}"
    )

    # --- Verify the composition transform landed ---
    # Re-join the scene to get a fresh snapshot (run is done, doc is settled).
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received after re-join"

    doc = scene_snapshots[-1]["document"]
    nodes = doc["nodes"]

    # Both elements must be in the scene.
    assert "spr.background" in nodes, (
        f"spr.background missing from scene: {list(nodes)}"
    )
    assert "spr.reel_frame" in nodes, (
        f"spr.reel_frame missing from scene: {list(nodes)}"
    )

    # The composition critic's scale transform must have landed on the reel frame.
    reel_scale = nodes["spr.reel_frame"]["props"]["scale"]
    assert reel_scale == {"x": 0.8, "y": 0.8}, (
        f"reel_frame scale should be {{x:0.8,y:0.8}} after critic transform, got: {reel_scale}"
    )

    await client.disconnect()
