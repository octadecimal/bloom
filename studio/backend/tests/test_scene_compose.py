from app.scene.compose import build_sprite_ops, DEFAULT_CANVAS


def _kinds(ops):
    return [o["kind"] for o in ops]


def test_basic_placement_emits_sprite_texture_and_two_edges():
    ops = build_sprite_ops(handle="logo", src="/media/g/a/logo.png")
    assert _kinds(ops) == ["addNode", "addNode", "connect", "connect"]
    sprite, texture, data_edge, child_edge = ops
    assert sprite["id"] == "spr.logo" and sprite["type"] == "Sprite"
    assert texture["id"] == "tex.logo" and texture["type"] == "Texture"
    assert texture["props"]["src"] == "/media/g/a/logo.png"
    # data edge: Texture.data -> Sprite.texture
    assert data_edge["type"] == "data"
    assert data_edge["from"] == {"node": "tex.logo", "port": "data"}
    assert data_edge["to"] == {"node": "spr.logo", "port": "texture"}
    # child edge: parent.children -> Sprite.parent
    assert child_edge["type"] == "child"
    assert child_edge["from"] == {"node": "root", "port": "children"}
    assert child_edge["to"] == {"node": "spr.logo", "port": "parent"}


def test_position_defaults_to_canvas_center_when_omitted():
    ops = build_sprite_ops(handle="bg", src="s", canvas=(1280, 720))
    pos = ops[0]["props"]["position"]
    assert pos == {"x": 640.0, "y": 360.0}


def test_explicit_top_center_position():
    ops = build_sprite_ops(handle="logo", src="s", canvas=(1280, 720),
                           y=0, anchor_y=0.0)
    sprite = ops[0]
    assert sprite["props"]["position"] == {"x": 640.0, "y": 0}
    assert sprite["props"]["anchor"] == {"x": 0.5, "y": 0.0}


def test_fit_cover_scales_to_cover_canvas():
    ops = build_sprite_ops(handle="bg", src="s", canvas=(1280, 720),
                           tex_size=(640, 720), fit="cover")
    # max(1280/640, 720/720) = 2.0
    assert ops[0]["props"]["scale"] == {"x": 2.0, "y": 2.0}


def test_fit_contain_scales_to_fit_inside_canvas():
    ops = build_sprite_ops(handle="bg", src="s", canvas=(1280, 720),
                           tex_size=(640, 720), fit="contain")
    # min(1280/640, 720/720) = 1.0
    assert ops[0]["props"]["scale"] == {"x": 1.0, "y": 1.0}


def test_fit_none_is_unit_scale():
    ops = build_sprite_ops(handle="x", src="s", tex_size=(640, 720), fit="none")
    assert ops[0]["props"]["scale"] == {"x": 1.0, "y": 1.0}


def test_ensure_root_prepends_a_root_node_with_canvas_dims():
    ops = build_sprite_ops(handle="bg", src="s", ensure_root=True, canvas=(800, 600))
    assert ops[0] == {"kind": "addNode", "id": "root", "type": "Root",
                      "props": {"width": 800, "height": 600}}
    assert _kinds(ops) == ["addNode", "addNode", "addNode", "connect", "connect"]


def test_role_prop_present_only_when_set():
    with_role = build_sprite_ops(handle="bg", src="s", role="background")
    assert with_role[0]["props"]["role"] == "background"
    without = build_sprite_ops(handle="bg", src="s")
    assert "role" not in without[0]["props"]


def test_custom_parent_and_default_canvas_constant():
    assert DEFAULT_CANVAS == (1280, 720)
    ops = build_sprite_ops(handle="x", src="s", parent_id="reels")
    child_edge = ops[-1]
    assert child_edge["from"] == {"node": "reels", "port": "children"}
