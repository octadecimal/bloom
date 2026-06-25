import pytest
import pytest_asyncio
from app.agent_tools import ToolContext, ToolFactory
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


def _ctx(store, hub):
    return ToolContext(room_id="r1", game_id="g1", asset_store=None, asset_hub=None,
                       scene_store=store, scene_hub=hub)


def _factory(store, hub):
    return ToolFactory(asset_store=None, asset_hub=None, scene_store=store, scene_hub=hub)


@pytest.mark.asyncio
async def test_add_node_then_set_prop(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)

    add = f.build(["scene_add_node"], ctx)[0]
    out = await add.ainvoke({"node_id": "root", "type": "Root",
                             "props_json": '{"width": 1280, "height": 720}'})
    assert "root" in out

    sp = f.build(["scene_set_prop"], ctx)[0]
    await sp.ainvoke({"node_id": "root", "path": "background", "value_json": '"#101014"'})
    doc = await store.get_document("g1")
    assert doc["nodes"]["root"]["props"]["background"] == "#101014"


@pytest.mark.asyncio
async def test_invalid_op_returns_error_string_not_raise(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)
    rm = f.build(["scene_remove_node"], ctx)[0]
    out = await rm.ainvoke({"node_id": "ghost"})
    assert "rejected" in out.lower() and "unknown_node" in out


@pytest.mark.asyncio
async def test_orphan_sprite_warns_until_parented(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)
    add = f.build(["scene_add_node"], ctx)[0]
    conn = f.build(["scene_connect"], ctx)[0]

    await add.ainvoke({"node_id": "root", "type": "Root"})
    out = await add.ainvoke({"node_id": "s", "type": "Sprite"})
    assert "not parented" in out.lower() and "s" in out  # orphan warning

    out2 = await conn.ainvoke({"edge_id": "e", "type": "child",
                               "from_node": "root", "from_port": "children",
                               "to_node": "s", "to_port": "parent"})
    assert "not parented" not in out2.lower()  # cleared once parented


@pytest.mark.asyncio
async def test_connect_and_apply_batch(mongo_db):
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    f, ctx = _factory(store, hub), _ctx(store, hub)

    batch = f.build(["scene_apply_batch"], ctx)[0]
    out = await batch.ainvoke({"ops_json":
        '[{"kind":"addNode","id":"root","type":"Root"},'
        ' {"kind":"addNode","id":"s","type":"Sprite"}]'})
    assert "2" in out

    conn = f.build(["scene_connect"], ctx)[0]
    await conn.ainvoke({"edge_id": "e1", "type": "child",
                        "from_node": "root", "from_port": "children",
                        "to_node": "s", "to_port": "parent"})
    doc = await store.get_document("g1")
    assert doc["edges"][0]["id"] == "e1"
