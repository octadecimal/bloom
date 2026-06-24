import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.models import MetricsWire, CurationResult
from app.simulator.store import SlotModelStore
from app.simulator.runner import FakeCurationRunner, CurationProgress
from app.simulator.hub import CurationHub


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})


class FakeSio:
    def __init__(self): self.events = []; self.rooms = []

    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))

    async def enter_room(self, sid, room): self.rooms.append((sid, room))


class FakeGdd:
    def __init__(self, data): self._data = data

    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data) if aspect == "math-model" else None


def _pass_result():
    return CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.9, feature_rtp=0.06, bonus_hit_rates=[]),
        realized_rtp=0.96, pool_size=1000, failure=None, ran_at="t")


@pytest.mark.asyncio
async def test_request_curation_emits_progress_then_complete(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    runner = FakeCurationRunner(
        progress=[CurationProgress("simulate", 1, 2)], result=_pass_result())
    sio = FakeSio()
    hub = CurationHub(sio, store, runner, FakeGdd({"rtp": 0.96, "volatility": "high"}))

    await hub.request_curation("g1")

    names = [e[0] for e in sio.events]
    assert "curation_progress" in names
    assert "curation_complete" in names
    saved = await store.get("g1")
    assert saved.result.status == "pass"


@pytest.mark.asyncio
async def test_request_curation_emits_failed_on_gdd_gap(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    runner = FakeCurationRunner(progress=[], result=_pass_result())
    sio = FakeSio()
    hub = CurationHub(sio, store, runner, FakeGdd({"volatility": "high"}))  # no rtp

    await hub.request_curation("g1")

    names = [e[0] for e in sio.events]
    assert "curation_failed" in names
