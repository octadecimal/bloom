import httpx
import pytest
import pytest_asyncio
from dataclasses import dataclass
from types import SimpleNamespace
from uuid import uuid4

from app.gdd.hub import GddHub
from app.gdd.store import GddStore
from app.math import rest as math_rest
from app.math.models import MetricsWire, TuneResult
from app.math.store import MathStore
from app.rest import SetGddFieldsBody, set_gdd_fields_rest


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_gdd_docs_endpoint_returns_empty_list_for_new_game(live_server):
    async with httpx.AsyncClient(base_url=live_server) as http:
        # Create a game implicitly via POST /rooms (auto-creates a game)
        room = (await http.post("/rooms", json={"name": "GddRest"})).json()
        game_id = room["gameId"]
        res = await http.get(f"/games/{game_id}/gdd/docs")
        assert res.status_code == 200
        assert res.json() == []  # nothing seeded until a design-game run starts


# ---------------------------------------------------------------------------
# In-process harness for PUT /gdd rebuild integration tests
# ---------------------------------------------------------------------------


class _FakeSio:
    """No-op socketio server: lets hub classes emit without a real Socket.IO server."""

    async def emit(self, event, data=None, **kwargs):
        pass

    async def enter_room(self, sid, room):
        pass


@dataclass
class _BlueprintRestHarness:
    game_id: str
    _state: object  # SimpleNamespace with all singletons

    async def put_gdd(self, game_id: str, aspect: str, fields: dict) -> dict:
        """Replicate the set_gdd_fields_rest handler body in-process."""
        from app.gdd.models import gdd_wire
        from app.scene.intent_rebuild import is_intent_change, rebuild_after_intent

        await self._state.gdd_store.seed_taxonomy(game_id)
        doc, warnings = await self._state.gdd_hub.set_fields(game_id, aspect, fields)
        rebuilt = False
        if is_intent_change(aspect, fields):
            rebuilt = (await rebuild_after_intent(self._state, game_id)) is not None
        return {"doc": gdd_wire(doc), "warnings": warnings, "rebuilt": rebuilt}

    async def scene_doc(self) -> dict:
        return await self._state.scene_store.get_document(self.game_id)


@pytest_asyncio.fixture
async def blueprint_rest_harness(mongo_db, tmp_path, monkeypatch):
    """Real stores + replay critics, no browser, no server subprocess.

    Mirrors compose_harness in test_scene_blueprint_compose.py, extended with
    GddStore/GddHub and an app.state-like namespace so rebuild_after_intent can
    read all singletons. Seeds a background+reels+logo scene via
    build_compose_scene_tool (same elements as the A1 e2e).
    """
    from app.agent_tools import ToolContext, build_compose_scene_tool
    from app.assets.comfy import ReplayComfyProvider
    from app.assets.hub import AssetHub
    from app.assets.media import MediaStore
    from app.assets.store import AssetStore
    from app.gdd.hub import GddHub
    from app.gdd.store import GddStore
    from app.replay.cassette import (
        DEFAULT_FIXTURES_DIR,
        load_asset_cassettes,
        load_critic_cassettes,
    )
    from app.scene.asset_critic import ReplayAssetCritic
    from app.scene.critic import ReplaySceneCritic
    from app.scene.hub import GameSceneHub
    from app.scene.layout.overrides import RegionOverrideStore
    from app.scene.store import GameSceneStore

    # Point get_settings().media_dir at the test-scoped tmp dir so
    # render_scene() can read back the PNGs the hub wrote there.
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

    gdd_store = GddStore(mongo_db)
    gdd_hub = GddHub(sio, gdd_store)

    scene_critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    asset_critic = ReplayAssetCritic(load_asset_cassettes(DEFAULT_FIXTURES_DIR))

    game_id = f"game-gdd-rest-{uuid4().hex[:8]}"

    region_override_store = RegionOverrideStore(mongo_db)

    # Assemble app.state-like object so rebuild_after_intent can read all singletons.
    state = SimpleNamespace(
        asset_store=asset_store,
        asset_hub=asset_hub,
        gdd_store=gdd_store,
        gdd_hub=gdd_hub,
        scene_store=scene_store,
        scene_hub=scene_hub,
        scene_critic=scene_critic,
        asset_critic=asset_critic,
        region_override_store=region_override_store,
    )

    # Seed the GDD taxonomy for this game.
    await gdd_store.seed_taxonomy(game_id)

    # Seed a background+reels+logo scene (mirrors A1 e2e compose fixture).
    ctx = ToolContext(
        room_id="",
        game_id=game_id,
        asset_store=asset_store,
        asset_hub=asset_hub,
        scene_store=scene_store,
        scene_hub=scene_hub,
        scene_critic=scene_critic,
        asset_critic=asset_critic,
    )
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

    try:
        yield _BlueprintRestHarness(game_id=game_id, _state=state)
    finally:
        await mongo_db["game_scenes"].delete_many({"_id": game_id})
        await mongo_db["gdd_docs"].delete_many({"game_id": game_id})
        await mongo_db["region_overrides"].delete_many({"_id": game_id})


