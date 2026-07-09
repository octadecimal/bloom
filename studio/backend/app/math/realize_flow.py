"""Store-wired GDD->SlotModel realization (spec 2026-07-09 §4-§5). Pure
decisions live in shape.py / realize.py; this module reads the GDD, realizes,
merges sectionally, persists, and writes the model_id join keys back."""
import logging
from dataclasses import dataclass, field

from app.math.realize import realize_slot_model
from app.math.shape import affected_sections, merge_sections

log = logging.getLogger(__name__)

_ASPECTS = ("math-model", "symbols-reels", "paytable", "bonus-features")


@dataclass(frozen=True)
class RealizeFlowResult:
    realized: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _existing_ids(symbols_data: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for row in symbols_data.get("symbols") or []:
        slot = str(row.get("slot", "")).strip().lower()
        mid = row.get("model_id")
        if slot and isinstance(mid, (int, float)) and str(mid) != "":
            out[slot] = int(mid)
    return out


async def realize_game(math_store, gdd_store, game_id: str, *,
                       aspect: str | None = None,
                       fields: dict | None = None) -> RealizeFlowResult:
    data = {}
    for a in _ASPECTS:
        doc = await gdd_store.get_doc(game_id, a)
        data[a] = dict(doc.data) if doc else {}

    result = realize_slot_model(
        data["math-model"], data["symbols-reels"], data["paytable"],
        data["bonus-features"], existing_ids=_existing_ids(data["symbols-reels"]),
    )
    if result.model is None:
        return RealizeFlowResult(False, result.errors, result.warnings)

    existing = await math_store.get_or_seed(game_id)
    if existing.origin == "realized":
        # aspect=None (explicit realize endpoint) means all sections, minus locks
        sections = (affected_sections(aspect, fields or {}) if aspect
                    else {"symbols", "reels", "paylines", "paytable", "bonuses"})
        model = merge_sections(existing.model, result.model, sections,
                               existing.locks)
    else:
        model = result.model  # birth: whole realized model
    await math_store.save_realized(game_id, model)

    # join-key write-back (spec §5) — direct store call, no entry-point hook
    rows = [dict(r) for r in data["symbols-reels"].get("symbols") or []]
    changed = False
    for row in rows:
        slot = str(row.get("slot", "")).strip().lower()
        new_id = (result.slot_ids or {}).get(slot)
        if new_id is not None and row.get("model_id") != new_id:
            row["model_id"] = new_id
            changed = True
    if changed:
        await gdd_store.set_fields(game_id, "symbols-reels", {"symbols": rows})

    return RealizeFlowResult(True, result.errors, result.warnings)


async def apply_math_hooks(app_state, game_id: str, aspect: str,
                           fields: dict) -> str | None:
    """Shape/target side-effects of a persisted GDD edit (spec §4). Best-effort:
    like the scene reflow, a failure must not fail the save's PUT."""
    from app.math.shape import is_shape_change, is_target_change

    try:
        math_store = app_state.math_store
        gdd_store = app_state.gdd_store
        if is_target_change(aspect, fields):
            doc = await math_store.get_or_seed(game_id)
            if doc.result is not None or doc.tune_result is not None:
                await math_store.set_stale_flags(game_id, verdict_stale=True)
        if not is_shape_change(aspect, fields):
            return None
        doc = await math_store.get_or_seed(game_id)
        if doc.touched:
            await math_store.set_stale_flags(game_id, shape_stale=True)
            return "pending"
        res = await realize_game(math_store, gdd_store, game_id,
                                 aspect=aspect, fields=fields)
        return "applied" if res.realized else None
    except Exception:  # noqa: BLE001 — the GDD save stays authoritative
        log.warning("math hook after GDD edit failed for game %s", game_id,
                    exc_info=True)
        return None
