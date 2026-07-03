"""Named starter SlotModels. A fresh game is seeded with DEFAULT_TEMPLATE so a
game's model is never {}. The video-5x3 / high-vol-5x4 literals are frozen
tuner output (tools/freeze_template.py, Task 7) so each template lands near its
stated target out of the box."""
import copy

from app.math.models import SectionLocks

_CLASSIC_3X3: dict = {
    # Identical to the proven runtime demo model (was DEMO_SLOT_MODEL in
    # app/scene/reels_spin.py; also runtime/server/demo/model.json).
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
    ],
    "rows": 3,
    "paylines": [[0, 0, 0], [1, 1, 1], [2, 2, 2]],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 5},
        {"symbol": 1, "count": 3, "payout": 3},
        {"symbol": 2, "count": 3, "payout": 2},
    ]},
    "bonuses": [],
}

_VIDEO_5X3: dict = {
    # Seed version — replaced by frozen tuner output in Task 7 (target: RTP 96%
    # ±1%, medium volatility 3–6, bonus hit rate ~1:150 ±25%).
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 3, "role": "normal"},
        {"id": 4, "role": "normal"},
        {"id": 5, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 3, 0, 4, 1, 5, 0, 2, 9, 1, 3, 0, 2, 4, 1, 0, 5, 2, 3, 9, 0, 1, 2, 4, 0, 3, 1, 5],
        [1, 0, 3, 2, 1, 5, 0, 4, 1, 3, 9, 0, 2, 1, 3, 5, 0, 1, 4, 3, 2, 9, 1, 0, 3, 5, 1, 2, 0, 4],
        [2, 3, 0, 1, 2, 4, 3, 5, 2, 0, 9, 3, 1, 2, 0, 4, 3, 2, 5, 0, 1, 9, 2, 3, 0, 4, 2, 1, 3, 5],
        [3, 2, 1, 0, 3, 5, 2, 4, 3, 1, 9, 2, 0, 3, 1, 5, 2, 3, 4, 1, 0, 9, 3, 2, 1, 5, 3, 0, 2, 4],
        [0, 3, 2, 1, 0, 4, 3, 5, 0, 2, 9, 3, 1, 0, 2, 4, 3, 0, 5, 2, 1, 9, 0, 3, 2, 4, 0, 1, 3, 5],
    ],
    "rows": 3,
    "paylines": [
        [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
        [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [1, 0, 0, 0, 1],
        [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 1, 0, 1],
    ],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 2},  {"symbol": 0, "count": 4, "payout": 5},   {"symbol": 0, "count": 5, "payout": 15},
        {"symbol": 1, "count": 3, "payout": 3},  {"symbol": 1, "count": 4, "payout": 8},   {"symbol": 1, "count": 5, "payout": 20},
        {"symbol": 2, "count": 3, "payout": 4},  {"symbol": 2, "count": 4, "payout": 10},  {"symbol": 2, "count": 5, "payout": 30},
        {"symbol": 3, "count": 3, "payout": 5},  {"symbol": 3, "count": 4, "payout": 15},  {"symbol": 3, "count": 5, "payout": 50},
        {"symbol": 4, "count": 3, "payout": 10}, {"symbol": 4, "count": 4, "payout": 30},  {"symbol": 4, "count": 5, "payout": 100},
        {"symbol": 5, "count": 3, "payout": 15}, {"symbol": 5, "count": 4, "payout": 50},  {"symbol": 5, "count": 5, "payout": 200},
    ]},
    "bonuses": [{
        "FreeSpins": {
            "trigger": {"symbol": 9, "min_count": 3},
            "config": {"spins_awarded": 10, "retrigger": False,
                       "multiplier": 2, "feature_reels": None},
        },
    }],
}

