import pytest
import pytest_asyncio
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


class FakeSio:
    def __init__(self):
        self.emitted = []
        self.rooms = []

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room, to))

    async def enter_room(self, sid, room):
        self.rooms.append((sid, room))


@pytest.mark.asyncio
async def test_attach_enters_room_and_sends_snapshot(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    await hub.attach("g1", "sid-1")
    assert ("sid-1", "g1") in sio.rooms
    snap = [e for e in sio.emitted if e[0] == "scene_snapshot"][-1]
    assert snap[1]["gameId"] == "g1"
    assert snap[1]["document"] == {"version": 1, "nodes": {}, "edges": []}
    assert snap[3] == "sid-1"  # to=sid


@pytest.mark.asyncio
async def test_apply_op_broadcasts_scene_op_to_room(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    op = {"kind": "addNode", "id": "root", "type": "Root"}
    await hub.apply_op("g1", op)
    ev = [e for e in sio.emitted if e[0] == "scene_op"][-1]
    assert ev[1] == {"gameId": "g1", "op": op}
    assert ev[2] == "g1"  # room


@pytest.mark.asyncio
async def test_apply_batch_broadcasts_each_op(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    ops = [
        {"kind": "addNode", "id": "root", "type": "Root"},
        {"kind": "addNode", "id": "s", "type": "Sprite"},
    ]
    await hub.apply_batch("g1", ops)
    sent = [e[1]["op"] for e in sio.emitted if e[0] == "scene_op"]
    assert sent == ops
