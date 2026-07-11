"""Derive a simulator TargetSpec (as the curate_json JSON contract) from the
structured GDD math-model intent. Pure; no IO. The enum->band table is a starting
contract (spec §3.3), tunable per game later."""
from app.math.models import CurationParams


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
    """Normalize a percent value to decimal form.

    String branch — converts human-authored strings from a math-model dict:
      "96"    → 0.96  (bare integer string, treated as percent)
      "96%"   → 0.96  (explicit percent suffix)
      "5000%" → 50.0  (large percent, e.g. an unreachable RTP sentinel)
      "0.96"  → 0.96  (already-decimal string, passes through)

    Non-string branch — values that originate from the GDD store are already
    normalized to decimal form by ``app.gdd.normalize._percent`` before they are
    written (e.g. "90%" → 0.9, "5000%" → 50.0).  Dividing again would be a
    double-normalization bug, so non-string inputs are returned unchanged.
    This means ``normalize_percent(0.9) == 0.9`` and
    ``normalize_percent(50.0) == 50.0``.  Integer non-string inputs (e.g. ``96``)
    are also passed through as-is (``96.0``) — production code never passes a
    raw un-normalized integer, but the contract must be explicit.
    """
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


def derive_num_bonuses(features_data: dict, model: dict) -> int:
    """Bonus-band count. GDD features are the intent (spec §5); the model must
    agree once realized — disagreement means the model needs re-realization and
    must fail loudly, not tune against the wrong band count."""
    features = features_data.get("features") or []
    model_count = len(model.get("bonuses") or [])
    if not features:
        return model_count
    if len(features) != model_count:
        raise TargetGap(
            f"GDD declares {len(features)} bonus feature(s) but the realized "
            f"model has {model_count}; re-realize the model (shape is stale)."
        )
    return len(features)


_RELATIONS = ("top-paying", "floor", "ceiling")


def _compile_pay_constraints(paytable_data: dict, symbols_data: dict) -> list[dict]:
    """GDD pay_constraints rows -> the Rust PayConstraint JSON, resolving each
    row's symbol (slot or name) to the model symbol id via the model_id join
    key (spec §5-§6). TargetGap on an unresolvable symbol: the join key is
    written by realization, so a miss means the model needs re-realizing."""
    rows = (paytable_data or {}).get("pay_constraints") or []
    if not rows:
        return []
    ids: dict[str, int] = {}
    for srow in (symbols_data or {}).get("symbols") or []:
        mid = srow.get("model_id")
        if not isinstance(mid, (int, float)) or isinstance(mid, bool):
            continue
        for key in (srow.get("slot"), srow.get("name")):
            k = str(key or "").strip().lower()
            if k:
                ids.setdefault(k, int(mid))
    out: list[dict] = []
    for row in rows:
        name = str(row.get("symbol", "")).strip().lower()
        relation = str(row.get("relation", "")).strip().lower()
        if relation not in _RELATIONS:
            raise TargetGap(f"unknown pay-constraint relation '{row.get('relation')}'")
        if name not in ids:
            raise TargetGap(
                f"pay constraint references symbol '{row.get('symbol')}' with no "
                f"model_id join key; re-realize the model (shape is stale).")
        c: dict = {"symbol": ids[name], "relation": relation}
        raw_count = row.get("count")
        if raw_count not in (None, ""):
            try:
                c["count"] = int(float(str(raw_count)))
            except ValueError:
                raise TargetGap(
                    f"pay constraint for '{row.get('symbol')}' has a malformed "
                    f"count '{raw_count}'")
        if relation != "top-paying":
            raw_value = row.get("value")
            if raw_value in (None, ""):
                raise TargetGap(
                    f"pay constraint '{relation}' for '{row.get('symbol')}' needs a value")
            try:
                c["value"] = int(float(str(raw_value).strip().lower().rstrip("x")))
            except ValueError:
                raise TargetGap(
                    f"pay constraint for '{row.get('symbol')}' has a malformed "
                    f"value '{raw_value}'")
        out.append(c)
    return out


def derive_target(math_model: dict, params: CurationParams, num_bonuses: int,
                  paytable_data: dict | None = None,
                  symbols_data: dict | None = None) -> dict:
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

    target = {
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

    hf = math_model.get("hit_frequency")
    if hf not in (None, ""):
        center = normalize_percent(hf)
        tol = params.bonus_rate_tolerance  # same statistic kind as bonus rates
        target["hit_frequency_band"] = {"min": center * (1.0 - tol),
                                        "max": center * (1.0 + tol)}

    mw = math_model.get("max_win")
    if mw not in (None, ""):
        val = float(str(mw).strip().lower().rstrip("x"))
        tol = params.max_win_tolerance
        target["max_win_band"] = {"min": val * (1.0 - tol), "max": val * (1.0 + tol)}

    constraints = _compile_pay_constraints(paytable_data or {}, symbols_data or {})
    if constraints:
        target["pay_constraints"] = constraints
    return target
