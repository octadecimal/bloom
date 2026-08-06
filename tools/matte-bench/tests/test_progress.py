from matte_bench.progress import progress
from matte_bench.store import Verdict


def _v(left, right, winner="left", bucket="wispy", cls="A"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t", cls=cls)


def test_empty_log():
    report = progress([], {})
    assert report.total == 0 and report.classes == ()


def test_single_class_counts_and_blindness():
    verdicts = [_v("t1", "t2"), _v("t1", "t2", bucket="filigree"),
                _v("t1", "t2", bucket="filigree")]
    report = progress(verdicts, {})
    assert report.total == 3
    [a] = report.classes
    assert a.cls == "A" and a.total == 3
    assert [b.bucket for b in a.buckets] == ["filigree", "wispy"]  # count desc
    assert all(b.winner is None for b in a.buckets)  # unseparated: blind


def test_separated_bucket_names_winner():
    verdicts = [_v("t1", "t2") for _ in range(12)]
    report = progress(verdicts, {"t1": "RMBG/BiRefNet-HR"})
    [a] = report.classes
    assert a.buckets[0].separated and a.buckets[0].winner == "RMBG/BiRefNet-HR"


def test_classes_partition_and_sort():
    verdicts = [_v("a1", "a2")] * 2 + [_v("b1", "b2", cls="B")] * 3
    report = progress(verdicts, {})
    assert report.total == 5
    assert [c.cls for c in report.classes] == ["A", "B"]
    assert report.classes[0].total == 2 and report.classes[1].total == 3


def test_class_b_winner_from_b_standings_only():
    verdicts = [_v("a1", "a2")] * 12 + [_v("b1", "b2", cls="B")] * 12
    report = progress(verdicts, {"a1": "A-champ", "b1": "B-champ"})
    a, b = report.classes
    assert a.buckets[0].winner == "A-champ"
    assert b.buckets[0].winner == "B-champ"
