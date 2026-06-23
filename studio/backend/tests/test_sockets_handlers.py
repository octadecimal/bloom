"""Unit tests for socket handler registration (no live server required)."""

import pytest

from app.sockets import register_socket_handlers


class _Sio:
    """Fake socket.io server that captures registered handlers."""

    def __init__(self):
        self._handlers = {}

    def event(self, fn):
        self._handlers[fn.__name__] = fn
        return fn

    def on(self, name):
        def deco(fn):
            self._handlers[name] = fn
            return fn

        return deco

    async def save_session(self, *a, **k):
        pass

    async def get_session(self, sid):
        return {"displayName": "Alice"}

    async def emit(self, *a, **k):
        pass

    async def enter_room(self, *a, **k):
        pass

    async def leave_room(self, *a, **k):
        pass


class _FakePresence:
    def leave_all(self, sid):
        return []

    def members(self, room_id):
        return []

    def join(self, room_id, sid, name):
        pass

    def leave(self, room_id, sid):
        pass


class _Hub:
    def __init__(self):
        self.resolve_approval_calls = []

    async def resolve_approval(self, room_id, run_id, decision):
        self.resolve_approval_calls.append((room_id, run_id, decision))

    async def attach_subscriber(self, *a, **k):
        pass

    async def handle_prompt(self, *a, **k):
        pass

    async def handle_skill_run(self, *a, **k):
        pass


@pytest.mark.asyncio
async def test_resolve_approval_handler_forwards_to_hub():
    sio = _Sio()
    hub = _Hub()
    presence = _FakePresence()

    register_socket_handlers(sio, hub, presence)

    handler = sio._handlers["resolve_approval"]
    await handler("sid1", {"roomId": "r1", "runId": "run1", "decision": "approve"})

    assert hub.resolve_approval_calls == [("r1", "run1", "approve")]
