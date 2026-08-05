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


def test_load_subjects_rejects_unknown_bucket(tmp_path: Path):
    path = tmp_path / "subjects.json"
    path.write_text(json.dumps([{"id": "a", "bucket": "nope", "prompt": "p",
                                 "seed": 1, "width": 8, "height": 8}]),
                    encoding="utf-8")
    with pytest.raises(ValueError, match="nope"):
        load_subjects(path)
