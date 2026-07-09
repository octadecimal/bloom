import pytest

from app.gdd.store import GddStore
from app.math.store import MathStore
from app.math.realize_flow import realize_game

GDD = {
    "math-model": {"reels": 5, "rows": 3, "payline_count": 10},
    "symbols-reels": {"symbols": [
        {"slot": "wild", "kind": "wild"}, {"slot": "a", "kind": "high"},
        {"slot": "scat", "kind": "scatter"},
    ]},
    "paytable": {},
    "bonus-features": {"features": [{"name": "FS", "trigger": "3 scat"}]},
}


@pytest.fixture
def math_store(mongo_db):
    return MathStore(mongo_db)


@pytest.fixture
def gdd_store(mongo_db):
    return GddStore(mongo_db)


async def _seed_gdd(gdd_store, game_id, data=GDD):
    await gdd_store.seed_taxonomy(game_id)
    for aspect, fields in data.items():
        if fields:
            await gdd_store.set_fields(game_id, aspect, fields)


async def test_birth_realizes_whole_model_and_writes_join_keys(math_store, gdd_store):
    await _seed_gdd(gdd_store, "g1")
    res = await realize_game(math_store, gdd_store, "g1")
    assert res.realized
    doc = await math_store.get("g1")
    assert doc.origin == "realized"
    assert len(doc.model["reels"]) == 5 and doc.model["rows"] == 3
    assert len(doc.model["bonuses"]) == 1
    sym_doc = await gdd_store.get_doc("g1", "symbols-reels")
    assert [r["model_id"] for r in sym_doc.data["symbols"]] == [0, 1, 2]


async def test_not_realizable_stores_nothing(math_store, gdd_store):
    await gdd_store.seed_taxonomy("g2")   # empty symbols table
    res = await realize_game(math_store, gdd_store, "g2")
    assert not res.realized and res.errors
    doc = await math_store.get_or_seed("g2")
    assert doc.origin == "template"


async def test_sectional_rerealize_preserves_unaffected_and_ids(math_store, gdd_store):
    await _seed_gdd(gdd_store, "g3")
    await realize_game(math_store, gdd_store, "g3")
    before = await math_store.get("g3")
    # GA-ish paytable edit that a dims change must NOT clobber
    tuned = dict(before.model)
    tuned["paytable"] = {"entries": [{"symbol": 1, "count": 5, "payout": 777}]}
    await math_store.put("g3", model=tuned, source="tuner")
    await gdd_store.set_fields("g3", "math-model", {"reels": 3})
    res = await realize_game(math_store, gdd_store, "g3",
                             aspect="math-model", fields={"reels": 3})
    assert res.realized
    doc = await math_store.get("g3")
    assert len(doc.model["reels"]) == 3                      # affected: rebuilt
    assert doc.model["paytable"]["entries"][0]["payout"] == 777  # untouched
    ids = {d["id"] for d in doc.model["symbols"]}
    assert ids == {0, 1, 2}                                  # join keys stable
