import asyncio
from types import SimpleNamespace

import pytest

from app.math.hub import MathHub
from app.math.models import (
    CurationResult, MetricsWire, PopulationStatsWire, SectionLocks, TuneResult,
)
from app.math.runners.curate import FakeCurationRunner
from app.math.runners.tune import FakeTunerRunner, TuneProgress
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

    async def run(self, model, target, on_progress, on_spawn=None):
        self.models.append(model)
        return self._result


class GatedTunerRunner:
    def __init__(self, result):
        self._result = result
        self.gate = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        await self.gate.wait()
        return self._result


class RaisingTunerRunner:
    """Simulates a subprocess crash / transient error inside the generate loop's
    tune attempt."""
    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        raise RuntimeError("boom")


def _population(diversity: float) -> PopulationStatsWire:
    return PopulationStatsWire(min=0.1, q1=0.2, median=0.3, q3=0.4, max=0.5,
                               mean=0.3, diversity=diversity)


def _metrics():
    return MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


def _pass_tune():
    return TuneResult(status="pass", verdict="pass", tuned_model={"rows": 7},
                      metrics=_metrics(), ran_at="t1", stop_reason="feasible")


def _pass_curation():
    return CurationResult(status="pass", metrics=_metrics(), ran_at="t2")


def _failing_curation():
    return CurationResult(status="fail", metrics=_metrics(), ran_at="t2")


def _hub(mongo_db, sio, *, tuner_runner, curation_runner, gdd=None):
    store = MathStore(mongo_db)
    runs = MathRunStore(mongo_db)
    return MathHub(sio, store, runs, curation_runner, tuner_runner,
                   gdd or FakeGdd()), store, runs


class SequencedTunerRunner:
    """Queued per-call results; records the (seed_model, config) of each call."""
    def __init__(self, results):
        self._results = list(results)
        self.calls: list[tuple[dict, dict]] = []

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        self.calls.append((dict(seed_model), dict(config)))
        return self._results.pop(0)


class SequencedCurationRunner:
    def __init__(self, results):
        self._results = list(results)
        self.models: list[dict] = []

    async def run(self, model, target, on_progress, on_spawn=None):
        self.models.append(dict(model))
        return self._results.pop(0)


def _near_miss_tune(rtp, model=None):
    """A stagnated near-miss whose miss score falls as rtp approaches the
    0.96±0.01 target band (FakeGdd intent + default curation params)."""
    return TuneResult(
        status="near_miss", verdict="near_miss",
        tuned_model=model or {"rows": 5},
        metrics=MetricsWire(rtp=rtp, volatility=4.0, hit_frequency=0.3,
                            base_rtp=rtp, feature_rtp=0.0, bonus_hit_rates=[]),
        ran_at="t1", stop_reason="stagnated")


