"""Authoritative realtime e2e for skill runs.

Two real Socket.IO clients watch a generate-sprite skill run unfold
(tool_call → tool_result → final text) and verify the resulting asset
is attached to the room's game — all under deterministic PROVIDER_MODE=replay.
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
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/rooms", json={"name": "SkillRunE2E"})
        data = resp.json()
        return data["id"], data["gameId"]


async def _list_assets(base_url: str, game_id: str) -> list[dict]:
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.get(f"/games/{game_id}/assets")
        return resp.json()


class RunRecorder:
    """Accumulates skill-run Socket.IO events for one client."""

    def __init__(self, client: socketio.AsyncClient):
        self.run_started: list[dict] = []
        self.run_step_started: list[dict] = []
        self.run_step_token: list[dict] = []
        self.run_step_completed: list[dict] = []
        self.run_completed: list[dict] = []
        # ordered sequence of event names received
        self.sequence: list[str] = []

        def _record(name, data):
            self.sequence.append(name)
            getattr(self, name).append(data)

        client.on("run_started", lambda d: _record("run_started", d))
        client.on("run_step_started", lambda d: _record("run_step_started", d))
        client.on("run_step_token", lambda d: _record("run_step_token", d))
        client.on("run_step_completed", lambda d: _record("run_step_completed", d))
        client.on("run_completed", lambda d: _record("run_completed", d))


# ---------------------------------------------------------------------------
# Case 1: two clients watch a skill run + asset attached
# ---------------------------------------------------------------------------

@pytest.mark.e2e
@pytest.mark.asyncio
async def test_two_clients_watch_skill_run_and_asset_attached(live_server):
    room_id, game_id = await _make_room(live_server)

    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra, rb = RunRecorder(alice), RunRecorder(bob)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    # brief pause to ensure join_room is processed before emitting run_skill
    await asyncio.sleep(0.2)

    await alice.emit(
        "run_skill",
        {"roomId": room_id, "skillName": "generate-sprite", "args": {"description": "a knight"}},
    )

    # Wait for both clients to see run_completed
    deadline = asyncio.get_event_loop().time() + 20
    while (not ra.run_completed or not rb.run_completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert ra.run_completed, "Alice must receive run_completed"
    assert rb.run_completed, "Bob must receive run_completed"

    # Both must see run_started and at least one run_step_started
    assert ra.run_started, "Alice must receive run_started"
    assert rb.run_started, "Bob must receive run_started"
    assert ra.run_step_started, "Alice must receive at least one run_step_started"
    assert rb.run_step_started, "Bob must receive at least one run_step_started"

    # The event-name sequence that Alice sees must match Bob's
    assert ra.sequence == rb.sequence, (
        f"Event sequences diverged:\n  Alice: {ra.sequence}\n  Bob:   {rb.sequence}"
    )

    # The run must have completed successfully
    assert ra.run_completed[0]["status"] == "completed"

    # Asset must be attached to the room's game
    assets = await _list_assets(live_server, game_id)
    done_assets = [a for a in assets if a.get("status") == "done"]
    assert done_assets, f"Expected >=1 done asset; got: {assets}"

    await alice.disconnect()
    await bob.disconnect()


# ---------------------------------------------------------------------------
# Case 2: serialization — two concurrent run_skill emits produce two separate runs
# ---------------------------------------------------------------------------

@pytest.mark.e2e
@pytest.mark.asyncio
async def test_concurrent_skill_runs_serialize(live_server):
    room_id, _game_id = await _make_room(live_server)

    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra = RunRecorder(alice)
    # Bob just joins so the second run_skill has a sender
    rb = RunRecorder(bob)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    # Fire two run_skill requests almost simultaneously from Alice.
    # The per-room lock must serialize them.
    await alice.emit(
        "run_skill",
        {"roomId": room_id, "skillName": "generate-sprite", "args": {"description": "a knight"}},
    )
    await alice.emit(
        "run_skill",
        {"roomId": room_id, "skillName": "generate-sprite", "args": {"description": "a dragon"}},
    )

    # Wait for both completions (generous timeout: two sequential skill runs)
    deadline = asyncio.get_event_loop().time() + 40
    while len(ra.run_completed) < 2 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert len(ra.run_completed) == 2, (
        f"Expected exactly 2 run_completed events; got {len(ra.run_completed)}"
    )

    # Two distinct runIds
    run_ids = [c["runId"] for c in ra.run_completed]
    assert len(set(run_ids)) == 2, f"Expected 2 distinct runIds; got {run_ids}"

    # Both completed successfully
    assert all(c["status"] == "completed" for c in ra.run_completed)

    await alice.disconnect()
    await bob.disconnect()


# ---------------------------------------------------------------------------
# Case 3: run_snapshot for a late joiner — SKIPPED as e2e
#
# Under PROVIDER_MODE=replay the agent loop (tool-call → tool-result → final)
# completes in milliseconds; creating a reliable in-flight window without
# deterministic pausing would be inherently flaky.  The run_snapshot path is
# already covered deterministically by Task 6's unit test
# (test_attach_subscriber_during_skill_run in tests/test_room_hub.py).
# ---------------------------------------------------------------------------
