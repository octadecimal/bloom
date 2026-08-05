import json
from pathlib import Path

from matte_bench.corpus import Subject
from matte_bench.session import install_state
from matte_bench.techniques import Technique, config_hash
from matte_bench.web import State


def _t(tid="birefnet-hr", model="BiRefNet-HR"):
    return Technique(id=tid, cls="A", node="BiRefNetRMBG", model=model,
                     params={}, post=())


def test_install_state_exposes_config_hashes_not_ids(tmp_path: Path):
    """The UI fetches /render/<subject>/<hash>.png, so state carries hashes."""
    st = State()
    subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                        width=8, height=8)]
    install_state(st, subjects, [_t()], tmp_path)
    assert st.techniques == [config_hash(_t())]


def test_install_state_records_plate_hashes(tmp_path: Path):
    st = State()
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    plate = tmp_path / "plates" / "s1.png"
    plate.parent.mkdir(parents=True)
    plate.write_bytes(b"pixels")
    install_state(st, [s], [_t()], tmp_path)
    assert set(st.plate_hashes) == {"s1"}


def test_bootstrap_reports_a_failed_plate_and_keeps_going(tmp_path, monkeypatch):
    """One unusable subject must not abort the session."""
    import asyncio

    from matte_bench import session as sess

    subjects_path = tmp_path / "subjects.json"
    subjects_path.write_text(json.dumps([
        {"id": "good", "bucket": "wispy", "prompt": "p", "seed": 1, "width": 8, "height": 8},
        {"id": "bad", "bucket": "wispy", "prompt": "p", "seed": 2, "width": 8, "height": 8},
    ]), encoding="utf-8")

    async def fake_plate(s, root, comfy_url):
        if s.id == "bad":
            raise RuntimeError("no plate produced")

    async def fake_render(s, t, root, comfy_url):
        return tmp_path / "x.png"

    monkeypatch.setattr(sess, "fetch_object_info", lambda url: {})
    monkeypatch.setattr(sess, "available_models",
                        lambda info: {"BiRefNetRMBG": ["BiRefNet-HR"]})
    monkeypatch.setattr(sess, "ensure_plate", fake_plate)
    monkeypatch.setattr(sess, "ensure_render", fake_render)

    subjects, usable, warnings = asyncio.run(
        sess.bootstrap(tmp_path, subjects_path, "http://x"))
    assert [s.id for s in subjects] == ["good"]
    assert len(usable) == 1
    assert any("bad" in w for w in warnings)


def test_bootstrap_reports_an_unavailable_technique(tmp_path, monkeypatch):
    """A technique that cannot render is excluded AND named in warnings."""
    import asyncio

    from matte_bench import session as sess
    from matte_bench.render import RenderError

    subjects_path = tmp_path / "subjects.json"
    subjects_path.write_text(json.dumps([
        {"id": "s1", "bucket": "wispy", "prompt": "p", "seed": 1, "width": 8, "height": 8},
    ]), encoding="utf-8")

    async def fake_plate(s, root, comfy_url):
        return tmp_path / "p.png"

    async def fake_render(s, t, root, comfy_url):
        raise RenderError(t.id, "weights missing")

    monkeypatch.setattr(sess, "fetch_object_info", lambda url: {})
    monkeypatch.setattr(sess, "available_models",
                        lambda info: {"BiRefNetRMBG": ["BiRefNet-HR"]})
    monkeypatch.setattr(sess, "ensure_plate", fake_plate)
    monkeypatch.setattr(sess, "ensure_render", fake_render)

    subjects, usable, warnings = asyncio.run(
        sess.bootstrap(tmp_path, subjects_path, "http://x"))
    assert usable == []
    assert any("weights missing" in w for w in warnings)


def test_bootstrap_marks_nothing_usable_when_every_plate_fails(tmp_path, monkeypatch):
    """Zero subjects must mean zero usable techniques, not vacuously all of them."""
    import asyncio

    from matte_bench import session as sess

    subjects_path = tmp_path / "subjects.json"
    subjects_path.write_text(json.dumps([
        {"id": "s1", "bucket": "wispy", "prompt": "p", "seed": 1, "width": 8, "height": 8},
    ]), encoding="utf-8")

    async def always_fails(s, root, comfy_url):
        raise RuntimeError("no plate produced")

    monkeypatch.setattr(sess, "fetch_object_info", lambda url: {})
    monkeypatch.setattr(sess, "available_models",
                        lambda info: {"BiRefNetRMBG": ["BiRefNet-HR"]})
    monkeypatch.setattr(sess, "ensure_plate", always_fails)

    subjects, usable, warnings = asyncio.run(
        sess.bootstrap(tmp_path, subjects_path, "http://x"))
    assert subjects == []
    assert usable == []
    assert any("no usable subjects" in w for w in warnings)
