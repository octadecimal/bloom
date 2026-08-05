from matte_bench.progress import BucketProgress, ProgressReport, progress
from matte_bench.store import Verdict


def _v(bucket, left="a", right="b", winner="left"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="2026-08-05T00:00:00Z")


def test_empty_log_reports_zero_and_no_buckets():
    assert progress([], {}) == ProgressReport(total=0, buckets=())


def test_thin_bucket_is_counted_but_not_separated_and_names_no_winner():
    report = progress([_v("wispy")], {"a": "Node/BiRefNet_alpha"})
    assert report.total == 1
    assert report.buckets == (
        BucketProgress(bucket="wispy", count=1, separated=False, winner=None),)


def test_separated_bucket_carries_the_winners_human_label():
    verdicts = [_v("wispy") for _ in range(10)]  # 10 unanimous wins for "a"
    report = progress(verdicts, {"a": "Node/BiRefNet_alpha"})
    assert report.buckets[0].separated is True
    assert report.buckets[0].winner == "Node/BiRefNet_alpha"


def test_winner_falls_back_to_the_hash_when_no_label_is_known():
    verdicts = [_v("wispy") for _ in range(10)]
    report = progress(verdicts, {})
    assert report.buckets[0].winner == "a"


def test_buckets_sort_by_count_descending_then_name():
    verdicts = ([_v("wispy")] * 2 + [_v("filigree")] * 3
                + [_v("crisp-text")] * 2)
    report = progress(verdicts, {})
    assert [b.bucket for b in report.buckets] == [
        "filigree", "crisp-text", "wispy"]
    assert report.total == 7
