"""Shape/target edit detection + sectional model merge (spec 2026-07-09 §4).

Structural sibling of app/scene/intent_rebuild.py: pure decisions here, the
store-wired orchestrator lives in realize_flow.py (Task 5)."""
import copy

from app.math.models import SectionLocks

SHAPE_FIELDS: dict[str, set[str]] = {
    "math-model": {"reels", "rows", "payline_mode", "payline_count", "game_family"},
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


# ── composed@1: 3-group merge (SP-D). Groups mirror the tuner's lock groups.
COMPOSED_GROUP_FIELDS: dict[tuple[str, str], set[str]] = {
    ("math-model", "reels"): {"reels"},
    ("math-model", "rows"): {"reels"},
    ("math-model", "payline_mode"): {"reels"},
    ("math-model", "payline_count"): {"reels"},
    ("math-model", "game_family"): {"reels", "paytable", "features"},
    ("symbols-reels", "symbols"): {"reels", "paytable"},
    ("symbols-reels", "strip_length"): {"reels"},
    ("bonus-features", "features"): {"features"},
}

_GROUP_LOCK_ATTR = {"reels": "reels", "paytable": "paytable", "features": "bonus"}


def composed_affected_groups(aspect: str, fields: dict) -> set[str]:
    out: set[str] = set()
    for key in fields:
        out |= COMPOSED_GROUP_FIELDS.get((aspect, key), set())
    return out


def _first_reels(definition: dict) -> dict | None:
    return next((m for m in definition.get("mechanics") or []
                 if m.get("type") == "reels@1"), None)


def _retarget(obj, old: str, new: str):
    """Rewrite mechanic references (bindings + script invokes) old -> new."""
    if isinstance(obj, list):
        return [_retarget(x, old, new) for x in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "mechanic" and v == old:
                out[k] = new
            elif k == "invoke" and isinstance(v, str) and v.startswith(old + "."):
                out[k] = new + v[len(old):]
            else:
                out[k] = _retarget(v, old, new)
        return out
    return obj


def merge_composed_groups(existing: dict, realized: dict, groups: set[str],
                          locks: SectionLocks) -> dict:
    unlocked = {g for g in groups if not getattr(locks, _GROUP_LOCK_ATTR[g])}
    out = copy.deepcopy(existing)
    re_reels = _first_reels(realized)  # realizer always emits main_reels
    ex_reels = _first_reels(out)
    if ex_reels is None:
        out.setdefault("mechanics", []).insert(0, copy.deepcopy(re_reels))
        ex_reels = _first_reels(out)
    reels_id = ex_reels["id"]
    if "reels" in unlocked:
        for key in ("strips", "rows", "symbols", "paylines"):
            ex_reels["config"][key] = copy.deepcopy(re_reels["config"][key])
    if "paytable" in unlocked:
        ex_reels["config"]["paytable"] = copy.deepcopy(re_reels["config"]["paytable"])
    if "features" in unlocked:
        ex_reels["config"]["events"] = copy.deepcopy(re_reels["config"].get("events", []))
        meters = [m for m in realized.get("mechanics") or []
                  if m.get("type") == "meter@1"]
        out["mechanics"] = [ex_reels] + copy.deepcopy(meters)
        for key in ("states", "transitions", "start", "caps"):
            out[key] = copy.deepcopy(realized[key])
        if reels_id != "main_reels":
            out["states"] = _retarget(out["states"], "main_reels", reels_id)
            out["transitions"] = _retarget(out["transitions"], "main_reels", reels_id)
    out["family"] = "composed@1"
    return out
