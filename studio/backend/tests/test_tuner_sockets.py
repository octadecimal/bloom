import pytest
from app.tuner.sockets import register_tuner_handlers


class RecordingSio:
    def __init__(self): self.handlers = {}; self.left = []
    def on(self, event):
        def deco(fn): self.handlers[event] = fn; return fn
        return deco
    async def leave_room(self, sid, room): self.left.append((sid, room))


class RecordingHub:
    def __init__(self): self.joined = []
    async def attach_subscriber(self, game_id, sid): self.joined.append((game_id, sid))


@pytest.mark.asyncio
async def test_join_and_leave_handlers():
    sio = RecordingSio()
    hub = RecordingHub()
    register_tuner_handlers(sio, hub)
    await sio.handlers["join_tuner"]("sid1", {"gameId": "g1"})
    await sio.handlers["leave_tuner"]("sid1", {"gameId": "g1"})
    assert hub.joined == [("g1", "sid1")]
    assert sio.left == [("sid1", "g1")]
