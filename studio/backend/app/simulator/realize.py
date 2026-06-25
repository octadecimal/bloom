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


def _all_patterns(rows: int, reel_count: int) -> list[list[int]]:
    """Every row-combination across reels: straight horizontals first, then the
    remainder in lexicographic order. Deterministic."""
    combos = list(product(range(rows), repeat=reel_count))
    constants = [list(c) for c in combos if len(set(c)) == 1]
    others = [list(c) for c in combos if len(set(c)) > 1]
    return constants + others


def _realize_paylines(
    math_model: dict, reel_count: int, rows: int
) -> tuple[list[list[int]], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    overrides = math_model.get("payline_overrides") or []
    if overrides:
        lines: list[list[int]] = []
        for i, pat in enumerate(overrides):
            parts = [p.strip() for p in str(pat).split(",") if p.strip() != ""]
            try:
                idxs = [int(p) for p in parts]
            except ValueError:
                errors.append(f"payline override {i} '{pat}' is not a comma list of integers")
                continue
            if len(idxs) != reel_count:
                errors.append(
                    f"payline override {i} has {len(idxs)} positions but reel count is {reel_count}"
                )
                continue
            bad = [x for x in idxs if x < 0 or x >= rows]
            if bad:
                errors.append(f"payline override {i} has row index {bad} outside [0,{rows})")
                continue
            lines.append(idxs)
        if errors:
            return [], errors, warnings
        return lines, errors, warnings

    total = rows ** reel_count
    mode = str(math_model.get("payline_mode") or "lines").strip().lower()
    if mode == "ways":
        if total > MAX_PAYLINES:
            errors.append(
                f"ways mode needs {total} paylines ({rows}^{reel_count}) which exceeds "
                f"MAX_PAYLINES {MAX_PAYLINES}; use payline_overrides or fewer rows/reels"
            )
            return [], errors, warnings
        declared = math_model.get("payline_count")
        if declared not in (None, "") and _to_int(declared, total) != total:
            warnings.append(
                f"payline_count {declared} != generated ways count {total}; using {total}"
            )
        return _all_patterns(rows, reel_count), errors, warnings

    n = _to_int(math_model.get("payline_count"), 1)
    if n > total:
        errors.append(
            f"payline_count {n} exceeds the {total} distinct paylines possible "
            f"({rows}^{reel_count})"
        )
        return [], errors, warnings
    return _all_patterns(rows, reel_count)[:n], errors, warnings


_OAK_COLUMNS = {"3oak": 3, "4oak": 4, "5oak": 5}


def _realize_paytable(
    paytable: dict, name_to_id: dict[str, int], symbol_defs: list[dict]
) -> tuple[dict, list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    entries: list[dict] = []
    for i, row in enumerate(paytable.get("payouts") or []):
        sym = str(row.get("symbol", "")).strip().lower()
        sid = name_to_id.get(sym)
        if sid is None:
            warnings.append(
                f"paytable row {i} symbol '{row.get('symbol')}' does not resolve "
                "to a known symbol; skipped"
            )
            continue
        for col, count in _OAK_COLUMNS.items():
            raw = row.get(col)
            if raw is None or (isinstance(raw, str) and not raw.strip()):
                continue
            try:
                payout = int(float(str(raw)))
            except ValueError:
                warnings.append(f"paytable row {i} {col} '{raw}' is not numeric; skipped")
                continue
            entries.append({"symbol": sid, "count": count, "payout": payout})
    if not entries:
        for rank, d in enumerate(d for d in symbol_defs if d["role"] == "normal"):
            base = rank + 1
            entries.append({"symbol": d["id"], "count": 3, "payout": base})
            entries.append({"symbol": d["id"], "count": 4, "payout": base * 5})
            entries.append({"symbol": d["id"], "count": 5, "payout": base * 20})
        warnings.append(
            "paytable empty or unresolved; seeded placeholder payouts for paying symbols"
        )
    return {"entries": entries}, errors, warnings


def _realize_bonuses(
    bonus_features: dict, symbol_defs: list[dict]
) -> tuple[list[dict], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    rows = bonus_features.get("free_spins") or []
    if not rows:
        return [], errors, warnings
    trigger = next((d["id"] for d in symbol_defs if d["role"] == "scatter"), None)
    if trigger is None:
        warnings.append(
            "bonus features defined but no scatter/bonus trigger symbol exists; "
            "bonuses skipped"
        )
        return [], errors, warnings
    bonuses: list[dict] = []
    for row in rows:
        bonuses.append({"FreeSpins": {
            "trigger": {"symbol": trigger, "min_count": BONUS_MIN_COUNT},
            "config": {
                "spins_awarded": _to_int(row.get("count"), 0),
                "retrigger": _to_bool(row.get("retrigger")),
                "multiplier": _to_int(row.get("multiplier"), 1),
                "feature_reels": None,
            },
        }})
    return bonuses, errors, warnings


def realize_slot_model(
    math_model: dict,
    symbols_reels: dict,
    paytable: dict,
    bonus_features: dict,
) -> RealizeResult:
    """Compile the structured GDD math aspects into a SlotModel dict. Fail-loud:
    model is None iff a hard structural contradiction was found."""
    errors: list[str] = []
    warnings: list[str] = []

    symbol_defs, name_to_id, e, w = _realize_symbols(symbols_reels)
    errors += e
    warnings += w
    if not symbol_defs:
        return RealizeResult(None, errors, warnings)
    distinct = len(symbol_defs)

    if math_model.get("reels") in (None, ""):
        warnings.append(f"reels absent; defaulted to {DEFAULT_REELS}")
    reel_count = _to_int(math_model.get("reels"), DEFAULT_REELS)
    if math_model.get("rows") in (None, ""):
        warnings.append(f"rows absent; defaulted to {DEFAULT_ROWS}")
    rows = _to_int(math_model.get("rows"), DEFAULT_ROWS)

    reels, e, w = _realize_reels(symbols_reels, distinct, reel_count)
    errors += e
    warnings += w
    paylines, e, w = _realize_paylines(math_model, reel_count, rows)
    errors += e
    warnings += w
    paytable_out, e, w = _realize_paytable(paytable, name_to_id, symbol_defs)
    errors += e
    warnings += w
    bonuses, e, w = _realize_bonuses(bonus_features, symbol_defs)
    errors += e
    warnings += w

    if errors:
        return RealizeResult(None, errors, warnings)

    model = {
        "symbols": symbol_defs,
        "reels": reels,
        "rows": rows,
        "paylines": paylines,
        "paytable": paytable_out,
        "bonuses": bonuses,
    }
    return RealizeResult(model, errors, warnings)
