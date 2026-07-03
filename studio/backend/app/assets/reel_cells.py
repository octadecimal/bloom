"""Geometric reel-cell cutter — punch the transparent play windows into a
generated reel frame.

Background removal (BiRefNetRMBG) only clears the OUTER background; a reel
frame's interior cells are enclosed, so they stay opaque. This cuts the play
windows geometrically from the frame's opaque bounding box — theme-agnostic (no
colour detection) and size-flexible (fractions of the actual frame) — so the
reels show through the cells while the ornate frame/posts/dividers stay solid.
Applied in the hub for the ``reels`` role (gated by ``GenParams.cut_cells``).
"""
from io import BytesIO

from PIL import Image

_ALPHA_VISIBLE = 16       # alpha above this counts as "visible"
MIN_FRAME_COVERAGE = 0.06  # if cutting leaves less than this opaque, it wasn't a frame


def cut_reel_cells(png_bytes: bytes, *, columns: int = 5,
                   border_x: float = 0.10, border_y: float = 0.14,
                   divider: float = 0.02) -> bytes:
    """Return the PNG with ``columns`` transparent column windows cut into the
    interior play area. No-op if the image has no opaque content, or if cutting
    would empty it (a non-framed asset whose content is the interior, not a
    border — e.g. a symbol — must not be mangled)."""
    img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    bbox = img.getchannel("A").getbbox()  # opaque frame extent
    if bbox is None:
        return png_bytes
    x0, y0, x1, y1 = bbox
    fw, fh = x1 - x0, y1 - y0
    bx, by = int(fw * border_x), int(fh * border_y)
    div = max(1, int(fw * divider))
    play_x0, play_y0 = x0 + bx, y0 + by
    play_x1, play_y1 = x1 - bx, y1 - by
    play_w, play_h = play_x1 - play_x0, play_y1 - play_y0
    if play_w <= 0 or play_h <= 0:
        return png_bytes
    col_w = (play_w - div * (columns - 1)) / columns
    if col_w <= 0:
        return png_bytes
    px = img.load()
    for c in range(columns):
        cx0 = int(round(play_x0 + c * (col_w + div)))
        cx1 = int(round(cx0 + col_w))
        for x in range(max(0, cx0), min(img.width, cx1)):
            for y in range(max(0, play_y0), min(img.height, play_y1)):
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    # Guard: a real reel frame's border + posts survive the cut; if almost nothing
    # opaque remains, the asset was not a framed asset — leave it untouched.
    visible = sum(img.getchannel("A").histogram()[_ALPHA_VISIBLE + 1:])
    if visible / (img.width * img.height) < MIN_FRAME_COVERAGE:
        return png_bytes
    out = BytesIO()
    img.save(out, "PNG")
    return out.getvalue()
