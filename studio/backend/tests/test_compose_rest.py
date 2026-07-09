from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.compose import rest
from app.compose.runner import FakeComposeRunner
from app.compose.store import ComposeStore
from app.config import Settings


def _req(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


def _settings() -> Settings:
    return Settings(provider_mode="replay", mongo_db="bloom_studio_test")


@pytest.mark.asyncio
async def test_get_seeds_and_put_updates(mongo_db):
    store = ComposeStore(mongo_db)
    req = _req(compose_store=store)
    got = await rest.get_game_definition("g1", req)
    assert got["gameId"] == "g1"
    assert got["definition"]["family"] == "composed@1"

    body = rest.PutGameDefinitionBody(
        definition={"family": "composed@1", "mechanics": []}, source="editor"
    )
    updated = await rest.put_game_definition("g1", body, req)
    assert updated["definition"]["mechanics"] == []


@pytest.mark.asyncio
async def test_put_fires_on_change_with_source(mongo_db):
    events = []

    async def on_change(doc, source):
        events.append(source)

    store = ComposeStore(mongo_db, on_change=on_change)
    req = _req(compose_store=store)
    await rest.put_game_definition(
        "g1", rest.PutGameDefinitionBody(presentation={"x": 1}, source="editor"), req
    )
    assert events == ["editor"]


@pytest.mark.asyncio
async def test_validate_prefers_request_definition(mongo_db):
    store = ComposeStore(mongo_db)
    fake = FakeComposeRunner({"ok": False, "errors": ['UnknownState { referenced: "x" }']})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    res = await rest.validate_game_definition(
        "g1", rest.ValidateGameDefinitionBody(definition={"family": "composed@1"}), req
    )
    assert res == {"ok": False, "errors": ['UnknownState { referenced: "x" }']}
    job = fake.jobs[0]
    assert job["validate_only"] is True
    assert job["definition"] == {"family": "composed@1"}
    assert "out_path" not in job


@pytest.mark.asyncio
async def test_validate_falls_back_to_stored_definition(mongo_db):
    store = ComposeStore(mongo_db)
    fake = FakeComposeRunner({"ok": True})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    res = await rest.validate_game_definition("g1", rest.ValidateGameDefinitionBody(), req)
    assert res["ok"] is True
    assert fake.jobs[0]["definition"]["family"] == "composed@1"


@pytest.mark.asyncio
async def test_build_shapes_job_and_response(mongo_db):
    store = ComposeStore(mongo_db)
    metrics = {"rtp": 0.93, "hitRate": 0.4, "maxWinX": 60, "stateVisits": {"base": 100}}
    fake = FakeComposeRunner({"ok": True, "metrics": metrics})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    res = await rest.build_game_definition("g1", req)
    assert res == {"ok": True, "errors": None, "metrics": metrics, "packageId": "g1"}
    job = fake.jobs[0]
    assert job["package_id"] == "g1"
    assert job["validate_only"] is False
    assert job["seed_count"] == 10000
    assert isinstance(job["master_seed"], int)
    assert job["out_path"].replace("\\", "/").endswith("var/packages/g1.pkg")
    assert job["presentation"] is not None
    # deterministic per game: rebuilds reproduce the same pool
    await rest.build_game_definition("g1", req)
    assert fake.jobs[1]["master_seed"] == job["master_seed"]


@pytest.mark.asyncio
async def test_build_rejects_a_game_id_that_escapes_the_packages_dir(mongo_db):
    store = ComposeStore(mongo_db)
    fake = FakeComposeRunner({"ok": True})
    req = _req(compose_store=store, compose_runner=fake, settings=_settings())
    with pytest.raises(HTTPException) as exc:
        await rest.build_game_definition("..\\foo", req)
    assert exc.value.status_code == 400
    assert fake.jobs == []
