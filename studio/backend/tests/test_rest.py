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
