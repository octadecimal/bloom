import asyncio
from pathlib import Path

from PIL import Image
from io import BytesIO

from matte_bench.render import ensure_render, render_path
from matte_bench.corpus import Subject, plate_path
from matte_bench.techniques import Technique, config_hash


def _t(**over):
    base = dict(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                model="BiRefNet-HR", params={}, post=())
    return Technique(**{**base, **over})


def test_render_path_includes_config_hash(tmp_path: Path):
    p = render_path(tmp_path, "s1", _t())
    assert p.parent == tmp_path / "renders" / "s1"
    assert config_hash(_t()) in p.name
    assert p.suffix == ".png"


def test_render_path_differs_when_params_differ(tmp_path: Path):
    """Changing params must not reuse a stale cached render."""
    a = render_path(tmp_path, "s1", _t())
    b = render_path(tmp_path, "s1", _t(params={"mask_blur": 4}))
    assert a != b


def test_render_path_differs_when_postops_differ(tmp_path: Path):
    a = render_path(tmp_path, "s1", _t())
    b = render_path(tmp_path, "s1", _t(post=(("despeckle", 0.001),)))
    assert a != b


def test_render_path_same_for_renamed_technique(tmp_path: Path):
    """The cache is keyed by configuration, not by label."""
    assert render_path(tmp_path, "s1", _t()) == render_path(tmp_path, "s1", _t(id="other"))


def _b(**over):
    base = dict(id="backdrop-chroma-green", cls="B", node="backdrop-key",
                model="chroma-green",
                params={"clause": "isolated on a solid flat chroma green backdrop",
                        "key_color": [0, 177, 64], "tolerance": 60,
                        "softness": 60, "despill": 1},
                post=())
    return Technique(**{**base, **over})


def _flat_png(color, size=(16, 16)):
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def test_backdrop_render_generates_and_keys(tmp_path, monkeypatch):
    """A backdrop technique renders its own image (no plate needed) and the
    key color comes out transparent."""
    captured = {}

    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            captured["graph"] = graph
            from matte_bench.render import ImageEvent
            yield ImageEvent(data=_flat_png((0, 177, 64)))

    monkeypatch.setattr("matte_bench.render.LiveComfyProvider", FakeProvider)
    s = Subject(id="s1", bucket="wispy", prompt="a fern", seed=3,
                width=16, height=16)
    dest = asyncio.run(ensure_render(s, _b(), tmp_path, "http://gpu:8188"))
    out = Image.open(dest).convert("RGBA")
    assert all(a == 0 for a in out.getchannel("A").getdata())
    # the generation prompt is the subject prompt plus the backdrop clause
    prompts = [n["inputs"].get("text") for n in captured["graph"].values()
               if isinstance(n.get("inputs"), dict) and "text" in n.get("inputs", {})]
    assert any(p and "a fern" in p and "chroma green" in p for p in prompts)
