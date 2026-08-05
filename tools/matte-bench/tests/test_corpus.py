import json
from pathlib import Path

import pytest

from matte_bench.corpus import Subject, plate_hash, plate_hashes, plate_path

REPO = Path(__file__).resolve().parents[3]


def test_subject_log_round_trips(tmp_path: Path):
    """Sampled subjects are appended to a registry so verdicts cast on them
    stay attributable and their plates stay regenerable (prompt+seed)."""
    from matte_bench.corpus import append_subject, load_subject_log

    log = tmp_path / "subjects-sampled.jsonl"
    a = Subject(id="wispy-5", bucket="wispy", prompt="p1", seed=5, width=8, height=8)
    b = Subject(id="filigree-9", bucket="filigree", prompt="p2", seed=9,
                width=16, height=16)
    append_subject(log, a)
    append_subject(log, b)
    assert load_subject_log(log) == [a, b]


def test_subject_log_missing_file_is_empty(tmp_path: Path):
    from matte_bench.corpus import load_subject_log

    assert load_subject_log(tmp_path / "nope.jsonl") == []


def test_subject_log_drops_retired_buckets(tmp_path: Path):
    """Entries from buckets that no longer exist load-skip rather than
    killing bootstrap; their verdicts simply go stale."""
    import json as _json

    from matte_bench.corpus import load_subject_log

    log = tmp_path / "subjects-sampled.jsonl"
    log.write_text(
        _json.dumps({"id": "old-1", "bucket": "busy-background", "prompt": "p",
                     "seed": 1, "width": 8, "height": 8}) + "\n" +
        _json.dumps({"id": "wispy-2", "bucket": "wispy", "prompt": "p",
                     "seed": 2, "width": 8, "height": 8}) + "\n",
        encoding="utf-8")
    assert [s.id for s in load_subject_log(log)] == ["wispy-2"]


def test_plate_hash_is_content_addressed():
    assert plate_hash(b"abc") == plate_hash(b"abc")
    assert plate_hash(b"abc") != plate_hash(b"abd")


def test_plate_hashes_skips_missing_plates(tmp_path: Path):
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    assert plate_hashes([s], tmp_path) == {}
    plate_path(tmp_path, "s1").parent.mkdir(parents=True, exist_ok=True)
    plate_path(tmp_path, "s1").write_bytes(b"xyz")
    assert plate_hashes([s], tmp_path) == {"s1": plate_hash(b"xyz")}


def _fake_provider(image: bytes):
    from matte_bench import corpus

    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            yield corpus.ImageEvent(data=image)

    return FakeProvider


def test_ensure_plate_invalidates_stale_renders_on_generation(tmp_path, monkeypatch):
    """A regenerated plate orphans every render cut from the old one; serving
    them would pair sides from two different source images — the one failure
    mode a blind A/B must never have."""
    import asyncio

    from matte_bench import corpus

    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    stale = tmp_path / "renders" / "s1" / "deadbeef.png"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"cut from the old plate")
    monkeypatch.setattr(corpus, "LiveComfyProvider", _fake_provider(b"new plate"))

    asyncio.run(corpus.ensure_plate(s, tmp_path, "http://unused"))

    assert not stale.exists()
    assert plate_path(tmp_path, "s1").read_bytes() == b"new plate"


def test_ensure_plate_regenerates_when_generation_params_change(tmp_path, monkeypatch):
    """A cached plate is only valid for the exact (prompt, seed, size,
    workflow) that produced it — otherwise editing subjects.json silently
    keeps judging stale art."""
    import asyncio

    from matte_bench import corpus

    s1 = Subject(id="s1", bucket="wispy", prompt="old prompt", seed=1,
                 width=8, height=8)
    monkeypatch.setattr(corpus, "LiveComfyProvider", _fake_provider(b"v1"))
    asyncio.run(corpus.ensure_plate(s1, tmp_path, "http://unused"))
    assert plate_path(tmp_path, "s1").read_bytes() == b"v1"

    s2 = Subject(id="s1", bucket="wispy", prompt="new prompt", seed=1,
                 width=8, height=8)
    monkeypatch.setattr(corpus, "LiveComfyProvider", _fake_provider(b"v2"))
    asyncio.run(corpus.ensure_plate(s2, tmp_path, "http://unused"))
    assert plate_path(tmp_path, "s1").read_bytes() == b"v2"


def test_ensure_plate_reuses_cache_when_params_match(tmp_path, monkeypatch):
    import asyncio

    from matte_bench import corpus

    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    monkeypatch.setattr(corpus, "LiveComfyProvider", _fake_provider(b"v1"))
    asyncio.run(corpus.ensure_plate(s, tmp_path, "http://unused"))

    class ExplodingProvider:
        def __init__(self, base_url):
            raise AssertionError("cached plate must not be regenerated")

    monkeypatch.setattr(corpus, "LiveComfyProvider", ExplodingProvider)
    asyncio.run(corpus.ensure_plate(s, tmp_path, "http://unused"))
    assert plate_path(tmp_path, "s1").read_bytes() == b"v1"


def test_ensure_plate_regenerates_when_provenance_is_unknown(tmp_path, monkeypatch):
    """A plate with no params sidecar predates provenance tracking; it cannot
    be trusted to match the current subject definition."""
    import asyncio

    from matte_bench import corpus

    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    plate_path(tmp_path, "s1").parent.mkdir(parents=True)
    plate_path(tmp_path, "s1").write_bytes(b"unknown origin")
    monkeypatch.setattr(corpus, "LiveComfyProvider", _fake_provider(b"fresh"))

    asyncio.run(corpus.ensure_plate(s, tmp_path, "http://unused"))
    assert plate_path(tmp_path, "s1").read_bytes() == b"fresh"


def test_ensure_plate_forwards_comfy_progress_as_fractions(tmp_path, monkeypatch):
    import asyncio

    from matte_bench import corpus

    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            yield corpus.ProgressEvent(value=1, max=4)
            yield corpus.ImageEvent(data=b"plate")

    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    monkeypatch.setattr(corpus, "LiveComfyProvider", FakeProvider)

    fractions = []
    asyncio.run(corpus.ensure_plate(s, tmp_path, "http://unused",
                                    on_progress=fractions.append))
    assert fractions == [0.25]


def test_ensure_plate_leaves_renders_alone_when_plate_is_cached(tmp_path, monkeypatch):
    import asyncio

    from matte_bench import corpus

    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    monkeypatch.setattr(corpus, "LiveComfyProvider", _fake_provider(b"the plate"))
    asyncio.run(corpus.ensure_plate(s, tmp_path, "http://unused"))
    render = tmp_path / "renders" / "s1" / "deadbeef.png"
    render.parent.mkdir(parents=True)
    render.write_bytes(b"cut from that plate")

    monkeypatch.setattr(corpus, "LiveComfyProvider", _fake_provider(b"unused"))
    asyncio.run(corpus.ensure_plate(s, tmp_path, "http://unused"))

    assert render.exists()
    assert plate_path(tmp_path, "s1").read_bytes() == b"the plate"


