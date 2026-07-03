from app.scene.layout.template import (
    TEMPLATE_VERSION, RoleRegion, canvas_for, template_for,
    BACKGROUND, REELS, LOGO, SPIN, FLOURISH_LEFT, FLOURISH_RIGHT,
    METER_LEFT, METER_RIGHT, MULTIPLIER,
)


def _left(r):
    return r.cx - r.w * r.anchor_x


def _right(r):
    return r.cx + r.w * (1 - r.anchor_x)


def test_template_version_is_pinned_int():
    assert isinstance(TEMPLATE_VERSION, int) and TEMPLATE_VERSION >= 1


def test_canvas_orientation():
    assert canvas_for("landscape") == (1280, 720)
    assert canvas_for("portrait") == (720, 1280)
    assert canvas_for("anything-else") == (1280, 720)  # default landscape


def test_landscape_template_has_all_roles():
    t = template_for("landscape")
    assert set(t) == {BACKGROUND, REELS, LOGO, SPIN, FLOURISH_LEFT, FLOURISH_RIGHT,
                      METER_LEFT, METER_RIGHT, MULTIPLIER}


def test_meters_flank_the_logo_horizontally_clear_of_it():
    t = template_for("landscape")
    logo = t[LOGO]
    ml, mr = t[METER_LEFT], t[METER_RIGHT]
    # left meter sits entirely left of the logo box; right meter entirely right of it
    assert _right(ml) <= _left(logo) + 1e-9
    assert _left(mr) >= _right(logo) - 1e-9
    # both live in the top band (above the reels), matching the logo band
    assert ml.cy < t[REELS].cy and mr.cy < t[REELS].cy
    assert abs(ml.cy - logo.cy) < 0.12 and abs(mr.cy - logo.cy) < 0.12


def test_multiplier_is_on_the_left_beside_the_reels():
    t = template_for("landscape")
    mult, reels = t[MULTIPLIER], t[REELS]
    # multiplier sits left of the reels box, vertically around the reels
    assert _right(mult) <= _left(reels) + 1e-9
    assert abs(mult.cy - reels.cy) < 0.25


def test_background_is_full_bleed_cover_at_back():
    bg = template_for("landscape")[BACKGROUND]
    assert (bg.cx, bg.cy, bg.w, bg.h) == (0.5, 0.5, 1.0, 1.0)
    assert bg.fit == "cover" and bg.z == 0


def test_reels_are_centered_and_focal_above_logo_below_spin():
    t = template_for("landscape")
    assert t[REELS].cx == 0.5                 # horizontally centered
    assert t[LOGO].cy < t[REELS].cy < t[SPIN].cy   # logo top, reels mid, spin bottom
    assert t[REELS].z < t[SPIN].z             # spin draws above reels


def test_regions_stay_within_unit_square():
    for orient in ("landscape", "portrait"):
        for r in template_for(orient).values():
            assert 0.0 <= r.cx <= 1.0 and 0.0 <= r.cy <= 1.0
            assert 0.0 < r.w <= 1.0 and 0.0 < r.h <= 1.0
