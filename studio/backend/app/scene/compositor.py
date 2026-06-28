"""Backend scene compositor — renders the canonical scene document to a PNG.

Replaces the live-engine frame capture as the source of the composition-critic's
image (see docs/superpowers/specs/2026-06-28-compose-critique-rework-design.md).
Pure: given the document + each texture's image bytes it composites a frame with
Pillow, matching the engine's layout math (anchor-positioned, scaled, z-ordered).
It deliberately reproduces only the *layout* (not engine filters/blend/responsive
scaling) — the composition critic acts on layout, and the canonical document is
the source of truth.

Note: this compositor places all Sprite nodes flat under the canvas by absolute
``position`` with a global zIndex sort; it intentionally ignores Container
nesting and parent transforms, which is correct for the compose loop (all
elements are placed directly under root).
"""

from io import BytesIO
from pathlib import Path

from PIL import Image

# Match runtime/client/src/render/pixiRenderer.ts BACKGROUND_COLOR '#0b0b0c'.
BACKGROUND_RGBA = (11, 11, 12, 255)


def _texture_of(document: dict, sprite_id: str) -> str | None:
    """The Texture node id bound to a sprite's `texture` port, or None.

    Mirrors `app.agent_tools._texture_of` (kept local to avoid an import cycle
    into the agent-tools module).
    """
    for e in document.get("edges", []):
        to = e.get("to") or {}
        if (e.get("type") == "data" and to.get("node") == sprite_id
                and to.get("port") == "texture"):
            return (e.get("from") or {}).get("node")
    return None


def collect_scene_images(document: dict, media_dir: str) -> dict[str, bytes]:
    """Read each bound texture's file from `media_dir`, keyed by texture-id.

    A texture whose `src` file is missing/unreadable is skipped (the compositor
    then renders the scene without it).
    """
    root = Path(media_dir)
    out: dict[str, bytes] = {}
    for nid, n in (document.get("nodes") or {}).items():
        if n.get("type") != "Texture":
            continue
        src = (n.get("props") or {}).get("src")
        if not src or not src.startswith("/media/"):
            continue
        path = root / src[len("/media/"):]
        try:
            out[nid] = path.read_bytes()
        except OSError:
            continue
    return out


def sprite_box(
    props: dict, sprite_size: tuple[int, int], canvas: tuple[int, int]
) -> tuple[int, int, int, int]:
    """(left, top, width, height) of a sprite in canvas pixels — the single source
    of box math for both the compositor and the keep-in-frame guard."""
    sw, sh = sprite_size
    cw, ch = canvas
    scale = props.get("scale") or {}
    sx = float(scale.get("x", 1.0))
    sy = float(scale.get("y", 1.0))
    rw = max(1, round(sw * sx))
    rh = max(1, round(sh * sy))
    anchor = props.get("anchor") or {}
    ax = float(anchor.get("x", 0.5))
    ay = float(anchor.get("y", 0.5))
    pos = props.get("position") or {}
    px = float(pos.get("x", cw / 2))
    py = float(pos.get("y", ch / 2))
    return (round(px - ax * rw), round(py - ay * rh), rw, rh)


def composite_scene(
    document: dict,
    images: dict[str, bytes],
    *,
    background: tuple[int, int, int, int] = BACKGROUND_RGBA,
) -> bytes:
    """Composite the canonical scene to PNG bytes.

    `images` maps texture-id -> PNG bytes. A sprite whose texture is unbound or
    absent from `images` is skipped. Sprites paint in ascending zIndex; each is
    scaled by its `scale` and positioned so its `anchor` point lands at
    `position`.
    """
    nodes = document.get("nodes") or {}
    root = next((n for n in nodes.values() if n.get("type") == "Root"), None)
    rp = (root or {}).get("props") or {}
    cw = int(rp.get("width", 1280) or 1280)
    ch = int(rp.get("height", 720) or 720)
    canvas = Image.new("RGBA", (cw, ch), background)

    sprites = [(nid, n) for nid, n in nodes.items() if n.get("type") == "Sprite"]
    sprites.sort(key=lambda it: float((it[1].get("props") or {}).get("zIndex", 0) or 0))

    for nid, n in sprites:
        tex_id = _texture_of(document, nid)
        if tex_id is None or tex_id not in images:
            continue
        try:
            sprite = Image.open(BytesIO(images[tex_id])).convert("RGBA")
        except Exception:
            continue
        props = n.get("props") or {}
        tlx, tly, rw, rh = sprite_box(props, (sprite.width, sprite.height), (cw, ch))
        if (rw, rh) != (sprite.width, sprite.height):
            sprite = sprite.resize((rw, rh))
        # Paste onto a full-canvas transparent layer (clips off-canvas regions),
        # then alpha-composite so partial transparency blends correctly.
        layer = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        layer.paste(sprite, (tlx, tly))
        canvas = Image.alpha_composite(canvas, layer)

    out = BytesIO()
    canvas.save(out, format="PNG")
    return out.getvalue()
