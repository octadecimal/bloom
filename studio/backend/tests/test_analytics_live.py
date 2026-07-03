"""Live progress relay: during a tune, TunerHub.request_tune ALSO emits an
enriched `analytics_progress` frame on the analytics room for every generation,
alongside the existing `tuning_progress`. Ephemeral — not persisted; the
persisted run doc still comes from AnalyticsHub.record_run at completion."""
import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.models import MetricsWire
from app.simulator.store import SlotModelStore
from app.analytics.store import MathRunStore
from app.analytics.hub import AnalyticsHub
from app.tuner.models import TuneResult, GenSnapshotWire, PopulationStatsWire
from app.tuner.store import TunerStore
from app.tuner.runner import FakeTunerRunner, TuneProgress
from app.tuner.hub import TunerHub


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    await mongo_db["math_runs"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    await mongo_db["math_runs"].delete_many({})


class FakeSio:
    def __init__(self): self.events = []
    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))
    async def enter_room(self, sid, room): pass


class FakeGdd:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data) if aspect == "math-model" else None


def _population(diversity: float) -> PopulationStatsWire:
    return PopulationStatsWire(min=0.1, q1=0.2, median=0.3, q3=0.4, max=0.5, mean=0.3, diversity=diversity)


def _pass_result():
    return TuneResult(status="pass", verdict="pass", tuned_model={"reels": [[0]]},
                      metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                                          base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
                      missed=[], trace=[GenSnapshotWire(generation=0, best_fitness=0.0,
                                                        best_rtp=0.9, best_volatility=2.0)],
                      ran_at="t")


@pytest.mark.asyncio
async def test_request_tune_emits_analytics_progress_then_run_complete(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"bonuses": []})
    tuner = TunerStore(mongo_db)
    runs = MathRunStore(mongo_db)
    sio = FakeSio()
    analytics = AnalyticsHub(sio, runs)  # real hub: run_complete must actually fire
    progress = [
        TuneProgress(0, 40, -0.5, 0.5, 2.0, population=_population(0.42), gene_agreement=[0.1, 0.2]),
        TuneProgress(1, 40, -0.3, 0.6, 1.9, population=_population(0.37), gene_agreement=[0.15, 0.25]),
    ]
    runner = FakeTunerRunner(progress=progress, result=_pass_result())
    hub = TunerHub(sio, tuner, sim, runner, FakeGdd({"rtp": 0.9, "volatility": "low"}), analytics)

    await hub.request_tune("g1")

    analytics_events = [e for e in sio.events if e[0] == "analytics_progress"]
    assert len(analytics_events) == 2
    for (event, payload, room), p in zip(analytics_events, progress):
        assert room == "g1"
        assert payload["gameId"] == "g1"
        assert payload["generation"] == p.generation
        assert payload["maxGenerations"] == p.max_generations
        assert payload["best"] == {
            "fitness": p.best_fitness, "rtp": p.best_rtp, "volatility": p.best_volatility,
        }
        assert payload["population"]["diversity"] == p.population.diversity
        assert payload["population"]["median"] == p.population.median
        assert payload["geneAgreement"] == p.gene_agreement

    names = [e[0] for e in sio.events]
    assert names.count("analytics_progress") == 2
    # the enriched frames precede the persisted run; run_complete is final.
    assert names[-1] == "run_complete"
    assert names.index("run_complete") > max(
        i for i, n in enumerate(names) if n == "analytics_progress"
    )
