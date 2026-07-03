"""Named starter SlotModels. A fresh game is seeded with DEFAULT_TEMPLATE so a
game's model is never {}. The video-5x3 / high-vol-5x4 literals are frozen
tuner output (tools/freeze_template.py, Task 7) so each template lands near its
stated target out of the box."""
import copy

from app.math.models import SectionLocks

_CLASSIC_3X3: dict = {
    # Started from the proven runtime demo model (was DEMO_SLOT_MODEL in
    # app/scene/reels_spin.py; also runtime/server/demo/model.json). Frozen
    # tuner output (tools/freeze_template.py, Task 7), pass, measured
    # rtp=0.95936 vol=2.3544826162871035 (curate_json's own 50k-candidate
    # evaluation, the same fidelity tests/test_math_templates_binary.py
    # checks — the tuner's internal 200k-candidate final verify reported a
    # slightly different rtp for the same model; two extra single-position
    # reel nudges closed that gap so both evaluations land in the target
    # band together).
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 1, 2, 0, 2, 1, 0],
        [0, 1, 2, 9, 0, 1, 2, 0, 1, 2],
        [0, 1, 2, 9, 0, 1, 2, 0, 1, 2],
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
    # Frozen tuner output (tools/freeze_template.py, Task 7), pass, measured
    # rtp=0.95258 vol=3.550543809559171 (target: RTP 96% ±1%, medium
    # volatility 3-6, bonus hit rate ~1:150 ±25%). The pre-tuned seed's
    # scatter density made free spins trigger ~9x too often at min_count=3
    # (measured ~1:17 vs the 1:150 target); min_count=4 was the near-miss
    # seed relax that let the GA close the rest of the gap.
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
        [0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 0, 1, 2, 0, 1, 0],
        [0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 0, 1, 3, 0, 1, 1],
        [0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 0, 2, 3, 2, 3, 2],
        [0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 1, 2, 3, 2, 3, 3],
        [0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 9, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 0, 2, 3, 0, 3, 0],
    ],
    "rows": 3,
    "paylines": [
        [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
        [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [1, 0, 0, 0, 1],
        [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 2, 1, 0, 1],
    ],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 1},  {"symbol": 0, "count": 4, "payout": 3},  {"symbol": 0, "count": 5, "payout": 8},
        {"symbol": 1, "count": 3, "payout": 2},  {"symbol": 1, "count": 4, "payout": 5},  {"symbol": 1, "count": 5, "payout": 11},
        {"symbol": 2, "count": 3, "payout": 2},  {"symbol": 2, "count": 4, "payout": 6},  {"symbol": 2, "count": 5, "payout": 16},
        {"symbol": 3, "count": 3, "payout": 3},  {"symbol": 3, "count": 4, "payout": 8},  {"symbol": 3, "count": 5, "payout": 27},
        {"symbol": 4, "count": 3, "payout": 6},  {"symbol": 4, "count": 4, "payout": 16}, {"symbol": 4, "count": 5, "payout": 55},
        {"symbol": 5, "count": 3, "payout": 8},  {"symbol": 5, "count": 4, "payout": 27}, {"symbol": 5, "count": 5, "payout": 109},
    ]},
    "bonuses": [{
        "FreeSpins": {
            "trigger": {"symbol": 9, "min_count": 4},
            "config": {"spins_awarded": 10, "retrigger": False,
                       "multiplier": 2, "feature_reels": None},
        },
    }],
}

