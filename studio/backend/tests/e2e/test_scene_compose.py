"""Backend non-browser e2e: one plain-chat prompt builds a scene end-to-end.

Under PROVIDER_MODE=replay, "make a pirate theme game with a background and a logo
centered at the top" routes through the design-router. Its replayed tool calls run
the REAL generate_asset (-> replay ComfyUI) and REAL add_sprite (-> real scene
mutation), so the persisted scene ends with two parented, texture-bound sprites.

Cassette: run/compose-pirate-scene.json (prompt-keyed).
"""
import asyncio

import httpx
import pytest
import socketio

PROMPT = "make a pirate theme game with a background and a logo centered at the top"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "ComposeE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_one_prompt_generates_and_places_background_and_logo(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    scene_ops: list[dict] = []
    run_completions: list[dict] = []
    scene_snapshots: list[dict] = []
    client.on("scene_op", lambda d: scene_ops.append(d))
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)

    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 40
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received for compose prompt"
    assert run_completions[0]["status"] == "completed", f"compose run failed: {run_completions}"

    # Two assets, tagged by their stable slots, each with a generated image.
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    by_slot = {a.get("slot"): a for a in assets}
    assert "background" in by_slot and "logo" in by_slot, f"assets: {assets}"
    for slot in ("background", "logo"):
        gens = by_slot[slot].get("generations") or []
        assert gens, f"{slot} asset has no generation: {by_slot[slot]}"

    # The persisted scene has both sprites, parented and texture-bound.
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received"
    doc = scene_snapshots[-1]["document"]
    nodes, edges = doc["nodes"], doc["edges"]
    assert any(n["type"] == "Root" for n in nodes.values()), "no Root auto-created"
    for handle in ("background", "logo"):
        assert f"spr.{handle}" in nodes, f"missing sprite spr.{handle}: {list(nodes)}"
        assert f"tex.{handle}" in nodes, f"missing texture tex.{handle}"
        # texture bound to the sprite via a data edge
        assert any(e["type"] == "data" and e["from"]["node"] == f"tex.{handle}"
                   and e["to"]["node"] == f"spr.{handle}" for e in edges), \
            f"tex.{handle} not bound to spr.{handle}"
        # sprite parented (child edge into it)
        assert any(e["type"] == "child" and e["to"]["node"] == f"spr.{handle}"
                   for e in edges), f"spr.{handle} not parented"
        # texture src points at generated media
        assert nodes[f"tex.{handle}"]["props"].get("src", "").startswith("/media/")

    # The placement was broadcast live (addNode + connect ops seen).
    kinds = [o.get("op", {}).get("kind") for o in scene_ops]
    assert "addNode" in kinds and "connect" in kinds, f"ops seen: {kinds}"

    await client.disconnect()
