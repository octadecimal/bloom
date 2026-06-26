from dataclasses import dataclass

from app.agent_tools import (
    _texture_of, _placed_elements, _resolve_placed_elements,
)


@dataclass
class _A:           # minimal Asset stand-in
    id: str
    slot: str
    name: str


def _doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.background": {"id": "spr.background", "type": "Sprite",
                               "props": {"role": "background"}},
            "tex.background": {"id": "tex.background", "type": "Texture",
                               "props": {"src": "/media/bg.png"}},
            "spr.seaweed": {"id": "spr.seaweed", "type": "Sprite",
                            "props": {"role": "prop"}},
            "tex.seaweed": {"id": "tex.seaweed", "type": "Texture",
                            "props": {"src": "/media/sea.png"}},
        },
        "edges": [
            {"id": "c1", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.background", "port": "parent"}},
            {"id": "d1", "type": "data", "from": {"node": "tex.background", "port": "data"},
             "to": {"node": "spr.background", "port": "texture"}},
            {"id": "c2", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.seaweed", "port": "parent"}},
            {"id": "d2", "type": "data", "from": {"node": "tex.seaweed", "port": "data"},
             "to": {"node": "spr.seaweed", "port": "texture"}},
        ],
    }


_ASSETS = [_A("a1", "background", "Background"), _A("a2", "seaweed", "Seaweed")]


def test_texture_of_resolves_bound_texture():
    assert _texture_of(_doc(), "spr.seaweed") == "tex.seaweed"
    assert _texture_of(_doc(), "spr.nope") is None


def test_placed_elements_lists_each_sprite_joined_to_asset_and_texture():
    els = _placed_elements(_doc(), _ASSETS)
    by_handle = {e.handle: e for e in els}
    assert set(by_handle) == {"background", "seaweed"}
    sea = by_handle["seaweed"]
    assert sea.sprite_id == "spr.seaweed"
    assert sea.texture_id == "tex.seaweed"
    assert sea.role == "prop"
    assert sea.asset is not None and sea.asset.name == "Seaweed"
    assert sea.src == "/media/sea.png"


def test_resolve_matches_by_handle_role_or_asset_name_case_insensitive():
    # by handle
    assert [e.handle for e in _resolve_placed_elements(_doc(), _ASSETS, "seaweed")] == ["seaweed"]
    # by asset name, different case
    assert [e.handle for e in _resolve_placed_elements(_doc(), _ASSETS, "SEAWEED")] == ["seaweed"]
    # by role
    assert [e.handle for e in _resolve_placed_elements(_doc(), _ASSETS, "background")] == ["background"]


def test_resolve_returns_empty_for_no_match_and_for_empty_ref():
    assert _resolve_placed_elements(_doc(), _ASSETS, "treasure") == []
    assert _resolve_placed_elements(_doc(), _ASSETS, "") == []


def test_resolve_returns_multiple_when_ref_is_ambiguous():
    doc = _doc()
    doc["nodes"]["spr.seaweed_left"] = {"id": "spr.seaweed_left", "type": "Sprite",
                                        "props": {"role": "prop"}}
    doc["nodes"]["spr.seaweed_right"] = {"id": "spr.seaweed_right", "type": "Sprite",
                                         "props": {"role": "prop"}}
    handles = sorted(e.handle for e in _resolve_placed_elements(doc, _ASSETS, "seaweed"))
    assert handles == ["seaweed", "seaweed_left", "seaweed_right"]


def test_placed_elements_tolerates_malformed_doc():
    doc = {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.seaweed": {"id": "spr.seaweed", "type": "Sprite", "props": {"role": "prop"}},
            "tex.seaweed": {"id": "tex.seaweed", "type": "Texture", "props": None},
        },
        "edges": [
            {"id": "broken", "type": "data", "from": {"node": "tex.seaweed", "port": "data"}},
            {"id": "d", "type": "data", "from": {"node": "tex.seaweed", "port": "data"},
             "to": {"node": "spr.seaweed", "port": "texture"}},
        ],
    }
    els = _placed_elements(doc, [])
    by_handle = {e.handle: e for e in els}
    assert "seaweed" in by_handle
    assert by_handle["seaweed"].texture_id == "tex.seaweed"  # the well-formed edge still resolves
    assert by_handle["seaweed"].src is None                  # props=None tolerated