@pytest.mark.asyncio
async def test_near_miss_restarts_seeded_from_best_with_escalation(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90, model={"a": 1}),
                                  _pass_tune()])
    recorder = RecordingCurationRunner(_pass_curation())
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=recorder)
    assert await hub.generate("g1") is True

    # Attempt 2 re-seeded from attempt 1's best model, escalated + reseeded.
    assert len(tuner.calls) == 2
    seed2, cfg2 = tuner.calls[1]
    cfg1 = tuner.calls[0][1]
    assert seed2 == {"a": 1}
    assert cfg2["master_seed"] == cfg1["master_seed"] + 1
    assert cfg2["mutation_rate"] == pytest.approx(min(0.5, cfg1["mutation_rate"] * 1.5))
    assert cfg2["bounds"] == cfg1["bounds"]  # derived once, never from the tuned model

    # Mid-loop verify only for passing tunes: the near-miss was never curated.
    assert recorder.models == [{"rows": 7}]

    # One folded run: best attempt's data + per-attempt telemetry.
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].verdict == "pass"
    assert docs[0].loop_stop == "pass"
    assert [a.attempt for a in docs[0].attempts] == [1, 2]
    assert docs[0].attempts[0].miss_score > 0
    assert docs[0].attempts[1].miss_score == 0.0
    assert docs[0].params.max_attempts == 4  # provenance

    assert sio.phases() == ["tuning", "tuning", "verifying", "done"]
    tuning_payloads = [p for e, p in sio.emits
                       if e == "generate_status" and p["phase"] == "tuning"]
    assert [(p["attempt"], p["maxAttempts"]) for p in tuning_payloads] == [(1, 4), (2, 4)]
    assert sio.count("run_complete") == 1
    assert (await store.get("g1")).tune_result.tuned_model == {"rows": 7}


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
async def test_generate_emits_analytics_progress_payload_shape(mongo_db):
    """The (live) analytics Evolution tab is fed by _tune_attempt's on_progress
    relay. This is the only test asserting the emitted analytics_progress
    payload shape survives the generate-loop refactor."""
    sio = FakeSio()
    progress = [
        TuneProgress(0, 40, -0.5, 0.5, 2.0, population=_population(0.42), gene_agreement=[0.1, 0.2]),
        TuneProgress(1, 40, -0.3, 0.6, 1.9, population=_population(0.37), gene_agreement=[0.15, 0.25]),
    ]
    hub, _, _ = _hub(mongo_db, sio,
                     tuner_runner=FakeTunerRunner(progress=progress, result=_pass_tune()),
                     curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    assert await hub.generate("g1") is True

    analytics_events = [p for e, p in sio.emits if e == "analytics_progress"]
    assert len(analytics_events) == 2
    for payload, p in zip(analytics_events, progress):
        assert payload["gameId"] == "g1"
        assert payload["generation"] == p.generation
        assert payload["maxGenerations"] == p.max_generations
        assert payload["best"] == {
            "fitness": p.best_fitness, "rtp": p.best_rtp, "volatility": p.best_volatility,
        }
        assert payload["population"]["diversity"] == p.population.diversity
        assert payload["population"]["median"] == p.population.median
        assert payload["geneAgreement"] == p.gene_agreement


@pytest.mark.asyncio
async def test_generate_records_the_tuners_stop_reason(mongo_db):
    from app.math.models import math_run_wire
    sio = FakeSio()
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                        curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    await hub.generate("g1")
    docs = await runs.list_for_game("g1")
    assert docs[0].stop_reason == "feasible"
    assert math_run_wire(docs[0])["stopReason"] == "feasible"
    assert docs[0].attempts is not None and docs[0].loop_stop == "pass"


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


@pytest.mark.asyncio
async def test_generate_unexpected_exception_emits_failed_and_releases_reservation(mongo_db):
    """Covers the review finding: an unhandled exception (subprocess crash,
    transient DB error) inside the tune/verify/persist body must still emit a
    terminal generate_status:failed, must not strand the reservation, and
    (via begin_generate's fire-and-forget path) must not leave an unretrieved
    asyncio task exception behind."""
    sio = FakeSio()
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=RaisingTunerRunner(),
                        curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))

    assert hub.begin_generate("g1") is True
    # Let the fire-and-forget task run to completion — it does real async I/O
    # (mongo reads) before raising, so a single sleep(0) isn't enough turns.
    for _ in range(100):
        if sio.phases() == ["tuning", "failed"]:
            break
        await asyncio.sleep(0.01)

    assert sio.phases() == ["tuning", "failed"]
    assert await runs.list_for_game("g1") == []

    # Reservation released (not stuck busy): a follow-up call is free to run
    # again — it raises the same RuntimeError rather than being rejected with
    # False, which is exactly how a "still busy" rejection would differ.
    with pytest.raises(RuntimeError):
        await hub.generate("g1")


@pytest.mark.asyncio
async def test_generate_records_params_from_pipeline_start_not_post_verify_reread(mongo_db):
    """Provenance: the run records the params the tune actually ran WITH, even if
    the user edits GA params mid-pipeline. We capture them at pipeline start, not
    by re-reading the doc after verify."""
    from app.math.models import default_tuning_params
    sio = FakeSio()
    gated = GatedTunerRunner(_pass_tune())
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=gated,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    # Doc starts with default population (24); a user edits it mid-tune to 99.
    task = asyncio.create_task(hub.generate("g1"))
    await asyncio.sleep(0)                    # let it reserve, capture params, park
    edited = default_tuning_params()
    edited.population = 99
    await store.put("g1", tuner_params=edited)
    gated.gate.set()
    assert await task is True
    docs = await runs.list_for_game("g1")
    assert docs[0].params.population == 24    # tuned-with value, not the mid-run edit


@pytest.mark.asyncio
async def test_generate_failed_verify_still_persists_run_with_done_phase(mongo_db):
    """Verify failing is not a pipeline failure: with restarts pinned OFF
    (max_attempts=1 — restart-on-verify-fail has its own test), the pipeline
    finishes 'done' and the run persists with the failing verify attached."""
    from app.math.models import default_tuning_params
    sio = FakeSio()
    hub, store, runs = _hub(mongo_db, sio,
                            tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                            curation_runner=FakeCurationRunner(progress=[], result=_failing_curation()))
    params = default_tuning_params()
    params.max_attempts = 1
    await store.put("g1", tuner_params=params)
    assert await hub.generate("g1") is True
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].verdict == "pass"
    assert docs[0].verify.status == "fail"
    assert docs[0].loop_stop == "attempts_exhausted"
    assert sio.phases() == ["tuning", "verifying", "done"]


