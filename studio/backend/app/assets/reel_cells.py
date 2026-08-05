"""Reel-cell cutter — punch the transparent play windows into a generated reel
frame.

Background removal (BiRefNetRMBG) only clears the OUTER background; a reel
frame's interior cells are enclosed, so they stay opaque. This clears the play
windows so the reels show through while the ornate frame/posts/dividers stay
solid. Applied in the hub for the ``reels`` role (gated by
``GenParams.cut_cells``).

The cut is CONTENT-AWARE, because a rectangular cut cannot work. Ornament that
sits inside a window — the arch curves of an arcade-style frame, the tracery of
a Victorian glasshouse — is inside the rectangle that bounds the glass, so any
rectangle clearing the glass also erases the ornament. That really happened: an
arcade frame came back with all five arches deleted and its cornice chewed.

So instead:

1. The frame extent is the largest connected opaque component, NOT the raw
   alpha bbox — matting routinely leaves a fleck of background outside the
   frame, and letting that fleck extend the bbox slid every seed sideways.
2. Glass and frame are separated on the warm-cool axis (``r - b``) with an
   Otsu split, so the threshold is FOUND rather than assumed. Which side is
   glass is decided by which class the play-area seeds fall into, so a silver
   frame around warm glass works by the same code.
3. Only LARGE connected glass regions are cleared. Cool-toned detail *within*
   the ornament (emerald inlays on a gilt column) is small and survives.

Rectangles remain as a FALLBACK for images where the split is untrustworthy —
a flat single-colour asset has no glass/frame distinction to find — so a
degenerate input still behaves the way it always did.

Seeded region-growing was tried and rejected: comparing each candidate to the
pixel it grew from lets a chain of small steps walk from glass through a soft
edge into the frame, which ate the cornice, the columns and the crowns.
"""
from io import BytesIO

from PIL import Image

_ALPHA_VISIBLE = 16        # alpha above this counts as "visible"
MIN_FRAME_COVERAGE = 0.06  # if cutting leaves less than this opaque, it wasn't a frame
_MIN_GLASS_REGION = 0.005  # a glass region smaller than this (of the image) is detail, not a window
_MIN_CLASS_SHARE = 0.10    # each colour class must hold this share of the frame to trust the split
_MIN_CLASS_GAP = 25        # ...and their means must be at least this far apart on r-b
_MIN_CLEARED = 0.05        # if the content-aware pass clears less than this, fall back to rectangles


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
            if x > 0 and mask[i - 1] and not seen[i - 1]:
                seen[i - 1] = 1
                stack.append(i - 1)
            if x < w - 1 and mask[i + 1] and not seen[i + 1]:
                seen[i + 1] = 1
                stack.append(i + 1)
            if y > 0 and mask[i - w] and not seen[i - w]:
                seen[i - w] = 1
                stack.append(i - w)
            if y < h - 1 and mask[i + w] and not seen[i + w]:
                seen[i + w] = 1
                stack.append(i + w)
        if area > best_area:
            best_area = area
            best = (x0, y0, x1 + 1, y1 + 1)
    return best


def _otsu(hist: list[int]) -> int:
    """Maximum between-class variance split of a 1-D histogram.

    Returns the INCLUSIVE upper bound of the low class: the count at ``t`` is
    accumulated into the low class before the variance at ``t`` is measured, so
    the classes are ``[0..t]`` and ``[t+1..]``. Getting this boundary wrong is
    silent on smooth histograms and fatal on spiky ones — a two-colour test
    image put every pixel in one class and disabled the split entirely.
    """
    total = sum(hist)
    if total == 0:
        return 0
    sum_all = sum(i * v for i, v in enumerate(hist))
    wb = 0
    sum_b = 0
    best_var = -1.0
    split = 0
    for t, count in enumerate(hist):
        wb += count
        if wb == 0:
            continue
        wf = total - wb
        if wf == 0:
            break
        sum_b += t * count
        between = wb * wf * ((sum_b / wb) - ((sum_all - sum_b) / wf)) ** 2
        if between > best_var:
            best_var = between
            split = t
    return split


def _play_rect(bbox, border_x: float, border_y: float):
    x0, y0, x1, y1 = bbox
    fw, fh = x1 - x0, y1 - y0
    bx, by = int(fw * border_x), int(fh * border_y)
    return x0 + bx, y0 + by, x1 - bx, y1 - by


def _seed_points(bbox, columns: int, border_x: float, border_y: float,
                 divider: float, per_column: int = 9):
    """Sample points down the middle of each expected window.

    A seed only has to LAND in glass — it never defines the cut — so a coarse
    grid is enough, and being wrong about a few is absorbed by the vote.
    """
    px0, py0, px1, py1 = _play_rect(bbox, border_x, border_y)
    fw = bbox[2] - bbox[0]
    div = max(1, int(fw * divider))
    play_w = px1 - px0
    col_w = (play_w - div * (columns - 1)) / columns
    if col_w <= 0 or py1 <= py0:
        return []
    out = []
    for c in range(columns):
        cx = int(px0 + c * (col_w + div) + col_w / 2)
        for k in range(per_column):
            out.append((cx, int(py0 + (k + 0.5) * (py1 - py0) / per_column)))
    return out


