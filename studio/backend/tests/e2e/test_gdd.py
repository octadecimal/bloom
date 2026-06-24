"""Backend service e2e for the design-game skill (replay).

Verifies that:
  1. Running design-game on a new room seeds 7 GDD docs in the database.
  2. The skill run reaches a ``question`` interrupt step (ask_user_question).

Runs entirely offline under PROVIDER_MODE=replay — no live providers, no API keys.
"""
import asyncio
import json

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    """POST /rooms (implicitly creates a game) and return (room_id, game_id)."""
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "GddE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_design_game_seeds_docs_and_asks_a_question(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    seen = {"gdd": [], "question_steps": []}

    client.on("gdd_snapshot", lambda d: seen["gdd"].append(d))
    client.on("gdd_doc_updated", lambda d: seen["gdd"].append(d))

    def _on_step(d):
        step = d.get("step", {})
        if step.get("type") == "question":
            seen["question_steps"].append(d)

    client.on("run_step_started", _on_step)

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("run_skill", {
        "roomId": room_id,
        "skillName": "design-game",
        "args": {},
        "text": "A neon cyberpunk slot with a free-spins bonus.",
    })

    # Poll until a question step arrives (deadline ~15 s)
    deadline = asyncio.get_event_loop().time() + 15
    while not seen["question_steps"] and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    # 1. Seeding is independent of the LLM: 7 docs must exist.
    async with httpx.AsyncClient(base_url=live_server) as http:
        docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
    assert len(docs) == 7, f"expected 7 GDD docs, got {len(docs)}: {docs}"

    # 2. The run must have reached a question interrupt.
    assert seen["question_steps"], "expected at least one question interrupt step"
    payload = json.loads(seen["question_steps"][0]["step"]["content"])
    assert payload["kind"] == "question", f"unexpected step payload: {payload}"

    await client.disconnect()
