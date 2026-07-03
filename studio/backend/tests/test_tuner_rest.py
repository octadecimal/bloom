import pytest
import pytest_asyncio
from types import SimpleNamespace
from app.simulator.store import SlotModelStore
from app.tuner.store import TunerStore
from app.tuner.models import TuneResult
from app.simulator.models import MetricsWire
from app.tuner import rest


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})
    await mongo_db["tuner_jobs"].delete_many({})


class FakeGdd:
    def __init__(self, data): self._data = data
    async def get_doc(self, game_id, aspect):
        return SimpleNamespace(data=self._data)


def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


@pytest.mark.asyncio
async def test_get_seeds_and_put_params(mongo_db):
    store = TunerStore(mongo_db)
    req = _req(tuner_store=store)
    got = await rest.get_tuner("g1", req)
    assert got["gameId"] == "g1"
    body = rest.PutTunerBody(params=got["params"])
    updated = await rest.put_tuner("g1", body, req)
    assert updated["params"]["population"] == got["params"]["population"]


@pytest.mark.asyncio
async def test_seed_endpoint_returns_slot_model(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"reels": [[0, 1]]})
    req = _req(sim_store=sim)
    seed = await rest.get_tuner_seed("g1", req)
    assert seed["model"] == {"reels": [[0, 1]]}


@pytest.mark.asyncio
async def test_target_endpoint_reports_gap_when_intent_missing(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"bonuses": []})
    req = _req(sim_store=sim, gdd_store=FakeGdd({"volatility": "low"}))  # no rtp
    out = await rest.get_tuner_target("g1", req)
    assert "gap" in out


@pytest.mark.asyncio
async def test_apply_writes_tuned_model_into_slot_store(mongo_db):
    sim = SlotModelStore(mongo_db)
    await sim.put("g1", model={"reels": [[9]]})  # stale seed
    tuner = TunerStore(mongo_db)
    await tuner.save_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0, 1, 2]]},
        metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[], trace=[], ran_at="t"))
    req = _req(sim_store=sim, tuner_store=tuner)
    out = await rest.apply_tuner("g1", req)
    assert out["model"] == {"reels": [[0, 1, 2]]}
    assert (await sim.get("g1")).model == {"reels": [[0, 1, 2]]}


@pytest.mark.asyncio
async def test_apply_emits_tuner_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    sim = SlotModelStore(mongo_db, on_change=on_change)
    await sim.put("g1", model={"reels": [[9]]})  # stale seed
    events.clear()  # ignore the seed write above; only the apply write matters
    tuner = TunerStore(mongo_db)
    await tuner.save_result("g1", TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0, 1, 2]]},
        metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                            base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
        missed=[], trace=[], ran_at="t"))
    req = _req(sim_store=sim, tuner_store=tuner)
    await rest.apply_tuner("g1", req)
    assert events == ["tuner"]


@pytest.mark.asyncio
async def test_apply_errors_when_no_tuned_model(mongo_db):
    from fastapi import HTTPException
    sim = SlotModelStore(mongo_db)
    tuner = TunerStore(mongo_db)
    await tuner.get_or_seed("g1")  # result is None
    req = _req(sim_store=sim, tuner_store=tuner)
    with pytest.raises(HTTPException):
        await rest.apply_tuner("g1", req)


@pytest.mark.asyncio
async def test_tune_kicks_off(mongo_db):
    calls = []
    async def _req_tune(gid):
        calls.append(gid)
    hub = SimpleNamespace(request_tune=_req_tune)
    req = _req(tuner_hub=hub)
    await rest.tune_tuner("g1", req)
    import asyncio
    await asyncio.sleep(0)
    assert calls == ["g1"]
