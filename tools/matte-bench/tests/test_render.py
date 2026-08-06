import asyncio
from pathlib import Path

from PIL import Image
from io import BytesIO

from matte_bench.render import backdrop_prompt, ensure_render, render_path
from matte_bench.corpus import Subject, plate_path
from matte_bench.sampler import DEFAULT_GROUND, GROUNDS
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


def test_backdrop_prompt_replaces_default_ground():
    """The chroma clause must REPLACE the ground directive, not follow it:
    two contradictory backdrop instructions and flux obeys the black one,
    leaving the keyer nothing chroma to remove (opaque renders)."""
    subject = f"a fern, premium slot game art, {DEFAULT_GROUND}"
    out = backdrop_prompt(subject, "isolated on a chroma green backdrop")
    assert "black background" not in out
    assert out.endswith("isolated on a chroma green backdrop")
    assert out.startswith("a fern, premium slot game art")
    assert ", ," not in out


def test_backdrop_prompt_replaces_bucket_ground():
    """low-contrast subjects carry their own ground clause; it conflicts with
    the chroma backdrop the same way the default one does."""
    subject = f"a pale grey moth, {GROUNDS['low-contrast']}"
    out = backdrop_prompt(subject, "isolated on a chroma green backdrop")
    assert "almost the same" not in out
    assert out.endswith("isolated on a chroma green backdrop")
    assert out.startswith("a pale grey moth")


def test_backdrop_prompt_without_ground_just_appends():
    assert backdrop_prompt("a fern", "on chroma") == "a fern, on chroma"


def test_backdrop_render_prompt_carries_no_ground_directive(tmp_path, monkeypatch):
    """End to end through ensure_render: the graph sent to ComfyUI must not
    ask for the black ground the subject prompt was sampled with."""
    captured = {}

    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            captured["graph"] = graph
            from matte_bench.render import ImageEvent
            yield ImageEvent(data=_flat_png((0, 177, 64)))

    monkeypatch.setattr("matte_bench.render.LiveComfyProvider", FakeProvider)
    s = Subject(id="s1", bucket="wispy", prompt=f"a fern, {DEFAULT_GROUND}",
                seed=3, width=16, height=16)
    asyncio.run(ensure_render(s, _b(), tmp_path, "http://gpu:8188"))
    prompts = [n["inputs"].get("text") for n in captured["graph"].values()
               if isinstance(n.get("inputs"), dict) and "text" in n.get("inputs", {})]
    positive = [p for p in prompts if p and "a fern" in p]
    assert positive, "no positive prompt found in graph"
    assert all("black background" not in p for p in positive)
    assert any("chroma green" in p for p in positive)


def test_backdrop_render_keys_on_sampled_border_color(tmp_path, monkeypatch):
    """key_source=border-median: flux answers a chroma clause with a
    desaturated wall nowhere near the nominal hex; the keyer must measure the
    backdrop it actually got instead of keying thin air."""
    wall, subject_px = (15, 38, 38), (200, 160, 40)

    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            from matte_bench.render import ImageEvent
            img = Image.new("RGB", (32, 32), wall)
            for x in range(8, 24):
                for y in range(8, 24):
                    img.putpixel((x, y), subject_px)
            buf = BytesIO()
            img.save(buf, "PNG")
            yield ImageEvent(data=buf.getvalue())

    monkeypatch.setattr("matte_bench.render.LiveComfyProvider", FakeProvider)
    s = Subject(id="s1", bucket="wispy", prompt="a fern", seed=3,
                width=32, height=32)
    t = _b(params={**_b().params, "key_source": "border-median"})
    dest = asyncio.run(ensure_render(s, t, tmp_path, "http://gpu:8188"))
    out = Image.open(dest).convert("RGBA")
    assert out.getpixel((0, 0))[3] == 0          # wall keyed out
    assert out.getpixel((16, 16))[3] == 255      # subject kept


def test_backdrop_techniques_key_on_border_median():
    from matte_bench.techniques import backdrop_techniques
    assert all(t.params["key_source"] == "border-median"
               for t in backdrop_techniques())


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
