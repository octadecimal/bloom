import pytest
from app.agent_tools import ToolContext, ToolFactory
from app.gdd.hub import GddHub
from app.gdd.store import GddStore


def _ctx(store, hub):
    return ToolContext(room_id="r1", game_id="g1", asset_store=None,
                       asset_hub=None, gdd_store=store, gdd_hub=hub)


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


def _factory(store, hub):
    return ToolFactory(asset_store=None, asset_hub=None, gdd_store=store, gdd_hub=hub)


@pytest.fixture(autouse=True)
async def _clean_gdd_docs(mongo_db):
    await mongo_db["gdd_docs"].delete_many({})
    yield
    await mongo_db["gdd_docs"].delete_many({})


@pytest.mark.asyncio
async def test_write_then_list_then_edit(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    factory = _factory(store, hub)
    ctx = _ctx(store, hub)

    write = factory.build(["write_gdd_doc"], ctx)[0]
    await write.ainvoke({"aspect": "math-model", "title": "Math Model",
                         "body": "RTP: TBD", "status": "drafted"})

    list_tool = factory.build(["list_gdd_docs"], ctx)[0]
    listing = await list_tool.ainvoke({})
    assert "math-model" in listing and "drafted" in listing

    edit = factory.build(["edit_gdd_doc"], ctx)[0]
    await edit.ainvoke({"aspect": "math-model", "old_string": "RTP: TBD",
                        "new_string": "RTP: 96%"})
    assert (await store.get_doc("g1", "math-model")).body == "RTP: 96%"


@pytest.mark.asyncio
async def test_edit_returns_error_string_when_unmatched(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    edit = _factory(store, hub).build(["edit_gdd_doc"], ctx)[0]
    result = await edit.ainvoke({"aspect": "theme", "old_string": "nope",
                                 "new_string": "x"})
    assert "not found" in result.lower()  # surfaced to the agent, not raised


@pytest.mark.asyncio
async def test_set_doc_status(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    tool = _factory(store, hub).build(["set_doc_status"], ctx)[0]
    await tool.ainvoke({"aspect": "audio", "status": "complete"})
    assert (await store.get_doc("g1", "audio")).status == "complete"
