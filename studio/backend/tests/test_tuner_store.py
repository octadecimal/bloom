import pytest
import pytest_asyncio
from app.tuner.models import default_tuning_params, TuneResult, GenSnapshotWire
from app.tuner.store import TunerStore


@pytest_asyncio.fixture(autouse=True)
async def _clear_tuner_jobs(mongo_db):
    await mongo_db["tuner_jobs"].delete_many({})
    yield
    await mongo_db["tuner_jobs"].delete_many({})


@pytest.mark.asyncio
async def test_get_or_seed_creates_defaults(mongo_db):
    store = TunerStore(mongo_db)
    doc = await store.get_or_seed("g1")
    assert doc.game_id == "g1"
    assert doc.params.population == default_tuning_params().population
    assert doc.result is None


@pytest.mark.asyncio
async def test_put_patches_params(mongo_db):
    store = TunerStore(mongo_db)
    await store.get_or_seed("g1")
    p = default_tuning_params()
    p.population = 11
    doc = await store.put("g1", params=p)
    assert doc.params.population == 11


@pytest.mark.asyncio
async def test_save_result_persists(mongo_db):
    store = TunerStore(mongo_db)
    await store.get_or_seed("g1")
    res = TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0]]},
        metrics=None, missed=[],
        trace=[GenSnapshotWire(generation=0, best_fitness=0.0, best_rtp=0.9, best_volatility=2.0)],
        failure=None, ran_at="t",
    )
    doc = await store.save_result("g1", res)
    assert doc.result is not None and doc.result.status == "pass"
    again = await store.get("g1")
    assert again.result.tuned_model == {"reels": [[0]]}
    assert len(again.result.trace) == 1
