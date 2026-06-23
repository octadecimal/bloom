import asyncio
from datetime import datetime, timezone

import pytest
import pytest_asyncio

from app.models import Message
from app.room_hub import RoomHub


class FakeSio:
    def __init__(self):
        self.events: list[tuple] = []
        self.entered: list[tuple] = []

    async def emit(self, event, data=None, room=None, to=None, skip_sid=None):
        self.events.append((event, data, room))

    async def enter_room(self, sid, room):
        self.entered.append((sid, room))

    def names(self):
        return [e[0] for e in self.events]


class FakeStore:
    def __init__(self, model="m:free"):
        self._model = model
        self.messages: list[Message] = []
        self._n = 0

    async def get_room(self, room_id):
        from app.models import Room

        return Room(id=room_id, name="R", model=self._model, created_at=datetime.now(timezone.utc))

    async def add_message(self, room_id, author, role, content, status):
        self._n += 1
        msg = Message(
            id=f"msg{self._n}",
            room_id=room_id,
            author=author,
            role=role,
            content=content,
            status=status,
            created_at=datetime.now(timezone.utc),
        )
        self.messages.append(msg)
        return msg

    async def list_messages(self, room_id):
        return [m for m in self.messages if m.room_id == room_id]

    async def complete_message(self, message_id, content):
        for m in self.messages:
            if m.id == message_id:
                m.content = content
                m.status = "complete"


class GatedChatService:
    """Each stream() call gates on its own release event so tests control timing."""

    def __init__(self):
        self.calls: list[dict] = []

    def new_call(self):
        gate = {"started": asyncio.Event(), "release": asyncio.Event()}
        self.calls.append(gate)
        return gate

    async def stream(self, messages, model):
        gate = self.new_call()
        gate["started"].set()
        await gate["release"].wait()
        for tok in ["a", "b"]:
            yield tok


@pytest.mark.asyncio
async def test_single_prompt_streams_and_completes():
    sio, store, chat = FakeSio(), FakeStore(), GatedChatService()
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "hello")
    await asyncio.wait_for(_wait_calls(chat, 1), timeout=1)
    chat.calls[0]["release"].set()
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=1)

    names = sio.names()
    # user message, generating status, assistant message, 2 tokens, completed, idle status
    assert names.count("message_created") == 2
    assert names.count("token") == 2
    assert "message_completed" in names
    statuses = [d["state"] for e, d, _ in sio.events if e == "ai_status"]
    assert statuses[0] == "generating"
    assert statuses[-1] == "idle"


@pytest.mark.asyncio
async def test_concurrent_prompts_are_serialized():
    sio, store, chat = FakeSio(), FakeStore(), GatedChatService()
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "first")
    await asyncio.wait_for(_wait_calls(chat, 1), timeout=1)  # gen 1 running

    await hub.handle_prompt("r1", "Bob", "second")  # arrives mid-generation
    await asyncio.sleep(0.05)
    # second generation must NOT have started yet
    assert len(chat.calls) == 1
    assert any(e == "ai_status" and d["state"] == "queued" for e, d, _ in sio.events)

    chat.calls[0]["release"].set()  # finish gen 1
    await asyncio.wait_for(_wait_calls(chat, 2), timeout=1)  # gen 2 starts
    chat.calls[1]["release"].set()
    await asyncio.sleep(0.05)

    completed = [d["messageId"] for e, d, _ in sio.events if e == "message_completed"]
    assert len(completed) == 2  # both answered, in order


async def _wait_calls(chat, n):
    while len(chat.calls) < n:
        await asyncio.sleep(0.01)


async def _wait_event(sio, name):
    while name not in sio.names():
        await asyncio.sleep(0.01)


class ExplodingChatService:
    """Fails the first generation, succeeds afterwards."""

    def __init__(self):
        self.calls = 0

    async def stream(self, messages, model):
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("boom")
        for tok in ["ok"]:
            yield tok


@pytest.mark.asyncio
async def test_generation_error_emits_error_and_keeps_draining():
    sio, store, chat = FakeSio(), FakeStore(), ExplodingChatService()
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "first")   # this generation will fail
    await hub.handle_prompt("r1", "Bob", "second")    # queued; must still run

    # an error event must be emitted for the failed generation
    await asyncio.wait_for(_wait_event(sio, "error"), timeout=1)
    # the second (queued) generation must still complete despite the first failing
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=1)
    # let the drain settle to idle
    await asyncio.sleep(0.05)

    assert chat.calls == 2, "second prompt must still be generated after the first errors"
    errors = [d for e, d, _ in sio.events if e == "error"]
    assert errors and errors[0]["roomId"] == "r1"
    completed = [d for e, d, _ in sio.events if e == "message_completed"]
    assert len(completed) == 1  # only the successful second generation completes
    statuses = [d["state"] for e, d, _ in sio.events if e == "ai_status"]
    assert statuses[-1] == "idle"  # room not deadlocked


