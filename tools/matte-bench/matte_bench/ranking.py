"""Bradley-Terry strengths per bucket, with bootstrap intervals.

Bradley-Terry rather than sequential Elo: Elo depends on the order votes
arrive, so re-running the same data could reorder the table. This fits all
verdicts at once, which makes standings reproducible and lets late votes
overturn early noise.
"""
import random
from dataclasses import dataclass

from matte_bench.store import Verdict

_ITERATIONS = 200
_TIE_WEIGHT = 0.5


@dataclass(frozen=True)
class Standing:
    technique: str
    score: float
    low: float
    high: float
    comparisons: int


def _tallies(verdicts: list[Verdict]):
    wins: dict[str, float] = {}
    pairs: dict[tuple[str, str], float] = {}
    for v in verdicts:
        for name in (v.left, v.right):
            wins.setdefault(name, 0.0)
        if v.winner == "left":
            wins[v.left] += 1.0
        elif v.winner == "right":
            wins[v.right] += 1.0
        else:
            wins[v.left] += _TIE_WEIGHT
            wins[v.right] += _TIE_WEIGHT
        key = (v.left, v.right) if v.left < v.right else (v.right, v.left)
        pairs[key] = pairs.get(key, 0.0) + 1.0
    return wins, pairs


def fit(verdicts: list[Verdict]) -> dict[str, float]:
    """Minorisation-maximisation fit; strengths normalised to sum 1."""
    wins, pairs = _tallies(verdicts)
    if not wins:
        return {}
    strength = {k: 1.0 for k in wins}
    for _ in range(_ITERATIONS):
        updated = {}
        for name in strength:
            denom = 0.0
            for (a, b), n in pairs.items():
                if name not in (a, b):
                    continue
                other = b if name == a else a
                denom += n / (strength[name] + strength[other])
            updated[name] = (wins[name] / denom) if denom > 0 else strength[name]
        total = sum(updated.values()) or 1.0
        strength = {k: v / total for k, v in updated.items()}
    return {k: round(v, 12) for k, v in strength.items()}


def standings(verdicts: list[Verdict], bucket: str, rounds: int = 200,
              rng_seed: int = 7) -> list[Standing]:
    scoped = [v for v in verdicts if v.bucket == bucket]
    base = fit(scoped)
    if not base:
        return []
    counts: dict[str, int] = {}
    for v in scoped:
        counts[v.left] = counts.get(v.left, 0) + 1
        counts[v.right] = counts.get(v.right, 0) + 1

    rng = random.Random(rng_seed)
    samples: dict[str, list[float]] = {k: [] for k in base}
    for _ in range(rounds):
        resampled = [scoped[rng.randrange(len(scoped))] for _ in scoped]
        got = fit(resampled)
        for name in base:
            samples[name].append(got.get(name, 0.0))
    rows = []
    for name, score in base.items():
        ordered = sorted(samples[name])
        lo = ordered[int(0.025 * (len(ordered) - 1))]
        hi = ordered[int(0.975 * (len(ordered) - 1))]
        rows.append(Standing(technique=name, score=score, low=lo, high=hi,
                             comparisons=counts.get(name, 0)))
    return sorted(rows, key=lambda r: r.score, reverse=True)


def separated(rows: list[Standing]) -> bool:
    """True only when the leader's interval clears the runner-up's."""
    return len(rows) >= 2 and rows[0].low > rows[1].high
