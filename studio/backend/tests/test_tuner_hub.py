import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.models import MetricsWire
from app.simulator.store import SlotModelStore
from app.tuner.models import TuneResult, GenSnapshotWire
from app.tuner.store import TunerStore
from app.tuner.runner import FakeTunerRunner, TuneProgress
from app.tuner.hub import TunerHub


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})


class FakeSio:
    def __init__(self): self.events = []
    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))
    async def enter_room(self, sid, room): pass


class FakeGdd:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data) if aspect == "math-model" else None


def _pass_result():
    return TuneResult(status="pass", verdict="pass", tuned_model={"reels": [[0]]},
                      metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                                          base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
                      missed=[], trace=[GenSnapshotWire(generation=0, best_fitness=0.0,
                                                        best_rtp=0.9, best_volatility=2.0)],
                      ran_at="t")


@pytest.mark.asyncio
async def test_request_tune_emits_progress_then_complete(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"bonuses": []})
    tuner = TunerStore(mongo_db)
    runner = FakeTunerRunner(progress=[TuneProgress(0, 40, -0.5, 0.5, 2.0)], result=_pass_result())
    sio = FakeSio()
    hub = TunerHub(sio, tuner, sim, runner, FakeGdd({"rtp": 0.9, "volatility": "low"}))

    await hub.request_tune("g1")

    names = [e[0] for e in sio.events]
    assert "tuning_progress" in names
    assert "tuning_complete" in names
    saved = await tuner.get("g1")
    assert saved.result.status == "pass"


@pytest.mark.asyncio
async def test_request_tune_emits_failed_on_gdd_gap(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"bonuses": []})
    tuner = TunerStore(mongo_db)
    runner = FakeTunerRunner(progress=[], result=_pass_result())
    sio = FakeSio()
    hub = TunerHub(sio, tuner, sim, runner, FakeGdd({"volatility": "low"}))  # no rtp

    await hub.request_tune("g1")

    assert "tuning_failed" in [e[0] for e in sio.events]
