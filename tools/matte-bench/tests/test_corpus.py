import json
from pathlib import Path

import pytest

from matte_bench.corpus import (
    BUCKETS, Subject, load_subjects, plate_hash, plate_hashes, plate_path,
)

REPO = Path(__file__).resolve().parents[3]


def test_shipped_subjects_cover_every_bucket_twice():
    subjects = load_subjects(REPO / "tools" / "matte-bench" / "subjects.json")
    counts: dict[str, int] = {}
    for s in subjects:
        counts[s.bucket] = counts.get(s.bucket, 0) + 1
    assert set(counts) == set(BUCKETS)
    assert all(n >= 2 for n in counts.values()), counts


def test_shipped_subject_ids_are_unique():
    subjects = load_subjects(REPO / "tools" / "matte-bench" / "subjects.json")
    ids = [s.id for s in subjects]
    assert len(ids) == len(set(ids))


def test_shipped_subject_prompts_mirror_production_boilerplate():
    """The bench must measure the distribution production actually generates:
    isolated, cutout-style subjects (recipes.py boilerplate) — not staged
    scenes whose foregrounds occlude the subject and make it unmattable."""
    from app.assets.recipes import profile_for

    std = profile_for("misc").positive       # _STANDARD fallback
    logo = profile_for("logo").positive
    for s in load_subjects(REPO / "tools" / "matte-bench" / "subjects.json"):
        assert s.prompt.endswith(std) or s.prompt.endswith(logo), (
            f"{s.id}: prompt does not end with a production boilerplate: {s.prompt!r}")


def test_shipped_subjects_pin_a_seed():
    """Plates must regenerate deterministically; a missing seed breaks that."""
    for s in load_subjects(REPO / "tools" / "matte-bench" / "subjects.json"):
        assert isinstance(s.seed, int) and s.seed > 0


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


def test_load_subjects_rejects_unknown_bucket(tmp_path: Path):
    path = tmp_path / "subjects.json"
    path.write_text(json.dumps([{"id": "a", "bucket": "nope", "prompt": "p",
                                 "seed": 1, "width": 8, "height": 8}]),
                    encoding="utf-8")
    with pytest.raises(ValueError, match="nope"):
        load_subjects(path)
