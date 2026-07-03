import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.store import SlotModelStore
from app.simulator import rest


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})


def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


@pytest.mark.asyncio
async def test_get_seeds_and_put_updates(mongo_db):
    store = SlotModelStore(mongo_db)
    req = _req(sim_store=store)
    got = await rest.get_slot_model("g1", req)
    assert got["gameId"] == "g1"
    updated = await rest.put_slot_model("g1", rest.PutSlotModelBody(model={"reels": [[0]]}), req)
    assert updated["model"] == {"reels": [[0]]}


@pytest.mark.asyncio
async def test_curate_kicks_off(mongo_db):
    store = SlotModelStore(mongo_db)
    calls = []
    hub = SimpleNamespace(request_curation=lambda gid: calls.append(gid))
    # request_curation must be awaitable in prod; here wrap to a coroutine:
    async def _req_cur(gid):
        calls.append(gid)
    hub.request_curation = _req_cur
    req = _req(sim_store=store, sim_hub=hub)
    resp = await rest.curate_slot_model("g1", req)
    # allow the scheduled task to run
    import asyncio
    await asyncio.sleep(0)
    assert calls == ["g1"]


@pytest.mark.asyncio
async def test_put_accepts_presentation_and_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = SlotModelStore(mongo_db, on_change=on_change)
    req = _req(sim_store=store)
    body = rest.PutSlotModelBody(
        model={"rows": 2},
        presentation={"symbols": {"0": {"label": "Ace", "color": "sym-1"}}},
        source="editor",
    )
    updated = await rest.put_slot_model("g1", body, req)
    assert updated["presentation"]["symbols"]["0"]["color"] == "sym-1"
    assert events == ["editor"]
    got = await rest.get_slot_model("g1", req)
    assert got["presentation"]["symbols"]["0"]["label"] == "Ace"
