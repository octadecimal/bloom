from io import BytesIO

import pytest
from PIL import Image

from app.assets.reel_cells import cut_reel_cells


GOLD = (200, 160, 40, 255)
CLEAR = (0, 0, 0, 0)


def _opaque_block(w=500, h=300):
    buf = BytesIO()
    Image.new("RGBA", (w, h), GOLD).save(buf, "PNG")
    return buf.getvalue()


def _to_png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _framed(w=500, h=300, *, top=40, bottom=30, side=25, margin=20, speck=None) -> Image.Image:
    """A reel frame inset by `margin`, with solid rails and a glass interior.

    The margin matters: it leaves clear space around the frame so a stray
    matting speck lands OUTSIDE it and genuinely extends the alpha bbox —
    which is the failure being reproduced. `top`/`bottom` are rail thicknesses
    measured from the frame's own edge, so the true play area is what the
    cutter has to discover.
    """
    img = Image.new("RGBA", (w, h), CLEAR)
    fx0, fy0, fx1, fy1 = margin, margin, w - margin, h - margin
    for x in range(fx0, fx1):
        for y in range(fy0, fy1):
            inner = (fx0 + side <= x < fx1 - side) and (fy0 + top <= y < fy1 - bottom)
            img.putpixel((x, y), (120, 200, 180, 255) if inner else GOLD)
    if speck is not None:
        sx, sy = speck
        for x in range(sx, sx + 6):
            for y in range(sy, sy + 6):
                img.putpixel((x, y), GOLD)
    return img


def test_cut_reel_cells_punches_transparent_columns_keeps_border():
    res = Image.open(BytesIO(cut_reel_cells(_opaque_block(), columns=5))).convert("RGBA")
    a = res.getchannel("A")
    assert a.getpixel((250, 150)) == 0            # a cell center is now transparent
    assert a.getpixel((3, 150)) == 255            # left border stays opaque
    assert a.getpixel((250, 3)) == 255            # top border stays opaque
    row = [a.getpixel((x, 150)) for x in range(0, 500, 2)]
    assert 0 in row and 255 in row                # frame dividers + transparent cells alternate


def test_cut_reel_cells_creates_five_distinct_windows():
    res = Image.open(BytesIO(cut_reel_cells(_opaque_block(), columns=5))).convert("RGBA")
    a = res.getchannel("A")
    # count transparent runs along the mid row -> one per column window
    row = [a.getpixel((x, 150)) == 0 for x in range(res.width)]
    runs = sum(1 for i in range(1, len(row)) if row[i] and not row[i - 1]) + (1 if row[0] else 0)
    assert runs == 5


def test_cut_reel_cells_noop_on_fully_transparent():
    buf = BytesIO(); Image.new("RGBA", (100, 100), (0, 0, 0, 0)).save(buf, "PNG")
    data = buf.getvalue()
    assert cut_reel_cells(data) == data


@pytest.mark.xfail(
    strict=True,
    reason="Needs a content-aware cut. The rail inset cannot be derived from "
           "alpha: the enclosed interior is opaque too (the reason this module "
           "exists), so every row is alpha-dense and the only signal separating "
           "rail from glass is COLOUR. Tracked as a follow-up.",
)
def test_cut_respects_a_thick_top_rail_instead_of_a_fixed_fraction():
    """The cut must start BELOW the frame's real top rail.

    A fixed 14%-of-height inset chews through any cornice thicker than that —
    the bug that ate the arches off an ornate Victorian reel frame. Here the
    rail is 90px of 260 (35%), so the fixed inset deletes most of it.
    """
    img = _framed(top=90, bottom=30, margin=20)
    res = Image.open(BytesIO(cut_reel_cells(_to_png(img), columns=5))).convert("RGBA")
    a = res.getchannel("A")
    # the frame spans y in [20, 280); its top rail is y in [20, 110)
    for y in (22, 60, 95, 108):
        assert a.getpixel((250, y)) == 255, f"top rail eaten at y={y}"
    # the glass immediately under the rail is still cut
    assert a.getpixel((250, 130)) == 0
    # bottom rail (y in [250, 280)) survives
    assert a.getpixel((250, 265)) == 255


def test_cut_ignores_a_stray_matting_speck_when_placing_columns():
    """Column placement must come from the frame, not from matting leftovers.

    BiRefNet routinely leaves a fleck of background outside the frame. It
    extends the alpha bbox, which slid every column sideways and left the last
    bay misaligned with a sliver of uncut glass.
    """
    clean = _framed()
    specked = _framed(speck=(2, 2))  # stray fleck in the far corner, outside the frame
    a_clean = Image.open(BytesIO(cut_reel_cells(_to_png(clean), columns=5))).convert("RGBA").getchannel("A")
    a_speck = Image.open(BytesIO(cut_reel_cells(_to_png(specked), columns=5))).convert("RGBA").getchannel("A")
    mid = 150
    row_clean = [a_clean.getpixel((x, mid)) == 0 for x in range(clean.width)]
    row_speck = [a_speck.getpixel((x, mid)) == 0 for x in range(specked.width)]
    assert row_clean == row_speck, "a stray speck shifted the cut columns"


def test_cut_reel_cells_guard_leaves_a_non_frame_asset_untouched():
    # a small centered blob (content IS the interior, no border) -> cutting would
    # empty it, so the guard returns the original bytes unchanged
    img = Image.new("RGBA", (500, 300), (0, 0, 0, 0))
    for x in range(210, 290):
        for y in range(120, 180):
            img.putpixel((x, y), (200, 160, 40, 255))
    buf = BytesIO(); img.save(buf, "PNG"); data = buf.getvalue()
    assert cut_reel_cells(data) == data
