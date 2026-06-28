from io import BytesIO

import pytest
from PIL import Image

from app.agent_tools import ToolContext
from app.scene.asset_critic import AssetVerdict


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

    async def get_by_slot(self, game_id, slot):
        return None


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


# ---------------------------------------------------------------------------
# Task 4: real deps — render_scene, critique_asset, asset_critic field
# ---------------------------------------------------------------------------

class _FakeAssetCritic:
    def __init__(self, verdict):
        self.verdict = verdict
        self.calls = []

    async def critique(self, request):
        self.calls.append(request.role)
        return self.verdict


def _png_bytes(color, size=(32, 32)):
    buf = BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_render_scene_composites_from_media(mongo_db, tmp_path, monkeypatch):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    # bind a texture node + edge and lay a media file matching its src
    await hub.apply_batch("g1", [
        {"kind": "addNode", "id": "tex.background", "type": "Texture",
         "props": {"src": "/media/g1/background/1.png"}},
        {"kind": "connect", "edgeId": "e.tex.background", "type": "data",
         "from": {"node": "tex.background", "port": "data"},
         "to": {"node": "spr.background", "port": "texture"}},
    ])
    media = tmp_path / "g1" / "background"
    media.mkdir(parents=True)
    (media / "1.png").write_bytes(_png_bytes((255, 0, 0, 255), (1280, 720)))

    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)
    monkeypatch.setattr("app.agent_tools.get_settings",
                        lambda: type("S", (), {"media_dir": str(tmp_path)})())
    deps = _SceneComposeDeps(ctx)
    png = await deps.render_scene()
    img = Image.open(BytesIO(png)).convert("RGBA")
    assert img.size == (1280, 720)
    assert img.getpixel((640, 360))[:3] == (255, 0, 0)
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_critique_asset_calls_asset_critic_with_latest_generation(
        mongo_db, tmp_path, monkeypatch):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "reel_frame", "reel frame")
    await hub.apply_batch("g1", [
        {"kind": "addNode", "id": "tex.reel_frame", "type": "Texture",
         "props": {"src": "/media/g1/reel_frame/1.png"}},
        {"kind": "connect", "edgeId": "e.tex.reel_frame", "type": "data",
         "from": {"node": "tex.reel_frame", "port": "data"},
         "to": {"node": "spr.reel_frame", "port": "texture"}},
    ])
    media = tmp_path / "g1" / "reel_frame"
    media.mkdir(parents=True)
    (media / "1.png").write_bytes(_png_bytes((9, 9, 9, 255)))

    fake = _FakeAssetCritic(AssetVerdict(ok=False, action="regenerate", reason="x"))
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub,
                      asset_critic=fake)
    monkeypatch.setattr("app.agent_tools.get_settings",
                        lambda: type("S", (), {"media_dir": str(tmp_path)})())
    deps = _SceneComposeDeps(ctx)
    verdict = await deps.critique_asset("reel_frame")
    assert verdict.action == "regenerate"
    assert fake.calls == ["reel frame"]   # role passed through
    await mongo_db["game_scenes"].delete_many({})


def test_tool_context_carries_asset_critic():
    sentinel = object()
    ctx = ToolContext("r1", "g1", None, None, asset_critic=sentinel)
    assert ctx.asset_critic is sentinel


# ---------------------------------------------------------------------------
# Task 5: format_compose_summary — surfaces asset + composition verdicts
# ---------------------------------------------------------------------------

from app.agent_tools import format_compose_summary
from app.scene.compose_loop import ComposeResult
from app.scene.compose import build_sprite_ops


def _texture_op(ops):
    return next(o for o in ops if o["kind"] == "addNode" and o["type"] == "Texture")


def test_build_sprite_ops_writes_asset_id_on_texture():
    ops = build_sprite_ops(handle="wild", src="/media/g1/a1/x.png", asset_id="a1")
    tex = _texture_op(ops)
    assert tex["props"]["src"] == "/media/g1/a1/x.png"
    assert tex["props"]["assetId"] == "a1"


def test_build_sprite_ops_omits_asset_id_when_absent():
    ops = build_sprite_ops(handle="wild", src="/media/g1/a1/x.png")
    tex = _texture_op(ops)
    assert "assetId" not in tex["props"]


def test_compose_summary_reports_asset_regenerations_and_notes():
    r = ComposeResult(elements_placed=2, passes=3, edits_applied=1,
                      regens_spent=2, assets_regenerated=1,
                      notes=["reel_frame: near-empty image (7600 bytes) -> regenerated",
                             "logo: asset ok", "scale logo: too big"])
    s = format_compose_summary(r)
    assert "2 element(s)" in s and "3 critique pass(es)" in s
    assert "1 asset regeneration(s)" in s
    assert "reel_frame: near-empty" in s and "logo: asset ok" in s
