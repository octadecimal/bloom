"""Backend e2e (replay): plan-driven compose + geometry reproducibility.

Mirrors the harness in tests/e2e/test_compose_loop.py (real compositor + replay
critic, no browser). The two pure bind tests need no fixtures; the integration
test wires a real-store + replay-critic harness directly — no server subprocess.
"""
from dataclasses import dataclass
from uuid import uuid4

import pytest_asyncio

from app.scene.layout.bind import GddIntent, bind
from app.scene.layout.template import LOGO, REELS


# ---------------------------------------------------------------------------
# Pure bind tests — no I/O, no fixtures
# ---------------------------------------------------------------------------


def test_bind_is_reproducible_from_same_intent():
    intent = GddIntent(
        orientation="landscape",
        focal_emphasis="reels",
        framing_density="ornate",
        art_direction="gold & teal",
    )
    a = bind(intent)
    b = bind(intent)
    assert a.roles.keys() == b.roles.keys()
    for role in a.roles:
        assert a.for_role(role) == b.for_role(role)  # frozen dataclass equality
    assert a.template_version == b.template_version


def test_focal_reels_plan_makes_reels_largest_non_background():
    plan = bind(GddIntent(focal_emphasis="reels"))
    reels = plan.for_role(REELS)
    logo = plan.for_role(LOGO)
    reels_area = reels.region_w * reels.region_h
    logo_area = logo.region_w * logo.region_h
    assert reels_area > logo_area


# ---------------------------------------------------------------------------
# Real-store + replay-critic harness (mirrors test_compose_loop.py approach)
# ---------------------------------------------------------------------------


class _FakeSio:
    """No-op socketio server: lets hub classes emit without a real Socket.IO server."""

    async def emit(self, event, data=None, **kwargs):
        pass

    async def enter_room(self, sid, room):
        pass


@dataclass
class _ComposeHarness:
    ctx: object  # ToolContext


@pytest_asyncio.fixture
async def compose_harness(mongo_db, tmp_path, monkeypatch):
    """Real stores + replay critics, no browser, no server subprocess.

    Mirrors the in-process spirit of test_compose_loop.py while driving
    build_compose_scene_tool directly.
    """
    from app.agent_tools import ToolContext
    from app.assets.comfy import ReplayComfyProvider
    from app.assets.hub import AssetHub
    from app.assets.media import MediaStore
    from app.assets.store import AssetStore
    from app.replay.cassette import (
        DEFAULT_FIXTURES_DIR,
        load_asset_cassettes,
        load_critic_cassettes,
    )
    from app.scene.asset_critic import ReplayAssetCritic
    from app.scene.critic import ReplaySceneCritic
    from app.scene.hub import GameSceneHub
    from app.scene.store import GameSceneStore

    # Point get_settings().media_dir at the test-scoped tmp dir so
    # _SceneComposeDeps.render_scene() can read back the PNGs the hub wrote there.
    media_dir = tmp_path / "media"
    media_dir.mkdir()
    monkeypatch.setenv("MEDIA_DIR", str(media_dir))

    sio = _FakeSio()
    asset_store = AssetStore(mongo_db)
    scene_store = GameSceneStore(mongo_db)
    scene_hub = GameSceneHub(sio, scene_store)

    media = MediaStore(media_dir)
    comfy = ReplayComfyProvider.from_dir(DEFAULT_FIXTURES_DIR, delay=0.0)
    asset_hub = AssetHub(
        sio, asset_store, comfy, media,
        scene_store=scene_store, scene_hub=scene_hub,
    )

    scene_critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    asset_critic = ReplayAssetCritic(load_asset_cassettes(DEFAULT_FIXTURES_DIR))

    game_id = f"game-bp-e2e-{uuid4().hex[:8]}"
    ctx = ToolContext(
        room_id=f"room-bp-e2e-{uuid4().hex[:8]}",
        game_id=game_id,
        asset_store=asset_store,
        asset_hub=asset_hub,
        scene_store=scene_store,
        scene_hub=scene_hub,
        scene_critic=scene_critic,
        asset_critic=asset_critic,
    )
    try:
        yield _ComposeHarness(ctx=ctx)
    finally:
        await mongo_db["game_scenes"].delete_many({"_id": game_id})


# ---------------------------------------------------------------------------
# Integration test: plan-driven build (geometry contract)
# ---------------------------------------------------------------------------


async def test_plan_driven_build_places_reels_in_planned_region(compose_harness):
    """Compose scene tool places spr.reels at the planned position/z and scales
    it into its region (below native 512x512)."""
    ctx = compose_harness.ctx
    from app.agent_tools import build_compose_scene_tool

    tool = build_compose_scene_tool(ctx)
    await tool.ainvoke({
        "elements": [
            {
                "slot": "background",
                "role": "background",
                "description": "vault, no text",
                "transparent": False,
                "size": "1280x720",
            },
            {
                "slot": "reels",
                "role": "reels",
                "description": "ornate gold reel frame",
                "size": "512x512",
            },
            {
                "slot": "logo",
                "role": "logo",
                "description": "crest wordmark",
                "size": "768x512",
            },
        ],
        "theme": "premium pirate slot",
    })

    doc = await ctx.scene_store.get_document(ctx.game_id)
    reels = doc["nodes"]["spr.reels"]["props"]
    plan_reels = bind(GddIntent()).for_role("reels")
    assert reels["position"] == {"x": plan_reels.x, "y": plan_reels.y}
    assert reels["zIndex"] == plan_reels.z
    # scaled to fit its planned region — not left at native 512x512
    assert reels["scale"]["x"] < 1.0
