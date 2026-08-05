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


def next_comparison(subjects: list[Subject], techniques: list[str],
                    verdicts: list[Verdict], rng: random.Random,
                    repeat_every: int = 20) -> Comparison | None:
    if len(techniques) < 2 or not subjects:
        return None
    seen = judged_pairs(verdicts)

    # Self-consistency probe: re-serve something already judged, unannounced.
    if repeat_every and seen and rng.randrange(repeat_every) == 0:
        subject, a, b = rng.choice(sorted(seen))
        bucket = next(s.bucket for s in subjects if s.id == subject)
        left, right = (a, b) if rng.random() < 0.5 else (b, a)
        return Comparison(subject=subject, bucket=bucket, left=left,
                          right=right, repeat_of=f"{subject}:{a}:{b}")

    by_bucket: dict[str, dict[str, float]] = {}
    for s in subjects:
        if s.bucket not in by_bucket:
            by_bucket[s.bucket] = fit([v for v in verdicts if v.bucket == s.bucket])

    candidates = []
    for s in subjects:
        strengths = by_bucket[s.bucket]
        for i, a in enumerate(techniques):
            for b in techniques[i + 1:]:
                k = _key(s.id, a, b)
                if k in seen:
                    continue
                gap = abs(strengths.get(a, 0.0) - strengths.get(b, 0.0))
                candidates.append((gap, s.id, s.bucket, a, b))
    if not candidates:
        return None
    best_gap = min(c[0] for c in candidates)
    tied = [c for c in candidates if c[0] == best_gap]
    _, subject, bucket, a, b = rng.choice(tied)
    left, right = (a, b) if rng.random() < 0.5 else (b, a)
    return Comparison(subject=subject, bucket=bucket, left=left, right=right)
