"""Ported from test_sim_hub.py (2 cases), test_tuner_hub.py (3 cases),
test_analytics_hub.py (4 cases), test_analytics_live.py (1 case) — one MathHub
replaces CurationHub + TunerHub + AnalyticsHub; event names unchanged."""
import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.math.models import (
    GenSnapshotWire, HistogramBinWire, MetricsWire, PopulationStatsWire,
    RunProfileWire, TailWire, TuneResult, WinDistributionWire,
    default_tuning_params,
)
from app.math.store import MathStore, MathRunStore
from app.math.runners.curate import FakeCurationRunner, CurationProgress
from app.math.runners.tune import FakeTunerRunner, TuneProgress
from app.math.hub import MathHub


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
    def __init__(self): self.events = []; self.rooms = []

    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))

    async def enter_room(self, sid, room): self.rooms.append((sid, room))


class FakeGdd:
    def __init__(self, data): self._data = data

    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data) if aspect == "math-model" else None


def _pass_curation_result():
    from app.math.models import CurationResult
    return CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.9, feature_rtp=0.06, bonus_hit_rates=[]),
        realized_rtp=0.96, pool_size=1000, failure=None, ran_at="t")


def _population(diversity: float) -> PopulationStatsWire:
    return PopulationStatsWire(min=0.1, q1=0.2, median=0.3, q3=0.4, max=0.5,
                               mean=0.3, diversity=diversity)


def _pass_tune_result():
    return TuneResult(status="pass", verdict="pass", tuned_model={"reels": [[0]]},
                      metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                                          base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
                      missed=[], trace=[GenSnapshotWire(generation=0, best_fitness=0.0,
                                                        best_rtp=0.9, best_volatility=2.0)],
                      ran_at="t")


def _error_tune_result():
    return TuneResult(status="error", verdict=None, tuned_model=None, metrics=None,
                      missed=[], trace=[], failure="boom", ran_at="t")


def _profile() -> RunProfileWire:
    return RunProfileWire(
        distribution=WinDistributionWire(
            bins=[HistogramBinWire(bin_lo=0.0, bin_hi=None, base=1, feature=0)],
            zero_count=0,
        ),
        tail=TailWire(max_win=10.0, p_ge100x=0.0, p_losing_spin=0.1,
                      longest_dead_streak=3, bonus_trigger_rate=0.02),
        rtp_convergence=[],
    )


def _pass_tune_result_with_profile() -> TuneResult:
    return TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0]]},
        metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[], trace=[GenSnapshotWire(generation=0, best_fitness=0.0,
                                          best_rtp=0.9, best_volatility=2.0)],
        profile=_profile(), failure=None, ran_at="t",
    )


def _error_tune_result_with_profile() -> TuneResult:
    return TuneResult(status="error", verdict=None, tuned_model=None, metrics=None,
                      missed=[], trace=[], profile=None, failure="boom", ran_at="t")


# ── curation (was test_sim_hub.py) ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_request_curation_emits_progress_then_complete(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    runner = FakeCurationRunner(
        progress=[CurationProgress("simulate", 1, 2)], result=_pass_curation_result())
    sio = FakeSio()
    run_store = MathRunStore(mongo_db)
    hub = MathHub(sio, store, run_store, runner, FakeTunerRunner(progress=[], result=_pass_tune_result()),
                 FakeGdd({"rtp": 0.96, "volatility": "high"}))

    await hub.request_curation("g1")

    names = [e[0] for e in sio.events]
    assert "curation_progress" in names
    assert "curation_complete" in names
    saved = await store.get("g1")
    assert saved.result.status == "pass"


@pytest.mark.asyncio
async def test_request_curation_emits_failed_on_gdd_gap(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    runner = FakeCurationRunner(progress=[], result=_pass_curation_result())
    sio = FakeSio()
    run_store = MathRunStore(mongo_db)
    hub = MathHub(sio, store, run_store, runner, FakeTunerRunner(progress=[], result=_pass_tune_result()),
                 FakeGdd({"volatility": "high"}))  # no rtp

    await hub.request_curation("g1")

    names = [e[0] for e in sio.events]
    assert "curation_failed" in names


# ── tuning (was test_tuner_hub.py) ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_request_tune_emits_progress_then_complete(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    run_store = MathRunStore(mongo_db)
    runner = FakeTunerRunner(progress=[TuneProgress(0, 40, -0.5, 0.5, 2.0)],
                             result=_pass_tune_result())
    sio = FakeSio()
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 runner, FakeGdd({"rtp": 0.9, "volatility": "low"}))

    result = await hub.request_tune("g1")

    names = [e[0] for e in sio.events]
    assert "tuning_progress" in names
    assert "tuning_complete" in names
    saved = await store.get("g1")
    assert saved.tune_result.status == "pass"
    runs = await run_store.list_for_game("g1")
    assert len(runs) == 1
    assert runs[0].game_id == "g1"
    assert runs[0].params == saved.tuner_params
    assert result.status == "pass"
    assert isinstance(runs[0].duration_ms, int)


