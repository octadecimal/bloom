"""MathStore family dispatch onto game_definitions (spec §2)."""
import pytest

from app.compose import templates
from app.compose.store import ComposeStore
from app.math.models import CurationParams, CurationResult, MetricsWire, TuneResult, default_params
from app.math.store import MathStore


async def _author_composed(compose: ComposeStore, game_id: str) -> None:
    """A deliberate definition write — sets GameDefinitionDoc.touched, the
    signal family() requires (a bare get_or_seed auto-seed must not count;
    see test_math_descriptor.py's untouched-seed regression test)."""
    await compose.put(game_id, definition=templates.default_definition())


def _metrics():
    return MetricsWire(rtp=0.96, volatility=2.0, hit_frequency=0.3,
                       base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[])


@pytest.fixture
def stores(mongo_db):
    compose = ComposeStore(mongo_db)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=None)
    return math, compose


@pytest.mark.asyncio
async def test_composed_get_returns_definition_as_model(stores):
    math, compose = stores
    await _author_composed(compose, "g1")  # composed game exists
    doc = await math.get_or_seed("g1")
    assert doc.model.get("family") == "composed@1"
    assert doc.params == default_params()  # folded defaults appear lazily


@pytest.mark.asyncio
async def test_composed_put_params_persists_without_definition_change(stores):
    math, compose = stores
    await _author_composed(compose, "g1")
    before = (await compose.get("g1")).updated_at
    params = default_params().model_copy(update={"rtp_tolerance": 0.05})
    doc = await math.put("g1", params=params)
    assert doc.params.rtp_tolerance == 0.05
    assert (await compose.get("g1")).definition.get("family") == "composed@1"


@pytest.mark.asyncio
async def test_composed_put_model_routes_through_compose_store(stores, mongo_db):
    math, _ = stores
    events = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    compose = ComposeStore(mongo_db, on_change=on_change)
    math = MathStore(mongo_db, compose_store=compose, gdd_store=None)
    await _author_composed(compose, "g1")
    events.clear()
    tuned = {"family": "composed@1", "mechanics": [], "states": [], "start": "base", "transitions": []}
    doc = await math.put("g1", model=tuned, source="tuner")
    assert doc.model == tuned
    assert events == [("g1", "tuner")]  # watermark/scene-sync/auto-build path fired


@pytest.mark.asyncio
async def test_composed_save_results_round_trip(stores):
    math, compose = stores
    await _author_composed(compose, "g1")
    cur = CurationResult(status="pass", metrics=_metrics(), realized_rtp=0.96,
                         pool_size=100, failure=None, ran_at="t0")
    doc = await math.save_result("g1", cur)
    assert doc.result.status == "pass" and doc.verdict_stale is False
    tune = TuneResult(status="pass", verdict="pass", tuned_model={"family": "composed@1"},
                      metrics=_metrics(), ran_at="t1")
    doc = await math.save_tune_result("g1", tune)
    assert doc.tune_result.tuned_model == {"family": "composed@1"}


@pytest.mark.asyncio
async def test_slots_path_unchanged(stores):
    math, _ = stores
    doc = await math.get_or_seed("slots-game")  # no composed doc → slots
    assert "reels" in doc.model  # slots default template
