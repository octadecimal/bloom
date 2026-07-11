"""Derive Game Scene module declarations from a composed definition.

Server-side twin of runtime/client/src/play/playMode.ts buildComposedPlayDocument:
the presentation manifest is the visual source of truth for the reels grid when
it is well-formed; otherwise geometry falls back to the reels@1 mechanic config.
Unknown mechanic types are skipped — the scene renders what it knows."""
import logging

logger = logging.getLogger(__name__)

DEFAULT_CANVAS = (1080, 1920)


def _reels_config(mechanic_config: dict, presentation: dict | None) -> dict:
    p = presentation or {}
    cols, rows, symbols = p.get("cols"), p.get("rows"), p.get("symbols")
    if (isinstance(cols, int) and isinstance(rows, int)
            and isinstance(symbols, list) and symbols
            and all(isinstance(s, str) for s in symbols)):
        return {"cols": cols, "rows": rows, "symbols": symbols, "parentId": "root"}
    strips = mechanic_config.get("strips") or []
    # symbols entries can be malformed via the JSON escape hatch — skip non-dicts
    # so one bad mechanic can't blow up the whole scene sync (→ save lockout).
    syms = [str(s.get("id")) for s in (mechanic_config.get("symbols") or []) if isinstance(s, dict)]
    return {
        "cols": len(strips) or 5,
        "rows": int(mechanic_config.get("rows") or 3),
        "symbols": syms or [str(i) for i in range(5)],
        "parentId": "root",
    }


def derive_scene_modules(definition: dict | None, presentation: dict | None) -> list[dict]:
    modules: list[dict] = []
    for m in (definition or {}).get("mechanics") or []:
        mid, mtype = m.get("id"), m.get("type")
        cfg = m.get("config") or {}
        if not mid or not mtype:
            continue
        if mtype == "reels@1":
            modules.append({"id": mid, "type": "reels", "config": _reels_config(cfg, presentation)})
        elif mtype == "meter@1":
            target = cfg.get("target")
            if isinstance(target, (int, float)) and not isinstance(target, bool):
                modules.append({"id": mid, "type": "meter", "config": {"target": target}})
    return modules


async def sync_scene_modules(scene_hub, game_id: str, definition: dict | None,
                             presentation: dict | None) -> None:
    modules = derive_scene_modules(definition, presentation)
    await scene_hub.ensure_root(game_id, DEFAULT_CANVAS)
    await scene_hub.set_modules(game_id, modules)


async def apply_definition_change(sio, scene_hub, auto_builder, doc, source: str) -> None:
    """Single reaction to a definition/presentation write: notify open panes,
    sync the scene, and schedule the auto-build. Scene-sync failures are isolated
    so a malformed mechanic can never lock out saves or drop the build."""
    await sio.emit(
        "game_definition_changed",
        {"gameId": doc.game_id, "updatedAt": doc.updated_at, "source": source},
        room=doc.game_id,
    )
    try:
        await sync_scene_modules(scene_hub, doc.game_id, doc.definition, doc.presentation)
    except Exception:  # never let a bad scene sync abort the build or the REST write
        logger.exception("scene sync failed for %s", doc.game_id)
    auto_builder.schedule(doc.game_id, doc.definition, doc.presentation)
