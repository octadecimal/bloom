"""Ported from test_sim_rest.py (3 cases), test_tuner_rest.py (7 cases),
test_analytics_rest.py (3 cases) — one router over the unified MathStore /
MathHub / MathRunStore, plus 3 NEW template-route cases."""
import asyncio
import pytest
import pytest_asyncio
from types import SimpleNamespace
from fastapi import HTTPException

from app.math.models import (
    CurationResult, MathRunDoc, SectionLocks, TuneResult, MetricsWire, default_tuning_params,
)
from app.math.store import MathStore, MathRunStore
from app.math.hub import MathHub
from app.math.runners.curate import FakeCurationRunner
from app.math.runners.tune import FakeTunerRunner
from app.math import rest


class _FakeSio:
    async def emit(self, event, payload, room=None, to=None):
        pass

    async def enter_room(self, sid, room):
        pass


class _GatedTunerRunner:
    """Parks forever until .gate is set — used to hold a generate() run 'in
    flight' so a second call observes the 409/busy path."""

    def __init__(self, result):
        self._result = result
        self.gate = asyncio.Event()

    async def run(self, seed_model, target, config, on_progress, on_spawn=None):
        await self.gate.wait()
        return self._result


def _metrics():
    return MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


def _pass_tune_result():
    return TuneResult(status="pass", verdict="pass", tuned_model={"rows": 7},
                      metrics=_metrics(), ran_at="t1")


def _pass_curation_result():
    return CurationResult(status="pass", metrics=_metrics(), ran_at="t2")


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    await mongo_db["math_runs"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    await mongo_db["math_runs"].delete_many({})


class FakeGdd:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data)


def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


# ── slot-model (was test_sim_rest.py) ────────────────────────────────────────
@pytest.mark.asyncio
async def test_get_seeds_and_put_updates(mongo_db):
    store = MathStore(mongo_db)
    req = _req(math_store=store)
    got = await rest.get_slot_model("g1", req)
    assert got["gameId"] == "g1"
    updated = await rest.put_slot_model("g1", rest.PutSlotModelBody(model={"reels": [[0]]}), req)
    assert updated["model"] == {"reels": [[0]]}


@pytest.mark.asyncio
async def test_curate_kicks_off(mongo_db):
    store = MathStore(mongo_db)
    calls = []

    async def _req_cur(gid):
        calls.append(gid)

    hub = SimpleNamespace(request_curation=_req_cur)
    req = _req(math_store=store, math_hub=hub)
    resp = await rest.curate_slot_model("g1", req)
    # allow the scheduled task to run
    await asyncio.sleep(0)
    assert calls == ["g1"]


@pytest.mark.asyncio
async def test_put_accepts_presentation_and_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = MathStore(mongo_db, on_change=on_change)
    req = _req(math_store=store)
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


# ── templates (NEW) ──────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_list_templates_route(mongo_db):
    out = await rest.list_slot_model_templates()
    assert len(out) == 3
    for entry in out:
        assert set(entry.keys()) == {"name", "label", "description"}
        assert "model" not in entry


