import asyncio
from datetime import datetime, timezone

import pytest

from app.models import Message
from app.room_hub import RoomHub


class FakeSio:
    def __init__(self):
        self.events: list[tuple] = []

    async def emit(self, event, data=None, room=None):
        self.events.append((event, data, room))

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
