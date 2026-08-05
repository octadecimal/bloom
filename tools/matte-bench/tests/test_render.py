from pathlib import Path

from matte_bench.render import render_path
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
