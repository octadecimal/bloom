"""Pure helpers for the auto-restart tune loop (spec
2026-07-06-auto-restart-tune-design.md): per-attempt config escalation and the
miss score that ranks attempts and feeds the FAIL diagnosis. No IO."""
from app.math.models import MetricsWire

MUTATION_CAP = 0.5
MUTATION_ESCALATION = 1.5
# A band wider than this is open-ended (volatility 'high' → hi=1e9); normalize
# such gates by the finite edge instead, or their misses would score ~0.
_OPEN_BAND = 1e8
_EPS = 1e-9


def escalate(config: dict, attempt: int) -> dict:
    """Config for attempt n (1-based). Attempt 1 is the user's config verbatim;
    each restart gets a fresh deterministic seed and more mutation (diversity)."""
    out = dict(config)
    if attempt > 1:
        out["master_seed"] = config["master_seed"] + (attempt - 1)
        out["mutation_rate"] = min(
            MUTATION_CAP,
            config["mutation_rate"] * MUTATION_ESCALATION ** (attempt - 1))
    return out


def _gate(measured: float, lo: float, hi: float) -> float:
    if lo <= measured <= hi:
        return 0.0
    width = hi - lo
    if width > _OPEN_BAND:
        width = abs(lo)
    width = max(width, _EPS)
    return (lo - measured) / width if measured < lo else (measured - hi) / width


def miss_score(metrics: MetricsWire | None, target: dict) -> float:
    """Sum of per-gate distance-to-band, each normalized by its band width.
    0.0 = every gate in band. Ranking + diagnosis only — never a verdict (the
    noise-aware 2·SE verdicts stay with the Rust tuner / simulator)."""
    if metrics is None:
        return float("inf")
    score = _gate(metrics.rtp,
                  target["rtp_target"] - target["rtp_tolerance"],
                  target["rtp_target"] + target["rtp_tolerance"])
    score += _gate(metrics.volatility,
                   target["volatility_min"], target["volatility_max"])
    for band, rate in zip(target["bonus_hit_rate_bands"],
                          metrics.bonus_hit_rates):
        score += _gate(rate, band["min"], band["max"])
    hf = target.get("hit_frequency_band")
    if hf:
        score += _gate(metrics.hit_frequency, hf["min"], hf["max"])
    return score