_HIGH_VOL_5X4: dict = {
    # Seed version — replaced by frozen tuner output in Task 7 (target: RTP 96%
    # ±1%, high volatility 10+, bonus hit rate ~1:200 ±25%).
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 3, "role": "normal"},
        {"id": 4, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 3, 1, 0, 4, 2, 1, 9, 0, 3, 1, 2, 0, 1, 4, 0, 2, 3, 1, 9, 0, 1, 2, 0, 3, 1, 4, 0, 2],
        [1, 0, 3, 1, 2, 0, 1, 4, 0, 2, 9, 1, 0, 3, 1, 2, 0, 1, 4, 3, 0, 2, 9, 1, 0, 2, 1, 3, 0, 4, 1, 2],
        [2, 1, 0, 2, 3, 1, 2, 4, 1, 0, 9, 2, 1, 3, 2, 0, 1, 2, 4, 0, 3, 1, 9, 2, 0, 1, 2, 3, 1, 4, 2, 0],
        [0, 2, 1, 0, 3, 2, 0, 4, 1, 2, 9, 0, 2, 3, 0, 1, 2, 0, 4, 1, 3, 2, 9, 0, 1, 2, 0, 3, 2, 4, 0, 1],
        [1, 2, 0, 1, 3, 0, 1, 4, 2, 0, 9, 1, 2, 3, 1, 0, 2, 1, 4, 0, 3, 2, 9, 1, 0, 2, 1, 3, 0, 4, 1, 2],
    ],
    "rows": 4,
    "paylines": [
        [0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3],
        [0, 1, 2, 1, 0], [3, 2, 1, 2, 3], [1, 0, 0, 0, 1], [2, 3, 3, 3, 2],
        [0, 1, 1, 1, 0], [3, 2, 2, 2, 3],
    ],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 1},  {"symbol": 0, "count": 4, "payout": 4},   {"symbol": 0, "count": 5, "payout": 12},
        {"symbol": 1, "count": 3, "payout": 2},  {"symbol": 1, "count": 4, "payout": 6},   {"symbol": 1, "count": 5, "payout": 25},
        {"symbol": 2, "count": 3, "payout": 4},  {"symbol": 2, "count": 4, "payout": 15},  {"symbol": 2, "count": 5, "payout": 60},
        {"symbol": 3, "count": 3, "payout": 10}, {"symbol": 3, "count": 4, "payout": 50},  {"symbol": 3, "count": 5, "payout": 250},
        {"symbol": 4, "count": 3, "payout": 25}, {"symbol": 4, "count": 4, "payout": 150}, {"symbol": 4, "count": 5, "payout": 1000},
    ]},
    "bonuses": [{
        "FreeSpins": {
            "trigger": {"symbol": 9, "min_count": 3},
            "config": {"spins_awarded": 12, "retrigger": False,
                       "multiplier": 3, "feature_reels": None},
        },
    }],
}

TEMPLATES: dict[str, dict] = {
    "classic-3x3": {
        "name": "classic-3x3", "label": "Classic 3×3",
        "description": "3 reels × 3 rows, low volatility, no bonus — a simple classic slot.",
        "model": _CLASSIC_3X3,
    },
    "video-5x3": {
        "name": "video-5x3", "label": "Video 5×3",
        "description": "5 reels × 3 rows, ~96% RTP, medium volatility, free-spins bonus. The default.",
        "model": _VIDEO_5X3,
    },
    "high-vol-5x4": {
        "name": "high-vol-5x4", "label": "High-Vol 5×4",
        "description": "5 reels × 4 rows, high volatility, steep top-end paytable, free-spins bonus.",
        "model": _HIGH_VOL_5X4,
    },
}

DEFAULT_TEMPLATE = "video-5x3"


def list_templates() -> list[dict]:
    return [{"name": t["name"], "label": t["label"], "description": t["description"]}
            for t in TEMPLATES.values()]


def get_model(name: str) -> dict:
    return copy.deepcopy(TEMPLATES[name]["model"])


def default_model() -> dict:
    return get_model(DEFAULT_TEMPLATE)


# Which model keys each lockable section owns. rows travels with reels — a
# locked reel-set keeps its own window height.
_LOCK_SECTIONS: dict[str, tuple[str, ...]] = {
    "reels": ("reels", "rows"),
    "paytable": ("paytable",),
    "bonus": ("bonuses",),
}


def apply_template(current_model: dict, template_model: dict,
                   locks: SectionLocks) -> dict:
    """Template wins, except sections the user locked keep their current values.
    Locks constrain automation, not humans (spec decision 4)."""
    merged = copy.deepcopy(template_model)
    current = current_model or {}
    for section, keys in _LOCK_SECTIONS.items():
        if getattr(locks, section):
            for key in keys:
                if key in current:
                    merged[key] = copy.deepcopy(current[key])
    return merged