@pytest.mark.asyncio
async def test_apply_template_respects_locks(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = MathStore(mongo_db, on_change=on_change)
    custom_paytable = {"entries": [{"symbol": 0, "count": 3, "payout": 999}]}
    await store.put("g1", model={"reels": [[9]], "paytable": custom_paytable},
                    locks=SectionLocks(paytable=True))
    events.clear()  # ignore the seed write above; only the apply-template write matters
    req = _req(math_store=store)
    body = rest.ApplyTemplateBody(name="classic-3x3")

    out = await rest.apply_slot_model_template("g1", body, req)

    assert out["model"]["paytable"] == custom_paytable
    assert out["model"]["reels"] != [[9]]  # template's reels applied (unlocked section)
    assert events == ["template"]


@pytest.mark.asyncio
async def test_apply_template_unknown_404(mongo_db):
    store = MathStore(mongo_db)
    req = _req(math_store=store)
    body = rest.ApplyTemplateBody(name="nope")

    with pytest.raises(HTTPException) as exc_info:
        await rest.apply_slot_model_template("g1", body, req)
    assert exc_info.value.status_code == 404


# ── tuner (was test_tuner_rest.py) ───────────────────────────────────────────
@pytest.mark.asyncio
async def test_get_seeds_and_put_params(mongo_db):
    store = MathStore(mongo_db)
    req = _req(math_store=store)
    got = await rest.get_tuner("g1", req)
    assert got["gameId"] == "g1"
    body = rest.PutTunerBody(params=got["params"])
    updated = await rest.put_tuner("g1", body, req)
    assert updated["params"]["population"] == got["params"]["population"]


@pytest.mark.asyncio
async def test_target_endpoint_reports_gap_when_intent_missing(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"bonuses": []})
    req = _req(math_store=store, gdd_store=FakeGdd({"volatility": "low"}))  # no rtp
    out = await rest.get_tuner_target("g1", req)
    assert "gap" in out


@pytest.mark.asyncio
async def test_apply_writes_tuned_model_into_slot_store(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"reels": [[9]]})  # stale seed
    await store.save_tune_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0, 1, 2]]},
        metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[], trace=[], ran_at="t"))
    req = _req(math_store=store)
    out = await rest.apply_tuner("g1", req)
    assert out["model"] == {"reels": [[0, 1, 2]]}
    assert (await store.get("g1")).model == {"reels": [[0, 1, 2]]}


@pytest.mark.asyncio
async def test_apply_emits_tuner_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = MathStore(mongo_db, on_change=on_change)
    await store.put("g1", model={"reels": [[9]]})  # stale seed
    events.clear()  # ignore the seed write above; only the apply write matters
    await store.save_tune_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0, 1, 2]]},
        metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[], trace=[], ran_at="t"))
    req = _req(math_store=store)
    await rest.apply_tuner("g1", req)
    assert events == ["tuner"]


@pytest.mark.asyncio
async def test_apply_errors_when_no_tuned_model(mongo_db):
    store = MathStore(mongo_db)
    await store.get_or_seed("g1")  # tune_result is None
    req = _req(math_store=store)
    with pytest.raises(HTTPException):
        await rest.apply_tuner("g1", req)


# ── generate pipeline route (NEW) ─────────────────────────────────────────────
def _generate_hub(mongo_db, *, tuner_runner):
    store = MathStore(mongo_db)
    run_store = MathRunStore(mongo_db)
    gdd = FakeGdd({"rtp": 0.96, "volatility": "medium", "bonus_hit_rate": "1:150"})
    return MathHub(_FakeSio(), store, run_store,
                   FakeCurationRunner(progress=[], result=_pass_curation_result()),
                   tuner_runner, gdd)


@pytest.mark.asyncio
async def test_generate_route_returns_202_while_idle(mongo_db):
    hub = _generate_hub(mongo_db,
                        tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune_result()))
    req = _req(math_hub=hub)
    resp = await rest.generate_math("g1", req)
    assert resp.status_code == 202
    await asyncio.sleep(0)  # let the background pipeline settle


@pytest.mark.asyncio
async def test_generate_route_returns_409_when_already_running(mongo_db):
    gated = _GatedTunerRunner(_pass_tune_result())
    hub = _generate_hub(mongo_db, tuner_runner=gated)
    req = _req(math_hub=hub)

    resp = await rest.generate_math("g1", req)
    assert resp.status_code == 202
    await asyncio.sleep(0)  # let the first run reserve + park on the gate

    with pytest.raises(HTTPException) as exc_info:
        await rest.generate_math("g1", req)
    assert exc_info.value.status_code == 409

    gated.gate.set()


