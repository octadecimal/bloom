from app.agent_tools import ToolContext


def test_tool_context_carries_critic_and_capture_broker():
    sentinel_critic = object()
    sentinel_broker = object()
    ctx = ToolContext(
        "r1", "g1", None, None,
        scene_critic=sentinel_critic, capture_broker=sentinel_broker,
    )
    assert ctx.scene_critic is sentinel_critic
    assert ctx.capture_broker is sentinel_broker


def test_tool_context_critic_and_broker_default_to_none():
    ctx = ToolContext("r1", "g1", None, None)
    assert ctx.scene_critic is None
    assert ctx.capture_broker is None


import pytest

from app.agent_tools import (
    ToolContext,
    ToolFactory,
    _SceneComposeDeps,
    build_compose_scene_tool,
)
from app.scene.compose_loop import BuildElement
from app.scene.critic import EditParams
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


class _NoAssets:
    async def list_assets(self, game_id):
        return []


class _FakeBroker:
    def __init__(self, png=b"\x89PNG-frame"):
        self.png = png
        self.calls = 0

    async def request_capture(self, game_id, *, timeout=10.0):
        self.calls += 1
        return self.png


async def _seed_sprite(hub, game_id, handle, role, *, pos=(640, 360), z=0):
    await hub.apply_batch(game_id, [
        {"kind": "addNode", "id": "root", "type": "Root", "props": {}},
        {"kind": "addNode", "id": f"spr.{handle}", "type": "Sprite", "props": {
            "position": {"x": pos[0], "y": pos[1]},
            "anchor": {"x": 0.5, "y": 0.5},
            "scale": {"x": 1, "y": 1}, "zIndex": z, "role": role}},
        {"kind": "connect", "edgeId": f"e.child.{handle}", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": f"spr.{handle}", "port": "parent"}},
    ])


@pytest.mark.asyncio
async def test_compose_deps_lists_placed_handles_in_order(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    # Add second sprite directly (root already exists after first seed)
    await hub.apply_batch("g1", [
        {"kind": "addNode", "id": "spr.logo", "type": "Sprite", "props": {
            "position": {"x": 640, "y": 100},
            "anchor": {"x": 0.5, "y": 0.5},
            "scale": {"x": 1, "y": 1}, "zIndex": 0, "role": "logo"}},
        {"kind": "connect", "edgeId": "e.child.logo", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": "spr.logo", "port": "parent"}},
    ])
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub,
                      capture_broker=_FakeBroker())
    deps = _SceneComposeDeps(ctx)
    assert await deps.placed_handles() == ["background", "logo"]
    ctxt = await deps.scene_context()
    assert any(e["handle"] == "logo" for e in ctxt["elements"])
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_compose_deps_capture_calls_the_broker(mongo_db):
    broker = _FakeBroker(png=b"\x89PNGxyz")
    ctx = ToolContext("r1", "g1", _NoAssets(), None,
                      scene_store=GameSceneStore(mongo_db), scene_hub=None,
                      capture_broker=broker)
    deps = _SceneComposeDeps(ctx)
    assert await deps.capture() == b"\x89PNGxyz"
    assert broker.calls == 1


@pytest.mark.asyncio
async def test_compose_deps_adjust_applies_a_scale(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "logo", "logo")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)
    deps = _SceneComposeDeps(ctx)
    await deps.adjust("logo", EditParams(scale=0.4))
    props = (await store.get_document("g1"))["nodes"]["spr.logo"]["props"]
    assert props["scale"] == {"x": 0.4, "y": 0.4}
    await mongo_db["game_scenes"].delete_many({})


def test_tool_factory_builds_compose_scene():
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=None, scene_hub=None)
    tools = ToolFactory(asset_store=None, asset_hub=None).build(["compose_scene"], ctx)
    assert [t.name for t in tools] == ["compose_scene"]
