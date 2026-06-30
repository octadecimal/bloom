"""Bridge the REST GDD save to the scene rebuild spine (HITL Surface 2).

A save that touches an art-direction / layout-intent field should reflow the
live scene the same way the design-router's chat path does — by running the one
`rebuild_scene_core` spine. This module decides "was this an intent edit?" and,
if so, assembles a ToolContext from the app's shared singletons and runs it.
No new persistence; geometry still comes only from the bind.
"""
from app.agent_tools import ToolContext, rebuild_scene_core

INTENT_FIELDS: dict[str, set[str]] = {
    "theme": {"art_direction"},
    "ui-ux": {"layout", "orientation", "focal_emphasis", "framing_density"},
}


def is_intent_change(aspect: str, fields: dict) -> bool:
    keys = INTENT_FIELDS.get(aspect, set())
    return any(k in keys for k in fields)


async def rebuild_after_intent(app_state, game_id: str) -> str | None:
    """Run the rebuild spine for game_id using app_state's singletons. Returns the
    summary string, or None when the rebuild is a no-op (no critics / empty scene)."""
    ctx = ToolContext(
        room_id="",
        game_id=game_id,
        asset_store=getattr(app_state, "asset_store", None),
        asset_hub=getattr(app_state, "asset_hub", None),
        gdd_store=getattr(app_state, "gdd_store", None),
        scene_store=getattr(app_state, "scene_store", None),
        scene_hub=getattr(app_state, "scene_hub", None),
        scene_critic=getattr(app_state, "scene_critic", None),
        asset_critic=getattr(app_state, "asset_critic", None),
    )
    summary = await rebuild_scene_core(ctx)
    if summary.startswith("Rebuild unavailable") or summary.startswith("Nothing to rebuild"):
        return None
    return summary
