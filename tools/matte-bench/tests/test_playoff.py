from matte_bench.playoff import class_champion, derive_cls, playoff_pair
from matte_bench.store import Verdict


def _v(left, right, winner="left", bucket="wispy", cls="A"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t", cls=cls)


def _decisive(a, b, cls, n=12):
    """Enough one-sided verdicts to clear the evidence floor and separate."""
    return [_v(a, b, "left", cls=cls) for _ in range(n)]


def test_no_champion_below_evidence_floor():
    assert class_champion([_v("a1", "a2")], "wispy", "A") is None


def test_champion_when_separated():
    assert class_champion(_decisive("a1", "a2", "A"), "wispy", "A") == "a1"


def test_playoff_pair_needs_both_classes():
    verdicts = _decisive("a1", "a2", "A")
    assert playoff_pair(verdicts, "wispy") is None
    verdicts += _decisive("b1", "b2", "B")
    assert playoff_pair(verdicts, "wispy") == ("a1", "b1")


def test_derive_cls_same_class_pairs():
    cls_map = {"a1": "A", "a2": "A", "b1": "B", "b2": "B"}
    assert derive_cls("a1", "a2", cls_map, [], "wispy") == "A"
    assert derive_cls("b1", "b2", cls_map, [], "wispy") == "B"


def test_derive_cls_champions_make_playoff():
    cls_map = {"a1": "A", "a2": "A", "b1": "B", "b2": "B"}
    verdicts = _decisive("a1", "a2", "A") + _decisive("b1", "b2", "B")
    assert derive_cls("a1", "b1", cls_map, verdicts, "wispy") == "X"
    assert derive_cls("b1", "a1", cls_map, verdicts, "wispy") == "X"


def test_derive_cls_rejects_illegal_pairs():
    cls_map = {"a1": "A", "a2": "A", "b1": "B", "b2": "B"}
    # cross-class but not champions (no separation at all)
    assert derive_cls("a1", "b1", cls_map, [], "wispy") is None
    # unknown technique
    assert derive_cls("a1", "zz", cls_map, [], "wispy") is None
    # cross-class, champions exist but this pair isn't them
    verdicts = _decisive("a1", "a2", "A") + _decisive("b1", "b2", "B")
    assert derive_cls("a2", "b1", cls_map, verdicts, "wispy") is None