from app.turn_runner import RunFinished as _RunFinished


class ErrorRunner:
    """Runner that yields only a RunFinished('error') — no tokens."""

    async def run(self, **kw):
        yield _RunFinished("error")


@pytest.mark.asyncio
async def test_runner_error_emits_error_and_keeps_draining():
    """When TurnRunner emits RunFinished('error') on the plain-chat path,
    an 'error' socket event must be emitted and the message must NOT be
    completed (status stays streaming / no message_completed event).
    Subsequent queued turns must still drain."""
    sio = FakeSio()
    store = FakeStore()
    chat = GatedChatService()  # unused by runner path but required positionally
    runner = ErrorRunner()
    hub = RoomHub(sio, store, chat, turn_runner=runner)

    await hub.handle_prompt("r1", "Alice", "first")

    await asyncio.wait_for(_wait_event(sio, "error"), timeout=1)
    # Let the drain settle to idle
    await asyncio.wait_for(_wait_event(sio, "ai_status"), timeout=1)
    await asyncio.sleep(0.05)

    # error event emitted for the room
    errors = [d for e, d, _ in sio.events if e == "error"]
    assert errors and errors[0]["roomId"] == "r1"
    # message must NOT have been completed (no message_completed event)
    assert "message_completed" not in sio.names()
    # room is not deadlocked
    statuses = [d["state"] for e, d, _ in sio.events if e == "ai_status"]
    assert statuses[-1] == "idle"


class StepChatService:
    """Yields tokens one at a time, each gated, so a test can observe mid-stream state."""

    def __init__(self, tokens):
        self._tokens = tokens
        self.go = [asyncio.Event() for _ in tokens]
        self.emitted = [asyncio.Event() for _ in tokens]

    async def stream(self, messages, model):
        for i, tok in enumerate(self._tokens):
            await self.go[i].wait()
            yield tok
            self.emitted[i].set()


@pytest.mark.asyncio
async def test_active_snapshot_tracks_then_clears():
    sio, store, chat = FakeSio(), FakeStore(), StepChatService(["a", "b"])
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "hi")
    chat.go[0].set()
    await asyncio.wait_for(chat.emitted[0].wait(), timeout=1)

    snap = hub.active_snapshot("r1")
    assert snap is not None
    assert snap["content"] == "a"
    assert snap["state"] == "generating"
    assert snap["messageId"] == "msg2"  # msg1 = user prompt, msg2 = assistant

    chat.go[1].set()
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=1)
    assert hub.active_snapshot("r1") is None


@pytest.mark.asyncio
async def test_attach_subscriber_emits_snapshot_to_late_joiner():
    sio, store, chat = FakeSio(), FakeStore(), StepChatService(["a", "b"])
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "hi")
    chat.go[0].set()
    await asyncio.wait_for(chat.emitted[0].wait(), timeout=1)

    await hub.attach_subscriber("r1", "sidCarol")
    assert ("sidCarol", "r1") in sio.entered
    snaps = [d for e, d, _ in sio.events if e == "stream_snapshot"]
    assert snaps, "late joiner must receive a stream_snapshot during generation"
    assert snaps[-1]["messageId"] == "msg2"
    assert snaps[-1]["content"] == "a"
    assert snaps[-1]["state"] == "generating"

    chat.go[1].set()
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=1)


@pytest.mark.asyncio
async def test_attach_subscriber_when_idle_enters_without_snapshot():
    sio, store, chat = FakeSio(), FakeStore(), StepChatService(["a"])
    hub = RoomHub(sio, store, chat)

    await hub.attach_subscriber("r1", "sidEarly")
    assert ("sidEarly", "r1") in sio.entered
    assert [e for e, _, _ in sio.events if e == "stream_snapshot"] == []


# ---------------------------------------------------------------------------
# Skill-run tests (Task 6)
# ---------------------------------------------------------------------------

from app.turn_runner import StepStarted, StepToken, StepCompleted, RunFinished


class SkillFakeStore(FakeStore):
    """FakeStore extended so get_room also sets a game_id attribute."""

    async def get_room(self, room_id):
        from app.models import Room

        room = Room(id=room_id, name="R", model=self._model, created_at=datetime.now(timezone.utc))
        room.game_id = "g1"
        return room


