"""Store-wired target derivation (spec 2026-07-09 §5-§6). Pure compilation
lives in targets.py; this module fetches the GDD aspects every caller needs.
Extracted from four duplicated call sites (hub, rest, two agent tools)."""
from app.math.targets import derive_num_bonuses, derive_target


async def derive_target_for(gdd_store, game_id: str, doc) -> dict:
    """Compile the curation/tuning target dict for a game from its GDD intent
    plus the math doc's params. Raises TargetGap on missing/contradictory
    intent, exactly like derive_target."""
    model = doc.model or {}

    async def data(aspect: str) -> dict:
        d = await gdd_store.get_doc(game_id, aspect)
        return getattr(d, "data", {}) if d is not None else {}

    math_model = await data("math-model")
    num_bonuses = derive_num_bonuses(await data("bonus-features"), model)
    return derive_target(math_model, doc.params, num_bonuses,
                         paytable_data=await data("paytable"),
                         symbols_data=await data("symbols-reels"))
