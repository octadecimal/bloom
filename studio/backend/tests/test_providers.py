import pytest
from app.config import Settings
from app.providers import (
    ReplayLLMProvider, LiveOpenRouterProvider, build_provider, ERROR_SENTINEL_MODEL,
)

CASSETTES = {"hi there": ["Hi", " back"], "__default__": ["Sure", " thing"]}


async def _collect(provider, turns, model):
    return "".join([c async for c in provider.stream(turns, model)])


async def test_replay_returns_recorded_chunks_not_echo():
    p = ReplayLLMProvider(CASSETTES)
    out = await _collect(p, [{"role": "user", "content": "Hi there"}], "m")
    assert out == "Hi back"
    assert not out.startswith("echo:")


async def test_replay_falls_back_to_default():
    p = ReplayLLMProvider(CASSETTES)
    out = await _collect(p, [{"role": "user", "content": "unknown prompt"}], "m")
    assert out == "Sure thing"


async def test_replay_raises_on_sentinel_model():
    p = ReplayLLMProvider(CASSETTES)
    with pytest.raises(RuntimeError):
        await _collect(p, [{"role": "user", "content": "x"}], ERROR_SENTINEL_MODEL)


def test_factory_selects_by_mode():
    assert isinstance(build_provider(Settings(provider_mode="replay")), ReplayLLMProvider)
    assert isinstance(build_provider(Settings(provider_mode="live")), LiveOpenRouterProvider)
