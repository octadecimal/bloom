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
    reply = ra.text_for(assistant_id).strip()
    assert reply, "assistant reply must be non-empty"
    assert not reply.startswith("echo:"), "reply must come from replay cassette, not fake echo provider"

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

    # fire two prompts almost simultaneously; REPLAY_TOKEN_DELAY=0.15 keeps gen 1 busy
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

    # Serialization: the two assistant token streams must NOT interleave.
    # Collapse ra.tokens' messageId sequence into contiguous runs; correct
    # per-room serialization yields exactly two runs (msg1 fully, then msg2).
    runs = []
    for t in ra.tokens:
        if not runs or runs[-1] != t["messageId"]:
            runs.append(t["messageId"])
    assert len(runs) == 2, f"assistant token streams interleaved: {runs}"

    await alice.disconnect()
    await bob.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_late_joiner_resumes_in_flight_stream(live_server):
    room_id = await _make_room(live_server)
    alice = socketio.AsyncClient()
    ra = Recorder(alice)
    await alice.connect(live_server, auth={"displayName": "Alice"})
    await alice.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    # Wait until the stream is genuinely mid-flight: Alice has >=1 token, no completion yet.
    deadline = asyncio.get_event_loop().time() + 5
    while (len(ra.tokens) < 1 or ra.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.02)
    assert ra.tokens and not ra.completed, "need an in-flight stream to resume"

    # Carol joins mid-stream and must catch up via stream_snapshot.
    carol = socketio.AsyncClient()
    snapshots: list[dict] = []
    carol.on("stream_snapshot", lambda d: snapshots.append(d))
    rc = Recorder(carol)
    await carol.connect(live_server, auth={"displayName": "Carol"})
    await carol.emit("join_room", {"roomId": room_id})

    deadline = asyncio.get_event_loop().time() + 5
    while (not ra.completed or not rc.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert rc.completed, "late joiner must see completion"

    assistant_id = ra.completed[-1]["messageId"]
    assert snapshots, "late joiner must receive a stream_snapshot"
    snap = snapshots[-1]
    assert snap["messageId"] == assistant_id
    assert snap["state"] == "generating"
    assert snap["content"], "snapshot carries the partial content accumulated so far"

    # Alice (present from start) reconstructs the full reply from the replay cassette.
    alice_full = ra.text_for(assistant_id).strip()
    assert alice_full, "assistant reply must be non-empty"
    assert not alice_full.startswith("echo:"), "reply must come from replay cassette, not fake echo provider"

    # snapshot content + tokens Carol received AFTER joining == full text, exactly (no gap/dup)
    carol_reconstructed = (snap["content"] + rc.text_for(assistant_id)).strip()
    assert carol_reconstructed == alice_full, (
        f"late joiner reconstruction mismatch: snap={snap['content']!r} + "
        f"carol_tokens={rc.text_for(assistant_id)!r} != alice_full={alice_full!r}"
    )

    await alice.disconnect()
    await carol.disconnect()
