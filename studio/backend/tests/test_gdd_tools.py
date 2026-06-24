# studio/backend/tests/test_gdd_tools.py
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
async def test_set_gdd_fields_then_read_reports_gaps(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    factory = _factory(store, hub)
    ctx = _ctx(store, hub)

    setter = factory.build(["set_gdd_fields"], ctx)[0]
    msg = await setter.ainvoke(
        {"aspect": "math-model", "fields": {"rtp": "96%", "volatility": "high"}}
    )
    assert "math-model" in msg
    assert (await store.get_doc("g1", "math-model")).data["rtp"] == 0.96

    reader = factory.build(["read_gdd_doc"], ctx)[0]
    view = await reader.ainvoke({"aspect": "math-model"})
    # bonus_hit_rate is required and still empty -> surfaced as a gap
    assert "bonus_hit_rate" in view
    assert "missing required" in view.lower()


@pytest.mark.asyncio
async def test_set_gdd_fields_writes_a_table(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    setter = _factory(store, hub).build(["set_gdd_fields"], ctx)[0]
    await setter.ainvoke({"aspect": "paytable", "fields": {"payouts": [
        {"symbol": "Wild", "3oak": 10, "4oak": 50, "5oak": 500},
    ]}})
    body = (await store.get_doc("g1", "paytable")).body
    assert "| Wild | 10 | 50 | 500 |" in body


@pytest.mark.asyncio
async def test_set_gdd_fields_reports_warnings(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    setter = _factory(store, hub).build(["set_gdd_fields"], ctx)[0]
    msg = await setter.ainvoke(
        {"aspect": "math-model", "fields": {"made_up": "x"}}
    )
    assert "warning" in msg.lower() and "made_up" in msg
