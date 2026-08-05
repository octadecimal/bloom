import random

from matte_bench.corpus import Subject
from matte_bench.pairing import judged_pairs, next_comparison
from matte_bench.store import Verdict


def _s(sid="s1", bucket="wispy"):
    return Subject(id=sid, bucket=bucket, prompt="p", seed=1, width=8, height=8)


def _v(subject, left, right, winner="left", bucket="wispy"):
    return Verdict(subject=subject, bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t")


def test_judged_pairs_is_order_insensitive():
    got = judged_pairs([_v("s1", "b", "a")])
    assert got == {("s1", "a", "b"): 1}


def test_next_comparison_returns_none_when_all_pairs_judged():
    rng = random.Random(1)
    verdicts = [_v("s1", "a", "b")]
    assert next_comparison([_s()], ["a", "b"], verdicts, rng, repeat_every=0) is None


def test_next_comparison_prefers_an_unjudged_pair():
    rng = random.Random(1)
    verdicts = [_v("s1", "a", "b")]
    c = next_comparison([_s()], ["a", "b", "c"], verdicts, rng, repeat_every=0)
    assert {c.left, c.right} != {"a", "b"}


def test_next_comparison_only_pairs_within_one_subject():
    rng = random.Random(1)
    subjects = [_s("s1"), _s("s2")]
    c = next_comparison(subjects, ["a", "b"], [], rng, repeat_every=0)
    assert c.subject in {"s1", "s2"}
    assert c.bucket == "wispy"


def test_next_comparison_needs_two_techniques():
    rng = random.Random(1)
    assert next_comparison([_s()], ["a"], [], rng, repeat_every=0) is None


def test_repeat_injection_reserves_a_judged_pair():
    """Self-consistency check: occasionally re-serve something already judged."""
    rng = random.Random(1)
    verdicts = [_v("s1", "a", "b")]
    c = next_comparison([_s()], ["a", "b", "c"], verdicts, rng, repeat_every=1)
    assert c.repeat_of is not None
    assert {c.left, c.right} == {"a", "b"}


def test_prefer_restricts_candidates_to_the_preferred_subject():
    """Plate affinity: with candidates available on both subjects, a prefer
    set steers selection to the subject whose plate already exists."""
    rng = random.Random(1)
    subjects = [_s("s1"), _s("s2")]
    c = next_comparison(subjects, ["a", "b"], [], rng, repeat_every=0, prefer={"s1"})
    assert c.subject == "s1"


def test_prefer_falls_through_when_preferred_subject_is_exhausted():
    """If the preferred subject has no unjudged pairs left, prefer must not
    starve the draw — it should fall back to the unpreferred subject rather
    than returning None."""
    rng = random.Random(1)
    subjects = [_s("s1"), _s("s2")]
    verdicts = [_v("s1", "a", "b")]
    c = next_comparison(subjects, ["a", "b"], verdicts, rng, repeat_every=0, prefer={"s1"})
    assert c is not None
    assert c.subject == "s2"


def test_sides_are_randomised_across_draws():
    """Blinding: a technique must not always appear on the same side."""
    seen = set()
    for seed in range(30):
        c = next_comparison([_s()], ["a", "b"], [], random.Random(seed),
                            repeat_every=0)
        seen.add((c.left, c.right))
    assert seen == {("a", "b"), ("b", "a")}
