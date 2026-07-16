"""Pure GDD→SlotModel realizer (SP2). Structural sibling of targets.py.

Compiles the structured GDD math aspects into a structurally-valid (numerically
rough) SlotModel dict the Rust kernel accepts. Pure: no IO, no RNG. Fail-loud:
returns a RealizeResult whose model is None iff a hard structural contradiction
was found. The tuner (SP3) reconciles the numbers; this only fixes structure.
"""
from dataclasses import dataclass
from itertools import product

MAX_PAYLINES = 4096
MAX_REELS = 12
MAX_ROWS = 12
DEFAULT_STRIP_LEN = 30
DEFAULT_REELS = 5
DEFAULT_ROWS = 3
BONUS_MIN_COUNT = 3
# Scatter/trigger symbols must be SPARSE on a strip: roughly one occurrence per
# this many cells (>= 1). A dense scatter (e.g. round-robin's one-in-N) makes the
# free-spins trigger near-certain every spin, which — with retrigger — is a
# supercritical loop. The kernel hard-caps that anyway (MAX_FREE_SPINS), but the
# realizer should never emit such a degenerate model in the first place.
SCATTER_STRIP_SPACING = 20
MAX_STRIP_LEN = 1000  # absurdity ceiling for a single reel strip

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
    slot_ids: dict[str, int] | None = None


def realize_symbols(
    symbols_reels: dict, existing_ids: dict[str, int] | None = None,
) -> tuple[list[dict], dict[str, int], list[str], list[str]]:
    """Build SymbolDef rows + a {slot/name -> id} map. Ids of surviving slots
    are preserved via existing_ids; new slots get fresh sequential ids (spec §5
    join-key stability)."""
    rows = symbols_reels.get("symbols") or []
    existing_ids = existing_ids or {}
    errors: list[str] = []
    warnings: list[str] = []
    defs: list[dict] = []
    name_to_id: dict[str, int] = {}
    used = set(existing_ids.values())
    next_id = max(used, default=-1) + 1
    for i, row in enumerate(rows):
        kind = str(row.get("kind", "")).strip().lower()
        role = _KIND_TO_ROLE.get(kind)
        if role is None:
            role = "normal"
            warnings.append(
                f"symbol row {i} kind '{row.get('kind')}' unknown; role defaulted to normal"
            )
        keys = [str(row.get(k, "")).strip().lower() for k in ("slot", "name")]
        keys = [k for k in keys if k]
        sid = next((existing_ids[k] for k in keys if k in existing_ids), None)
        if sid is None:
            sid = next_id
            next_id += 1
        defs.append({"id": sid, "role": role})
        for k in keys:
            name_to_id[k] = sid
    if not defs:
        errors.append("no symbols defined; cannot realize a model")
    return defs, name_to_id, errors, warnings


