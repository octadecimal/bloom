"""Which comparison to serve next.

Adaptive, not exhaustive: draws where the current strengths are closest, so 15
techniques are separable without judging all 105 pairs per subject. Sides are
randomised so a technique cannot win by always sitting on the left.
"""
import random
from dataclasses import dataclass

from matte_bench.corpus import Subject
from matte_bench.ranking import fit
from matte_bench.store import Verdict


@dataclass(frozen=True)
class Comparison:
    subject: str
    bucket: str
    left: str
    right: str
    repeat_of: str | None = None


def _key(subject: str, a: str, b: str) -> tuple[str, str, str]:
    lo, hi = (a, b) if a < b else (b, a)
    return (subject, lo, hi)


def judged_pairs(verdicts: list[Verdict]) -> dict[tuple[str, str, str], int]:
    out: dict[tuple[str, str, str], int] = {}
    for v in verdicts:
        k = _key(v.subject, v.left, v.right)
        out[k] = out.get(k, 0) + 1
    return out


def least_judged_bucket(buckets, verdicts: list[Verdict],
                        rng: random.Random) -> str:
    """Evidence balance across buckets: the next sampled subject comes from
    wherever the standings are thinnest."""
    counts = {b: 0 for b in buckets}
    for v in verdicts:
        if v.bucket in counts:
            counts[v.bucket] += 1
    thinnest = min(counts.values())
    return rng.choice(sorted(b for b, n in counts.items() if n == thinnest))


def next_sampled_comparison(subject: Subject, techniques: list[str],
                            verdicts: list[Verdict], rng: random.Random,
                            repeat_every: int = 20,
                            known: list[Subject] | None = None,
                            ) -> Comparison | None:
    """Pick the technique pair to judge on a freshly sampled subject.

    Pair choice balances evidence bucket-wide (pairs least judged in this
    bucket first, across ALL its subjects), tie-broken adaptively toward the
    closest current strengths. Sides are randomised so a technique cannot win
    by always sitting on the left.
    """
    if len(techniques) < 2:
        return None
    seen = judged_pairs(verdicts)
    known = known or []

    # Self-consistency probe: re-serve something already judged, unannounced.
    # Restricted to subjects still in the registry — an unknown subject's
    # plate has no recipe to regenerate from.
    if repeat_every and seen and known and rng.randrange(repeat_every) == 0:
        ids = {s.id for s in known}
        candidates = [k for k in sorted(seen) if k[0] in ids]
        if candidates:
            sid, a, b = rng.choice(candidates)
            bucket = next(s.bucket for s in known if s.id == sid)
            left, right = (a, b) if rng.random() < 0.5 else (b, a)
            return Comparison(subject=sid, bucket=bucket, left=left,
                              right=right, repeat_of=f"{sid}:{a}:{b}")

    scoped = [v for v in verdicts if v.bucket == subject.bucket]
    strengths = fit(scoped)
    pair_counts: dict[tuple[str, str], int] = {}
    for v in scoped:
        lo, hi = (v.left, v.right) if v.left < v.right else (v.right, v.left)
        pair_counts[(lo, hi)] = pair_counts.get((lo, hi), 0) + 1

    candidates = []
    for i, a in enumerate(techniques):
        for b in techniques[i + 1:]:
            lo, hi = (a, b) if a < b else (b, a)
            count = pair_counts.get((lo, hi), 0)
            gap = abs(strengths.get(a, 0.0) - strengths.get(b, 0.0))
            candidates.append((count, gap, a, b))
    best = min(c[:2] for c in candidates)
    tied = [c for c in candidates if c[:2] == best]
    _, _, a, b = rng.choice(tied)
    left, right = (a, b) if rng.random() < 0.5 else (b, a)
    return Comparison(subject=subject.id, bucket=subject.bucket,
                      left=left, right=right)