_HIGH_VOL_5X4: dict = {
    # NEAR-MISS, NOT frozen-to-pass — Task 7 BLOCKED on this template; see
    # .superpowers/sdd/task-7-report.md. Closest safe candidate found:
    # rtp=0.97008 vol=10.445243165848316 bonusHR=0.00452 (target: RTP 96%
    # ±1%, i.e. rtp<=0.97 — misses by 0.00008; volatility 10+ and bonus hit
    # rate ~1:200 both already in band). Root cause is NOT this paytable: it
    # is a genuine non-terminating loop in freeze_pool's greedy swap search
    # (studio/simulator/src/curate.rs) that triggers whenever a candidate's
    # single-jackpot payout delta vastly exceeds pool_size*rtp_tolerance —
    # exactly the regime a "volatility 10+" target requires. Every paytable
    # found during search whose *measured* rtp/vol actually verified inside
    # the target bands then hung for 20-400s+ in curate_json's freeze phase
    # (confirmed via source read: verify() runs before freeze_pool, so
    # reaching freeze_pool implies verify() had already passed) — so this
    # literal was deliberately kept just outside the rtp band (fails fast at
    # the `verify` stage) rather than risk shipping a template whose own
    # re-curation hangs in production. Do not ship a template requiring
    # freeze_pool to pass until that bug is fixed upstream.
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 3, "role": "normal"},
        {"id": 4, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 3, 1, 0, 4, 2, 1, 9, 0, 3, 1, 2, 0, 1, 4, 0, 2, 3, 1, 9, 0, 1, 2, 0, 3, 1, 4, 0, 2, 0, 1, 2, 3, 4, 1, 2, 3, 0, 4, 2, 1],
        [1, 0, 3, 1, 2, 0, 1, 4, 0, 2, 9, 1, 0, 3, 1, 2, 0, 1, 4, 3, 0, 2, 9, 1, 0, 2, 1, 3, 0, 4, 1, 2, 3, 4, 1, 2, 3, 0, 4, 2, 1, 0, 1, 2],
        [2, 1, 0, 2, 3, 1, 2, 4, 1, 0, 9, 2, 1, 3, 2, 0, 1, 2, 4, 0, 3, 1, 9, 2, 0, 1, 2, 3, 1, 4, 2, 0, 2, 3, 0, 4, 2, 1, 0, 1, 2, 3, 4, 1],
        [0, 2, 1, 0, 3, 2, 0, 4, 1, 2, 9, 0, 2, 3, 0, 1, 2, 0, 4, 1, 3, 2, 9, 0, 1, 2, 0, 3, 2, 4, 0, 1, 4, 2, 1, 0, 1, 2, 3, 4, 1, 2, 3, 0],
        [1, 2, 0, 1, 3, 0, 1, 4, 2, 0, 9, 1, 2, 3, 1, 0, 2, 1, 4, 0, 3, 2, 9, 1, 0, 2, 1, 3, 0, 4, 1, 2, 1, 2, 3, 4, 1, 2, 3, 0, 4, 2, 1, 0],
    ],
    "rows": 4,
    "paylines": [
        [0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [3, 3, 3, 3, 3],
        [0, 1, 2, 1, 0], [3, 2, 1, 2, 3], [1, 0, 0, 0, 1], [2, 3, 3, 3, 2],
        [0, 1, 1, 1, 0], [3, 2, 2, 2, 3],
    ],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 1}, {"symbol": 0, "count": 4, "payout": 1}, {"symbol": 0, "count": 5, "payout": 1},
        {"symbol": 1, "count": 3, "payout": 1}, {"symbol": 1, "count": 4, "payout": 1}, {"symbol": 1, "count": 5, "payout": 1},
        {"symbol": 2, "count": 3, "payout": 1}, {"symbol": 2, "count": 4, "payout": 1}, {"symbol": 2, "count": 5, "payout": 1},
        {"symbol": 3, "count": 3, "payout": 1}, {"symbol": 3, "count": 4, "payout": 1}, {"symbol": 3, "count": 5, "payout": 400},
        {"symbol": 4, "count": 3, "payout": 18}, {"symbol": 4, "count": 4, "payout": 50}, {"symbol": 4, "count": 5, "payout": 450},
    ]},
    "bonuses": [{
        "FreeSpins": {
            "trigger": {"symbol": 9, "min_count": 4},
            "config": {"spins_awarded": 2, "retrigger": False,
                       "multiplier": 1, "feature_reels": None},
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
