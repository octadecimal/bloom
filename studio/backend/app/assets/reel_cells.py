"""Geometric reel-cell cutter — punch the transparent play windows into a
generated reel frame.

Background removal (BiRefNetRMBG) only clears the OUTER background; a reel
frame's interior cells are enclosed, so they stay opaque. This cuts the play
windows geometrically so the reels show through the cells while the ornate
frame/posts/dividers stay solid. Applied in the hub for the ``reels`` role
(gated by ``GenParams.cut_cells``).

The frame extent is the largest connected opaque component, NOT the raw alpha
bbox: matting routinely leaves a fleck of background outside the frame, and
letting that fleck extend the bbox slid every column sideways and left the
last bay misaligned over a sliver of uncut glass.

KNOWN LIMITS — both need a content-aware cut to fix, and neither is solvable
by choosing better rectangle bounds:

* The rail insets are still fixed fractions. They cannot be derived from
  alpha, because the enclosed interior is opaque too (that is the whole
  reason this module exists), so every row and column is alpha-dense and the
  signal separating rail from glass is COLOUR, not coverage. A cornice
  thicker than ``border_y`` is chewed through.
* Ornament that sits *inside* the play rectangle — the arch curves of an
  arcade-style frame, say — is inside the window it decorates, so a
  rectangular cut clears it along with the glass.
"""
from io import BytesIO

from PIL import Image

_ALPHA_VISIBLE = 16       # alpha above this counts as "visible"
MIN_FRAME_COVERAGE = 0.06  # if cutting leaves less than this opaque, it wasn't a frame


def _largest_opaque_bbox(mask: bytearray, w: int, h: int) -> tuple[int, int, int, int] | None:
    """Bounding box of the largest 4-connected run of visible pixels.

    O(pixels), with an explicit stack — no recursion (a full-frame component
    would blow the interpreter's stack) and no per-pixel tuple allocation.
    """
    seen = bytearray(w * h)
    best: tuple[int, int, int, int] | None = None
    best_area = 0
    for start in range(w * h):
        if not mask[start] or seen[start]:
            continue
        seen[start] = 1
        stack = [start]
        area = 0
        x0 = x1 = start % w
        y0 = y1 = start // w
        while stack:
            i = stack.pop()
            y, x = divmod(i, w)
            area += 1
            if x < x0:
                x0 = x
            if x > x1:
                x1 = x
            if y < y0:
                y0 = y
            if y > y1:
                y1 = y
            if x > 0:
                j = i - 1
                if mask[j] and not seen[j]:
                    seen[j] = 1
                    stack.append(j)
            if x < w - 1:
                j = i + 1
                if mask[j] and not seen[j]:
                    seen[j] = 1
                    stack.append(j)
            if y > 0:
                j = i - w
                if mask[j] and not seen[j]:
                    seen[j] = 1
                    stack.append(j)
            if y < h - 1:
                j = i + w
                if mask[j] and not seen[j]:
                    seen[j] = 1
                    stack.append(j)
        if area > best_area:
            best_area = area
            best = (x0, y0, x1 + 1, y1 + 1)
    return best


def cut_reel_cells(png_bytes: bytes, *, columns: int = 5,
                   border_x: float = 0.10, border_y: float = 0.14,
                   divider: float = 0.02) -> bytes:
    """Return the PNG with ``columns`` transparent column windows cut into the
    interior play area, inset by ``border_x``/``border_y`` of the frame's own
    extent. No-op if the image has no opaque content, or if cutting would empty
    it (a non-framed asset whose content is the interior, not a border — e.g. a
    symbol — must not be mangled)."""
    img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    w, h = img.size
    mask = bytearray(1 if v > _ALPHA_VISIBLE else 0 for v in img.getchannel("A").tobytes())
    bbox = _largest_opaque_bbox(mask, w, h)
    if bbox is None:
        return png_bytes
    x0, y0, x1, y1 = bbox
    fw, fh = x1 - x0, y1 - y0
    if fw <= 0 or fh <= 0:
        return png_bytes

    bx, by = int(fw * border_x), int(fh * border_y)
    play_x0, play_y0 = x0 + bx, y0 + by
    play_x1, play_y1 = x1 - bx, y1 - by
    play_w, play_h = play_x1 - play_x0, play_y1 - play_y0
    if play_w <= 0 or play_h <= 0:
        return png_bytes
    div = max(1, int(fw * divider))
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
