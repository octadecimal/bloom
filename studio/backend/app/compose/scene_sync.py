"""Derive Game Scene module declarations from a composed definition.

Server-side twin of runtime/client/src/play/playMode.ts buildComposedPlayDocument:
the presentation manifest is the visual source of truth for the reels grid when
it is well-formed; otherwise geometry falls back to the reels@1 mechanic config.
Unknown mechanic types are skipped — the scene renders what it knows."""

DEFAULT_CANVAS = (1080, 1920)


def _reels_config(mechanic_config: dict, presentation: dict | None) -> dict:
    p = presentation or {}
    cols, rows, symbols = p.get("cols"), p.get("rows"), p.get("symbols")
    if (isinstance(cols, int) and isinstance(rows, int)
            and isinstance(symbols, list) and symbols
            and all(isinstance(s, str) for s in symbols)):
        return {"cols": cols, "rows": rows, "symbols": symbols, "parentId": "root"}
    strips = mechanic_config.get("strips") or []
    syms = [str(s.get("id")) for s in (mechanic_config.get("symbols") or [])]
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
