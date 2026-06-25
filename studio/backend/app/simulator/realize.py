"""Pure GDD→SlotModel realizer (SP2). Structural sibling of targets.py.

Compiles the structured GDD math aspects into a structurally-valid (numerically
rough) SlotModel dict the Rust kernel accepts. Pure: no IO, no RNG. Fail-loud:
returns a RealizeResult whose model is None iff a hard structural contradiction
was found. The tuner (SP3) reconciles the numbers; this only fixes structure.
"""
from dataclasses import dataclass
from itertools import product

MAX_PAYLINES = 4096
DEFAULT_STRIP_LEN = 30
DEFAULT_REELS = 5
DEFAULT_ROWS = 3
BONUS_MIN_COUNT = 3

# GDD design-language `kind` -> kernel SymbolRole (serialized lowercase).
_KIND_TO_ROLE = {
    "wild": "wild",
    "scatter": "scatter",
    "bonus": "scatter",  # bonus symbols trigger features via scatter-count
    "high": "normal",
    "low": "normal",
}


def _to_int(raw, default: int) -> int:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return default
    try:
        return int(float(str(raw)))
    except (ValueError, TypeError):
        return default


def _to_bool(raw) -> bool:
    return str(raw).strip().lower() in ("yes", "true", "1", "y", "on")


@dataclass(frozen=True)
class RealizeResult:
    model: dict | None
    errors: list[str]
    warnings: list[str]


def _realize_symbols(
    symbols_reels: dict,
) -> tuple[list[dict], dict[str, int], list[str], list[str]]:
    """Build SymbolDef rows + a {slot/name -> id} map. id == row index."""
    rows = symbols_reels.get("symbols") or []
    errors: list[str] = []
    warnings: list[str] = []
    defs: list[dict] = []
    name_to_id: dict[str, int] = {}
    for i, row in enumerate(rows):
        kind = str(row.get("kind", "")).strip().lower()
        role = _KIND_TO_ROLE.get(kind)
        if role is None:
            role = "normal"
            warnings.append(
                f"symbol row {i} kind '{row.get('kind')}' unknown; role defaulted to normal"
            )
        defs.append({"id": i, "role": role})
        for key in ("slot", "name"):
            v = str(row.get(key, "")).strip().lower()
            if v:
                name_to_id[v] = i
    if not defs:
        errors.append("no symbols defined; cannot realize a model")
    return defs, name_to_id, errors, warnings


def _realize_reels(
    symbols_reels: dict, distinct_count: int, reel_count: int
) -> tuple[list[list[int]], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    sl = symbols_reels.get("strip_length")
    if isinstance(sl, dict) and "min" in sl and "max" in sl:
        lo, hi = float(sl["min"]), float(sl["max"])
        if hi < distinct_count:
            errors.append(
                f"strip_length.max {hi:g} < distinct symbol count {distinct_count}; "
                "cannot place every symbol on a strip"
            )
            return [], errors, warnings
        length = round((lo + hi) / 2)
        if length < distinct_count:
            warnings.append(
                f"strip_length midpoint {length} < distinct symbol count "
                f"{distinct_count}; clamped up to {distinct_count}"
            )
            length = distinct_count
    else:
        length = max(distinct_count, DEFAULT_STRIP_LEN)
        warnings.append(f"strip_length absent; defaulted strip length to {length}")
    reel = [pos % distinct_count for pos in range(length)]
    return [list(reel) for _ in range(reel_count)], errors, warnings
