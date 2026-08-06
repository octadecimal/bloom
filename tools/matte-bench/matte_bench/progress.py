"""Per-bucket judging progress: counts, separation, and settled winners.

Pure aggregation over the fresh verdict set — the route feeds it the same
verdicts the rankings are fitted from, so the numbers the operator watches
are the numbers that decide.
"""
from dataclasses import dataclass

from matte_bench.ranking import separated, standings
from matte_bench.store import Verdict


@dataclass(frozen=True)
class BucketProgress:
    bucket: str
    count: int
    separated: bool
    winner: str | None


@dataclass(frozen=True)
class ClassProgress:
    cls: str
    total: int
    buckets: tuple[BucketProgress, ...]


@dataclass(frozen=True)
class ProgressReport:
    total: int
    classes: tuple[ClassProgress, ...]


def progress(verdicts: list[Verdict],
             technique_names: dict[str, str]) -> ProgressReport:
    classes = []
    for cls in sorted({v.cls for v in verdicts}):
        scoped = [v for v in verdicts if v.cls == cls]
        counts: dict[str, int] = {}
        for v in scoped:
            counts[v.bucket] = counts.get(v.bucket, 0) + 1
        buckets = []
        for bucket in sorted(counts, key=lambda b: (-counts[b], b)):
            rows = standings(verdicts, bucket, cls=cls)
            done = separated(rows)
            # Winner names only for finished buckets: the operator judging an
            # active bucket stays blind to its standings.
            winner = (technique_names.get(rows[0].technique, rows[0].technique)
                      if done else None)
            buckets.append(BucketProgress(bucket=bucket, count=counts[bucket],
                                          separated=done, winner=winner))
        classes.append(ClassProgress(cls=cls, total=len(scoped),
                                     buckets=tuple(buckets)))
    return ProgressReport(total=len(verdicts), classes=tuple(classes))
