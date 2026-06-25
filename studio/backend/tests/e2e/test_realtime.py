import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> str:
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/rooms", json={"name": "Realtime"})
        return resp.json()["id"]


class RunRecorder:
    """Records the run-wire events a routed plain-chat turn produces."""

    def __init__(self, client: socketio.AsyncClient):
        self.created: list[dict] = []     # message_created (user messages)
        self.tokens: list[dict] = []      # run_step_token
        self.completed: list[dict] = []   # run_completed
        client.on("message_created", lambda d: self.created.append(d))
        client.on("run_step_token", lambda d: self.tokens.append(d))
        client.on("run_completed", lambda d: self.completed.append(d))

    def text_for(self, run_id: str) -> str:
        return "".join(t["delta"] for t in self.tokens if t["runId"] == run_id)


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_both_clients_receive_streamed_run_tokens(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra, rb = RunRecorder(alice), RunRecorder(bob)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    deadline = asyncio.get_running_loop().time() + 8
    while (not ra.completed or not rb.completed) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert ra.completed and rb.completed, "both clients must see the run complete"
    run_id = ra.completed[-1]["runId"]

    # both clients reconstruct the same streamed run text
    assert ra.text_for(run_id) == rb.text_for(run_id)
    assert ra.text_for(run_id).strip(), "router reply must be non-empty"

    # Alice's user message is attributed to Alice and seen by Bob
    user_msgs = [c["message"] for c in rb.created if c["message"]["role"] == "user"]
    assert user_msgs[-1]["author"] == "Alice"

    await alice.disconnect()
    await bob.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_concurrent_prompts_serialize_into_two_runs(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra = RunRecorder(alice)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    # fire two prompts almost simultaneously; REPLAY_TOKEN_DELAY=0.15 keeps run 1 busy
    await alice.emit("send_prompt", {"roomId": room_id, "text": "first"})
    await bob.emit("send_prompt", {"roomId": room_id, "text": "second"})

    deadline = asyncio.get_running_loop().time() + 10
    while len(ra.completed) < 2 and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert len(ra.completed) == 2, "both prompts answered by exactly one run each"

    async with httpx.AsyncClient(base_url=live_server) as client:
        history = (await client.get(f"/rooms/{room_id}/messages")).json()
        runs = (await client.get(f"/rooms/{room_id}/runs")).json()
    assert [m["role"] for m in history].count("user") == 2   # 2 user messages persisted
    assert len(runs) == 2 and all(r["status"] == "completed" for r in runs)

    # Serialization: run-token streams (by runId) must NOT interleave -> two contiguous runs.
    seq = []
    for t in ra.tokens:
        if not seq or seq[-1] != t["runId"]:
            seq.append(t["runId"])
    assert len(seq) == 2, f"run token streams interleaved: {seq}"

    await alice.disconnect()
    await bob.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_late_joiner_resumes_in_flight_run(live_server):
    room_id = await _make_room(live_server)
    alice = socketio.AsyncClient()
    ra = RunRecorder(alice)
    await alice.connect(live_server, auth={"displayName": "Alice"})
    await alice.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    # Wait until the run is genuinely mid-flight: >=1 token, not completed.
    deadline = asyncio.get_running_loop().time() + 5
    while (len(ra.tokens) < 1 or ra.completed) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.02)
    assert ra.tokens and not ra.completed, "need an in-flight run to resume"
    run_id = ra.tokens[-1]["runId"]

    # Carol joins mid-run and must catch up via run_snapshot.
    carol = socketio.AsyncClient()
    snapshots: list[dict] = []
    carol.on("run_snapshot", lambda d: snapshots.append(d))
    rc = RunRecorder(carol)
    await carol.connect(live_server, auth={"displayName": "Carol"})
    await carol.emit("join_room", {"roomId": room_id})

    deadline = asyncio.get_running_loop().time() + 5
    while (not ra.completed or not rc.completed) and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert rc.completed, "late joiner must see the run complete"

    assert snapshots, "late joiner must receive a run_snapshot"
    snap = snapshots[-1]["run"]
    assert snap["id"] == run_id
    assert snap["status"] == "running"

    await alice.disconnect()
    await carol.disconnect()
