import httpx
import pytest

from app.config import Settings
from app.scene.composed_spin import ComposedSpinClient, ComposedSpinError, build_composed_spin_client


def _client(handler):
    return ComposedSpinClient("http://rt:9000", transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_spin_posts_bet_and_package_and_returns_the_round():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.content.decode()
        return httpx.Response(200, json={"seed": "11", "bet": 1,
                                         "outcome": {"mechanic": "composed@1", "total_payout": 5},
                                         "trace": [{"t": "round_start", "seed": "11"}]})

    res = await _client(handler).spin("g1")
    assert seen["url"] == "http://rt:9000/spin"
    assert '"package": "g1"' in seen["body"] or '"package":"g1"' in seen["body"]
    assert res["outcome"]["total_payout"] == 5


@pytest.mark.asyncio
async def test_404_maps_to_a_not_built_yet_message():
    with pytest.raises(ComposedSpinError, match="not built yet"):
        await _client(lambda r: httpx.Response(404)).spin("g1")


@pytest.mark.asyncio
async def test_connection_failure_names_the_fix():
    def handler(request):
        raise httpx.ConnectError("boom")

    with pytest.raises(ComposedSpinError, match="just runtime-serve-packages"):
        await _client(handler).spin("g1")


@pytest.mark.asyncio
async def test_5xx_surfaces_status():
    with pytest.raises(ComposedSpinError, match="500"):
        await _client(lambda r: httpx.Response(500, text="audit down")).spin("g1")


def test_default_url_derives_from_port_offset(monkeypatch):
    monkeypatch.setenv("BLOOM_PORT_OFFSET", "2")
    c = build_composed_spin_client(Settings(runtime_server_url=""))
    assert c.base_url == "http://localhost:9002"
    c2 = build_composed_spin_client(Settings(runtime_server_url="http://x:9302"))
    assert c2.base_url == "http://x:9302"
