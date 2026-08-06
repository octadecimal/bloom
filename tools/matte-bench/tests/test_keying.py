from PIL import Image

from matte_bench.keying import chroma_key, sample_key_color

GREEN = (0, 177, 64)


def _flat(color, size=(8, 8)):
    return Image.new("RGB", size, color)


def _bordered(border_color, center_color, size=(32, 32)):
    img = Image.new("RGB", size, border_color)
    for x in range(8, 24):
        for y in range(8, 24):
            img.putpixel((x, y), center_color)
    return img


def test_sample_key_color_reads_border_not_subject():
    """Flux never paints the literal hex we ask for (a chroma-green clause
    comes back as a dark desaturated wall), so the key must be measured from
    the render's own border, where only backdrop pixels live."""
    img = _bordered((15, 38, 38), (200, 160, 40))
    assert sample_key_color(img) == (15, 38, 38)


def test_sample_key_color_is_median_robust_to_border_speck():
    img = _bordered((15, 38, 38), (200, 160, 40))
    img.putpixel((0, 0), (255, 255, 255))   # one stray highlight on the border
    assert sample_key_color(img) == (15, 38, 38)


def test_key_color_becomes_fully_transparent():
    out = chroma_key(_flat(GREEN), GREEN, tolerance=60, softness=60)
    assert out.mode == "RGBA"
    assert all(a == 0 for a in out.getchannel("A").getdata())


def test_distant_color_stays_opaque():
    out = chroma_key(_flat((200, 40, 180)), GREEN, tolerance=60, softness=60)
    assert all(a == 255 for a in out.getchannel("A").getdata())


def test_ramp_between_tolerance_and_softness():
    # distance from GREEN is 90: past tolerance 60, half-way through softness 60
    near = (0, 177, 64 + 90)
    out = chroma_key(_flat(near), GREEN, tolerance=60, softness=60)
    a = out.getchannel("A").getdata()[0]
    assert 100 <= a <= 155      # ~50% with rounding slack


def test_despill_clamps_key_dominant_channel():
    # a green-spilled edge pixel: green well above red/blue
    out = chroma_key(_flat((80, 200, 90)), GREEN, tolerance=10, softness=10,
                     despill=True)
    r, g, b, a = out.getpixel((0, 0))
    assert g <= max(r, b)


def test_despill_off_preserves_color():
    out = chroma_key(_flat((80, 200, 90)), GREEN, tolerance=10, softness=10,
                     despill=False)
    assert out.getpixel((0, 0))[:3] == (80, 200, 90)


def test_input_not_mutated():
    src = _flat(GREEN)
    chroma_key(src, GREEN, tolerance=60, softness=60)
    assert src.getpixel((0, 0)) == GREEN
