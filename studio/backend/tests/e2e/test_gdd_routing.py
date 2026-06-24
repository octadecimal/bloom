# studio/backend/tests/e2e/test_gdd_routing.py
"""Backend service e2e for design-intent routing on plain chat (replay).

Plain chat in a game room runs the design-router: a concrete design decision
routes to set_gdd_fields without an explicit /design-game; an ambiguous target
triggers a disambiguation question. Offline under PROVIDER_MODE=replay.
"""
import asyncio
import json

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "RouteE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_plain_chat_sets_a_field_without_design_game(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    updates: list[dict] = []
    client.on("gdd_doc_updated", lambda d: updates.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("send_prompt",
                      {"roomId": room_id, "text": "set the bonus hit rate to 1:200"})

    # Poll the math-model doc until the routed set_gdd_fields lands.
    math = None
    async with httpx.AsyncClient(base_url=live_server) as http:
        deadline = asyncio.get_event_loop().time() + 15
        while asyncio.get_event_loop().time() < deadline:
            docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
            math = next((d for d in docs if d["aspect"] == "math-model"), None)
            if math and math.get("data", {}).get("bonus_hit_rate"):
                break
            await asyncio.sleep(0.1)

    assert math is not None, "math-model doc missing"
    assert math["data"]["bonus_hit_rate"] == "1:200", f"field not set: {math['data']}"
    assert "1:200" in math["body"]

    # Viewer reflects it live via gdd_doc_updated for math-model.
    math_updates = [u for u in updates if u["doc"]["aspect"] == "math-model"]
    assert math_updates, "no live gdd_doc_updated for math-model"
    assert math_updates[-1]["doc"]["data"]["bonus_hit_rate"] == "1:200"

    await client.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_ambiguous_hit_rate_triggers_disambiguation(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    question_steps: list[dict] = []

    def _on_step(d):
        if d.get("step", {}).get("type") == "question":
            question_steps.append(d)

    client.on("run_step_started", _on_step)

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("send_prompt",
                      {"roomId": room_id, "text": "set the hit rate to 1:200"})

    deadline = asyncio.get_event_loop().time() + 15
    while not question_steps and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert question_steps, "ambiguous edit must trigger a disambiguation question"
    payload = json.loads(question_steps[0]["step"]["content"])
    assert payload["kind"] == "question"

    # The ambiguous edit must NOT have blindly set a hit-rate field.
    async with httpx.AsyncClient(base_url=live_server) as http:
        docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
    math = next(d for d in docs if d["aspect"] == "math-model")
    assert not math.get("data", {}).get("bonus_hit_rate")
    assert not math.get("data", {}).get("hit_frequency")

    await client.disconnect()