# ---------------------------------------------------------------------------
# Integration tests: PUT /gdd rebuild behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_put_intent_field_emits_and_rebuilds(blueprint_rest_harness):
    """A PUT to an intent field on a non-empty scene reflows the scene and
    reports rebuilt=True; the reels region grows under focal_emphasis=reels."""
    from app.scene.layout.bind import GddIntent, bind

    h = blueprint_rest_harness
    gid = h.game_id

    before_scale = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["scale"]["x"]
    resp = await h.put_gdd(gid, "ui-ux", {"focal_emphasis": "reels"})
    assert resp["rebuilt"] is True

    plan = bind(GddIntent(focal_emphasis="reels"))
    after = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert after == {"x": plan.for_role("reels").x, "y": plan.for_role("reels").y}
    # focal_emphasis=reels enlarges the reels region (~1.18×/1.12×), so
    # scale_to_region yields a strictly larger fit scale for the same 512×512 texture.
    after_scale = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["scale"]["x"]
    assert after_scale > before_scale


@pytest.mark.asyncio
async def test_put_orientation_flip_resizes_root_and_reflows(blueprint_rest_harness):
    from app.scene.layout.bind import GddIntent, bind

    h = blueprint_rest_harness
    resp = await h.put_gdd(h.game_id, "ui-ux", {"orientation": "portrait"})
    assert resp["rebuilt"] is True
    doc = await h.scene_doc()
    root = next(n for n in doc["nodes"].values() if n["type"] == "Root")
    assert (int(root["props"]["width"]), int(root["props"]["height"])) == (720, 1280)
    plan = bind(GddIntent(orientation="portrait"))
    assert doc["nodes"]["spr.reels"]["props"]["position"] == {
        "x": plan.for_role("reels").x, "y": plan.for_role("reels").y}


@pytest.mark.asyncio
async def test_put_non_intent_field_does_not_rebuild(blueprint_rest_harness):
    h = blueprint_rest_harness
    resp = await h.put_gdd(h.game_id, "ui-ux", {"controls": "tap to spin"})
    assert resp["rebuilt"] is False


@pytest.mark.asyncio
async def test_put_intent_field_is_reproducible(blueprint_rest_harness):
    """Same intent save twice -> identical reels geometry (derivable scene)."""
    h = blueprint_rest_harness
    await h.put_gdd(h.game_id, "ui-ux", {"focal_emphasis": "reels"})
    first = (await h.scene_doc())["nodes"]["spr.reels"]["props"]
    await h.put_gdd(h.game_id, "ui-ux", {"focal_emphasis": "reels"})
    second = (await h.scene_doc())["nodes"]["spr.reels"]["props"]
    assert first["position"] == second["position"]
    assert first["scale"] == second["scale"]


# ---------------------------------------------------------------------------
# Task 6: PUT /gdd/{aspect} shape/target hooks + explicit realize endpoint.
# Lightweight harness (no scene/asset infra needed): real GddStore/GddHub/
# MathStore over mongo_db, calling the REST handlers directly (mirrors the
# _req(**state) pattern in tests/test_math_rest.py).
# ---------------------------------------------------------------------------