class StubRunner:
    async def run(self, **kw):
        yield StepStarted(0, "tool_call", "generate_asset")
        yield StepCompleted(0, "complete", "{'description': 'knight'}", "generate_asset")
        yield StepStarted(1, "final")
        yield StepToken(1, "Done.")
        yield StepCompleted(1, "complete", "Done.")
        yield RunFinished("completed")


class FakeSkills:
    """Minimal skill registry stub: one skill named 'generate-sprite'."""

    def __init__(self):
        from types import SimpleNamespace
        self._spec = SimpleNamespace(name="generate-sprite", body="make sprites", tools=["generate_asset"])

    def get(self, name):
        return self._spec if name == "generate-sprite" else None

    def validate_args(self, spec, args, *, enforce_required=True):
        return args


class GatedStubRunner:
    """StubRunner that gates mid-run so tests can observe in-flight state."""

    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def run(self, **kw):
        self.started.set()
        await self.release.wait()
        yield StepStarted(0, "final")
        yield StepToken(0, "Hi.")
        yield StepCompleted(0, "complete", "Hi.")
        yield RunFinished("completed")


@pytest_asyncio.fixture
async def room_hub_with_skill(mongo_db):
    from app.runs import RunStore
    sio = FakeSio()
    store = SkillFakeStore()
    chat = GatedChatService()  # unused by skill path but required positionally
    run_store = RunStore(mongo_db)
    skills = FakeSkills()
    runner = StubRunner()
    hub = RoomHub(sio, store, chat, run_store=run_store, turn_runner=runner, skills=skills)
    return hub, sio


@pytest.mark.asyncio
async def test_handle_skill_run_emits_run_events(room_hub_with_skill):
    hub, sio = room_hub_with_skill
    await hub.handle_skill_run("r1", "alice", "generate-sprite", {"description": "knight"})
    # Drain is a background task; wait for run_completed to appear.
    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=2)
    names = [e for (e, _, _) in sio.events]
    # run_started must be the first run-lifecycle event (ai_status may appear before it)
    run_lifecycle = [n for n in names if n.startswith("run_")]
    assert run_lifecycle[0] == "run_started"
    assert "run_step_started" in names and "run_step_token" in names
    assert run_lifecycle[-1] == "run_completed"


async def _wait_event_count(sio, name, n):
    while [e for (e, _, _) in sio.events if e == name].__len__() < n:
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_concurrent_skill_runs_are_serialized(mongo_db):
    """Two concurrent handle_skill_run calls must not overlap — second waits for first."""
    from app.runs import RunStore
    sio = FakeSio()
    store = SkillFakeStore()
    chat = GatedChatService()
    run_store = RunStore(mongo_db)
    skills = FakeSkills()
    gated = GatedStubRunner()
    hub = RoomHub(sio, store, chat, run_store=run_store, turn_runner=gated, skills=skills)

    # Fire first skill run (will block at gated.release inside the drain task)
    await hub.handle_skill_run("r1", "alice", "generate-sprite", {"description": "a"})
    await asyncio.wait_for(gated.started.wait(), timeout=1)

    # Fire second skill run while first is still in progress
    await hub.handle_skill_run("r1", "bob", "generate-sprite", {"description": "b"})
    await asyncio.sleep(0.05)

    # At this point only one run_started should have been emitted
    started_events = [e for (e, _, _) in sio.events if e == "run_started"]
    assert len(started_events) == 1, "second run must not start while first is active"
    assert any(e == "ai_status" and d["state"] == "queued" for e, d, _ in sio.events)

    # Release first; second should now run and finish
    gated.release.set()
    await asyncio.wait_for(_wait_event_count(sio, "run_completed", 2), timeout=3)

    completed_events = [e for (e, _, _) in sio.events if e == "run_completed"]
    assert len(completed_events) == 2, "both runs must complete"


@pytest.mark.asyncio
async def test_attach_subscriber_emits_run_snapshot_during_active_run(mongo_db):
    """A late joiner during an active skill run should receive run_snapshot."""
    from app.runs import RunStore
    sio = FakeSio()
    store = SkillFakeStore()
    chat = GatedChatService()
    run_store = RunStore(mongo_db)
    skills = FakeSkills()
    gated = GatedStubRunner()
    hub = RoomHub(sio, store, chat, run_store=run_store, turn_runner=gated, skills=skills)

    # Start skill run (drain is a background task that blocks at gated.release)
    await hub.handle_skill_run("r1", "alice", "generate-sprite", {"description": "x"})
    await asyncio.wait_for(gated.started.wait(), timeout=1)

    # Late joiner attaches while the run is in-progress
    await hub.attach_subscriber("r1", "sidLate")
    snap_events = [d for (e, d, _) in sio.events if e == "run_snapshot"]
    assert snap_events, "late joiner must receive run_snapshot during active run"
    assert "run" in snap_events[-1]

    # Release the run so cleanup happens and we don't leave dangling tasks
    gated.release.set()
    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=2)


