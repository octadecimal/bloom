import pytest

from app.compose.store import ComposeStore
from app.compose import templates


@pytest.mark.asyncio
async def test_get_returns_none_then_seed_creates_from_template(mongo_db):
    store = ComposeStore(mongo_db)
    assert await store.get("g1") is None
    doc = await store.get_or_seed("g1")
    assert doc.game_id == "g1"
    assert doc.definition["family"] == "composed@1"
    assert doc.definition == templates.default_definition()
    assert doc.presentation == templates.default_presentation()
    # idempotent
    again = await store.get_or_seed("g1")
    assert again.id == doc.id


@pytest.mark.asyncio
async def test_put_updates_and_fires_on_change(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    store = ComposeStore(mongo_db, on_change=on_change)
    definition = templates.default_definition()
    definition["caps"]["max_steps"] = 500
    doc = await store.put("g1", definition=definition, source="editor")
    assert doc.definition["caps"]["max_steps"] == 500
    assert events == [("g1", "editor")]

    doc2 = await store.put("g1", presentation={"theme": "x"}, source="api")
    assert doc2.presentation == {"theme": "x"}
    assert doc2.updated_at > doc.updated_at
    assert events[-1] == ("g1", "api")


@pytest.mark.asyncio
async def test_put_with_no_fields_does_not_fire_on_change(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = ComposeStore(mongo_db, on_change=on_change)
    await store.put("g1", source="noop")
    assert events == []
