import json
from app.replay.cassette import (
    normalize_prompt, load_llm_cassettes, load_comfy_cassette,
)


def test_normalize_prompt_collapses_ws():
    assert normalize_prompt("  Hello   There  ") == "hello there"


def test_load_llm_cassettes_keys_by_prompt_and_default(tmp_path):
    d = tmp_path / "llm"
    d.mkdir()
    (d / "greet.json").write_text(json.dumps({"prompt": "Hi there", "chunks": ["Hi", " back"]}))
    (d / "default.json").write_text(json.dumps({"prompt": "anything", "chunks": ["Sure", "."]}))
    cas = load_llm_cassettes(tmp_path)
    assert cas[normalize_prompt("Hi there")] == ["Hi", " back"]
    assert cas["__default__"] == ["Sure", "."]


def test_load_comfy_cassette(tmp_path):
    c = tmp_path / "comfy"
    c.mkdir()
    (c / "default.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 100)
    (c / "default.json").write_text(json.dumps({"progress": [[1, 2], [2, 2]], "image": "default.png"}))
    progress, image = load_comfy_cassette(tmp_path)
    assert progress == [(1, 2), (2, 2)]
    assert image.startswith(b"\x89PNG")