class RaisingRunner:
    """Runner that yields one StepStarted then raises mid-iteration."""

    async def run(self, **kw):
        yield StepStarted(0, "tool_call", "generate_asset")
        raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_skill_run_error_still_completes(mongo_db):
    """If the runner raises mid-iteration, run_completed must still be emitted
    with status='error' and the run must be persisted as terminal in the store."""
    from app.runs import RunStore
    sio = FakeSio()
    store = SkillFakeStore()
    chat = GatedChatService()
    run_store = RunStore(mongo_db)
    skills = FakeSkills()
    runner = RaisingRunner()
    hub = RoomHub(sio, store, chat, run_store=run_store, turn_runner=runner, skills=skills)

    await hub.handle_skill_run("r1", "alice", "generate-sprite", {"description": "knight"})
    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=2)

    # (a) run_completed emitted with status == "error"
    completed_events = [(e, d) for (e, d, _) in sio.events if e == "run_completed"]
    assert completed_events, "run_completed must be emitted even when runner raises"
    assert completed_events[-1][1]["status"] == "error", (
        f"expected status='error', got {completed_events[-1][1]['status']}"
    )
    run_id = completed_events[-1][1]["runId"]

    # (b) persisted run has status == "error" (not left as "running")
    persisted = await run_store.get_run(run_id)
    assert persisted is not None, "run must exist in the store"
    assert persisted.status == "error", (
        f"expected persisted status='error', got {persisted.status}"
    )


@pytest.mark.asyncio
async def test_handle_skill_run_persists_prose_invocation_message(mongo_db):
    """Prose text supplied to handle_skill_run must be persisted as a user message
    and emitted via message_created before the skill run begins."""
    from app.runs import RunStore
    sio = FakeSio()
    store = SkillFakeStore()
    chat = GatedChatService()
    run_store = RunStore(mongo_db)
    skills = FakeSkills()
    runner = StubRunner()
    hub = RoomHub(sio, store, chat, run_store=run_store, turn_runner=runner, skills=skills)

    await hub.handle_skill_run("r1", "alice", "generate-sprite", {}, text="a knight in armor")

    user_msgs = [m for m in store.messages if m.role == "user"]
    assert user_msgs and user_msgs[-1].content == "a knight in armor"
    assert "message_created" in sio.names()


# ---------------------------------------------------------------------------
# Approval gate tests (Task 6)
# ---------------------------------------------------------------------------

import json as _json

from app.turn_runner import ApprovalRequired


class _ApprovalRunner:
    """Yields a delete tool_call, an ApprovalRequired (index=1), then finishes
    after awaiting on_approval."""

    def __init__(self):
        self.decision = None

    async def run(self, *, messages, model, skill, args, ctx, run_id=None, on_approval=None):
        action = {"tool": "delete_asset", "args": {"asset_id": "a1"}, "label": "Delete 'knight'."}
        yield StepStarted(0, "tool_call", "delete_asset")
        yield StepCompleted(0, "complete", "{'asset_id': 'a1'}", "delete_asset")
        # index=1: runner reserved slot 1 for the approval step
        yield ApprovalRequired(action, 1)
        decision = await on_approval(action)
        self.decision = decision
        yield StepStarted(2, "final")
        yield StepCompleted(2, "complete", f"decision={decision}")
        yield RunFinished("completed")


class FakeSkillsWithManageAssets(FakeSkills):
    """Extends FakeSkills to also serve manage-assets."""

    def __init__(self):
        super().__init__()
        from types import SimpleNamespace
        self._manage_spec = SimpleNamespace(
            name="manage-assets",
            body="manage",
            tools=["list_assets", "delete_asset"],
        )

    def get(self, name):
        if name == "manage-assets":
            return self._manage_spec
        return super().get(name)


async def _wait(pred, timeout=2):
    """Poll pred() every 10 ms until it returns truthy or timeout is reached."""
    import asyncio as _asyncio
    deadline = _asyncio.get_event_loop().time() + timeout
    while not pred():
        if _asyncio.get_event_loop().time() >= deadline:
            raise TimeoutError("_wait timed out")
        await _asyncio.sleep(0.01)


