import pytest
import pytest_asyncio
from app.tuner.models import default_tuning_params
from app.analytics.models import MathRunDoc
from app.analytics.store import MathRunStore


@pytest_asyncio.fixture(autouse=True)
async def _clear_math_runs(mongo_db):
    await mongo_db["math_runs"].delete_many({})
    yield
    await mongo_db["math_runs"].delete_many({})


def _run(run_id: str, game_id: str, created_at: str) -> MathRunDoc:
    return MathRunDoc(
        id=run_id,
        game_id=game_id,
        params=default_tuning_params(),
        verdict="pass",
        metrics=None,
        trace=[],
        profile=None,
        created_at=created_at,
        duration_ms=1234,
    )


@pytest.mark.asyncio
async def test_append_never_overwrites(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))
    await store.append(_run("r2", "g1", "2026-01-02T00:00:00+00:00"))
    count = await mongo_db["math_runs"].count_documents({"game_id": "g1"})
    assert count == 2


@pytest.mark.asyncio
async def test_list_for_game_newest_first_and_scoped(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))
    await store.append(_run("r2", "g1", "2026-01-02T00:00:00+00:00"))
    await store.append(_run("r3", "g2", "2026-01-03T00:00:00+00:00"))

    docs = await store.list_for_game("g1")
    assert [d.id for d in docs] == ["r2", "r1"]


@pytest.mark.asyncio
async def test_list_for_game_respects_limit(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))
    await store.append(_run("r2", "g1", "2026-01-02T00:00:00+00:00"))
    await store.append(_run("r3", "g1", "2026-01-03T00:00:00+00:00"))

    docs = await store.list_for_game("g1", limit=2)
    assert [d.id for d in docs] == ["r3", "r2"]


@pytest.mark.asyncio
async def test_get_returns_run_or_none(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))

    got = await store.get("r1")
    assert got is not None
    assert got.id == "r1"
    assert got.game_id == "g1"

    missing = await store.get("nope")
    assert missing is None
