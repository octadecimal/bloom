"""Unit tests for simulator socket handlers."""

import pytest

from app.simulator.sockets import register_sim_handlers


class FakeSio:
    def __init__(self):
        self.handlers = {}
        self.left = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn

        return deco

    async def leave_room(self, sid, room):
        self.left.append((sid, room))


class FakeHub:
    def __init__(self):
        self.attached = []

    async def attach_subscriber(self, game_id, sid):
        self.attached.append((game_id, sid))


@pytest.mark.asyncio
async def test_join_and_leave():
    sio, hub = FakeSio(), FakeHub()
    register_sim_handlers(sio, hub)
    await sio.handlers["join_sim"]("sid1", {"gameId": "g1"})
    await sio.handlers["leave_sim"]("sid1", {"gameId": "g1"})
    assert hub.attached == [("g1", "sid1")]
    assert sio.left == [("sid1", "g1")]
