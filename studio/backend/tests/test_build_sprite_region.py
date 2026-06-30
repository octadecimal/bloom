from app.scene.compose import build_sprite_ops


def _sprite_scale(ops):
    spr = next(o for o in ops if o["type"] == "Sprite")
    return spr["props"]["scale"]["x"]


def test_region_fit_scales_texture_into_box():
    ops = build_sprite_ops(
        handle="reels", src="/m/x.png", canvas=(1280, 720),
        tex_size=(512, 512), fit="region", region=(794, 432),
    )
    assert _sprite_scale(ops) == 432 / 512   # height-limited contain into the box


def test_region_fit_without_region_falls_back_to_native():
    ops = build_sprite_ops(
        handle="x", src="/m/x.png", canvas=(1280, 720),
        tex_size=(512, 512), fit="region", region=None,
    )
    assert _sprite_scale(ops) == 1.0


def test_cover_still_fills_canvas():
    ops = build_sprite_ops(
        handle="bg", src="/m/b.png", canvas=(1280, 720),
        tex_size=(640, 360), fit="cover",
    )
    assert _sprite_scale(ops) == 2.0   # max(1280/640, 720/360)
