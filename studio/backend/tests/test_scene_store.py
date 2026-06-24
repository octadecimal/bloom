import pytest
import pytest_asyncio
from app.scene.store import GameSceneStore
from app.scene.document import OpError


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_get_or_create_returns_empty_document(mongo_db):
    store = GameSceneStore(mongo_db)
    doc = await store.get_or_create("g1")
    assert doc == {"version": 1, "nodes": {}, "edges": []}


@pytest.mark.asyncio
async def test_apply_op_persists_and_round_trips_dotted_ids(mongo_db):
    store = GameSceneStore(mongo_db)
    await store.apply_op("g1", {"kind": "addNode", "id": "tex.oak", "type": "Texture",
                                "props": {"src": "asset:1"}})
    reread = await store.get_document("g1")
    assert "tex.oak" in reread["nodes"]
    assert reread["nodes"]["tex.oak"]["props"]["src"] == "asset:1"


@pytest.mark.asyncio
async def test_apply_op_invalid_raises_and_leaves_doc_untouched(mongo_db):
    store = GameSceneStore(mongo_db)
    await store.apply_op("g1", {"kind": "addNode", "id": "s", "type": "Sprite"})
    with pytest.raises(OpError):
        await store.apply_op("g1", {"kind": "addNode", "id": "s", "type": "Sprite"})
    doc = await store.get_document("g1")
    assert list(doc["nodes"]) == ["s"]  # no partial mutation


@pytest.mark.asyncio
async def test_apply_batch_is_atomic(mongo_db):
    store = GameSceneStore(mongo_db)
    with pytest.raises(OpError):
        await store.apply_batch("g1", [
            {"kind": "addNode", "id": "a", "type": "Sprite"},
            {"kind": "addNode", "id": "a", "type": "Sprite"},
        ])
    doc = await store.get_document("g1")
    # game_scenes row was created empty by get_or_create; the batch rolled back.
    assert doc["nodes"] == {}
