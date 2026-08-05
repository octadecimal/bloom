from PIL import Image

from matte_bench.postops import (
    apply_postops, despeckle, grow_alpha, hole_fill, threshold_alpha,
)


def _blank(w=40, h=40):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


def _fill(img, box, rgba):
    x0, y0, x1, y1 = box
    for x in range(x0, x1):
        for y in range(y0, y1):
            img.putpixel((x, y), rgba)


def test_threshold_alpha_is_binary():
    img = _blank(4, 1)
    for x, a in enumerate((0, 100, 200, 255)):
        img.putpixel((x, 0), (9, 9, 9, a))
    out = threshold_alpha(img, 128)
    assert [out.getpixel((x, 0))[3] for x in range(4)] == [0, 0, 255, 255]


def test_despeckle_removes_small_island_keeps_body():
    """The stray matting fleck that misaligned a real reel cut."""
    img = _blank()
    _fill(img, (5, 5, 35, 35), (200, 160, 40, 255))   # body: 900 px
    _fill(img, (0, 0, 2, 2), (200, 160, 40, 255))     # fleck: 4 px
    out = despeckle(img, min_area_frac=0.01)          # 16 px threshold
    assert out.getpixel((20, 20))[3] == 255
    assert out.getpixel((0, 0))[3] == 0


def test_despeckle_keeps_everything_when_threshold_is_tiny():
    img = _blank()
    _fill(img, (0, 0, 2, 2), (200, 160, 40, 255))
    out = despeckle(img, min_area_frac=0.0)
    assert out.getpixel((0, 0))[3] == 255


def test_hole_fill_closes_enclosed_gap_only():
    img = _blank()
    _fill(img, (5, 5, 35, 35), (200, 160, 40, 255))
    _fill(img, (18, 18, 22, 22), (0, 0, 0, 0))        # enclosed hole, 16 px
    out = hole_fill(img, max_area_frac=0.05)          # 80 px threshold
    assert out.getpixel((20, 20))[3] == 255           # hole closed
    assert out.getpixel((1, 1))[3] == 0               # outside untouched


def test_grow_alpha_erodes_with_negative_px():
    img = _blank()
    _fill(img, (10, 10, 30, 30), (200, 160, 40, 255))
    out = grow_alpha(img, -1)
    assert out.getpixel((10, 20))[3] == 0             # edge eaten
    assert out.getpixel((20, 20))[3] == 255           # centre intact


def test_apply_postops_runs_in_order():
    img = _blank()
    _fill(img, (0, 0, 2, 2), (200, 160, 40, 255))
    _fill(img, (5, 5, 35, 35), (200, 160, 40, 255))
    out = apply_postops(img, (("despeckle", 0.01),))
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((20, 20))[3] == 255


def test_apply_postops_empty_is_identity():
    img = _blank()
    _fill(img, (5, 5, 10, 10), (1, 2, 3, 255))
    assert apply_postops(img, ()).getpixel((6, 6)) == (1, 2, 3, 255)
