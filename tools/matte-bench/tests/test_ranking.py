from matte_bench.ranking import fit, separated, standings
from matte_bench.store import Verdict


def _v(left, right, winner, bucket="wispy", subject="s1"):
    return Verdict(subject=subject, bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="2026-08-04T00:00:00Z")


def test_fit_ranks_a_dominant_winner_highest():
    v = [_v("a", "b", "left") for _ in range(10)]
    strengths = fit(v)
    assert strengths["a"] > strengths["b"]


def test_fit_is_order_independent():
    """Bradley-Terry fits all verdicts at once; Elo would not give this."""
    forward = [_v("a", "b", "left"), _v("a", "b", "left"), _v("a", "b", "right")]
    shuffled = [forward[2], forward[0], forward[1]]
    assert fit(forward) == fit(shuffled)


def test_fit_treats_side_as_irrelevant():
    """Winning as 'right' must count exactly as much as winning as 'left'."""
    as_left = [_v("a", "b", "left") for _ in range(6)]
    as_right = [_v("b", "a", "right") for _ in range(6)]
    assert fit(as_left)["a"] == fit(as_right)["a"]


def test_ties_do_not_crown_a_winner():
    v = [_v("a", "b", "tie") for _ in range(8)]
    s = fit(v)
    assert abs(s["a"] - s["b"]) < 1e-6


def test_both_bad_expresses_no_relative_preference():
    """"Both are bad" is an absolute judgment; for the pairwise ranking it
    must weigh exactly like a tie."""
    v = [_v("a", "b", "both_bad") for _ in range(8)]
    s = fit(v)
    assert abs(s["a"] - s["b"]) < 1e-6


def test_standings_filter_by_bucket():
    v = [_v("a", "b", "left", bucket="wispy"),
         _v("c", "d", "left", bucket="crisp-text")]
    names = {row.technique for row in standings(v, "wispy")}
    assert names == {"a", "b"}


def test_standings_sorted_best_first_with_counts():
    v = [_v("a", "b", "left") for _ in range(9)] + [_v("a", "b", "right")]
    rows = standings(v, "wispy")
    assert rows[0].technique == "a"
    assert rows[0].comparisons == 10
    assert rows[0].low <= rows[0].score <= rows[0].high


def test_separated_is_false_when_evidence_is_thin():
    """One vote must not be reported as a real lead."""
    rows = standings([_v("a", "b", "left")], "wispy")
    assert separated(rows) is False


def test_separated_is_true_with_overwhelming_evidence():
    rows = standings([_v("a", "b", "left") for _ in range(40)], "wispy")
    assert separated(rows) is True


def test_separated_respects_the_evidence_floor_boundary():
    """One vote below the floor is not a real lead; at the floor it can be."""
    below = standings([_v("a", "b", "left") for _ in range(7)], "wispy")
    at_floor = standings([_v("a", "b", "left") for _ in range(8)], "wispy")
    assert separated(below) is False
    assert separated(at_floor) is True
