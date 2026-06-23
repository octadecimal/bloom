# studio/backend/tests/test_fixtures_committed.py
from app.replay.cassette import DEFAULT_FIXTURES_DIR, load_comfy_cassette, load_llm_cassettes


def test_llm_default_cassette_is_real():
    cas = load_llm_cassettes(DEFAULT_FIXTURES_DIR)
    assert "__default__" in cas
    text = "".join(cas["__default__"])
    assert text and not text.startswith("echo:")


def test_comfy_default_cassette_is_a_real_png():
    progress, image = load_comfy_cassette(DEFAULT_FIXTURES_DIR)
    assert image.startswith(b"\x89PNG")
    assert len(image) > 5_000  # a real generation, not the old ~70-byte 1x1
    assert len(progress) >= 1


def test_run_cassette_is_real():
    from app.replay.cassette import load_run_cassette, DEFAULT_FIXTURES_DIR
    cas = load_run_cassette(DEFAULT_FIXTURES_DIR)
    assert cas["tool_calls"] and "".join(cas["final"]).strip()
