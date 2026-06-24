import pytest
import pytest_asyncio
from app.simulator.models import default_params, MetricsWire, CurationResult
from app.simulator.store import SlotModelStore


@pytest_asyncio.fixture(autouse=True)
async def _clear_slot_models(mongo_db):
    # conftest's mongo_db fixture does NOT wipe new collections — do it here.
    await mongo_db["slot_models"].delete_many({})
    yield
    await mongo_db["slot_models"].delete_many({})


@pytest.mark.asyncio
async def test_get_or_seed_creates_empty(mongo_db):
    store = SlotModelStore(mongo_db)
    doc = await store.get_or_seed("g1")
    assert doc.game_id == "g1"
    assert doc.params.candidate_count == default_params().candidate_count
    assert doc.result is None


@pytest.mark.asyncio
async def test_put_patches_model_and_params(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.get_or_seed("g1")
    doc = await store.put("g1", model={"reels": [[0, 1]]})
    assert doc.model == {"reels": [[0, 1]]}
    p = default_params(); p.pool_size = 500
    doc = await store.put("g1", params=p)
    assert doc.params.pool_size == 500
    assert doc.model == {"reels": [[0, 1]]}  # untouched


@pytest.mark.asyncio
async def test_save_result_persists(mongo_db):
    store = SlotModelStore(mongo_db)
    await store.get_or_seed("g1")
    res = CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.9, feature_rtp=0.06, bonus_hit_rates=[]),
        realized_rtp=0.96, pool_size=1000, failure=None, ran_at="t",
    )
    doc = await store.save_result("g1", res)
    assert doc.result is not None and doc.result.status == "pass"
    again = await store.get("g1")
    assert again.result.realized_rtp == pytest.approx(0.96)
