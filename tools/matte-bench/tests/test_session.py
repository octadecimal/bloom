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
    install_state(st, subjects, [_t()], tmp_path, "http://x")
    assert st.techniques == [config_hash(_t())]


def test_install_state_records_plate_hashes(tmp_path: Path):
    st = State()
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    plate = tmp_path / "plates" / "s1.png"
    plate.parent.mkdir(parents=True)
    plate.write_bytes(b"pixels")
    install_state(st, [s], [_t()], tmp_path, "http://x")
    assert set(st.plate_hashes) == {"s1"}


def test_install_state_records_technique_objs_by_hash(tmp_path: Path):
    """Lazy rendering (web._prepare) looks up the Technique object by the same
    hash used in state.techniques, so install_state must key it that way."""
    st = State()
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    t = _t()
    install_state(st, [s], [t], tmp_path, "http://x")
    assert st.technique_objs == {config_hash(t): t}
    assert st.comfy_url == "http://x"


def test_bootstrap_does_not_render_anything(tmp_path, monkeypatch):
    """Rendering is lazy now — bootstrap must not touch the GPU."""
    import asyncio

    from matte_bench import session as sess

    subjects_path = tmp_path / "subjects.json"
    subjects_path.write_text(json.dumps([
        {"id": "s1", "bucket": "wispy", "prompt": "p", "seed": 1, "width": 8, "height": 8},
    ]), encoding="utf-8")

    called = []

    async def boom_plate(*a, **k):
        called.append("plate")

    async def boom_render(*a, **k):
        called.append("render")

    monkeypatch.setattr(sess, "fetch_object_info", lambda url: {})
    monkeypatch.setattr(sess, "available_models",
                        lambda info: {"BiRefNetRMBG": ["BiRefNet-HR"]})
    if hasattr(sess, "ensure_plate"):
        monkeypatch.setattr(sess, "ensure_plate", boom_plate)
    if hasattr(sess, "ensure_render"):
        monkeypatch.setattr(sess, "ensure_render", boom_render)

    subjects, techniques, warnings = asyncio.run(
        sess.bootstrap(tmp_path, subjects_path, "http://x"))
    assert [s.id for s in subjects] == ["s1"]
    assert len(techniques) == 1
    assert called == []
