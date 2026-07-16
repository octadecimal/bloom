"""Pure GDD→GameDefinition realizer (SP-D). Structural sibling of realize.py:
compiles the structured GDD aspects into a structurally-valid (numerically
rough) composed@1 GameDefinition dict. Pure: no IO, no RNG. Fail-loud:
RealizeResult.model is None iff a hard structural contradiction was found.
The GA owns the numbers (strips, paytable, budgets, targets) after seeding."""
from app.math.realize import (
    BONUS_MIN_COUNT, DEFAULT_REELS, DEFAULT_ROWS, MAX_REELS, MAX_ROWS,
    RealizeResult, _to_bool, _to_int, realize_paylines, realize_paytable,
    realize_reels, realize_symbols, slot_id_map,
)

SCATTER_EVENT = f"scatters:{BONUS_MIN_COUNT}"
DEFAULT_FS_SPINS = 8       # matches the demo definition's fs1 initial
DEFAULT_METER_TARGET = 6   # matches the demo meter target
METER_STATE_BUDGET = 5     # fixed-budget bonus state a full meter enters
MAX_STEPS = 1000           # matches runtime/server/demo caps


def _kind(row: dict) -> str:
    k = str(row.get("kind", "")).strip().lower()
    return k if k in ("free-spins", "meter") else "free-spins"


def realize_game_definition(
    math_model: dict,
    symbols_reels: dict,
    paytable: dict,
    bonus_features: dict,
    existing_ids: dict[str, int] | None = None,
) -> RealizeResult:
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

    strips, e, w = realize_reels(symbols_reels, symbol_defs, reel_count)
    errors += e
    warnings += w
    paylines, e, w = realize_paylines(math_model, reel_count, rows)
    errors += e
    warnings += w
    paytable_out, e, w = realize_paytable(paytable, name_to_id, symbol_defs)
    errors += e
    warnings += w
    if errors:
        return RealizeResult(None, errors, warnings)

    scatter = next((d["id"] for d in symbol_defs if d["role"] == "scatter"), None)
    feature_rows = list(bonus_features.get("features") or [])
    if feature_rows and scatter is None:
        warnings.append(
            "bonus features defined but no scatter/bonus trigger symbol "
            "exists; features skipped")
        feature_rows = []

    reels_config: dict = {
        "strips": strips, "rows": rows, "symbols": symbol_defs,
        "paylines": paylines, "paytable": paytable_out, "events": [],
    }
    if any(_kind(r) == "free-spins" for r in feature_rows):
        reels_config["events"].append(
            {"symbol": scatter, "min_count": BONUS_MIN_COUNT,
             "emit": SCATTER_EVENT})

    mechanics: list[dict] = [
        {"id": "main_reels", "type": "reels@1", "config": reels_config}]
    base_bindings: list[dict] = [{"mechanic": "main_reels"}]
    base_script: list[dict] = [{"invoke": "main_reels.spin"}]
    states: list[dict] = []
    transitions: list[dict] = []
    last_fs: tuple[str, dict] | None = None  # (state id, feature row)

    for i, row in enumerate(feature_rows, start=1):
        if _kind(row) == "free-spins":
            sid = f"fs_{i}"
            initial = _to_int(row.get("budget"), DEFAULT_FS_SPINS)
            states.append({
                "id": sid,
                "bindings": [{"mechanic": "main_reels"}],
                "steps": {"budget": "awarded", "initial": initial},
                "script": [{"invoke": "main_reels.spin"}],
            })
            # Later free-spins states chain from the previous one: two
            # transitions from the same state on the one scatter event would
            # be ambiguous.
            src = last_fs[0] if last_fs else "base"
            if last_fs:
                warnings.append(
                    f"multiple free-spins features share one scatter event; "
                    f"'{sid}' chains from '{last_fs[0]}' instead of base")
            transitions.append({"from": src, "on": SCATTER_EVENT, "to": sid})
            last_fs = (sid, row)
        else:  # meter
            mid = f"meter_{i}"
            on_full = f"meter{i}:full"  # explicit per-meter event: collision-free
            target = _to_int(row.get("budget"), DEFAULT_METER_TARGET)
            mechanics.append({
                "id": mid, "type": "meter@1",
                "config": {"target": target, "count_symbol": scatter,
                           "on_full": on_full, "reset_on_full": True},
            })
            base_bindings.append({"mechanic": mid})
            base_script.append({"invoke": f"{mid}.accumulate"})
            sid = f"meter_{i}_bonus"
            states.append({
                "id": sid,
                "bindings": [{"mechanic": "main_reels"}],
                "steps": {"budget": METER_STATE_BUDGET},
                "script": [{"invoke": "main_reels.spin"}],
            })
            transitions.append({"from": "base", "on": on_full, "to": sid})

    # Retrigger only on the LAST free-spins state in the chain: any earlier
    # fs state already consumes the scatter event with its chain transition.
    if last_fs is not None and _to_bool(last_fs[1].get("retrigger")):
        initial = _to_int(last_fs[1].get("budget"), DEFAULT_FS_SPINS)
        transitions.append({"from": last_fs[0], "on": SCATTER_EVENT,
                            "effect": f"steps:add:{initial}"})

    base = {"id": "base", "bindings": base_bindings,
            "steps": {"budget": 1}, "script": base_script}
    model = {
        "family": "composed@1",
        "mechanics": mechanics,
        "states": [base] + states,
        "start": "base",
        "transitions": transitions,
        "caps": {"max_steps": MAX_STEPS},
    }
    return RealizeResult(model, errors, warnings,
                         slot_id_map(symbols_reels, name_to_id))
