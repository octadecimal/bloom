import pytest

from app.assets.comfy import FakeComfyProvider, ImageEvent, ProgressEvent, build_provider
from app.config import Settings


@pytest.mark.asyncio
async def test_fake_provider_streams_progress_then_image():
    provider = FakeComfyProvider(ticks=3)
    events = [ev async for ev in provider.generate({"any": "graph"})]

    progress = [e for e in events if isinstance(e, ProgressEvent)]
    images = [e for e in events if isinstance(e, ImageEvent)]
    assert len(progress) == 3
    assert progress[-1].value == progress[-1].max  # ends at 100%
    assert len(images) == 1
    assert images[0].data.startswith(b"\x89PNG")  # valid PNG header


def test_build_provider_selects_fake():
    provider = build_provider(Settings(comfy_backend="fake"))
    assert isinstance(provider, FakeComfyProvider)
