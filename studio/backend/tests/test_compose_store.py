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


@pytest.mark.asyncio
async def test_seeding_fires_on_change_once_with_source_seed(mongo_db):
    events: list[tuple[str, str]] = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    store = ComposeStore(mongo_db, on_change=on_change)
    await store.get_or_seed("g-seed")          # inserts -> fires
    await store.get_or_seed("g-seed")          # read-only -> silent
    await store.get("g-seed")                  # read-only -> silent
    assert events == [("g-seed", "seed")]


class _RacingDocs:
    """Delegates to the real collection, but insert_one loses the seed race."""

    def __init__(self, docs, insert_one):
        self._docs = docs
        self.insert_one = insert_one

    def __getattr__(self, name):
        return getattr(self._docs, name)


@pytest.mark.asyncio
async def test_lost_seed_race_does_not_fire_on_change(mongo_db):
    # Deterministic concurrent-seeder race: the doc is missing at get() time,
    # but a rival wins the insert so ours raises DuplicateKeyError. The loser
    # must NOT fire "seed" for a doc it didn't insert.
    from pymongo.errors import DuplicateKeyError

    events = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    rival = ComposeStore(mongo_db)
    store = ComposeStore(mongo_db, on_change=on_change)

    async def losing_insert_one(raw):
        await rival.get_or_seed("g-race")  # rival wins first
        raise DuplicateKeyError("duplicate game_id")

    store._docs = _RacingDocs(store._docs, losing_insert_one)
    doc = await store.get_or_seed("g-race")
    assert doc.game_id == "g-race"
    assert events == []