def _build_approval_hub(mongo_db, runner, approval_timeout=None):
    from app.runs import RunStore
    sio = FakeSio()
    store = SkillFakeStore()
    chat = GatedChatService()
    run_store = RunStore(mongo_db)
    skills = FakeSkillsWithManageAssets()
    hub = RoomHub(sio, store, chat, run_store=run_store, turn_runner=runner, skills=skills)
    if approval_timeout is not None:
        hub._approval_timeout = approval_timeout
    return hub


@pytest.mark.asyncio
async def test_skill_run_emits_approval_step_and_resolves_approve(mongo_db):
    runner = _ApprovalRunner()
    hub = _build_approval_hub(mongo_db, runner)
    sio = hub._sio

    # handle_skill_run spawns a background drain task; do NOT await for completion here
    await hub.handle_skill_run("r1", "Alice", "manage-assets", {"target": "knight"})

    # Wait until the approval run_step_started event appears
    await asyncio.wait_for(
        _wait(lambda: any(
            e == "run_step_started" and d.get("step", {}).get("type") == "approval"
            for e, d, _ in sio.events
        )),
        timeout=2,
    )

    # Extract runId from run_started event
    run_id = next(d["run"]["id"] for e, d, _ in sio.events if e == "run_started")

    # Resolve approval
    await hub.resolve_approval("r1", run_id, "approve")

    # Wait for run_completed
    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=2)

    # Assert run completed successfully
    completed_events = [(e, d) for e, d, _ in sio.events if e == "run_completed"]
    assert completed_events and completed_events[-1][1]["status"] == "completed"

    # Assert approval step had index=1
    approval_started = [
        d for e, d, _ in sio.events
        if e == "run_step_started" and d.get("step", {}).get("type") == "approval"
    ]
    assert approval_started, "approval run_step_started must be emitted"
    assert approval_started[0]["step"]["index"] == 1

    # Assert run_step_completed at stepIndex=1 contains decision and label
    approval_completed = [
        d for e, d, _ in sio.events
        if e == "run_step_completed" and d.get("stepIndex") == 1
    ]
    assert approval_completed, "run_step_completed for approval step must be emitted"
    content = _json.loads(approval_completed[0]["content"])
    assert content.get("decision") == "approve"
    assert "knight" in _json.dumps(content)  # label preserved


@pytest.mark.asyncio
async def test_approval_timeout_denies(mongo_db):
    runner = _ApprovalRunner()
    hub = _build_approval_hub(mongo_db, runner, approval_timeout=0.1)
    sio = hub._sio

    # Fire the skill run; the timeout will auto-deny without resolve_approval
    await hub.handle_skill_run("r1", "Alice", "manage-assets", {"target": "knight"})

    # Wait for run_completed (timeout path must drive the run to completion)
    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=3)

    assert runner.decision == "deny"


class _RaisingAfterApprovalRunner:
    """Yields StepStarted + StepCompleted + ApprovalRequired, then raises BEFORE
    the on_approval callback is ever awaited — simulating a mid-run failure after
    the approval entry has been registered but before it is resolved."""

    async def run(self, *, messages, model, skill, args, ctx, run_id=None, on_approval=None):
        action = {"tool": "delete_asset", "args": {"asset_id": "a1"}, "label": "Delete 'knight'."}
        yield StepStarted(0, "tool_call", "delete_asset")
        yield StepCompleted(0, "complete", "{'asset_id': 'a1'}", "delete_asset")
        yield ApprovalRequired(action, 1)
        # Raise immediately — never awaits on_approval, so the future is never resolved.
        raise RuntimeError("boom")


@pytest.mark.asyncio
async def test_pending_approval_future_not_leaked_on_runner_failure(mongo_db):
    """If the runner raises after registering an approval (but before resolving it),
    _run_skill's finally block must cancel+remove the pending entry so
    hub._pending_approvals is empty when the run is done."""
    runner = _RaisingAfterApprovalRunner()
    hub = _build_approval_hub(mongo_db, runner)
    sio = hub._sio

    await hub.handle_skill_run("r1", "Alice", "manage-assets", {"target": "knight"})

    # Wait for run_completed (will have status="error")
    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=2)

    # The completed event must carry status="error"
    completed_events = [(e, d) for e, d, _ in sio.events if e == "run_completed"]
    assert completed_events and completed_events[-1][1]["status"] == "error"

    # The pending_approvals dict must be empty — no future leak
    assert hub._pending_approvals == {}, (
        f"Expected no pending approvals after error, got: {hub._pending_approvals}"
    )
