import httpx
import pytest

from app.config import Settings
from app.main import build


def _client(ctx):
    transport = httpx.ASGITransport(app=ctx.fastapi_app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_create_then_list_rooms(ctx, mongo_db):
    async with _client(ctx) as client:
        created = await client.post("/rooms", json={"name": "General"})
        assert created.status_code == 201
        body = created.json()
        assert body["name"] == "General"
        assert body["model"]  # defaulted
        assert "createdAt" in body

        listed = await client.get("/rooms")
        assert listed.status_code == 200
        assert [r["name"] for r in listed.json()] == ["General"]


@pytest.mark.asyncio
async def test_history_endpoint_and_404(ctx, mongo_db):
    async with _client(ctx) as client:
        created = await client.post("/rooms", json={"name": "R", "model": "m:free"})
        room_id = created.json()["id"]
        await ctx.store.add_message(room_id, "Alice", "user", "hello", "complete")

        history = await client.get(f"/rooms/{room_id}/messages")
        assert history.status_code == 200
        assert history.json()[0]["content"] == "hello"
        assert history.json()[0]["author"] == "Alice"

        missing = await client.get("/rooms/nope/messages")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_models_endpoint_returns_catalog(ctx):
    async with _client(ctx) as client:
        resp = await client.get("/models")
        assert resp.status_code == 200
        catalog = resp.json()
        assert isinstance(catalog, list) and catalog
        first = catalog[0]
        assert set(first.keys()) == {"id", "label", "free"}
        assert any(item["free"] for item in catalog)  # at least one :free dev model


@pytest.mark.asyncio
async def test_get_skills_lists_registered(ctx):
    async with _client(ctx) as client:
        resp = await client.get("/skills")
        assert resp.status_code == 200
        names = [s["name"] for s in resp.json()]
        assert "generate-sprite" in names


@pytest.mark.asyncio
async def test_get_skill_full_and_404(ctx):
    async with _client(ctx) as client:
        ok = await client.get("/skills/generate-sprite")
        assert ok.status_code == 200
        body = ok.json()
        assert body["name"] == "generate-sprite"
        assert "description" in body and "body" in body and "tools" in body and isinstance(body["args"], list)
        missing = await client.get("/skills/nope")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_get_tools_lists_known(ctx):
    async with _client(ctx) as client:
        resp = await client.get("/tools")
        assert resp.status_code == 200
        assert {"name": "generate_asset"} in resp.json()


@pytest.mark.asyncio
async def test_post_skill_writes_and_rejects(tmp_path):
    app = build(Settings(provider_mode="replay", mongo_db="bloom_studio_test", skills_dir=str(tmp_path)))
    transport = httpx.ASGITransport(app=app.fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        good = await client.post("/skills", json={
            "name": "tmp-skill", "description": "d",
            "args": [{"name": "description", "type": "string", "required": True}],
            "tools": ["generate_asset"], "body": "use generate_asset",
        })
        assert good.status_code == 200
        assert good.json()["name"] == "tmp-skill"
        # now listed
        listed = await client.get("/skills")
        assert "tmp-skill" in [s["name"] for s in listed.json()]
        # unknown tool rejected
        bad = await client.post("/skills", json={
            "name": "bad-skill", "description": "d", "args": [],
            "tools": ["nuke"], "body": "x",
        })
        assert bad.status_code == 400
        assert "detail" in bad.json() and bad.json()["detail"]


@pytest.mark.asyncio
async def test_rest_sends_cors_headers_for_browser_origin(ctx):
    # The frontend runs on a different origin (e.g. :4200) than the backend
    # (:8000), so the REST routes must answer CORS preflights and echo an
    # Access-Control-Allow-Origin header, or the browser blocks every fetch.
    origin = "http://localhost:4200"
    async with _client(ctx) as client:
        simple = await client.get("/health", headers={"Origin": origin})
        assert simple.headers.get("access-control-allow-origin") in ("*", origin)

        preflight = await client.options(
            "/rooms",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert preflight.status_code in (200, 204)
        assert preflight.headers.get("access-control-allow-origin") in ("*", origin)
