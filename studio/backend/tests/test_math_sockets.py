"""Ported from test_sim_sockets.py, test_tuner_sockets.py, test_analytics_sockets.py
— one register_math_handlers wires all six event names onto the three
attach_*_subscriber methods."""
import pytest
from app.math.sockets import register_math_handlers


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
        self.sim_attached = []
        self.tuner_attached = []
        self.analytics_attached = []

    async def attach_sim_subscriber(self, game_id, sid):
        self.sim_attached.append((game_id, sid))

    async def attach_tuner_subscriber(self, game_id, sid):
        self.tuner_attached.append((game_id, sid))

    async def attach_analytics_subscriber(self, game_id, sid):
        self.analytics_attached.append((game_id, sid))


@pytest.mark.asyncio
async def test_join_and_leave_sim():
    sio, hub = FakeSio(), FakeHub()
    register_math_handlers(sio, hub)
    await sio.handlers["join_sim"]("sid1", {"gameId": "g1"})
    await sio.handlers["leave_sim"]("sid1", {"gameId": "g1"})
    assert hub.sim_attached == [("g1", "sid1")]
    assert ("sid1", "g1") in sio.left


@pytest.mark.asyncio
async def test_join_and_leave_tuner():
    sio, hub = FakeSio(), FakeHub()
    register_math_handlers(sio, hub)
    await sio.handlers["join_tuner"]("sid1", {"gameId": "g1"})
    await sio.handlers["leave_tuner"]("sid1", {"gameId": "g1"})
    assert hub.tuner_attached == [("g1", "sid1")]
    assert ("sid1", "g1") in sio.left


@pytest.mark.asyncio
async def test_join_and_leave_analytics():
    sio, hub = FakeSio(), FakeHub()
    register_math_handlers(sio, hub)
    await sio.handlers["join_analytics"]("sid1", {"gameId": "g1"})
    await sio.handlers["leave_analytics"]("sid1", {"gameId": "g1"})
    assert hub.analytics_attached == [("g1", "sid1")]
    assert ("sid1", "g1") in sio.left


@pytest.mark.asyncio
async def test_all_six_events_registered():
    sio, hub = FakeSio(), FakeHub()
    register_math_handlers(sio, hub)
    assert set(sio.handlers.keys()) == {
        "join_sim", "leave_sim",
        "join_tuner", "leave_tuner",
        "join_analytics", "leave_analytics",
    }
