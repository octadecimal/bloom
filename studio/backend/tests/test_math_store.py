import pytest

from app.math import templates
from app.math.models import (
    CurationResult, MetricsWire, SectionLocks, TuneResult,
    default_params, default_tuning_params,
)
from app.math.store import MathStore, MathRunStore


def _metrics() -> MetricsWire:
    return MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


@pytest.mark.asyncio
async def test_get_or_seed_seeds_the_default_template(mongo_db):
    store = MathStore(mongo_db)
    doc = await store.get_or_seed("g-seed")
    assert doc.model == templates.default_model()   # never {} again
    assert doc.params == default_params()
    assert doc.tuner_params == default_tuning_params()
    assert doc.locks == SectionLocks()
    # And it persisted, not just returned:
    again = await store.get("g-seed")
    assert again.model == templates.default_model()


@pytest.mark.asyncio
async def test_put_updates_and_fires_on_change_for_model_presentation_locks(mongo_db):
    events: list[tuple[str, str]] = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    store = MathStore(mongo_db, on_change=on_change)
    await store.put("g-put", model={"rows": 4}, source="editor")
    await store.put("g-put", presentation={"symbols": {}}, source="editor")
    await store.put("g-put", locks=SectionLocks(reels=True), source="editor")
    await store.put("g-put", tuner_params=default_tuning_params())  # no broadcast
    await store.put("g-put", params=default_params())               # no broadcast
    assert events == [("g-put", "editor")] * 3
    doc = await store.get("g-put")
    assert doc.model == {"rows": 4}
    assert doc.locks.reels is True


@pytest.mark.asyncio
async def test_save_tune_result_persists_without_broadcast(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = MathStore(mongo_db, on_change=on_change)
    await store.get_or_seed("g-tune")
    tr = TuneResult(status="pass", verdict="pass", tuned_model={"rows": 3},
                    metrics=_metrics(), ran_at="t1")
    await store.save_tune_result("g-tune", tr)
    doc = await store.get("g-tune")
    assert doc.tune_result.tuned_model == {"rows": 3}
    assert events == []


@pytest.mark.asyncio
async def test_save_result_persists_curation(mongo_db):
    store = MathStore(mongo_db)
    await store.get_or_seed("g-cur")
    await store.save_result("g-cur", CurationResult(status="pass",
                                                    metrics=_metrics(), ran_at="t1"))
    doc = await store.get("g-cur")
    assert doc.result.status == "pass"


@pytest.mark.asyncio
async def test_legacy_doc_migrates_tuner_fields_from_tuner_jobs(mongo_db):
    # A pre-merge slot_models doc (no tuner_params/locks/tune_result keys) whose
    # game has a customized legacy tuner_jobs doc.
    await mongo_db["slot_models"].insert_one({
        "_id": "legacy1", "game_id": "g-legacy", "model": {"rows": 3},
        "params": default_params().model_dump(mode="json"),
        "presentation": {}, "result": None,
        "created_at": "t0", "updated_at": "t0",
    })
    legacy_params = default_tuning_params().model_dump(mode="json")
    legacy_params["population"] = 48   # the customization that must survive
    tr = TuneResult(status="pass", verdict="pass", tuned_model={"rows": 5},
                    metrics=_metrics(), ran_at="t1")
    await mongo_db["tuner_jobs"].insert_one({
        "_id": "tj1", "game_id": "g-legacy", "params": legacy_params,
        "result": tr.model_dump(mode="json"),
        "created_at": "t0", "updated_at": "t0",
    })

    store = MathStore(mongo_db)
    doc = await store.get("g-legacy")
    assert doc.tuner_params.population == 48
    assert doc.tune_result.tuned_model == {"rows": 5}
    assert doc.locks == SectionLocks()
    # Migration is one-shot: the fields are now persisted on the doc itself.
    raw = await mongo_db["slot_models"].find_one({"game_id": "g-legacy"})
    assert raw["tuner_params"]["population"] == 48


@pytest.mark.asyncio
async def test_legacy_doc_without_tuner_jobs_gets_defaults(mongo_db):
    await mongo_db["slot_models"].insert_one({
        "_id": "legacy2", "game_id": "g-legacy2", "model": {},
        "params": default_params().model_dump(mode="json"),
        "presentation": {}, "result": None,
        "created_at": "t0", "updated_at": "t0",
    })
    store = MathStore(mongo_db)
    doc = await store.get("g-legacy2")
    assert doc.tuner_params == default_tuning_params()
    assert doc.tune_result is None


@pytest.mark.asyncio
async def test_math_run_store_appends_and_lists_newest_first(mongo_db):
    from app.math.models import MathRunDoc
    store = MathRunStore(mongo_db)
    for i in range(3):
        await store.append(MathRunDoc(id=f"r{i}", game_id="g-runs",
                                      params=default_tuning_params(),
                                      created_at=f"2026-07-03T0{i}:00:00+00:00"))
    runs = await store.list_for_game("g-runs")
    assert [r.id for r in runs] == ["r2", "r1", "r0"]
    assert (await store.get("r1")).id == "r1"
    assert await store.get("missing") is None
