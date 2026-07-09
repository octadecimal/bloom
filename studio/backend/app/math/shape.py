"""Shape/target edit detection + sectional model merge (spec 2026-07-09 §4).

Structural sibling of app/scene/intent_rebuild.py: pure decisions here, the
store-wired orchestrator lives in realize_flow.py (Task 5)."""
from app.math.models import SectionLocks

SHAPE_FIELDS: dict[str, set[str]] = {
    "math-model": {"reels", "rows", "payline_mode", "payline_count"},
    "symbols-reels": {"symbols", "strip_length"},
    "bonus-features": {"features"},
}

TARGET_FIELDS: dict[str, set[str]] = {
    "math-model": {"rtp", "volatility", "bonus_hit_rate", "max_win", "hit_frequency"},
}

# GDD change -> which model sections must be re-realized. A roster change also
# reseeds strips and paytable rows (new/removed symbols invalidate both).
_SECTIONS_BY_FIELD: dict[tuple[str, str], set[str]] = {
    ("math-model", "reels"): {"reels", "paylines"},
    ("math-model", "rows"): {"reels", "paylines"},
    ("math-model", "payline_mode"): {"paylines"},
    ("math-model", "payline_count"): {"paylines"},
    ("symbols-reels", "symbols"): {"symbols", "reels", "paytable"},
    ("symbols-reels", "strip_length"): {"reels"},
    ("bonus-features", "features"): {"bonuses"},
}

# section -> SlotModel dict keys it owns
_SECTION_KEYS: dict[str, tuple[str, ...]] = {
    "symbols": ("symbols",),
    "reels": ("reels", "rows"),
    "paylines": ("paylines",),
    "paytable": ("paytable",),
    "bonuses": ("bonuses",),
}

# SectionLocks attr -> sections it blocks (symbols is never lockable)
_LOCK_BLOCKS: dict[str, set[str]] = {
    "reels": {"reels", "paylines"},
    "paytable": {"paytable"},
    "bonus": {"bonuses"},
}


def is_shape_change(aspect: str, fields: dict) -> bool:
    keys = SHAPE_FIELDS.get(aspect, set())
    return any(k in keys for k in fields)


def is_target_change(aspect: str, fields: dict) -> bool:
    keys = TARGET_FIELDS.get(aspect, set())
    return any(k in keys for k in fields)


def affected_sections(aspect: str, fields: dict) -> set[str]:
    out: set[str] = set()
    for key in fields:
        out |= _SECTIONS_BY_FIELD.get((aspect, key), set())
    return out


def merge_sections(existing: dict, realized: dict, sections: set[str],
                   locks: SectionLocks) -> dict:
    blocked: set[str] = set()
    for attr, blocks in _LOCK_BLOCKS.items():
        if getattr(locks, attr):
            blocked |= blocks
    out = dict(existing)
    for section in sections - blocked:
        for key in _SECTION_KEYS[section]:
            out[key] = realized[key]
    return out
