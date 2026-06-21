import pytest

from app.config import Settings
from app.assets.comfy import (
    ReplayComfyProvider, LiveComfyProvider, ProgressEvent, ImageEvent, build_provider,
)

REAL_PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 500


async def test_replay_yields_recorded_progress_then_image():
    p = ReplayComfyProvider(progress=[(1, 2), (2, 2)], image=REAL_PNG, delay=0.0)
    events = [e async for e in p.generate({})]
    assert [type(e) for e in events] == [ProgressEvent, ProgressEvent, ImageEvent]
    assert events[-1].data == REAL_PNG
    assert len(events[-1].data) > 70  # not the old 1x1 fake


def test_factory_selects_by_mode(tmp_path, monkeypatch):
    # live branch needs no fixtures
    assert isinstance(build_provider(Settings(provider_mode="live")), LiveComfyProvider)


@pytest.mark.asyncio
async def test_replay_raises_on_force_error_prompt():
    provider = ReplayComfyProvider(progress=[(1, 1)], image=b"\x89PNG\r\n\x1a\n")
    graph = {"6": {"inputs": {"text": "Force Error"}}}
    with pytest.raises(RuntimeError):
        async for _ in provider.generate(graph):
            pass
