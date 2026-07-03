import pytest
import pytest_asyncio
from types import SimpleNamespace
from fastapi import HTTPException

from app.tuner.models import default_tuning_params
from app.analytics.models import MathRunDoc
from app.analytics.store import MathRunStore
from app.analytics import rest


@pytest_asyncio.fixture(autouse=True)
async def _clear(mongo_db):
    await mongo_db["math_runs"].delete_many({})
    yield
    await mongo_db["math_runs"].delete_many({})


def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


def _run(run_id: str, game_id: str, created_at: str) -> MathRunDoc:
    return MathRunDoc(
        id=run_id,
        game_id=game_id,
        params=default_tuning_params(),
        verdict="pass",
        metrics=None,
        trace=[],
        profile={
            "distribution": {
                "bins": [
                    {"binLo": 0.0, "binHi": 1.0, "base": 1, "feature": 0},
                    {"binLo": 1.0, "binHi": None, "base": 0, "feature": 0},
                ],
                "zeroCount": 0,
            },
            "tail": {
                "maxWin": 10.0,
                "pGE100x": 0.0,
                "pLosingSpin": 0.1,
                "longestDeadStreak": 3,
                "bonusTriggerRate": 0.02,
            },
            "rtpConvergence": [],
        },
        created_at=created_at,
        duration_ms=1234,
    )


@pytest.mark.asyncio
async def test_list_runs_returns_camel_case_docs_with_null_bin_hi(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))
    await store.append(_run("r2", "g1", "2026-01-02T00:00:00+00:00"))
    req = _req(math_run_store=store)

    out = await rest.list_runs("g1", req)

    assert len(out) == 2
    assert out[0]["gameId"] == "g1"
    assert out[0]["id"] == "r2"
    assert out[0]["profile"]["distribution"]["bins"][-1]["binHi"] is None


@pytest.mark.asyncio
async def test_get_run_returns_404_for_missing(mongo_db):
    store = MathRunStore(mongo_db)
    req = _req(math_run_store=store)

    with pytest.raises(HTTPException) as exc_info:
        await rest.get_run("missing", req)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_get_run_returns_doc(mongo_db):
    store = MathRunStore(mongo_db)
    await store.append(_run("r1", "g1", "2026-01-01T00:00:00+00:00"))
    req = _req(math_run_store=store)

    out = await rest.get_run("r1", req)
    assert out["id"] == "r1"
    assert out["gameId"] == "g1"
