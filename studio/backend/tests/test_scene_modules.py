import pytest
import pytest_asyncio
from app.scene.document import empty_document
from app.scene.store import GameSceneStore


@pytest_asyncio.fixture(autouse=True)
async def _clean_scenes(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    yield
    await mongo_db["game_scenes"].delete_many({})


def test_empty_document_has_modules_list():
    assert empty_document()["modules"] == []


@pytest.mark.asyncio
async def test_set_modules_persists_and_survives_node_ops(mongo_db):
    store = GameSceneStore(mongo_db)
    decl = [{"id": "reels", "type": "reels", "config": {"cols": 3, "rows": 3}}]
    await store.set_modules("g1", decl)

    # A subsequent node op must NOT wipe the modules declaration.
    await store.apply_op("g1", {"kind": "addNode", "id": "root", "type": "Root", "props": {}})
    doc = await store.get_document("g1")
    assert doc["modules"] == decl
    assert "root" in doc["nodes"]
