import asyncio
from types import SimpleNamespace

import pytest

from app.math.hub import MathHub
from app.math.models import CurationResult, MetricsWire, TuneResult
from app.math.runners.curate import FakeCurationRunner
from app.math.runners.tune import FakeTunerRunner
from app.math.store import MathRunStore, MathStore


class FakeSio:
    def __init__(self):
        self.emits: list[tuple[str, dict]] = []

    async def emit(self, event, payload, room=None, to=None):
        self.emits.append((event, payload))

    async def enter_room(self, sid, room):
        pass

    def phases(self):
        return [p["phase"] for e, p in self.emits if e == "generate_status"]

    def count(self, event):
        return sum(1 for e, _ in self.emits if e == event)


class FakeGdd:
    """Returns a complete math-model intent (or None when empty=True)."""

    def __init__(self, empty=False):
        self._empty = empty

    async def get_doc(self, game_id, aspect):
        if self._empty:
            return None
        return SimpleNamespace(data={"rtp": 0.96, "volatility": "medium",
                                     "bonus_hit_rate": "1:150"})


class RecordingCurationRunner:
    def __init__(self, result):
        self._result = result
        self.models: list[dict] = []

    async def run(self, model, target, on_progress):
        self.models.append(model)
        return self._result


class GatedTunerRunner:
    def __init__(self, result):
        self._result = result
        self.gate = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress):
        await self.gate.wait()
        return self._result


def _metrics():
    return MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


def _pass_tune():
    return TuneResult(status="pass", verdict="pass", tuned_model={"rows": 7},
                      metrics=_metrics(), ran_at="t1")


def _pass_curation():
    return CurationResult(status="pass", metrics=_metrics(), ran_at="t2")


def _hub(mongo_db, sio, *, tuner_runner, curation_runner, gdd=None):
    store = MathStore(mongo_db)
    runs = MathRunStore(mongo_db)
    return MathHub(sio, store, runs, curation_runner, tuner_runner,
                   gdd or FakeGdd()), store, runs


@pytest.mark.asyncio
async def test_generate_runs_tune_then_verify_and_persists_one_run(mongo_db):
    sio = FakeSio()
    hub, store, runs = _hub(mongo_db, sio,
                            tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    assert await hub.generate("g1") is True
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].verdict == "pass"
    assert docs[0].verify.status == "pass"
    assert (await store.get("g1")).tune_result.tuned_model == {"rows": 7}
    assert sio.phases() == ["tuning", "verifying", "done"]
    assert sio.count("run_complete") == 1


@pytest.mark.asyncio
async def test_generate_verifies_the_tuned_model_not_the_stored_model(mongo_db):
    sio = FakeSio()
    recorder = RecordingCurationRunner(_pass_curation())
    hub, store, _ = _hub(mongo_db, sio,
                         tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                         curation_runner=recorder)
    await hub.generate("g1")
    assert recorder.models == [{"rows": 7}]          # the WINNER, not doc.model
    assert (await store.get("g1")).result is None    # stored-model slot untouched
    assert sio.count("curation_complete") == 0       # no simulator-pane events


@pytest.mark.asyncio
async def test_generate_failed_tune_skips_verify(mongo_db):
    sio = FakeSio()
    recorder = RecordingCurationRunner(_pass_curation())
    failed = TuneResult(status="error", failure="boom", ran_at="t1")
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=FakeTunerRunner(progress=[], result=failed),
                        curation_runner=recorder)
    assert await hub.generate("g1") is True
    assert recorder.models == []
    assert await runs.list_for_game("g1") == []
    assert sio.phases() == ["tuning", "failed"]
    assert sio.count("tuning_failed") == 1


@pytest.mark.asyncio
async def test_generate_target_gap_reports_failed(mongo_db):
    sio = FakeSio()
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                        curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()),
                        gdd=FakeGdd(empty=True))
    assert await hub.generate("g1") is True
    assert await runs.list_for_game("g1") == []
    assert sio.phases() == ["tuning", "failed"]


@pytest.mark.asyncio
async def test_second_generate_while_active_returns_false(mongo_db):
    sio = FakeSio()
    gated = GatedTunerRunner(_pass_tune())
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=gated,
                        curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    first = asyncio.create_task(hub.generate("g1"))
    await asyncio.sleep(0)                    # let the first reserve + park
    assert await hub.generate("g1") is False  # agent-tool path rejected
    assert hub.begin_generate("g1") is False  # route path rejected
    gated.gate.set()
    assert await first is True
    assert len(await runs.list_for_game("g1")) == 1
