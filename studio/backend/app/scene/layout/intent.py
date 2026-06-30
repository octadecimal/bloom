"""Read persisted GDD docs into a GddIntent for the bind step.

The GDD holds intent as rich prose + three enums (Task 1). This module is the
single place that knows which aspect/field each piece of intent lives in, so the
bind stays decoupled from GDD storage.
"""
from app.scene.layout.bind import GddIntent

_VALID = {
    "orientation": ("portrait", "landscape"),
    "focal_emphasis": ("reels", "logo", "balanced"),
    "framing_density": ("clean", "moderate", "ornate"),
}
_DEFAULTS = {"orientation": "landscape", "focal_emphasis": "balanced",
             "framing_density": "moderate"}


def _enum(data: dict, key: str) -> str:
    val = str(data.get(key) or "").strip().lower()
    return val if val in _VALID[key] else _DEFAULTS[key]


async def read_intent(gdd_store, game_id: str) -> GddIntent:
    theme_doc = await gdd_store.get_doc(game_id, "theme")
    ui_doc = await gdd_store.get_doc(game_id, "ui-ux")
    theme = getattr(theme_doc, "data", {}) or {}
    ui = getattr(ui_doc, "data", {}) or {}
    return GddIntent(
        orientation=_enum(ui, "orientation"),
        focal_emphasis=_enum(ui, "focal_emphasis"),
        framing_density=_enum(ui, "framing_density"),
        art_direction=str(theme.get("art_direction") or ""),
        tone=str(theme.get("tone") or ""),
        setting=str(theme.get("setting") or ""),
        layout=str(ui.get("layout") or ""),
        role_snippets={},
    )


def prompt_for_role(role: str, intent: GddIntent) -> str:
    parts = [
        intent.role_snippets.get(role, ""),
        intent.art_direction,
        f"{intent.tone} tone" if intent.tone else "",
        intent.setting,
    ]
    return ", ".join(p for p in parts if p)