def realize_reels(
    symbols_reels: dict, symbol_defs: list[dict], reel_count: int
) -> tuple[list[list[int]], list[str], list[str]]:
    """Seed one identical strip per reel. Paying symbols (normal/wild) fill the
    strip round-robin; scatter symbols are sprinkled SPARSELY (see
    SCATTER_STRIP_SPACING) so the trigger stays a rare event — never the dense
    one-in-N that a flat round-robin would produce."""
    errors: list[str] = []
    warnings: list[str] = []
    distinct_count = len(symbol_defs)
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

    if length > MAX_STRIP_LEN:
        warnings.append(
            f"strip length {length} exceeds MAX_STRIP_LEN {MAX_STRIP_LEN}; clamped"
        )
        length = MAX_STRIP_LEN

    paying = [d["id"] for d in symbol_defs if d["role"] in ("normal", "wild")]
    scatters = [d["id"] for d in symbol_defs if d["role"] == "scatter"]
    if not paying:
        # Degenerate model (only scatters/unknowns): fall back to all symbols so
        # the strip is still composed of something the kernel accepts.
        paying = [d["id"] for d in symbol_defs]
        warnings.append(
            "no paying (normal/wild) symbols; reels seeded round-robin from all symbols"
        )

    reel = [paying[pos % len(paying)] for pos in range(length)]

    # Sprinkle each scatter ~one per SCATTER_STRIP_SPACING cells, spread evenly so
    # occurrences never cluster. Round-robin which scatter lands at each slot.
    if scatters:
        occ_per = max(1, length // SCATTER_STRIP_SPACING)
        total = occ_per * len(scatters)
        for idx in range(total):
            pos = (2 * idx + 1) * length // (2 * total)  # evenly spaced midpoints
            reel[pos % length] = scatters[idx % len(scatters)]

    return [list(reel) for _ in range(reel_count)], errors, warnings


def _all_patterns(rows: int, reel_count: int) -> list[list[int]]:
    """Every row-combination across reels: straight horizontals first, then the
    remainder in lexicographic order. Deterministic."""
    combos = list(product(range(rows), repeat=reel_count))
    constants = [list(c) for c in combos if len(set(c)) == 1]
    others = [list(c) for c in combos if len(set(c)) > 1]
    return constants + others


def _first_n_patterns(rows: int, reel_count: int, n: int) -> list[list[int]]:
    """The first `n` paylines in the same order as `_all_patterns` (constants
    first, then lexicographic), generated LAZILY — never materializes more than
    `n` patterns. "lines" mode uses this so a large rows^reel_count geometry can
    never OOM when only `n` lines are kept."""
    out: list[list[int]] = []
    for r in range(rows):  # constants first
        if len(out) >= n:
            return out
        out.append([r] * reel_count)
    for combo in product(range(rows), repeat=reel_count):  # then non-constants
        if len(out) >= n:
            break
        if len(set(combo)) > 1:
            out.append(list(combo))
    return out


def realize_paylines(
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
    return _first_n_patterns(rows, reel_count, n), errors, warnings


_OAK_COLUMNS = {"3oak": 3, "4oak": 4, "5oak": 5}


def realize_paytable(
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
    """One FreeSpins bonus per GDD features row. The numeric config is a seed
    the GA owns (free_spins was evicted from the GDD — spec §3)."""
    errors: list[str] = []
    warnings: list[str] = []
    rows = bonus_features.get("features") or []
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
    for _row in rows:
        bonuses.append({"FreeSpins": {
            "trigger": {"symbol": trigger, "min_count": BONUS_MIN_COUNT},
            "config": {
                "spins_awarded": 10, "retrigger": False,
                "multiplier": 1, "feature_reels": None,
            },
        }})
    return bonuses, errors, warnings


def slot_id_map(symbols_reels: dict, name_to_id: dict[str, int]) -> dict[str, int]:
    """{slot -> model symbol id} for the GDD model_id join-key write-back."""
    return {
        str(row.get("slot", "")).strip().lower():
            name_to_id[str(row.get("slot", "")).strip().lower()]
        for row in (symbols_reels.get("symbols") or [])
        if str(row.get("slot", "")).strip()
    }


def realize_slot_model(
    math_model: dict,
    symbols_reels: dict,
    paytable: dict,
    bonus_features: dict,
    existing_ids: dict[str, int] | None = None,
) -> RealizeResult:
    """Compile the structured GDD math aspects into a SlotModel dict. Fail-loud:
    model is None iff a hard structural contradiction was found."""
    errors: list[str] = []
    warnings: list[str] = []

    symbol_defs, name_to_id, e, w = realize_symbols(symbols_reels, existing_ids)
    errors += e
    warnings += w
    if not symbol_defs:
        return RealizeResult(None, errors, warnings)

    if math_model.get("reels") in (None, ""):
        warnings.append(f"reels absent; defaulted to {DEFAULT_REELS}")
    reel_count = _to_int(math_model.get("reels"), DEFAULT_REELS)
    if math_model.get("rows") in (None, ""):
        warnings.append(f"rows absent; defaulted to {DEFAULT_ROWS}")
    rows = _to_int(math_model.get("rows"), DEFAULT_ROWS)

    if reel_count > MAX_REELS:
        errors.append(f"reels {reel_count} exceeds MAX_REELS {MAX_REELS}")
    if rows > MAX_ROWS:
        errors.append(f"rows {rows} exceeds MAX_ROWS {MAX_ROWS}")
    if errors:
        return RealizeResult(None, errors, warnings)

    reels, e, w = realize_reels(symbols_reels, symbol_defs, reel_count)
    errors += e
    warnings += w
    paylines, e, w = realize_paylines(math_model, reel_count, rows)
    errors += e
    warnings += w
    paytable_out, e, w = realize_paytable(paytable, name_to_id, symbol_defs)
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
    return RealizeResult(model, errors, warnings,
                         slot_id_map(symbols_reels, name_to_id))
