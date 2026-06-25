"""Backend non-browser e2e: a chat message reshapes a slot symbol end-to-end.

Proves the full design-router → set_gdd_fields(symbols-reels) → realize_symbol
pipeline under PROVIDER_MODE=replay:
  - Seeds a game with a high1 symbol row in the GDD, an Asset tagged slot=high1
    (with one generation), and a scene with a Sprite(props.slot=high1) bound to
    a Texture via a data edge.
  - Sends "make the high symbol a dragon" as plain chat (routes through the
    design-router agent).
  - Asserts: the GDD high1 row changed name/art_desc, the asset gained a second
    generation, the scene Texture's src changed, and a scene_op was observed.

Harness: external subprocess server (live_server fixture from conftest.py).
Cassette files used:
  - run/reshape-symbol.json  (keyed prompt: "make the high symbol a dragon")
  - run/seed-scene-high1.json (keyed prompt: "seed scene with high1 sprite and texture")
  - run/generate-sprite-high1.json (generate-sprite via generate_asset + generate_and_wait, prompt-keyed)
"""
import asyncio

import httpx
import pytest
import socketio


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _make_room(base_url: str) -> tuple[str, str]:
    """POST /rooms and return (room_id, game_id)."""
    async with httpx.AsyncClient(base_url=base_url) as http:
        resp = await http.post("/rooms", json={"name": "SymbolReshapeE2E"})
        data = resp.json()
        return data["id"], data["gameId"]


async def _seed_gdd_high1(base_url: str, game_id: str) -> None:
    """Seed the symbols-reels GDD doc with a high1 symbol row via REST."""
    async with httpx.AsyncClient(base_url=base_url) as http:
        await http.put(
            f"/games/{game_id}/gdd/symbols-reels",
            json={
                "fields": {
                    "symbols": [
                        {
                            "slot": "high1",
                            "name": "Phoenix",
                            "kind": "high",
                            "art_desc": "a phoenix bird with red and gold feathers",
                        }
                    ]
                }
            },
        )


# ---------------------------------------------------------------------------
# Main test
# ---------------------------------------------------------------------------

