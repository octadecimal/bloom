"""Rebind scene Textures to an asset's selected generation.

Single source of truth for propagating an asset's currently-selected
generation into every scene Sprite bound to that asset. The board paths
(REST variant-select, socket regenerate) and the agent regenerate path all
funnel through ``rebind_asset_textures`` so exactly one mechanism rewrites a
bound Texture's ``src``.
"""


def selected_image_ref(asset) -> str | None:
    """image_ref of the asset's selected generation, or None."""
    sel = getattr(asset, "selected_generation_id", None)
    if not sel:
        return None
    for g in getattr(asset, "generations", []) or []:
        if getattr(g, "id", None) == sel:
            return getattr(g, "image_ref", None)
    return None


def bound_texture_ids(document: dict | None, *, asset_id: str, slot: str | None = None) -> list[str]:
    """Texture node ids bound to ``asset_id``.

    Primary: Textures carrying ``props.assetId == asset_id`` (written at
    placement). Fallback for scenes placed before assetId existed: the
    id-convention ``tex.{slot}`` / ``tex.{asset_id}``.
    """
    nodes = (document or {}).get("nodes", {}) or {}
    explicit = [
        nid for nid, n in nodes.items()
        if n.get("type") == "Texture" and (n.get("props") or {}).get("assetId") == asset_id
    ]
    if explicit:
        return explicit
    legacy: list[str] = []
    for handle in (slot, asset_id):
        if handle:
            tid = f"tex.{handle}"
            n = nodes.get(tid)
            if n is not None and n.get("type") == "Texture":
                legacy.append(tid)
    return legacy


async def rebind_asset_textures(scene_store, scene_hub, game_id: str, asset) -> list[str]:
    """Rewrite every bound Texture's src to the asset's selected generation.

    Returns the rewritten texture ids (empty when the asset has no selected
    image or no bound Texture — both no-ops, scene untouched).
    """
    src = selected_image_ref(asset)
    if not src:
        return []
    document = await scene_store.get_document(game_id)
    ids = bound_texture_ids(
        document, asset_id=getattr(asset, "id", ""), slot=getattr(asset, "slot", None)
    )
    for tid in ids:
        await scene_hub.apply_op(
            game_id, {"kind": "setProp", "id": tid, "path": "src", "value": src}
        )
    return ids
