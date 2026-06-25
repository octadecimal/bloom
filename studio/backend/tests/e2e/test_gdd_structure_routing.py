# studio/backend/tests/e2e/test_gdd_structure_routing.py
"""Backend service e2e: structural design intent routes into a typed GDD field.

Plain chat in a game room runs the design-router; a concrete strip-length edit
routes to set_gdd_fields and lands as a structured range. Offline under
PROVIDER_MODE=replay (prompt-keyed cassette route-strip-length.json).
"""
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "StructE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_plain_chat_sets_strip_length_range(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    updates: list[dict] = []
    client.on("gdd_doc_updated", lambda d: updates.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("send_prompt",
                      {"roomId": room_id,
                       "text": "set the reel strip length between 30 and 40"})

    symbols = None
    async with httpx.AsyncClient(base_url=live_server) as http:
        deadline = asyncio.get_running_loop().time() + 15
        while asyncio.get_running_loop().time() < deadline:
            docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
            symbols = next((d for d in docs if d["aspect"] == "symbols-reels"), None)
            if symbols and symbols.get("data", {}).get("strip_length"):
                break
            await asyncio.sleep(0.1)

    assert symbols is not None, "symbols-reels doc missing"
    assert symbols["data"]["strip_length"] == {"min": 30.0, "max": 40.0}, \
        f"field not set: {symbols['data']}"
    assert "30–40" in symbols["body"]

    # Viewer reflects it live via gdd_doc_updated for symbols-reels.
    sr_updates = [u for u in updates if u["doc"]["aspect"] == "symbols-reels"]
    assert sr_updates, "no live gdd_doc_updated for symbols-reels"
    assert sr_updates[-1]["doc"]["data"]["strip_length"] == {"min": 30.0, "max": 40.0}

    await client.disconnect()
