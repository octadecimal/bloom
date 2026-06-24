import pytest
import pytest_asyncio
from app.gdd.hub import GddHub
from app.gdd.store import GddStore


@pytest_asyncio.fixture(autouse=True)
async def _clean_gdd_docs(mongo_db):
    # The shared mongo_db fixture does not wipe gdd_docs, so clear it here to
    # keep each test deterministic regardless of leftover state from prior runs.
    await mongo_db["gdd_docs"].delete_many({})
    yield
    await mongo_db["gdd_docs"].delete_many({})


class FakeSio:
    def __init__(self):
        self.emitted = []
        self.rooms = []

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room, to))

    async def enter_room(self, sid, room):
        self.rooms.append((sid, room))


@pytest.mark.asyncio
async def test_set_fields_persists_and_emits_update(mongo_db):
    sio, store = FakeSio(), GddStore(mongo_db)
    hub = GddHub(sio, store)
    await hub.seed_taxonomy("g1")
    doc, warnings = await hub.set_fields(
        "g1", "math-model",
        {"rtp": "96%", "volatility": "high", "bonus_hit_rate": "1:200"},
    )
    assert warnings == [] and doc.status == "drafted"
    events = [e for e in sio.emitted if e[0] == "gdd_doc_updated"]
    last = events[-1]
    assert last[1]["gameId"] == "g1"
    assert last[1]["doc"]["aspect"] == "math-model"
    assert last[2] == "g1"  # room


@pytest.mark.asyncio
async def test_attach_enters_room_and_sends_snapshot(mongo_db):
    sio, store = FakeSio(), GddStore(mongo_db)
    hub = GddHub(sio, store)
    await hub.seed_taxonomy("g1")
    await hub.attach("g1", "sid-1")
    assert ("sid-1", "g1") in sio.rooms
    snap = [e for e in sio.emitted if e[0] == "gdd_snapshot"][-1]
    assert snap[1]["gameId"] == "g1"
    assert len(snap[1]["docs"]) == 7
    assert snap[3] == "sid-1"  # to=sid