@pytest.mark.asyncio
async def test_generate_snapshots_locks_onto_the_run(mongo_db):
    sio = FakeSio()
    hub, store, runs = _hub(mongo_db, sio,
                            tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    await store.put("g1", locks=SectionLocks(bonus=True))
    ok = await hub.generate("g1")
    assert ok is True
    saved = (await runs.list_for_game("g1"))[0]
    assert saved.locks is not None
    assert saved.locks.bonus is True and saved.locks.reels is False and saved.locks.paytable is False


class HangingTunerRunner:
    """Runs until its kill callable fires (mirrors a subprocess that only ends
    when killed); returns the error-shaped result a killed tune produces."""
    def __init__(self):
        self.spawned = asyncio.Event()
        self._killed = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        if on_spawn is not None:
            on_spawn(self._killed.set)
        self.spawned.set()
        await self._killed.wait()
        return TuneResult(status="error", verdict=None, tuned_model=None,
                          metrics=None, missed=[], trace=[],
                          failure="tuner produced no result (exit -9)", ran_at="t1")


class SlowSpawnTunerRunner(HangingTunerRunner):
    """Holds the 'subprocess' back until released — models cancel arriving
    before the spawn registers its kill callable."""
    def __init__(self):
        super().__init__()
        self.release_spawn = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        await self.release_spawn.wait()
        return await super().run(seed_model, target, config, on_progress,
                                 on_spawn=on_spawn)


class HangingCurationRunner:
    def __init__(self):
        self.spawned = asyncio.Event()
        self._killed = asyncio.Event()

    async def run(self, model, target, on_progress, on_spawn=None):
        if on_spawn is not None:
            on_spawn(self._killed.set)
        self.spawned.set()
        await self._killed.wait()
        return CurationResult(status="error", metrics=_metrics(),
                              failure="simulator produced no result (exit -9)",
                              ran_at="t2")


@pytest.mark.asyncio
async def test_cancel_during_tune_emits_cancelled_and_persists_nothing(mongo_db):
    sio = FakeSio()
    tuner = HangingTunerRunner()
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    task = asyncio.create_task(hub.generate("g1"))
    await asyncio.wait_for(tuner.spawned.wait(), timeout=2)
    assert hub.cancel_generate("g1") is True
    assert await task is True
    assert sio.phases() == ["tuning", "cancelled"]
    assert sio.count("tuning_failed") == 0
    assert sio.count("run_complete") == 0
    assert await runs.list_for_game("g1") == []
    assert (await store.get("g1")).tune_result is None
    assert hub.cancel_generate("g1") is False  # reservation freed


@pytest.mark.asyncio
async def test_cancel_during_verify_emits_cancelled_and_records_no_run(mongo_db):
    sio = FakeSio()
    cur = HangingCurationRunner()
    hub, _, runs = _hub(mongo_db, sio,
                        tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                        curation_runner=cur)
    task = asyncio.create_task(hub.generate("g1"))
    await asyncio.wait_for(cur.spawned.wait(), timeout=2)
    assert hub.cancel_generate("g1") is True
    assert await task is True
    assert sio.phases() == ["tuning", "verifying", "cancelled"]
    assert sio.count("run_complete") == 0
    assert await runs.list_for_game("g1") == []


@pytest.mark.asyncio
async def test_cancel_before_spawn_kills_on_registration(mongo_db):
    sio = FakeSio()
    tuner = SlowSpawnTunerRunner()
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                        curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    task = asyncio.create_task(hub.generate("g1"))
    await asyncio.sleep(0)  # let the pipeline reserve + park before spawn
    assert hub.cancel_generate("g1") is True   # no kill callable yet: flag-only
    tuner.release_spawn.set()                  # spawn now registers → killed at once
    assert await task is True
    assert sio.phases() == ["tuning", "cancelled"]
    assert await runs.list_for_game("g1") == []


@pytest.mark.asyncio
async def test_cancel_without_active_run_returns_false(mongo_db):
    hub, _, _ = _hub(mongo_db, FakeSio(),
                     tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune()),
                     curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    assert hub.cancel_generate("nope") is False


@pytest.mark.asyncio
async def test_pass_with_failing_verify_restarts_and_records_the_passing_attempt(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([_pass_tune(), _pass_tune()])
    curation = SequencedCurationRunner([_failing_curation(), _pass_curation()])
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=tuner, curation_runner=curation)
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 2
    docs = await runs.list_for_game("g1")
    assert len(docs) == 1
    assert docs[0].loop_stop == "pass"
    assert docs[0].verify.status == "pass"   # the joint-pass attempt won
    assert len(docs[0].attempts) == 2
    assert sio.phases() == ["tuning", "verifying", "tuning", "verifying", "done"]


@pytest.mark.asyncio
async def test_error_mid_loop_is_terminal_but_keeps_best_for_apply(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([
        _near_miss_tune(0.90, model={"best": 1}),
        TuneResult(status="error", failure="boom", ran_at="t1"),
    ])
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 2                       # no third attempt
    assert sio.phases() == ["tuning", "tuning", "failed"]
    assert sio.count("tuning_failed") == 1
    assert await runs.list_for_game("g1") == []        # error → no run recorded
    # ...but Apply still has the best-so-far model.
    assert (await store.get("g1")).tune_result.tuned_model == {"best": 1}


@pytest.mark.asyncio
async def test_static_misses_exit_early_with_not_improving(mongo_db):
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90, {"m": 1}),
                                  _near_miss_tune(0.90, {"m": 2}),
                                  _near_miss_tune(0.90, {"m": 3})])
    recorder = RecordingCurationRunner(_pass_curation())
    hub, _, runs = _hub(mongo_db, sio, tuner_runner=tuner, curation_runner=recorder)
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 3                       # stopped before the cap (4)
    docs = await runs.list_for_game("g1")
    assert docs[0].loop_stop == "not_improving"
    assert len(docs[0].attempts) == 3
    assert docs[0].verdict == "near_miss"
    # Final catch-up verify ran once, on the BEST (first) attempt's model.
    assert recorder.models == [{"m": 1}]
    assert sio.phases() == ["tuning", "tuning", "tuning", "verifying", "done"]


