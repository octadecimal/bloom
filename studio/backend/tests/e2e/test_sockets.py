import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> str:
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/rooms", json={"name": "E2E"})
        return resp.json()["id"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_join_emits_presence(live_server):
    room_id = await _make_room(live_server)
    client = socketio.AsyncClient()
    presence_events = []
    client.on("presence", lambda data: presence_events.append(data))

    await client.connect(live_server, auth={"displayName": "Alice"})
    await client.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.3)

    assert presence_events
    assert "Alice" in presence_events[-1]["members"]
    await client.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_typing_is_broadcast_to_other_members(live_server):
    room_id = await _make_room(live_server)
    alice = socketio.AsyncClient()
    bob = socketio.AsyncClient()
    bob_typing = []
    bob.on("typing", lambda data: bob_typing.append(data))

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("typing", {"roomId": room_id, "isTyping": True})
    await asyncio.sleep(0.2)

    assert bob_typing
    assert bob_typing[-1]["author"] == "Alice"
    assert bob_typing[-1]["isTyping"] is True
    await alice.disconnect()
    await bob.disconnect()
