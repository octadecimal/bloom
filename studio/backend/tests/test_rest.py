import httpx
import pytest


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
