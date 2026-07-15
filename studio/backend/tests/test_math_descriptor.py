"""MathStore.family — the one backend answer to 'what family is this game'."""
import pytest

from app.compose import templates
from app.compose.models import GameDefinitionDoc
from app.compose.store import ComposeStore
from app.math.store import MathStore


class _FakeGddStore:
    def __init__(self, math_model_data=None):
        self._data = math_model_data

    async def get_doc(self, game_id, aspect):
        if aspect == "math-model" and self._data is not None:
            class _Doc:
                data = self._data
            return _Doc()
        return None


class _FakeComposeStore:
    def __init__(self, has_doc: bool, touched: bool = True):
        self._has = has_doc
        self._touched = touched

    async def get(self, game_id):
        return self._doc() if self._has else None

    async def get_or_seed(self, game_id):
        # Task 2 dispatch calls this when family() already resolved composed@1
        # (e.g. get_or_seed's own family check) — mirror ComposeStore's shape.
        return self._doc()

    def _doc(self):
        return GameDefinitionDoc(id="fake", game_id="g1", definition={},
                                 touched=self._touched,
                                 created_at="t0", updated_at="t0")


def _store(mongo_db, *, compose_has=False, gdd_data=None, compose_touched=True):
    return MathStore(mongo_db,
                     compose_store=_FakeComposeStore(compose_has, compose_touched),
                     gdd_store=_FakeGddStore(gdd_data))


@pytest.mark.asyncio
async def test_gdd_game_family_wins(mongo_db):
    store = _store(mongo_db, compose_has=False,
                   gdd_data={"game_family": "composed@1"})
    assert await store.family("g1") == "composed@1"


@pytest.mark.asyncio
async def test_composed_doc_beats_stray_slots_doc(mongo_db):
    store = _store(mongo_db, compose_has=True)
    await store.get_or_seed("g1")  # stray slots doc, as legacy panes created
    assert await store.family("g1") == "composed@1"


@pytest.mark.asyncio
async def test_slots_doc_resolves_slots(mongo_db):
    store = _store(mongo_db, compose_has=False)
    await store.get_or_seed("g1")
    assert await store.family("g1") == "slots@1"


@pytest.mark.asyncio
async def test_no_docs_defaults_slots(mongo_db):
    store = _store(mongo_db, compose_has=False)
    assert await store.family("nope") == "slots@1"


@pytest.mark.asyncio
async def test_bogus_gdd_family_is_ignored(mongo_db):
    store = _store(mongo_db, compose_has=True, gdd_data={"game_family": "weird"})
    assert await store.family("g1") == "composed@1"


@pytest.mark.asyncio
async def test_untouched_compose_seed_does_not_flip_an_ordinary_slots_game(mongo_db):
    # GET /games/{id}/game-definition auto-seeds a default doc for EVERY room
    # (get_or_seed), fired unconditionally by RoomRoute's openGameStructure —
    # that bare, never-written seed must not silently convert a slots game to
    # composed@1 the moment its room is opened in the Studio UI.
    store = _store(mongo_db, compose_has=True, compose_touched=False)
    assert await store.family("g1") == "slots@1"


@pytest.mark.asyncio
async def test_legacy_authored_doc_backfills_touched_true(mongo_db):
    # A doc written before GameDefinitionDoc.touched existed: no `touched` key
    # at all. It's genuinely authored (definition differs from the seed
    # template) — the backfill must compute touched=True, not just default it.
    definition = {"family": "composed@1", "mechanics": [], "states": [],
                 "start": "base", "transitions": []}
    await mongo_db["game_definitions"].insert_one({
        "_id": "legacy-authored", "game_id": "g-legacy-authored",
        "definition": definition, "presentation": {},
        "created_at": "t0", "updated_at": "t0",
    })
    compose = ComposeStore(mongo_db)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=None)
    assert await math.family("g-legacy-authored") == "composed@1"
    # Persisted, not recomputed on every read.
    raw = await mongo_db["game_definitions"].find_one({"game_id": "g-legacy-authored"})
    assert raw["touched"] is True


@pytest.mark.asyncio
async def test_legacy_stray_seed_doc_backfills_touched_false(mongo_db):
    # A doc written before `touched` existed, byte-equal to the seed template:
    # the old auto-seeding GET /game-definition stray, not an authored game.
    # A blind touched=True backfill would wrongly flip this to composed@1.
    await mongo_db["game_definitions"].insert_one({
        "_id": "legacy-stray", "game_id": "g-legacy-stray",
        "definition": templates.default_definition(), "presentation": {},
        "created_at": "t0", "updated_at": "t0",
    })
    compose = ComposeStore(mongo_db)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=None)
    assert await math.family("g-legacy-stray") == "slots@1"
