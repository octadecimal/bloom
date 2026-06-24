import pytest
from app.gdd.store import GddStore, GddEditError


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
async def test_edit_doc_replaces_unique_block(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    await store.upsert_doc("g1", "math-model", body="RTP: TBD\nVolatility: high")
    doc = await store.edit_doc("g1", "math-model", "RTP: TBD", "RTP: 96%")
    assert doc.body == "RTP: 96%\nVolatility: high"


@pytest.mark.asyncio
async def test_edit_doc_raises_when_missing_or_ambiguous(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    await store.upsert_doc("g1", "paytable", body="row\nrow")
    with pytest.raises(GddEditError):
        await store.edit_doc("g1", "paytable", "missing", "x")
    with pytest.raises(GddEditError):
        await store.edit_doc("g1", "paytable", "row", "x")  # 2 matches, no replace_all
    doc = await store.edit_doc("g1", "paytable", "row", "x", replace_all=True)
    assert doc.body == "x\nx"


@pytest.mark.asyncio
async def test_set_status(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc = await store.set_status("g1", "audio", "complete")
    assert doc.status == "complete"
