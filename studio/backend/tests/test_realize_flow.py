from types import SimpleNamespace

import pytest

from app.gdd.store import GddStore
from app.math.models import SectionLocks
from app.math.store import MathStore
from app.math.realize_flow import apply_math_hooks, realize_game

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


async def test_first_sectional_realize_from_template_realizes_all_sections(
    math_store, gdd_store
):
    # A fresh game's first realize arrives via a sectional shape edit (aspect +
    # fields). The base model is still the seeded template — merging only the
    # edit's sections would leave template residue (e.g. the video-5x3 bonuses
    # whose trigger symbol doesn't exist in the fresh strips). First realize
    # from template must cover all sections.
    gdd_no_features = {**GDD, "bonus-features": {}}
    await _seed_gdd(gdd_store, "g11", gdd_no_features)
    await math_store.get_or_seed("g11")   # seeds the template model

    res = await realize_game(
        math_store, gdd_store, "g11", aspect="symbols-reels",
        fields={"symbols": gdd_no_features["symbols-reels"]["symbols"]})

    assert res.realized
    doc = await math_store.get("g11")
    assert doc.origin == "realized"
    assert doc.model["bonuses"] == []   # realized (no GDD features), not template leftover


async def test_approve_realize_honors_locks_on_touched_template_origin(math_store, gdd_store):
    # A hand-authored/tuner-applied model that was never GDD-born: origin stays
    # "template", touched=True (every legacy backfilled doc looks like this
    # too). The interrupt-approve / explicit-realize path must still honor
    # SectionLocks, not wholesale-replace the model.
    await _seed_gdd(gdd_store, "g8")
    await math_store.put("g8", model={
        "symbols": [], "reels": [[0]], "rows": 1, "paylines": [],
        "paytable": {"entries": [{"symbol": 0, "count": 3, "payout": 999}]},
        "bonuses": [],
    }, locks=SectionLocks(paytable=True), source="editor")
    before = await math_store.get("g8")
    assert before.origin == "template" and before.touched is True

    res = await realize_game(math_store, gdd_store, "g8")

    assert res.realized
    doc = await math_store.get("g8")
    assert doc.origin == "realized"
    assert doc.model["paytable"]["entries"][0]["payout"] == 999  # locked: kept
    assert len(doc.model["reels"]) == 5                          # not locked: realized


class _RecordingGddHub:
    """Minimal gdd_hub double: same signature as GddHub.set_fields, delegates
    to the real store so read-back assertions still work."""

    def __init__(self, gdd_store):
        self._store = gdd_store
        self.calls: list[tuple[str, str, dict]] = []

    async def set_fields(self, game_id, aspect, fields):
        self.calls.append((game_id, aspect, fields))
        return await self._store.set_fields(game_id, aspect, fields)


async def test_realize_game_writes_join_keys_through_gdd_hub_when_provided(
    math_store, gdd_store
):
    await _seed_gdd(gdd_store, "g9")
    hub = _RecordingGddHub(gdd_store)

    res = await realize_game(math_store, gdd_store, "g9", gdd_hub=hub)

    assert res.realized
    assert hub.calls, "join-key write-back must route through the hub, not the store directly"
    game_id, aspect, fields = hub.calls[0]
    assert (game_id, aspect) == ("g9", "symbols-reels")
    assert "symbols" in fields


async def test_apply_math_hooks_escalates_to_full_realize_when_shape_stale(
    math_store, gdd_store
):
    await _seed_gdd(gdd_store, "g10")
    await realize_game(math_store, gdd_store, "g10")  # baseline realize, untouched

    # Simulate an earlier denied edit: bonus-features already drifted (a second
    # feature added) but the model was never re-realized for it — shape_stale
    # is the only record of that drift.
    await gdd_store.set_fields("g10", "bonus-features", {"features": [
        {"name": "FS", "trigger": "3 scat"},
        {"name": "Pick", "trigger": "bonus symbol"},
    ]})
    await math_store.set_stale_flags("g10", shape_stale=True)

    # Mirrors the real call site (app/rest.py): the GDD field is already
    # persisted by the time apply_math_hooks runs as its post-save hook.
    await gdd_store.set_fields("g10", "math-model", {"reels": 4})
    app_state = SimpleNamespace(math_store=math_store, gdd_store=gdd_store, gdd_hub=None)
    result = await apply_math_hooks(app_state, "g10", "math-model", {"reels": 4})

    assert result == "applied"
    doc = await math_store.get("g10")
    assert len(doc.model["bonuses"]) == 2   # the previously-drifted section too
    assert len(doc.model["reels"]) == 4     # this edit's section
    assert doc.shape_stale is False