def _new_math_game() -> str:
    return f"game-math-hook-{uuid4().hex[:8]}"


def _math_req(state) -> SimpleNamespace:
    return SimpleNamespace(app=SimpleNamespace(state=state))


@pytest_asyncio.fixture
async def math_gdd_state(mongo_db):
    gdd_store = GddStore(mongo_db)
    gdd_hub = GddHub(_FakeSio(), gdd_store)
    math_store = MathStore(mongo_db)
    return SimpleNamespace(gdd_store=gdd_store, gdd_hub=gdd_hub, math_store=math_store)


async def _put_gdd(state, game_id: str, aspect: str, fields: dict) -> dict:
    return await set_gdd_fields_rest(
        game_id, aspect, SetGddFieldsBody(fields=fields), _math_req(state))


@pytest_asyncio.fixture
async def seeded_result(math_gdd_state):
    """A game whose slot-model already has a stored tune_result (verdict)."""
    state = math_gdd_state
    gid = _new_math_game()
    await state.gdd_store.seed_taxonomy(gid)
    await state.math_store.get_or_seed(gid)
    await state.math_store.save_tune_result(gid, TuneResult(
        status="pass", verdict="pass", tuned_model={"reels": [[0]]},
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.8, feature_rtp=0.16, bonus_hit_rates=[]),
        ran_at="t1"))
    return state, gid


@pytest.mark.asyncio
async def test_shape_edit_on_untouched_model_realizes(math_gdd_state):
    state = math_gdd_state
    gid = _new_math_game()
    await _put_gdd(state, gid, "symbols-reels",
                   {"symbols": [{"slot": "a", "kind": "high"}]})
    r = await _put_gdd(state, gid, "math-model", {"reels": 4, "rows": 3})
    assert r["realize"] == "applied"
    model = await math_rest.get_slot_model(gid, _math_req(state))
    assert len(model["model"]["reels"]) == 4
    assert model["origin"] == "realized"


@pytest.mark.asyncio
async def test_shape_edit_on_touched_model_goes_pending(math_gdd_state):
    state = math_gdd_state
    gid = _new_math_game()
    req = _math_req(state)
    await _put_gdd(state, gid, "symbols-reels",
                   {"symbols": [{"slot": "a", "kind": "high"}]})
    await _put_gdd(state, gid, "math-model", {"reels": 4})
    doc = await math_rest.get_slot_model(gid, req)
    # human edit -> touched
    await math_rest.put_slot_model(
        gid, math_rest.PutSlotModelBody(model=doc["model"]), req)
    r = await _put_gdd(state, gid, "math-model", {"reels": 3})
    assert r["realize"] == "pending"
    doc = await math_rest.get_slot_model(gid, req)
    assert doc["shapeStale"] is True
    assert len(doc["model"]["reels"]) == 4          # model untouched


@pytest.mark.asyncio
async def test_explicit_realize_applies_and_clears_shape_stale(math_gdd_state):
    state = math_gdd_state
    gid = _new_math_game()
    req = _math_req(state)
    await _put_gdd(state, gid, "symbols-reels",
                   {"symbols": [{"slot": "a", "kind": "high"}]})
    await _put_gdd(state, gid, "math-model", {"reels": 4})
    doc = await math_rest.get_slot_model(gid, req)
    await math_rest.put_slot_model(
        gid, math_rest.PutSlotModelBody(model=doc["model"]), req)
    await _put_gdd(state, gid, "math-model", {"reels": 3})
    r = await math_rest.realize_slot_model_rest(gid, req)
    assert r["realized"] is True
    doc = await math_rest.get_slot_model(gid, req)
    assert doc["shapeStale"] is False
    assert len(doc["model"]["reels"]) == 3


@pytest.mark.asyncio
async def test_target_edit_after_result_sets_verdict_stale(seeded_result):
    state, gid = seeded_result
    await _put_gdd(state, gid, "math-model", {"rtp": "94%"})
    doc = await math_rest.get_slot_model(gid, _math_req(state))
    assert doc["verdictStale"] is True
