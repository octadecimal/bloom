from PIL import Image

from matte_bench.keying import region_key, sample_key_color

BACKDROP = (15, 38, 38)          # what flux actually paints for "chroma green"
BRIGHT = (84, 210, 98)           # what flux paints when the clause DOES win
SUBJECT = (200, 160, 40)
KW = dict(seed_tolerance=60, step_tolerance=12, envelope=180,
          hole_tolerance=25, softness=30, despill=True)


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
    img = _bordered(BACKDROP, SUBJECT)
    assert sample_key_color(img) == BACKDROP


def test_sample_key_color_is_median_robust_to_border_speck():
    img = _bordered(BACKDROP, SUBJECT)
    img.putpixel((0, 0), (255, 255, 255))   # one stray highlight on the border
    assert sample_key_color(img) == BACKDROP


def test_flat_backdrop_fully_keyed():
    out = region_key(_flat(BACKDROP), BACKDROP, **KW)
    assert out.mode == "RGBA"
    assert all(a == 0 for a in out.getchannel("A").getdata())


def test_gradient_backdrop_fully_keyed():
    """The halo case: the backdrop drifts far from the border median, but it
    drifts SMOOTHLY — the region grow must follow it (up to the envelope; this
    ramp tops out at drift ~156 < 180). A global key at any sane tolerance
    keeps the far end of this ramp."""
    img = Image.new("RGB", (64, 8))
    for x in range(64):
        v = round(x * 90 / 63)               # 0 → 90 per channel, drift ≤ ~156
        for y in range(8):
            img.putpixel((x, y), (15 + v, 38 + v, 38 + v))
    out = region_key(img, sample_key_color(img), **KW)
    assert all(a == 0 for a in out.getchannel("A").getdata())


def test_shadow_bridge_cannot_erase_subject():
    """Root cause of the 2026-08-06 crisp-text erasure: a soft drop shadow is
    a SMOOTH ramp from bright backdrop to near-black, so unbounded
    step-chaining walked the grow across it and erased solid black letters
    (measured drift 246 from the key). The envelope caps the walk: nothing
    farther than `envelope` from the key color is ever grow-keyed, and the
    anchor ramp must not finish the job either."""
    img = Image.new("RGB", (80, 8), BRIGHT)
    for i, x in enumerate(range(20, 60)):        # 40-column smooth ramp to black
        f = (i + 1) / 40
        c = (round(84 * (1 - f)), round(210 * (1 - f)), round(98 * (1 - f)))
        for y in range(2, 6):
            img.putpixel((x, y), c)
    for x in range(60, 72):                      # the 'letter': solid black
        for y in range(2, 6):
            img.putpixel((x, y), (0, 0, 0))
    out = region_key(img, sample_key_color(img), **KW)
    for x in range(60, 72):
        for y in range(2, 6):
            assert out.getpixel((x, y))[3] == 255, (x, y)


def test_sharp_subject_stays_opaque():
    out = region_key(_bordered(BACKDROP, SUBJECT), BACKDROP, **KW)
    assert out.getpixel((16, 16))[3] == 255
    assert out.getpixel((0, 0))[3] == 0


def test_disconnected_near_key_region_survives():
    """The erosion case: a patch INSIDE the subject whose color is fairly
    close to the backdrop (dist ~64 — the old global key at 60+60 ate it).
    It is not border-connected and not within the strict hole ramp, so it
    must survive."""
    img = _bordered(BACKDROP, SUBJECT)
    for x in range(12, 20):
        for y in range(12, 20):
            img.putpixel((x, y), (45, 78, 78))     # dist from BACKDROP ≈ 64
    out = region_key(img, BACKDROP, **KW)
    assert out.getpixel((16, 16))[3] == 255


def test_enclosed_hole_matching_backdrop_is_keyed():
    """The enclosed-holes case: a hole showing actual backdrop color inside
    the subject must still clear, even though the grow can't reach it."""
    img = _bordered(BACKDROP, SUBJECT)
    for x in range(14, 18):
        for y in range(14, 18):
            img.putpixel((x, y), BACKDROP)
    out = region_key(img, BACKDROP, **KW)
    assert out.getpixel((16, 16))[3] == 0
    assert out.getpixel((10, 10))[3] == 255        # subject ring intact


def test_soft_edge_ramp():
    """A pixel between hole_tolerance and hole_tolerance+softness of its
    nearest keyed anchor gets partial alpha — the fur/wisp edge quality."""
    img = _bordered(BACKDROP, SUBJECT)
    img.putpixel((16, 16), (15 + 23, 38 + 23, 38 + 23))   # dist ≈ 40 from BACKDROP
    out = region_key(img, BACKDROP, **KW)
    a = out.getpixel((16, 16))[3]
    assert 100 <= a <= 155      # ramp midpoint ≈ 255*(40-25)/30 ≈ 128


def test_despill_clamps_key_dominant_channel():
    green = (0, 177, 64)
    img = _bordered(green, (80, 200, 90))
    out = region_key(img, green, **KW)
    r, g, b, a = out.getpixel((16, 16))
    if a > 0:
        assert g <= max(r, b)


def test_despill_off_preserves_color():
    img = _bordered(BACKDROP, SUBJECT)
    out = region_key(img, BACKDROP, **{**KW, "despill": False})
    assert out.getpixel((16, 16))[:3] == SUBJECT


def test_no_backdrop_found_keeps_everything():
    """If no border pixel matches the key (degenerate render), nothing is
    keyed rather than everything."""
    out = region_key(_flat(SUBJECT), BACKDROP, **KW)
    assert all(a == 255 for a in out.getchannel("A").getdata())


def test_input_not_mutated():
    src = _flat(BACKDROP)
    region_key(src, BACKDROP, **KW)
    assert src.getpixel((0, 0)) == BACKDROP


def test_deterministic():
    img = _bordered(BACKDROP, SUBJECT)
    a = region_key(img, BACKDROP, **KW).tobytes()
    b = region_key(img, BACKDROP, **KW).tobytes()
    assert a == b
