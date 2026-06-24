import pytest
from app.scene.sockets import register_scene_handlers


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

    async def attach(self, game_id, sid):
        self.attached.append((game_id, sid))


@pytest.mark.asyncio
async def test_join_scene_attaches_and_leave_leaves():
    sio, hub = FakeSio(), FakeHub()
    register_scene_handlers(sio, hub)
    await sio.handlers["join_scene"]("sid-1", {"gameId": "g1"})
    assert hub.attached == [("g1", "sid-1")]
    await sio.handlers["leave_scene"]("sid-1", {"gameId": "g1"})
    assert sio.left == [("sid-1", "g1")]