@pytest.mark.e2e
@pytest.mark.asyncio
async def test_chat_reshapes_high_symbol(live_server):
    """Plain chat 'make the high symbol a dragon' reshapes slot high1 end-to-end."""

    # -----------------------------------------------------------------------
    # 1. Create room + game
    # -----------------------------------------------------------------------
    room_id, game_id = await _make_room(live_server)

    # -----------------------------------------------------------------------
    # 2. Connect a socket client; join the room and scene
    # -----------------------------------------------------------------------
    client = socketio.AsyncClient()
    scene_ops: list[dict] = []
    run_completions: list[dict] = []
    gdd_updates: list[dict] = []
    scene_snapshots: list[dict] = []

    client.on("scene_op", lambda d: scene_ops.append(d))
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("gdd_doc_updated", lambda d: gdd_updates.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.3)

    # -----------------------------------------------------------------------
    # 3. Seed the GDD symbols-reels with a high1 row (via REST PUT)
    # -----------------------------------------------------------------------
    await _seed_gdd_high1(live_server, game_id)

    # -----------------------------------------------------------------------
    # 4. Generate an initial asset for slot=high1 (via generate-sprite run_skill).
    #    Uses the default.json cassette (generate_asset → replay comfy → generation).
    # -----------------------------------------------------------------------
    run_completions.clear()
    await client.emit(
        "run_skill",
        {
            "roomId": room_id,
            "skillName": "generate-sprite",
            "args": {"description": "a phoenix bird", "slot": "high1"},
            "text": "generate sprite for high1 slot",
        },
    )
    deadline = asyncio.get_running_loop().time() + 25
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "generate-sprite run_completed not received"
    assert run_completions[0]["status"] == "completed", (
        f"generate-sprite run failed: {run_completions}"
    )

    # Read initial asset state
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    high1_assets = [a for a in assets if a.get("slot") == "high1"]
    assert high1_assets, f"No asset with slot=high1 after generate-sprite; assets={assets}"
    orig_asset = high1_assets[0]
    orig_gen_count = len(orig_asset.get("generations") or [])
    orig_gens = orig_asset.get("generations") or []
    orig_src = orig_gens[-1].get("imageRef", "") if orig_gens else ""
    assert orig_gen_count >= 1, f"Expected at least 1 generation; got {orig_gen_count}"

    # -----------------------------------------------------------------------
    # 5. Seed the scene: Root + Container + Sprite(slot=high1) + Texture(old src)
    #    + edges (child chain + data edge Texture→Sprite).
    #    Uses the seed-scene-high1.json cassette keyed on a unique prompt.
    # -----------------------------------------------------------------------
    run_completions.clear()
    scene_ops.clear()
    await client.emit(
        "run_skill",
        {
            "roomId": room_id,
            "skillName": "design-scene",
            "args": {},
            "text": "seed scene with high1 sprite and texture",
        },
    )
    deadline = asyncio.get_running_loop().time() + 20
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "design-scene (seed) run_completed not received"
    assert run_completions[0]["status"] == "completed", (
        f"design-scene (seed) run failed: {run_completions}"
    )

    # Confirm the scene now has a Texture node
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received after seeding scene"
    snap = scene_snapshots[-1]
    doc = snap["document"]
    texture_nodes = {nid: n for nid, n in doc["nodes"].items() if n["type"] == "Texture"}
    sprite_nodes = {nid: n for nid, n in doc["nodes"].items()
                   if n["type"] == "Sprite" and (n.get("props") or {}).get("slot") == "high1"}
    assert sprite_nodes, f"No Sprite with slot=high1 in scene after seeding: {doc['nodes']}"
    assert texture_nodes, f"No Texture node in scene after seeding: {doc['nodes']}"
    old_texture_src = next(iter(texture_nodes.values()))["props"].get("src", "")

    # -----------------------------------------------------------------------
    # 6. Send the reshape prompt via plain chat (design-router path).
    #    Uses reshape-symbol.json cassette keyed on "make the high symbol a dragon".
    # -----------------------------------------------------------------------
    run_completions.clear()
    scene_ops.clear()
    gdd_updates.clear()

    await client.emit("send_prompt", {"roomId": room_id, "text": "make the high symbol a dragon"})

    # Wait for run_completed (the design-router runs as a skill run)
    deadline = asyncio.get_running_loop().time() + 30
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received after reshape prompt"
    assert run_completions[0]["status"] == "completed", (
        f"reshape run failed: {run_completions}"
    )

    # -----------------------------------------------------------------------
    # 7. Assert: GDD high1 row updated
    # -----------------------------------------------------------------------
    async with httpx.AsyncClient(base_url=live_server) as http:
        docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
    sym_doc = next((d for d in docs if d["aspect"] == "symbols-reels"), None)
    assert sym_doc is not None, "symbols-reels GDD doc not found"
    symbols = sym_doc["data"].get("symbols") or []
    high1_row = next((r for r in symbols if r.get("slot") == "high1"), None)
    assert high1_row is not None, f"high1 row not found in symbols-reels data: {symbols}"
    # The cassette sets name="Dragon" via set_gdd_fields
    assert high1_row.get("name", "").lower() == "dragon", (
        f"high1 name not updated to Dragon: {high1_row}"
    )
    # Also verify art_desc changed from phoenix
    updated_text = (
        str(high1_row.get("name", "")) + " " + str(high1_row.get("art_desc", ""))
    ).lower()
    assert "dragon" in updated_text, (
        f"high1 row does not mention dragon after reshape: {high1_row}"
    )

    # -----------------------------------------------------------------------
    # 8. Assert: asset gained a new generation
    # -----------------------------------------------------------------------
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets2 = (await http.get(f"/games/{game_id}/assets")).json()
    high1_assets2 = [a for a in assets2 if a.get("slot") == "high1"]
    assert high1_assets2, "No high1 asset after reshape"
    new_gen_count = len(high1_assets2[0].get("generations") or [])
    assert new_gen_count > orig_gen_count, (
        f"Expected more generations after reshape; had {orig_gen_count}, now {new_gen_count}"
    )

    # -----------------------------------------------------------------------
    # 9. Assert: scene Texture src changed (read back via join_scene snapshot)
    # -----------------------------------------------------------------------
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received after reshape"
    new_snap = scene_snapshots[-1]["document"]
    new_texture_nodes = {nid: n for nid, n in new_snap["nodes"].items() if n["type"] == "Texture"}
    assert new_texture_nodes, f"No Texture node in scene after reshape: {new_snap['nodes']}"
    new_texture_src = next(iter(new_texture_nodes.values()))["props"].get("src", "")
    assert new_texture_src != old_texture_src, (
        f"Texture src did not change: was '{old_texture_src}', still '{new_texture_src}'"
    )

    # -----------------------------------------------------------------------
    # 10. Assert: a scene_op (setProp on the Texture) was broadcast
    # -----------------------------------------------------------------------
    assert scene_ops, "No scene_op events received during reshape"
    set_prop_ops = [o for o in scene_ops if o.get("op", {}).get("kind") == "setProp"]
    assert set_prop_ops, f"No setProp scene_op seen; all ops: {[o['op'] for o in scene_ops]}"

    await client.disconnect()
