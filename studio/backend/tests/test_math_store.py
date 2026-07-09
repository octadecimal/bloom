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
async def test_get_or_seed_never_duplicates_under_concurrency(mongo_db):
    # The live DB grew twin docs (created 1ms apart) from the old
    # check-then-insert race; the unique index must make that impossible.
    import asyncio
    store = MathStore(mongo_db)
    docs = await asyncio.gather(*[store.get_or_seed("g-race") for _ in range(8)])
    assert len({d.id for d in docs}) == 1
    n = await mongo_db["slot_models"].count_documents({"game_id": "g-race"})
    assert n == 1


def _raw_doc(_id: str, game_id: str) -> dict:
    return {
        "_id": _id, "game_id": game_id, "model": {"reels": [[0]]},
        "params": default_params().model_dump(mode="json"),
        "tuner_params": default_tuning_params().model_dump(mode="json"),
        "locks": SectionLocks().model_dump(mode="json"),
        "presentation": {}, "result": None, "tune_result": None,
        "created_at": "t0", "updated_at": "t0",
    }


@pytest.mark.asyncio
async def test_existing_duplicate_docs_are_healed_keeping_the_first(mongo_db):
    # Pre-existing race twins: the natural-first doc is the one every read and
    # update_one has always hit, so healing must keep IT and drop the twin.
    # Model the pre-fix DB: no unique index yet (it survives across tests).
    await mongo_db["slot_models"].drop_indexes()
    await mongo_db["slot_models"].insert_one(_raw_doc("first", "g-dupe"))
    await mongo_db["slot_models"].insert_one(_raw_doc("twin", "g-dupe"))
    store = MathStore(mongo_db)
    doc = await store.get("g-dupe")
    assert doc.id == "first"
    n = await mongo_db["slot_models"].count_documents({"game_id": "g-dupe"})
    assert n == 1


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
async def test_legacy_doc_with_empty_model_backfills_default_template(mongo_db):
    # A pre-existing dev doc: the old SlotModelStore.get_or_seed stamped model={}
    # on first touch. This one is ALREADY migrated (has tuner_params) but still
    # carries the empty model — the deleted DEMO fallback used to make {} spinnable,
    # so without a backfill the spin path feeds {} to spin_json and throws.
    await mongo_db["slot_models"].insert_one({
        "_id": "empty1", "game_id": "g-empty", "model": {},
        "params": default_params().model_dump(mode="json"),
        "tuner_params": default_tuning_params().model_dump(mode="json"),
        "tune_result": None,
        "locks": SectionLocks().model_dump(mode="json"),
        "presentation": {}, "result": None,
        "created_at": "t0", "updated_at": "t0",
    })
    store = MathStore(mongo_db)
    doc = await store.get("g-empty")
    assert doc.model == templates.default_model()   # never {}: spin path stays safe
    # And it persisted, not just returned:
    raw = await mongo_db["slot_models"].find_one({"game_id": "g-empty"})
    assert raw["model"] == templates.default_model()


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


@pytest.fixture
def sample_tune_result():
    """Minimal TuneResult for testing."""
    return TuneResult(status="pass", ran_at="2026-07-09T00:00:00Z")


@pytest.mark.asyncio
async def test_put_stamps_touched(mongo_db):
    store = MathStore(mongo_db)
    await store.get_or_seed("g1")
    doc = await store.put("g1", model={"rows": 3}, source="api")
    assert doc.touched is True
    assert doc.origin == "template"


@pytest.mark.asyncio
async def test_save_realized_sets_origin_and_clears_shape_stale(mongo_db):
    store = MathStore(mongo_db)
    await store.get_or_seed("g2")
    await store.set_stale_flags("g2", shape_stale=True)
    doc = await store.save_realized("g2", {"rows": 4})
    assert doc.origin == "realized"
    assert doc.model["rows"] == 4
    assert doc.shape_stale is False


@pytest.mark.asyncio
async def test_save_realized_marks_verdict_stale_when_result_exists(mongo_db, sample_tune_result):
    store = MathStore(mongo_db)
    await store.get_or_seed("g3")
    await store.save_tune_result("g3", sample_tune_result)
    doc = await store.save_realized("g3", {"rows": 4})
    assert doc.verdict_stale is True


@pytest.mark.asyncio
async def test_new_results_clear_verdict_stale(mongo_db, sample_tune_result):
    store = MathStore(mongo_db)
    await store.get_or_seed("g4")
    await store.set_stale_flags("g4", verdict_stale=True)
    doc = await store.save_tune_result("g4", sample_tune_result)
    assert doc.verdict_stale is False


@pytest.mark.asyncio
async def test_legacy_doc_backfills_touched_true(mongo_db):
    # simulate a pre-rework doc: strip the new keys at the raw level
    store = MathStore(mongo_db)
    await store.get_or_seed("g5")
    await store._docs.update_one(
        {"game_id": "g5"},
        {"$unset": {"touched": "", "origin": "", "verdict_stale": "", "shape_stale": ""}},
    )
    doc = await store.get("g5")
    assert doc.touched is True and doc.origin == "template"
