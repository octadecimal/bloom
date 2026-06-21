import httpx
import pytest


@pytest.mark.asyncio
async def test_health_ok(ctx):
    transport = httpx.ASGITransport(app=ctx.fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "providerMode": "replay"}


@pytest.mark.asyncio
async def test_health_reports_provider_mode(ctx):
    transport = httpx.ASGITransport(app=ctx.fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
    body = resp.json()
    assert body["status"] == "ok"
    assert body["providerMode"] == "replay"
