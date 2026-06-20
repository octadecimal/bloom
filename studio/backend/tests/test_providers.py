import pytest

from app.config import Settings
from app.providers import FakeProvider, build_provider


@pytest.mark.asyncio
async def test_fake_provider_echoes_last_turn():
    provider = FakeProvider(delay=0.0)
    turns = [{"role": "user", "content": "Alice: hello"}]
    tokens = [tok async for tok in provider.stream(turns, "m:free")]
    assert "".join(tokens).strip() == "echo: Alice: hello"
    assert len(tokens) > 1  # streamed as multiple tokens


def test_build_provider_selects_fake_when_configured():
    provider = build_provider(Settings(llm_backend="fake"))
    assert isinstance(provider, FakeProvider)