@pytest.mark.asyncio
async def test_request_tune_emits_failed_on_gdd_gap(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    run_store = MathRunStore(mongo_db)
    runner = FakeTunerRunner(progress=[], result=_pass_tune_result())
    sio = FakeSio()
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 runner, FakeGdd({"volatility": "low"}))  # no rtp

    result = await hub.request_tune("g1")

    assert "tuning_failed" in [e[0] for e in sio.events]
    assert result is None
    assert await run_store.list_for_game("g1") == []


@pytest.mark.asyncio
async def test_request_tune_does_not_record_analytics_on_error(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    run_store = MathRunStore(mongo_db)
    runner = FakeTunerRunner(progress=[], result=_error_tune_result())
    sio = FakeSio()
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 runner, FakeGdd({"rtp": 0.9, "volatility": "low"}))

    await hub.request_tune("g1")

    assert "tuning_failed" in [e[0] for e in sio.events]
    assert await run_store.list_for_game("g1") == []


# ── run recording + subscribers (was test_analytics_hub.py) ─────────────────
@pytest.mark.asyncio
async def test_record_run_appends_and_emits_camel_case(mongo_db):
    store = MathStore(mongo_db)
    run_store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 FakeTunerRunner(progress=[], result=_pass_tune_result()), FakeGdd({}))
    params = default_tuning_params()

    doc = await hub.record_run("g1", params, _pass_tune_result_with_profile(), duration_ms=4321)

    saved = await run_store.get(doc.id)
    assert saved is not None
    assert saved.game_id == "g1"
    assert saved.verdict == "pass"
    assert saved.duration_ms == 4321
    assert isinstance(saved.created_at, str) and saved.created_at

    names = [e[0] for e in sio.events]
    assert "run_complete" in names
    event, payload, room = next(e for e in sio.events if e[0] == "run_complete")
    assert room == "g1"
    assert payload["gameId"] == "g1"
    assert payload["run"]["gameId"] == "g1"
    assert payload["run"]["id"] == doc.id
    assert payload["run"]["profile"]["distribution"]["bins"][0]["binHi"] is None


@pytest.mark.asyncio
async def test_record_run_skips_error_status(mongo_db):
    store = MathStore(mongo_db)
    run_store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 FakeTunerRunner(progress=[], result=_pass_tune_result()), FakeGdd({}))
    params = default_tuning_params()

    doc = await hub.record_run("g1", params, _error_tune_result_with_profile(), duration_ms=100)

    assert doc is None
    assert sio.events == []
    docs = await run_store.list_for_game("g1")
    assert docs == []


@pytest.mark.asyncio
async def test_attach_analytics_subscriber_joins_room_and_emits_latest(mongo_db):
    store = MathStore(mongo_db)
    run_store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 FakeTunerRunner(progress=[], result=_pass_tune_result()), FakeGdd({}))
    params = default_tuning_params()
    await hub.record_run("g1", params, _pass_tune_result_with_profile(), duration_ms=10)

    await hub.attach_analytics_subscriber("g1", "sid1")

    assert ("sid1", "g1") in sio.rooms
    event, payload, to = next(e for e in sio.events if e[2] == "sid1")
    assert event == "run_complete"
    assert payload["gameId"] == "g1"


@pytest.mark.asyncio
async def test_attach_analytics_subscriber_no_emit_when_no_runs(mongo_db):
    store = MathStore(mongo_db)
    run_store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 FakeTunerRunner(progress=[], result=_pass_tune_result()), FakeGdd({}))

    await hub.attach_analytics_subscriber("g-empty", "sid1")

    assert ("sid1", "g-empty") in sio.rooms
    assert sio.events == []


# ── live analytics_progress relay (was test_analytics_live.py) ──────────────
@pytest.mark.asyncio
async def test_request_tune_emits_analytics_progress_then_run_complete(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    run_store = MathRunStore(mongo_db)
    sio = FakeSio()
    progress = [
        TuneProgress(0, 40, -0.5, 0.5, 2.0, population=_population(0.42), gene_agreement=[0.1, 0.2]),
        TuneProgress(1, 40, -0.3, 0.6, 1.9, population=_population(0.37), gene_agreement=[0.15, 0.25]),
    ]
    runner = FakeTunerRunner(progress=progress, result=_pass_tune_result())
    hub = MathHub(sio, store, run_store, FakeCurationRunner(progress=[], result=_pass_curation_result()),
                 runner, FakeGdd({"rtp": 0.9, "volatility": "low"}))

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


class _ConfigCapturingTunerRunner:
    def __init__(self, result):
        self._result = result
        self.config: dict | None = None

    async def run(self, seed_model, target, config, on_progress):
        self.config = config
        return self._result


@pytest.mark.asyncio
async def test_request_tune_passes_doc_locks_into_tuner_config(mongo_db):
    from app.math.models import SectionLocks
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []}, locks=SectionLocks(reels=True))
    run_store = MathRunStore(mongo_db)
    runner = _ConfigCapturingTunerRunner(_pass_tune_result())
    sio = FakeSio()
    hub = MathHub(sio, store, run_store,
                  FakeCurationRunner(progress=[], result=_pass_curation_result()),
                  runner, FakeGdd({"rtp": 0.9, "volatility": "low"}))

    await hub.request_tune("g1")

    assert runner.config is not None
    assert runner.config["locks"] == {"reels": True, "paytable": False, "bonus": False}
