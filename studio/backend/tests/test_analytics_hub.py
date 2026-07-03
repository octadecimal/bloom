import pytest
import pytest_asyncio
from app.tuner.models import TuneResult, GenSnapshotWire, default_tuning_params
from app.simulator.models import MetricsWire
from app.tuner.models import RunProfileWire, WinDistributionWire, HistogramBinWire, TailWire
from app.analytics.store import MathRunStore
from app.analytics.hub import AnalyticsHub


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["math_runs"].delete_many({})
    yield
    await mongo_db["math_runs"].delete_many({})


class FakeSio:
    def __init__(self):
        self.events = []
        self.rooms = []

    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))

    async def enter_room(self, sid, room):
        self.rooms.append((sid, room))


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


def _pass_result() -> TuneResult:
    return TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0]]},
        metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[], trace=[GenSnapshotWire(generation=0, best_fitness=0.0,
                                          best_rtp=0.9, best_volatility=2.0)],
        profile=_profile(), failure=None, ran_at="t",
    )


def _error_result() -> TuneResult:
    return TuneResult(status="error", verdict=None, tuned_model=None, metrics=None,
                      missed=[], trace=[], profile=None, failure="boom", ran_at="t")


@pytest.mark.asyncio
async def test_record_run_appends_and_emits_camel_case(mongo_db):
    store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = AnalyticsHub(sio, store)
    params = default_tuning_params()

    doc = await hub.record_run("g1", params, _pass_result(), duration_ms=4321)

    saved = await store.get(doc.id)
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
    store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = AnalyticsHub(sio, store)
    params = default_tuning_params()

    doc = await hub.record_run("g1", params, _error_result(), duration_ms=100)

    assert doc is None
    assert sio.events == []
    docs = await store.list_for_game("g1")
    assert docs == []


@pytest.mark.asyncio
async def test_attach_subscriber_joins_room_and_emits_latest(mongo_db):
    store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = AnalyticsHub(sio, store)
    params = default_tuning_params()
    await hub.record_run("g1", params, _pass_result(), duration_ms=10)

    await hub.attach_subscriber("g1", "sid1")

    assert ("sid1", "g1") in sio.rooms
    event, payload, to = next(e for e in sio.events if e[2] == "sid1")
    assert event == "run_complete"
    assert payload["gameId"] == "g1"


@pytest.mark.asyncio
async def test_attach_subscriber_no_emit_when_no_runs(mongo_db):
    store = MathRunStore(mongo_db)
    sio = FakeSio()
    hub = AnalyticsHub(sio, store)

    await hub.attach_subscriber("g-empty", "sid1")

    assert ("sid1", "g-empty") in sio.rooms
    assert sio.events == []
