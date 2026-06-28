import pytest

from app.agent_tools import ToolContext, ToolFactory, build_adjust_element_tool
from app.scene.store import GameSceneStore
from app.scene.hub import GameSceneHub


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


class _NoAssets:
    async def list_assets(self, game_id):
        return []


async def _seed_sprite(hub, game_id, handle, role, *, pos=(640, 360), z=0):
    """Place a bare Sprite (no texture needed — adjust_element resolves off the
    Sprite node + handle) parented to an auto-created Root."""
    await hub.apply_batch(game_id, [
        {"kind": "addNode", "id": "root", "type": "Root", "props": {}},
        {"kind": "addNode", "id": f"spr.{handle}", "type": "Sprite", "props": {
            "position": {"x": pos[0], "y": pos[1]},
            "anchor": {"x": 0.5, "y": 0.5},
            "scale": {"x": 1, "y": 1},
            "zIndex": z,
            "role": role,
        }},
        {"kind": "connect", "edgeId": f"e.child.{handle}", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": f"spr.{handle}", "port": "parent"}},
    ])


@pytest.mark.asyncio
async def test_adjust_element_moves_scales_and_reorders_a_placed_sprite(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke(
        {"ref": "background", "x": 100, "y": 50, "scale": 0.4, "z": 5})

    assert "Adjusted" in out and "background" in out
    props = (await store.get_document("g1"))["nodes"]["spr.background"]["props"]
    assert props["position"] == {"x": 100, "y": 50}
    assert props["scale"] == {"x": 0.4, "y": 0.4}
    assert props["zIndex"] == 5
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_adjust_element_changes_only_the_named_fields(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "logo", "logo", pos=(640, 100), z=2)
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    await build_adjust_element_tool(ctx).ainvoke({"ref": "logo", "y": 30})

    props = (await store.get_document("g1"))["nodes"]["spr.logo"]["props"]
    assert props["position"] == {"x": 640, "y": 30}   # x untouched
    assert props["scale"] == {"x": 1, "y": 1}          # scale untouched
    assert props["zIndex"] == 2                          # z untouched
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_adjust_element_with_no_fields_is_a_no_op_with_guidance(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke({"ref": "background"})

    assert "at least one of x, y, scale, or z" in out
    props = (await store.get_document("g1"))["nodes"]["spr.background"]["props"]
    assert props["position"] == {"x": 640, "y": 360}   # unchanged
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_adjust_element_unknown_ref_lists_what_is_placed(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke({"ref": "nope", "x": 1})

    assert "No placed element matches 'nope'" in out
    assert "background" in out   # the placed summary
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_adjust_element_ambiguous_ref_returns_candidates(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    # two sprites whose handles both contain "logo" → "logo" matches both
    await _seed_sprite(hub, "g1", "logo_top", "logo")
    await hub.apply_batch("g1", [
        {"kind": "addNode", "id": "spr.logo_bottom", "type": "Sprite", "props": {
            "position": {"x": 640, "y": 700}, "anchor": {"x": 0.5, "y": 0.5},
            "scale": {"x": 1, "y": 1}, "zIndex": 0, "role": "logo"}},
        {"kind": "connect", "edgeId": "e.child.logo_bottom", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": "spr.logo_bottom", "port": "parent"}},
    ])
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke({"ref": "logo", "y": 10})

    assert "matches several" in out
    assert "logo_top" in out and "logo_bottom" in out
    await mongo_db["game_scenes"].delete_many({})


def test_tool_factory_builds_adjust_element():
    f = ToolFactory(asset_store=None, asset_hub=None)
    ctx = ToolContext("r1", "g1", None, None, scene_store=None, scene_hub=None)
    tools = f.build(["adjust_element"], ctx)
    assert [t.name for t in tools] == ["adjust_element"]
