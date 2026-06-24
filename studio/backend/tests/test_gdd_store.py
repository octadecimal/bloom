import pytest
import pytest_asyncio
from app.gdd.store import GddStore, GddEditError


@pytest_asyncio.fixture(autouse=True)
async def _clean_gdd_docs(mongo_db):
    # The shared mongo_db fixture does not wipe gdd_docs, so clear it here to
    # keep each test deterministic regardless of leftover state from prior runs.
    await mongo_db["gdd_docs"].delete_many({})
    yield
    await mongo_db["gdd_docs"].delete_many({})


@pytest.mark.asyncio
async def test_seed_taxonomy_creates_seven_empty_docs_idempotently(mongo_db):
    store = GddStore(mongo_db)
    first = await store.seed_taxonomy("g1")
    assert [d.aspect for d in first] == [
        "theme", "math-model", "symbols-reels", "paytable",
        "bonus-features", "ui-ux", "audio",
    ]
    assert all(d.status == "empty" and d.body == "" for d in first)
    # Idempotent: seeding again does not duplicate.
    again = await store.seed_taxonomy("g1")
    assert len(again) == 7
    assert len(await store.list_docs("g1")) == 7


@pytest.mark.asyncio
async def test_upsert_doc_replaces_body_in_place(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc = await store.upsert_doc("g1", "theme", title="Theme & Narrative",
                                 body="Ancient Egypt", status="drafted")
    assert doc.body == "Ancient Egypt" and doc.status == "drafted"
    # No duplicate row for the same (game, aspect).
    assert len([d for d in await store.list_docs("g1") if d.aspect == "theme"]) == 1


@pytest.mark.asyncio
async def test_set_fields_normalizes_renders_and_derives_status(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc, warnings = await store.set_fields(
        "g1", "math-model",
        {"rtp": "96%", "volatility": "High", "bonus_hit_rate": "1 in 200"},
    )
    assert warnings == []
    assert doc.data["rtp"] == 0.96
    assert doc.data["volatility"] == "high"
    assert doc.data["bonus_hit_rate"] == "1:200"
    assert doc.status == "drafted"          # all required present
    assert "**RTP:** 96%" in doc.body       # body is rendered from data


@pytest.mark.asyncio
async def test_set_fields_is_surgical_and_keeps_untouched_fields(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    await store.set_fields("g1", "math-model", {"rtp": "96%"})
    doc, _ = await store.set_fields("g1", "math-model", {"volatility": "low"})
    assert doc.data["rtp"] == 0.96          # earlier field untouched
    assert doc.data["volatility"] == "low"
    assert doc.status == "needs_input"      # bonus_hit_rate still missing


@pytest.mark.asyncio
async def test_set_fields_warns_on_unknown_field_without_blocking(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc, warnings = await store.set_fields(
        "g1", "math-model", {"rtp": "96%", "made_up": "x"},
    )
    assert doc.data["rtp"] == 0.96          # valid field still applied
    assert any("made_up" in w for w in warnings)
    assert "made_up" not in doc.data


@pytest.mark.asyncio
async def test_set_fields_raises_when_aspect_unseeded(mongo_db):
    store = GddStore(mongo_db)
    with pytest.raises(GddEditError):
        await store.set_fields("g1", "math-model", {"rtp": "96%"})


@pytest.mark.asyncio
async def test_set_status(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc = await store.set_status("g1", "audio", "complete")
    assert doc.status == "complete"


@pytest.mark.asyncio
async def test_upsert_doc_raises_when_aspect_unseeded(mongo_db):
    store = GddStore(mongo_db)
    # No seed_taxonomy: the (game, aspect) does not exist.
    with pytest.raises(GddEditError) as excinfo:
        await store.upsert_doc("g1", "theme", body="x")
    # Must be a real, clear error -- not a bare AssertionError.
    assert not isinstance(excinfo.value, AssertionError)
    assert "seed" in str(excinfo.value).lower()
