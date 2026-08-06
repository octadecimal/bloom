import asyncio
import json
from pathlib import Path

from matte_bench.corpus import Subject
from matte_bench.session import bootstrap, install_state
from matte_bench.techniques import Technique, backdrop_techniques, config_hash, stage1_models
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

    templates_path = tmp_path / "templates.json"
    templates_path.write_text(json.dumps({
        "wispy": {"width": 8, "height": 8,
                  "templates": [{"text": "a tuft"}], "pools": {}},
    }), encoding="utf-8")
    subject_log = tmp_path / "subjects-sampled.jsonl"
    subject_log.write_text(json.dumps(
        {"id": "wispy-1", "bucket": "wispy", "prompt": "p", "seed": 1,
         "width": 8, "height": 8}) + "\n", encoding="utf-8")

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

    subjects, templates, techniques, warnings = asyncio.run(
        sess.bootstrap(tmp_path, templates_path, subject_log, "http://x"))
    assert [s.id for s in subjects] == ["wispy-1"]
    assert "wispy" in templates
    assert len(techniques) == 1
    assert called == []


def _info_with_flux_and_matting():
    return {
        "CheckpointLoaderSimple": {"input": {"required": {
            "ckpt_name": [["flux1-dev-fp8.safetensors"]]}}},
        "BiRefNetRMBG": {"input": {"required": {
            "model": [["BiRefNet-HR", "BiRefNet-general"]]}}},
    }


def test_bootstrap_adds_backdrop_when_checkpoint_present(tmp_path, monkeypatch):
    monkeypatch.setattr("matte_bench.session.fetch_object_info",
                        lambda url: _info_with_flux_and_matting())
    (tmp_path / "templates.json").write_text("{}", encoding="utf-8")
    subjects, templates, techniques, warnings = asyncio.run(bootstrap(
        tmp_path, tmp_path / "templates.json", tmp_path / "subjects.jsonl",
        "http://gpu:8188"))
    assert any(t.cls == "B" and t.node == "backdrop-key" for t in techniques)
    assert any(t.cls == "A" for t in techniques)
    assert any("qwen-layered disabled" in w for w in warnings)


def test_bootstrap_gates_backdrop_without_checkpoint(tmp_path, monkeypatch):
    info = _info_with_flux_and_matting()
    info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"] = [[]]
    monkeypatch.setattr("matte_bench.session.fetch_object_info", lambda url: info)
    (tmp_path / "templates.json").write_text("{}", encoding="utf-8")
    _, _, techniques, warnings = asyncio.run(bootstrap(
        tmp_path, tmp_path / "templates.json", tmp_path / "subjects.jsonl",
        "http://gpu:8188"))
    assert not any(t.node == "backdrop-key" for t in techniques)
    assert any("backdrop-key disabled" in w for w in warnings)


def test_install_state_maps_hash_to_cls(tmp_path):
    from matte_bench.web import State
    s = State()
    techniques = stage1_models({"RMBG": ["m1", "m2"]}) + backdrop_techniques()
    install_state(s, [], techniques, tmp_path, "http://gpu:8188")
    assert set(s.technique_cls.values()) == {"A", "B"}
    assert len(s.technique_cls) == len(techniques)
