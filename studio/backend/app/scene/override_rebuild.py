"""Bridge REST region-override edits to the scene rebuild spine (HITL Surface 4).

A human nudging a role's region persists a per-game override, then the scene
reflows through the SAME rebuild_scene_core spine the intent-save path uses — so
the nudge shows live and survives future rebuilds. Geometry lives here + in the
override store, never in the GDD.
"""
import logging

from app.agent_tools import ToolContext, rebuild_scene_core
from app.scene.layout.bind import GddIntent, bind
from app.scene.layout.intent import read_intent
from app.scene.layout.overrides import RegionOverride
from app.scene.layout.plan import canonical_role

log = logging.getLogger(__name__)


def _ctx(app_state, game_id: str) -> ToolContext:
    return ToolContext(
        room_id="",
        game_id=game_id,
        asset_store=getattr(app_state, "asset_store", None),
        asset_hub=getattr(app_state, "asset_hub", None),
        gdd_store=getattr(app_state, "gdd_store", None),
        scene_store=getattr(app_state, "scene_store", None),
        scene_hub=getattr(app_state, "scene_hub", None),
        scene_critic=getattr(app_state, "scene_critic", None),
        asset_critic=getattr(app_state, "asset_critic", None),
        region_override_store=getattr(app_state, "region_override_store", None),
    )


async def _rebuild(app_state, game_id: str) -> str | None:
    """Best-effort reflow: the override is already persisted, so a live-mode
    critic/LLM/store error must not fail the nudge's PUT."""
    try:
        summary = await rebuild_scene_core(_ctx(app_state, game_id))
    except Exception:  # noqa: BLE001 — reflow is best-effort; the override stays authoritative
        log.warning("scene reflow after region nudge failed for game %s", game_id, exc_info=True)
        return None
    if summary.startswith("Rebuild unavailable") or summary.startswith("Nothing to rebuild"):
        return None
    return summary


async def set_override_and_rebuild(app_state, game_id: str, role: str,
                                   override: RegionOverride) -> str | None:
    key = canonical_role(role)
    if key is None:
        return None
    store = getattr(app_state, "region_override_store", None)
    if store is not None:
        await store.set_role(game_id, key, override)
    return await _rebuild(app_state, game_id)


async def clear_override_and_rebuild(app_state, game_id: str, role: str) -> str | None:
    key = canonical_role(role)
    if key is None:
        return None
    store = getattr(app_state, "region_override_store", None)
    if store is not None:
        await store.clear_role(game_id, key)
    return await _rebuild(app_state, game_id)


async def override_view(app_state, game_id: str) -> dict:
    """The editor read model: plan defaults (NO overrides) as placeholders + the
    stored overrides for the form's current values."""
    gdd_store = getattr(app_state, "gdd_store", None)
    intent = await read_intent(gdd_store, game_id) if gdd_store is not None else GddIntent()
    base = bind(intent)  # no overrides -> the defaults the human nudges away from
    plan = {role: {"x": pr.x, "y": pr.y, "region_w": pr.region_w,
                   "region_h": pr.region_h, "anchor_x": pr.anchor_x,
                   "anchor_y": pr.anchor_y}
            for role, pr in base.roles.items()}
    store = getattr(app_state, "region_override_store", None)
    ovr = await store.get(game_id) if store is not None else {}
    overrides = {role: o.as_set_fields() for role, o in ovr.items()}
    return {"canvas": list(base.canvas), "plan": plan, "overrides": overrides}
