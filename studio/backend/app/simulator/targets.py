"""Derive a simulator TargetSpec (as the curate_json JSON contract) from the
structured GDD math-model intent. Pure; no IO. The enum->band table is a starting
contract (spec §3.3), tunable per game later."""
from app.simulator.models import CurationParams


# Volatility index = std-dev of per-spin payout in bet-multiples. Starting bands.
VOLATILITY_BANDS: dict[str, tuple[float, float]] = {
    "low": (0.0, 3.0),
    "medium": (3.0, 6.0),
    "medium-high": (6.0, 10.0),
    "high": (10.0, 1e9),
}


class TargetGap(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def normalize_percent(raw) -> float:
    if isinstance(raw, str):
        raw = float(raw.strip().rstrip("%"))
        # "96" (as string) means 96%, "0.96" means 0.96
        return raw / 100.0 if raw > 1.0 else raw
    # Non-string values come from the GDD store, which already normalises to
    # decimal form via _percent (e.g. "5000%" → 50.0, "90%" → 0.9). Return as-is.
    return float(raw)


def parse_ratio(raw) -> float:
    if isinstance(raw, str) and ":" in raw:
        num, denom = raw.split(":", 1)
        return float(num) / float(denom)
    return float(raw)


def _require(math_model: dict, key: str):
    val = math_model.get(key)
    if val is None or (isinstance(val, str) and not val.strip()):
        raise TargetGap(f"GDD math-model is missing required intent: {key}")
    return val


def derive_target(math_model: dict, params: CurationParams, num_bonuses: int) -> dict:
    rtp_target = normalize_percent(_require(math_model, "rtp"))

    vol_key = str(_require(math_model, "volatility")).strip().lower()
    if vol_key not in VOLATILITY_BANDS:
        raise TargetGap(f"unknown volatility '{vol_key}'")
    vmin, vmax = VOLATILITY_BANDS[vol_key]

    bands: list[dict] = []
    if num_bonuses > 0:
        center = parse_ratio(_require(math_model, "bonus_hit_rate"))
        tol = params.bonus_rate_tolerance
        band = {"min": center * (1.0 - tol), "max": center * (1.0 + tol)}
        bands = [dict(band) for _ in range(num_bonuses)]

    return {
        "rtp_target": rtp_target,
        "rtp_tolerance": params.rtp_tolerance,
        "volatility_min": vmin,
        "volatility_max": vmax,
        "bonus_hit_rate_bands": bands,
        "pool_size": params.pool_size,
        "candidate_count": params.candidate_count,
        "realized_correction_band": params.realized_correction_band,
        "master_seed": params.master_seed,
    }
