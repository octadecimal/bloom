import json
from pathlib import Path

from matte_bench.store import (
    Verdict, append_verdict, read_verdicts, fresh_verdicts, atomic_write_bytes,
)


def _v(subject="s1", left="a", right="b", winner="left", plate_hash="h1"):
    return Verdict(subject=subject, bucket="wispy", left=left, right=right,
                   winner=winner, plate_hash=plate_hash, ts="2026-08-04T00:00:00Z")


def test_verdicts_round_trip(tmp_path: Path):
    log = tmp_path / "verdicts.jsonl"
    append_verdict(log, _v())
    append_verdict(log, _v(winner="right"))
    got = read_verdicts(log)
    assert [v.winner for v in got] == ["left", "right"]
    assert got[0].subject == "s1" and got[0].bucket == "wispy"


def test_read_verdicts_missing_file_is_empty(tmp_path: Path):
    assert read_verdicts(tmp_path / "nope.jsonl") == []


def test_fresh_verdicts_drops_stale_plate_hashes(tmp_path: Path):
    """A regenerated plate invalidates verdicts cast on the old pixels."""
    kept = _v(plate_hash="current")
    stale = _v(plate_hash="old")
    assert fresh_verdicts([kept, stale], {"s1": "current"}) == [kept]


def test_fresh_verdicts_drops_unknown_subjects():
    assert fresh_verdicts([_v(subject="gone")], {"s1": "current"}) == []


def test_atomic_write_leaves_no_partial_file(tmp_path: Path):
    target = tmp_path / "out.bin"
    atomic_write_bytes(target, b"abc")
    assert target.read_bytes() == b"abc"
    assert list(tmp_path.iterdir()) == [target]  # no temp left behind


def test_old_verdict_lines_parse_as_class_a(tmp_path):
    """Lines written before the cls field must read back as Class A."""
    log = tmp_path / "verdicts.jsonl"
    log.write_text(json.dumps({
        "subject": "s1", "bucket": "wispy", "left": "aaa", "right": "bbb",
        "winner": "left", "plate_hash": "h1", "ts": "t", "repeat_of": None,
    }) + "\n", encoding="utf-8")
    [v] = read_verdicts(log)
    assert v.cls == "A"


def test_append_verdict_writes_cls(tmp_path):
    log = tmp_path / "verdicts.jsonl"
    append_verdict(log, Verdict(subject="s1", bucket="wispy", left="aaa",
                                right="bbb", winner="tie", plate_hash="h1",
                                ts="t", cls="X"))
    line = json.loads(log.read_text(encoding="utf-8").strip())
    assert line["cls"] == "X"
    [v] = read_verdicts(log)
    assert v.cls == "X"
