from io import BytesIO

from PIL import Image

from app.scene.compositor import collect_scene_images, composite_scene, sprite_box, _texture_of


def _png(w: int, h: int, color) -> bytes:
    buf = BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def _doc():
    # canvas 200x100; one opaque red bg (full), one 40x40 blue sprite centered at (150,50)
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 200, "height": 100}},
            "spr.bg": {"id": "spr.bg", "type": "Sprite", "props": {
                "position": {"x": 100, "y": 50}, "anchor": {"x": 0.5, "y": 0.5},
                "scale": {"x": 1.0, "y": 1.0}, "zIndex": 0}},
            "tex.bg": {"id": "tex.bg", "type": "Texture", "props": {"src": "/media/g/bg/1.png"}},
            "spr.logo": {"id": "spr.logo", "type": "Sprite", "props": {
                "position": {"x": 150, "y": 50}, "anchor": {"x": 0.5, "y": 0.5},
                "scale": {"x": 1.0, "y": 1.0}, "zIndex": 5}},
            "tex.logo": {"id": "tex.logo", "type": "Texture", "props": {"src": "/media/g/logo/1.png"}},
        },
        "edges": [
            {"type": "data", "from": {"node": "tex.bg", "port": "data"}, "to": {"node": "spr.bg", "port": "texture"}},
            {"type": "data", "from": {"node": "tex.logo", "port": "data"}, "to": {"node": "spr.logo", "port": "texture"}},
        ],
    }


def test_texture_of_finds_bound_texture():
    assert _texture_of(_doc(), "spr.bg") == "tex.bg"
    assert _texture_of(_doc(), "spr.none") is None


def test_composite_places_sprites_by_anchor_and_zorder():
    images = {"tex.bg": _png(200, 100, (255, 0, 0, 255)),
              "tex.logo": _png(40, 40, (0, 0, 255, 255))}
    out = composite_scene(_doc(), images)
    img = Image.open(BytesIO(out)).convert("RGBA")
    assert img.size == (200, 100)
    # background red where the logo isn't
    assert img.getpixel((10, 50))[:3] == (255, 0, 0)
    # logo (40x40 centered at 150,50) => spans x 130..170, y 30..70 => blue at its center
    assert img.getpixel((150, 50))[:3] == (0, 0, 255)
    assert img.getpixel((135, 50))[:3] == (0, 0, 255)  # inside anchored box; fails if position used as top-left
    # just outside the logo box stays background
    assert img.getpixel((128, 50))[:3] == (255, 0, 0)


def test_composite_applies_scale():
    # scale the logo 2x => 80x80 centered at 150,50 spans x 110..190
    doc = _doc()
    doc["nodes"]["spr.logo"]["props"]["scale"] = {"x": 2.0, "y": 2.0}
    images = {"tex.bg": _png(200, 100, (255, 0, 0, 255)),
              "tex.logo": _png(40, 40, (0, 0, 255, 255))}
    img = Image.open(BytesIO(composite_scene(doc, images))).convert("RGBA")
    assert img.getpixel((115, 50))[:3] == (0, 0, 255)  # inside the scaled box


def test_composite_skips_unbound_or_missing_images():
    doc = _doc()
    # only bg image present; logo image missing => logo skipped, no crash
    img = Image.open(BytesIO(composite_scene(doc, {"tex.bg": _png(200, 100, (255, 0, 0, 255))}))).convert("RGBA")
    assert img.getpixel((150, 50))[:3] == (255, 0, 0)


def test_sprite_box_anchors_and_scales():
    # 40x40 sprite, anchor centre, scale 2 => 80x80, centred at (150,50)
    props = {"position": {"x": 150, "y": 50}, "anchor": {"x": 0.5, "y": 0.5},
             "scale": {"x": 2.0, "y": 2.0}}
    assert sprite_box(props, (40, 40), (200, 100)) == (110, 10, 80, 80)


def test_sprite_box_top_left_anchor():
    props = {"position": {"x": 10, "y": 20}, "anchor": {"x": 0.0, "y": 0.0},
             "scale": {"x": 1.0, "y": 1.0}}
    assert sprite_box(props, (30, 30), (200, 100)) == (10, 20, 30, 30)


def test_collect_scene_images_reads_media(tmp_path):
    # lay a media file matching tex.bg's src under media_dir
    (tmp_path / "g" / "bg").mkdir(parents=True)
    (tmp_path / "g" / "bg" / "1.png").write_bytes(_png(8, 8, (1, 2, 3, 255)))
    images = collect_scene_images(_doc(), str(tmp_path))
    assert "tex.bg" in images and images["tex.bg"]
    assert "tex.logo" not in images  # file absent => skipped
