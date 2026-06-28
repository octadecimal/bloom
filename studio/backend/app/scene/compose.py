"""Pure op-builders that compose higher-level scene constructs from primitives.

Each builder returns an ordered list of scene ops (the same add/connect shapes
GraphModel validates) for ONE node type, hiding the Sprite+Texture+edges
bookkeeping from callers. ``build_sprite_ops`` is the first; ``build_text_ops`` /
``build_spine_ops`` are future siblings that follow the same pattern.
"""

DEFAULT_CANVAS: tuple[int, int] = (1280, 720)


def _scale_for_fit(fit: str, canvas: tuple[int, int], tex: tuple[int, int]) -> float:
    cw, ch = canvas
    tw, th = tex
    if not tw or not th:
        return 1.0
    if fit == "cover":
        return max(cw / tw, ch / th)
    if fit == "contain":
        return min(cw / tw, ch / th)
    return 1.0


def build_sprite_ops(
    *,
    handle: str,
    src: str,
    role: str = "",
    parent_id: str = "root",
    ensure_root: bool = False,
    canvas: tuple[int, int] = DEFAULT_CANVAS,
    tex_size: tuple[int, int] = (512, 512),
    x: float | None = None,
    y: float | None = None,
    anchor_x: float = 0.5,
    anchor_y: float = 0.5,
    fit: str = "none",
    z_index: int = 0,
    asset_id: str = "",
) -> list[dict]:
    """Ops to place an image asset as a Sprite bound to a Texture.

    ``handle`` is a stable, unique token (a slot or asset id) used to derive node
    and edge ids so re-runs and replay are deterministic. ``ensure_root`` prepends
    a Root (id 'root', canvas dims) when the scene has none yet. Position defaults
    to the canvas centre; omit ``x`` to centre horizontally.
    """
    cw, ch = canvas
    px = cw / 2 if x is None else x
    py = ch / 2 if y is None else y
    scale = _scale_for_fit(fit, canvas, tex_size)

    sprite_id = f"spr.{handle}"
    texture_id = f"tex.{handle}"
    sprite_props: dict = {
        "position": {"x": px, "y": py},
        "anchor": {"x": anchor_x, "y": anchor_y},
        "scale": {"x": scale, "y": scale},
        "zIndex": z_index,
    }
    if role:
        sprite_props["role"] = role

    ops: list[dict] = []
    if ensure_root:
        ops.append({"kind": "addNode", "id": "root", "type": "Root",
                    "props": {"width": cw, "height": ch}})
    ops.append({"kind": "addNode", "id": sprite_id, "type": "Sprite", "props": sprite_props})
    tex_props: dict = {"src": src}
    if asset_id:
        tex_props["assetId"] = asset_id
    ops.append({"kind": "addNode", "id": texture_id, "type": "Texture", "props": tex_props})
    ops.append({"kind": "connect", "edgeId": f"e.data.{handle}", "type": "data",
                "from": {"node": texture_id, "port": "data"},
                "to": {"node": sprite_id, "port": "texture"}})
    ops.append({"kind": "connect", "edgeId": f"e.child.{handle}", "type": "child",
                "from": {"node": parent_id, "port": "children"},
                "to": {"node": sprite_id, "port": "parent"}})
    return ops
