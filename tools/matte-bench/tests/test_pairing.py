import random

from matte_bench.corpus import Subject
from matte_bench.pairing import (
    judged_pairs, least_judged_bucket, next_sampled_comparison, pick_class,
)
from matte_bench.store import Verdict


def _s(sid="s1", bucket="wispy"):
    return Subject(id=sid, bucket=bucket, prompt="p", seed=1, width=8, height=8)


def _v(subject, left, right, winner="left", bucket="wispy"):
    return Verdict(subject=subject, bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t")


def test_judged_pairs_is_order_insensitive():
    got = judged_pairs([_v("s1", "b", "a")])
    assert got == {("s1", "a", "b"): 1}


def test_least_judged_bucket_picks_the_thinnest():
    verdicts = [_v("s1", "a", "b", bucket="wispy")] * 3 + \
               [_v("s2", "a", "b", bucket="filigree")]
    got = least_judged_bucket(("wispy", "filigree", "glow-soft"), verdicts,
                              random.Random(1))
    assert got == "glow-soft"


def test_next_sampled_comparison_pairs_on_the_given_subject():
    c = next_sampled_comparison(_s("wispy-9"), ["a", "b"], [], random.Random(1),
                                repeat_every=0)
    assert c.subject == "wispy-9"
    assert c.bucket == "wispy"
    assert {c.left, c.right} == {"a", "b"}


def test_prefers_the_least_judged_pair_in_the_bucket():
    """Evidence balance carries across subjects: a pair already judged on an
    earlier draw in this bucket yields to an unjudged pair."""
    verdicts = [_v("earlier-draw", "a", "b")]
    c = next_sampled_comparison(_s("s1"), ["a", "b", "c"], verdicts,
                                random.Random(1), repeat_every=0)
    assert {c.left, c.right} != {"a", "b"}


def test_needs_two_techniques():
    assert next_sampled_comparison(_s(), ["a"], [], random.Random(1),
                                   repeat_every=0) is None


def test_repeat_injection_reserves_a_judged_pair():
    """Self-consistency probe survives the sampled regime: it re-serves a
    judged comparison from a KNOWN past subject, whose plate is cached."""
    verdicts = [_v("s1", "a", "b")]
    c = next_sampled_comparison(_s("wispy-77"), ["a", "b", "c"], verdicts,
                                random.Random(1), repeat_every=1,
                                known=[_s("s1")])
    assert c.repeat_of is not None
    assert c.subject == "s1"
    assert {c.left, c.right} == {"a", "b"}


def test_repeat_skips_subjects_no_longer_known():
    """A judged subject absent from the registry cannot be re-served — its
    recipe is gone, so its plate could never be regenerated."""
    verdicts = [_v("ghost", "a", "b")]
    c = next_sampled_comparison(_s("wispy-77"), ["a", "b"], verdicts,
                                random.Random(1), repeat_every=1, known=[])
    assert c.repeat_of is None
    assert c.subject == "wispy-77"


def test_sides_are_randomised_across_draws():
    """Blinding: a technique must not always appear on the same side."""
    seen = set()
    for seed in range(30):
        c = next_sampled_comparison(_s(), ["a", "b"], [], random.Random(seed),
                                    repeat_every=0)
        seen.add((c.left, c.right))
    assert seen == {("a", "b"), ("b", "a")}


def _cv(left, right, bucket="wispy", cls="A"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner="left", plate_hash="h", ts="t", cls=cls)


def test_next_comparison_scopes_verdicts_to_class():
    """B verdicts must not influence A pair counts. With one A pair already
    judged and an unrelated B verdict logged, the A picker must still prefer
    the unjudged A pair."""
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = [_cv("a1", "a2"), _cv("b1", "b2", cls="B"),
                _cv("b1", "b2", cls="B"), _cv("b1", "b2", cls="B")]
    rng = random.Random(7)
    c = next_sampled_comparison(s, ["a1", "a2", "a3"], verdicts, rng,
                                repeat_every=0, cls="A")
    assert {c.left, c.right} != {"a1", "a2"}   # least-judged: an a3 pair


def test_repeat_probe_stays_intra_class():
    """With repeat certain to fire, candidates only come from same-class
    verdicts of registered subjects."""
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = [_cv("b1", "b2", cls="B")]
    rng = random.Random(7)
    c = next_sampled_comparison(s, ["a1", "a2"], verdicts, rng,
                                repeat_every=1, known=[s], cls="A")
    assert c.repeat_of is None    # the only logged pair is class B


def test_pick_class_fewest_verdicts_first():
    pools = {"A": ["a1", "a2"], "B": ["b1", "b2"]}
    verdicts = [_cv("a1", "a2")] * 3 + [_cv("b1", "b2", cls="B")]
    assert pick_class("wispy", verdicts, pools, playoff_open=False) == "B"


def test_pick_class_tie_prefers_a():
    pools = {"A": ["a1", "a2"], "B": ["b1", "b2"]}
    assert pick_class("wispy", [], pools, playoff_open=False) == "A"


def test_pick_class_skips_single_technique_pools():
    pools = {"A": ["a1", "a2"], "B": ["b1"]}
    verdicts = [_cv("a1", "a2")] * 5
    assert pick_class("wispy", verdicts, pools, playoff_open=False) == "A"


def test_pick_class_includes_open_playoff():
    pools = {"A": ["a1", "a2"], "B": ["b1", "b2"]}
    verdicts = [_cv("a1", "a2")] * 3 + [_cv("b1", "b2", cls="B")] * 3
    assert pick_class("wispy", verdicts, pools, playoff_open=True) == "X"


def test_pick_class_none_when_nothing_serveable():
    assert pick_class("wispy", [], {"A": ["a1"], "B": []}, playoff_open=False) is None