def _glass_mask(raw: bytes, w: int, h: int, bbox, seeds) -> bytearray | None:
    """Per-pixel glass classification, or None when the split is untrustworthy.

    Splits opaque frame pixels on ``r - b`` with Otsu, then lets the seeds vote
    on which side is glass. Returns None if the two classes are lopsided or too
    close together — i.e. there is no real glass/frame distinction to find.
    """
    x0, y0, x1, y1 = bbox
    hist = [0] * 512
    for y in range(y0, y1):
        row = y * w
        for x in range(x0, x1):
            o = (row + x) * 4
            if raw[o + 3] > _ALPHA_VISIBLE:
                hist[(raw[o] - raw[o + 2]) + 255] += 1
    total = sum(hist)
    if total == 0:
        return None
    split = _otsu(hist)

    below = sum(hist[:split + 1])   # split is INCLUSIVE (see _otsu)
    above = total - below
    if min(below, above) < _MIN_CLASS_SHARE * total:
        return None  # effectively one population — nothing to separate
    mean_lo = sum(i * hist[i] for i in range(split + 1)) / below if below else 0
    mean_hi = sum(i * hist[i] for i in range(split + 1, 512)) / above if above else 0
    if (mean_hi - mean_lo) < _MIN_CLASS_GAP:
        return None  # two classes, but not meaningfully different

    cool = warm = 0
    for sx, sy in seeds:
        o = (sy * w + sx) * 4
        if raw[o + 3] <= _ALPHA_VISIBLE:
            continue
        if (raw[o] - raw[o + 2]) + 255 <= split:
            cool += 1
        else:
            warm += 1
    if cool == warm == 0:
        return None
    glass_is_cool = cool >= warm

    mask = bytearray(w * h)
    for i in range(w * h):
        o = i * 4
        if raw[o + 3] > _ALPHA_VISIBLE and \
                (((raw[o] - raw[o + 2]) + 255 <= split) == glass_is_cool):
            mask[i] = 1
    return mask


def _clear_large_regions(img: Image.Image, glass: bytearray, w: int, h: int) -> int:
    """Clear every connected glass region at or above ``_MIN_GLASS_REGION``.

    Small regions are ornament detail that merely shares the glass tone — an
    emerald inlay down a gilt column — and must survive.
    """
    seen = bytearray(w * h)
    px = img.load()
    min_px = _MIN_GLASS_REGION * w * h
    cleared = 0
    for start in range(w * h):
        if not glass[start] or seen[start]:
            continue
        seen[start] = 1
        stack = [start]
        members = []
        while stack:
            i = stack.pop()
            members.append(i)
            y, x = divmod(i, w)
            if x > 0 and glass[i - 1] and not seen[i - 1]:
                seen[i - 1] = 1
                stack.append(i - 1)
            if x < w - 1 and glass[i + 1] and not seen[i + 1]:
                seen[i + 1] = 1
                stack.append(i + 1)
            if y > 0 and glass[i - w] and not seen[i - w]:
                seen[i - w] = 1
                stack.append(i - w)
            if y < h - 1 and glass[i + w] and not seen[i + w]:
                seen[i + w] = 1
                stack.append(i + w)
        if len(members) < min_px:
            continue
        for i in members:
            y, x = divmod(i, w)
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 0)
        cleared += len(members)
    return cleared


def _rect_cut(img: Image.Image, bbox, columns: int, border_x: float,
              border_y: float, divider: float) -> bool:
    """The original rectangular cut, kept as the fallback. True if it cut."""
    x0, y0, x1, y1 = bbox
    fw = x1 - x0
    play_x0, play_y0, play_x1, play_y1 = _play_rect(bbox, border_x, border_y)
    play_w, play_h = play_x1 - play_x0, play_y1 - play_y0
    if play_w <= 0 or play_h <= 0:
        return False
    div = max(1, int(fw * divider))
    col_w = (play_w - div * (columns - 1)) / columns
    if col_w <= 0:
        return False
    px = img.load()
    for c in range(columns):
        cx0 = int(round(play_x0 + c * (col_w + div)))
        cx1 = int(round(cx0 + col_w))
        for x in range(max(0, cx0), min(img.width, cx1)):
            for y in range(max(0, play_y0), min(img.height, play_y1)):
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    return True


def cut_reel_cells(png_bytes: bytes, *, columns: int = 5,
                   border_x: float = 0.10, border_y: float = 0.14,
                   divider: float = 0.02) -> bytes:
    """Return the PNG with the interior play windows made transparent.

    ``columns``/``border_x``/``border_y``/``divider`` describe the expected
    window grid. They place the seeds for the content-aware pass, and drive the
    rectangular fallback when no glass/frame split can be found. No-op if the
    image has no opaque content, or if cutting would empty it (a non-framed
    asset whose content is the interior, not a border — e.g. a symbol — must
    not be mangled).
    """
    img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    w, h = img.size
    raw = img.tobytes()  # RGBA, 4 bytes per pixel
    mask = bytearray(1 if raw[i * 4 + 3] > _ALPHA_VISIBLE else 0 for i in range(w * h))
    bbox = _largest_opaque_bbox(mask, w, h)
    if bbox is None:
        return png_bytes

    seeds = _seed_points(bbox, columns, border_x, border_y, divider)
    glass = _glass_mask(raw, w, h, bbox, seeds) if seeds else None
    cut = False
    if glass is not None:
        cleared = _clear_large_regions(img, glass, w, h)
        cut = cleared >= _MIN_CLEARED * w * h
        if not cut:
            # Detected a split but it did not describe the windows; start over
            # from the untouched bytes so the fallback sees the original.
            img = Image.open(BytesIO(png_bytes)).convert("RGBA")
    if not cut and not _rect_cut(img, bbox, columns, border_x, border_y, divider):
        return png_bytes

    # Guard: a real reel frame's border + posts survive the cut; if almost nothing
    # opaque remains, the asset was not a framed asset — leave it untouched.
    visible = sum(img.getchannel("A").histogram()[_ALPHA_VISIBLE + 1:])
    if visible / (w * h) < MIN_FRAME_COVERAGE:
        return png_bytes
    out = BytesIO()
    img.save(out, "PNG")
    return out.getvalue()
