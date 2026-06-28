import pytest
import pytest_asyncio
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore
from app.scene.sockets import register_scene_handlers


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


class FakeSio:
    """Captures @sio.on handlers so they can be invoked directly, and records emits."""

    def __init__(self):
        self.handlers = {}
        self.emitted = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room, to))

    async def enter_room(self, sid, room):
        pass

    async def leave_room(self, sid, room):
        pass


async def _seed_sprite(hub):
    await hub.apply_op("g1", {"kind": "addNode", "id": "s", "type": "Sprite"})


@pytest.mark.asyncio
async def test_setprop_calls_hub_and_broadcasts(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub, None, None, None)
    await _seed_sprite(hub)
    sio.emitted.clear()

    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "setProp", "id": "s", "path": "x", "value": 5}}
    )

    ops = [e for e in sio.emitted if e[0] == "scene_op"]
    assert ops, "expected a scene_op broadcast"
    assert ops[-1][1]["op"] == {"kind": "setProp", "id": "s", "path": "x", "value": 5}
    assert ops[-1][2] == "g1"  # room broadcast
    doc = await hub._store.get_document("g1")
    assert doc["nodes"]["s"]["props"]["x"] == 5


@pytest.mark.asyncio
async def test_non_setprop_kind_is_rejected_without_touching_hub(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub, None, None, None)
    sio.emitted.clear()

    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "addNode", "id": "x", "type": "Sprite"}}
    )

    assert not [e for e in sio.emitted if e[0] == "scene_op"], "hub must not be called"
    rej = [e for e in sio.emitted if e[0] == "scene_op_rejected"]
    assert rej, "expected a rejection"
    assert rej[-1][1]["code"] == "forbidden_kind"
    assert rej[-1][3] == "sid-1"  # to=sid only


@pytest.mark.asyncio
async def test_operror_is_reported_as_rejection_to_sender(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub, None, None, None)
    sio.emitted.clear()

    # setProp on a node that does not exist -> OpError("unknown_node")
    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "setProp", "id": "ghost", "path": "x", "value": 1}}
    )

    rej = [e for e in sio.emitted if e[0] == "scene_op_rejected"]
    assert rej, "expected a rejection"
    assert rej[-1][1]["code"] == "unknown_node"
    assert rej[-1][3] == "sid-1"


@pytest.mark.asyncio
async def test_setprop_missing_id_is_rejected_as_bad_op(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub, None, None, None)
    sio.emitted.clear()

    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "setProp", "path": "x", "value": 5}}
    )

    assert not [e for e in sio.emitted if e[0] == "scene_op"], "hub must not be called"
    rej = [e for e in sio.emitted if e[0] == "scene_op_rejected"]
    assert rej, "expected a rejection"
    assert rej[-1][1]["code"] == "bad_op"
    assert rej[-1][3] == "sid-1"


@pytest.mark.asyncio
async def test_setprop_missing_value_key_is_rejected_as_bad_op(mongo_db):
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub, None, None, None)
    sio.emitted.clear()

    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "setProp", "id": "s", "path": "x"}}
    )

    assert not [e for e in sio.emitted if e[0] == "scene_op"], "hub must not be called"
    rej = [e for e in sio.emitted if e[0] == "scene_op_rejected"]
    assert rej, "expected a rejection"
    assert rej[-1][1]["code"] == "bad_op"
    assert rej[-1][3] == "sid-1"


@pytest.mark.asyncio
async def test_setprop_value_null_is_not_rejected_as_bad_op(mongo_db):
    """value: null is a legitimate value; key presence, not truthiness, is what matters."""
    sio = FakeSio()
    hub = GameSceneHub(sio, GameSceneStore(mongo_db))
    register_scene_handlers(sio, hub, None, None, None)
    await _seed_sprite(hub)
    sio.emitted.clear()

    await sio.handlers["scene_apply_op"](
        "sid-1", {"gameId": "g1", "op": {"kind": "setProp", "id": "s", "path": "x", "value": None}}
    )

    bad_op = [e for e in sio.emitted if e[0] == "scene_op_rejected" and e[1]["code"] == "bad_op"]
    assert not bad_op, "value=null must not trigger bad_op rejection"
    # Hub was called — op should broadcast
    ops = [e for e in sio.emitted if e[0] == "scene_op"]
    assert ops, "expected hub to be called and broadcast scene_op"
