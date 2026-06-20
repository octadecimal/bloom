import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> str:
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/rooms", json={"name": "Realtime"})
        return resp.json()["id"]


class Recorder:
    def __init__(self, client: socketio.AsyncClient):
        self.tokens: list[dict] = []
        self.created: list[dict] = []
        self.completed: list[dict] = []
        client.on("token", lambda d: self.tokens.append(d))
        client.on("message_created", lambda d: self.created.append(d))
        client.on("message_completed", lambda d: self.completed.append(d))

    def text_for(self, message_id: str) -> str:
        return "".join(t["delta"] for t in self.tokens if t["messageId"] == message_id)


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_both_clients_receive_streamed_tokens(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra, rb = Recorder(alice), Recorder(bob)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    # wait for completion on both sides
    deadline = asyncio.get_event_loop().time() + 5
    while (not ra.completed or not rb.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert ra.completed and rb.completed, "both clients must see completion"
    assistant_id = ra.completed[-1]["messageId"]

    # both clients reconstruct the same streamed assistant text
    assert ra.text_for(assistant_id) == rb.text_for(assistant_id)
    assert ra.text_for(assistant_id).strip() == "echo: Alice: hello"

    # Alice's user message is attributed to Alice and seen by Bob
    user_msgs = [c["message"] for c in rb.created if c["message"]["role"] == "user"]
    assert user_msgs[-1]["author"] == "Alice"

    await alice.disconnect()
    await bob.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_concurrent_prompts_serialize_into_two_answers(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra = Recorder(alice)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    # fire two prompts almost simultaneously; FAKE_TOKEN_DELAY=0.15 keeps gen 1 busy
    await alice.emit("send_prompt", {"roomId": room_id, "text": "first"})
    await bob.emit("send_prompt", {"roomId": room_id, "text": "second"})

    deadline = asyncio.get_event_loop().time() + 8
    while len(ra.completed) < 2 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert len(ra.completed) == 2, "both prompts answered exactly once each"

    # verify history persisted: 2 user + 2 assistant messages, all complete
    async with httpx.AsyncClient(base_url=live_server) as client:
        history = (await client.get(f"/rooms/{room_id}/messages")).json()
    roles = [m["role"] for m in history]
    assert roles.count("user") == 2
    assert roles.count("assistant") == 2
    assert all(m["status"] == "complete" for m in history)

    await alice.disconnect()
    await bob.disconnect()