@pytest.mark.asyncio
async def test_improving_misses_run_to_the_cap(mongo_db):
    from app.math.models import default_tuning_params
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90, {"m": 1}),
                                  _near_miss_tune(0.92, {"m": 2}),
                                  _near_miss_tune(0.94, {"m": 3})])
    recorder = RecordingCurationRunner(_pass_curation())
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner, curation_runner=recorder)
    params = default_tuning_params()
    params.max_attempts = 3
    await store.put("g1", tuner_params=params)
    assert await hub.generate("g1") is True
    docs = await runs.list_for_game("g1")
    assert docs[0].loop_stop == "attempts_exhausted"
    scores = [a.miss_score for a in docs[0].attempts]
    assert scores == sorted(scores, reverse=True)      # strictly shrinking misses
    assert recorder.models == [{"m": 3}]               # best = last (closest) attempt
    assert (await store.get("g1")).tune_result.tuned_model == {"m": 3}
    assert docs[0].metrics.rtp == pytest.approx(0.94)  # run carries the best metrics


@pytest.mark.asyncio
async def test_max_attempts_one_is_todays_single_shot(mongo_db):
    from app.math.models import default_tuning_params
    sio = FakeSio()
    tuner = SequencedTunerRunner([_near_miss_tune(0.90)])
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    params = default_tuning_params()
    params.max_attempts = 1
    await store.put("g1", tuner_params=params)
    assert await hub.generate("g1") is True
    assert len(tuner.calls) == 1
    assert sio.phases() == ["tuning", "verifying", "done"]
    assert (await runs.list_for_game("g1"))[0].loop_stop == "attempts_exhausted"


@pytest.mark.asyncio
async def test_cancel_landing_after_an_attempt_stops_the_loop(mongo_db):
    sio = FakeSio()
    holder = {}

    class CancelOnReturnRunner:
        def __init__(self):
            self.calls = 0

        async def run(self, seed_model, target, config, on_progress, on_spawn=None):
            self.calls += 1
            holder["hub"].cancel_generate("g1")   # cancel lands as the attempt ends
            return _near_miss_tune(0.90)

    tuner = CancelOnReturnRunner()
    hub, store, runs = _hub(mongo_db, sio, tuner_runner=tuner,
                            curation_runner=FakeCurationRunner(progress=[], result=_pass_curation()))
    holder["hub"] = hub
    assert await hub.generate("g1") is True
    assert tuner.calls == 1                            # no restart after cancel
    assert sio.phases() == ["tuning", "cancelled"]
    assert await runs.list_for_game("g1") == []
    # Cancel is checked BEFORE scoring/saving: nothing was persisted.
    assert (await store.get("g1")).tune_result is None