@pytest.mark.asyncio
async def test_cancel_route_409_when_idle(mongo_db):
    hub = _generate_hub(mongo_db,
                        tuner_runner=FakeTunerRunner(progress=[], result=_pass_tune_result()))
    req = _req(math_hub=hub)
    with pytest.raises(HTTPException) as exc_info:
        await rest.cancel_generate_math("g1", req)
    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_cancel_route_202_aborts_running_generate(mongo_db):
    gated = _GatedTunerRunner(_pass_tune_result())
    hub = _generate_hub(mongo_db, tuner_runner=gated)
    req = _req(math_hub=hub)

    resp = await rest.generate_math("g1", req)
    assert resp.status_code == 202
    await asyncio.sleep(0)  # let the run reserve + park on the gate

    resp = await rest.cancel_generate_math("g1", req)
    assert resp.status_code == 202
    gated.gate.set()  # runner returns; pipeline sees the flag and cancels
    await asyncio.sleep(0.05)
    with pytest.raises(HTTPException):  # nothing active anymore
        await rest.cancel_generate_math("g1", req)


# ── analytics (was test_analytics_rest.py) ───────────────────────────────────
def _run(run_id: str, game_id: str, created_at: str) -> MathRunDoc:
    return MathRunDoc(
        id=run_id,
        game_id=game_id,
        params=default_tuning_params(),
        verdict="pass",
        metrics=None,
        trace=[],
        profile={
            "distribution": {
                "bins": [
                    {"binLo": 0.0, "binHi": 1.0, "base": 1, "feature": 0},
                    {"binLo": 1.0, "binHi": None, "base": 0, "feature": 0},
                ],
                "zeroCount": 0,
            },
            "tail": {
                "maxWin": 10.0,
                "pGE100x": 0.0,
                "pLosingSpin": 0.1,
                "longestDeadStreak": 3,
                "bonusTriggerRate": 0.02,
            },
            "rtpConvergence": [],
        },
        created_at=created_at,
        duration_ms=1234,
    )


@pytest.mark.asyncio
async def test_list_runs_returns_camel_case_docs_with_null_bin_hi(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))
    await store.append(_run("r2", "g1", "2026-01-02T00:00:00+00:00"))
    req = _req(math_run_store=store)

    out = await rest.list_runs("g1", req)

    assert len(out) == 2
    assert out[0]["gameId"] == "g1"
    assert out[0]["id"] == "r2"
    assert out[0]["profile"]["distribution"]["bins"][-1]["binHi"] is None


@pytest.mark.asyncio
async def test_get_run_returns_404_for_missing(mongo_db):
    store = MathRunStore(mongo_db)
    req = _req(math_run_store=store)

    with pytest.raises(HTTPException) as exc_info:
        await rest.get_run("missing", req)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_get_run_returns_doc(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))
    req = _req(math_run_store=store)

    out = await rest.get_run("r1", req)
    assert out["id"] == "r1"
    assert out["gameId"] == "g1"


# ── locks (NEW, issue #141) ───────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_put_slot_model_persists_locks_and_broadcasts(mongo_db):
    events: list[str] = []

    async def on_change(doc, source):
        events.append(source)

    store = MathStore(mongo_db, on_change=on_change)
    await store.put("g1", model={"reels": [[0]]})
    events.clear()
    req = _req(math_store=store)

    body = rest.PutSlotModelBody(locks=SectionLocks(paytable=True), source="editor")
    out = await rest.put_slot_model("g1", body, req)

    assert out["locks"] == {"reels": False, "paytable": True, "bonus": False}
    assert events == ["editor"]  # a locks write broadcasts slot_model_changed
    saved = await store.get("g1")
    assert saved.locks.paytable is True


@pytest.mark.asyncio
async def test_put_slot_model_without_locks_leaves_them_untouched(mongo_db):
    store = MathStore(mongo_db)
    await store.put("g1", model={"reels": [[0]]}, locks=SectionLocks(reels=True))
    req = _req(math_store=store)

    out = await rest.put_slot_model("g1", rest.PutSlotModelBody(model={"reels": [[1]]}), req)

    assert out["locks"] == {"reels": True, "paytable": False, "bonus": False}




