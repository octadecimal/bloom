"""An upload failure must surface as RenderError, not escape as an httpx error.

bootstrap only catches RenderError, so anything else aborts the entire run
instead of marking one technique unavailable.
"""
import asyncio

import pytest

from matte_bench import render as rnd
from matte_bench.corpus import Subject
from matte_bench.render import RenderError
from matte_bench.techniques import Technique


def _subject():
    return Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)


def _technique():
    return Technique(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                     model="BiRefNet-HR", params={}, post=())


def test_upload_failure_becomes_render_error(tmp_path, monkeypatch):
    plate = tmp_path / "plates" / "s1.png"
    plate.parent.mkdir(parents=True)
    plate.write_bytes(b"\x89PNG\r\n\x1a\n")

    def boom(base_url, path):
        raise RuntimeError("upload rejected: 500")

    monkeypatch.setattr(rnd, "upload_plate", boom)

    with pytest.raises(RenderError) as excinfo:
        asyncio.run(rnd.ensure_render(_subject(), _technique(), tmp_path, "http://x"))
    assert excinfo.value.technique_id == "birefnet-hr"
    assert "upload rejected" in excinfo.value.reason


def test_missing_plate_becomes_render_error(tmp_path):
    with pytest.raises(RenderError) as excinfo:
        asyncio.run(rnd.ensure_render(_subject(), _technique(), tmp_path, "http://x"))
    assert excinfo.value.technique_id == "birefnet-hr"


def test_ensure_render_forwards_comfy_progress_as_fractions(tmp_path, monkeypatch):
    """ComfyUI streams ProgressEvents during a render; the bench must surface
    them so the judging page can show a real progress bar."""
    from app.assets.comfy import ImageEvent, ProgressEvent

    plate = tmp_path / "plates" / "s1.png"
    plate.parent.mkdir(parents=True)
    plate.write_bytes(b"\x89PNG\r\n\x1a\n")
    monkeypatch.setattr(rnd, "upload_plate", lambda base_url, path: "s1.png")

    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            yield ProgressEvent(value=2, max=10)
            yield ProgressEvent(value=5, max=10)
            yield ProgressEvent(value=1, max=0)   # malformed: must not divide
            yield ImageEvent(data=b"\x89PNG\r\n\x1a\nrender")

    monkeypatch.setattr(rnd, "LiveComfyProvider", FakeProvider)

    fractions = []
    asyncio.run(rnd.ensure_render(_subject(), _technique(), tmp_path, "http://x",
                                  on_progress=fractions.append))
    assert fractions == [0.2, 0.5]
