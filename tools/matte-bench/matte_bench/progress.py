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
class ProgressReport:
    total: int
    buckets: tuple[BucketProgress, ...]


def progress(verdicts: list[Verdict],
             technique_names: dict[str, str]) -> ProgressReport:
    counts: dict[str, int] = {}
    for v in verdicts:
        counts[v.bucket] = counts.get(v.bucket, 0) + 1
    buckets = []
    for bucket in sorted(counts, key=lambda b: (-counts[b], b)):
        rows = standings(verdicts, bucket)
        done = separated(rows)
        # Winner names only for finished buckets: the operator judging an
        # active bucket stays blind to its standings.
        winner = (technique_names.get(rows[0].technique, rows[0].technique)
                  if done else None)
        buckets.append(BucketProgress(bucket=bucket, count=counts[bucket],
                                      separated=done, winner=winner))
    return ProgressReport(total=len(verdicts), buckets=tuple(buckets))
