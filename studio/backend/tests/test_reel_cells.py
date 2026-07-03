from io import BytesIO
from PIL import Image
from app.assets.reel_cells import cut_reel_cells


def _opaque_block(w=500, h=300):
    buf = BytesIO()
    Image.new("RGBA", (w, h), (200, 160, 40, 255)).save(buf, "PNG")
    return buf.getvalue()


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


def test_cut_reel_cells_guard_leaves_a_non_frame_asset_untouched():
    # a small centered blob (content IS the interior, no border) -> cutting would
    # empty it, so the guard returns the original bytes unchanged
    img = Image.new("RGBA", (500, 300), (0, 0, 0, 0))
    for x in range(210, 290):
        for y in range(120, 180):
            img.putpixel((x, y), (200, 160, 40, 255))
    buf = BytesIO(); img.save(buf, "PNG"); data = buf.getvalue()
    assert cut_reel_cells(data) == data
