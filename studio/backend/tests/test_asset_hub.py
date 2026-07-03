# studio/backend/tests/test_asset_hub.py
import asyncio

import pytest

from app.assets.comfy import ReplayComfyProvider, ImageEvent, ProgressEvent

# Minimal valid PNG bytes for in-memory replay fixtures
_FAKE_PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 500
FAKE_PNG = _FAKE_PNG  # keep name for FlakyProvider inline usage
from app.assets.hub import AssetHub
from app.assets.media import MediaStore
from app.assets.store import AssetStore


class FakeSio:
    def __init__(self):
        self.events = []  # (event, payload, room/to)
        self.rooms = []

    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))

    async def enter_room(self, sid, room):
        self.rooms.append((sid, room))


async def _wait_for(sio, event, timeout=2.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if any(e[0] == event for e in sio.events):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"event {event} not emitted; got {[e[0] for e in sio.events]}")


async def _wait_until(predicate, timeout=2.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("predicate not satisfied within timeout")


@pytest.mark.asyncio
async def test_generation_emits_status_progress_completed(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-transparent", seed=5)
    sio = FakeSio()
    hub = AssetHub(sio, store, ReplayComfyProvider(progress=[(1, 2), (2, 2)], image=_FAKE_PNG, delay=0.0), MediaStore(tmp_path))

    await hub.request_generation("g1", asset.id)
    await _wait_for(sio, "asset_completed")

    kinds = [e[0] for e in sio.events]
    assert "asset_status" in kinds and "asset_progress" in kinds and "asset_completed" in kinds

    completed = next(e for e in sio.events if e[0] == "asset_completed")
    payload = completed[1]
    assert payload["gameId"] == "g1"
    assert payload["asset"]["status"] == "done"
    assert len(payload["asset"]["generations"]) == 1
    assert payload["asset"]["generations"][0]["seed"] == 5
    assert payload["asset"]["selectedGenerationId"] == payload["asset"]["generations"][0]["id"]

    # the image file exists on disk
    ref = payload["asset"]["generations"][0]["imageRef"]
    assert (tmp_path / ref.removeprefix("/media/")).exists()


@pytest.mark.asyncio
async def test_failure_sets_error_status(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-opaque", seed=1)

    class BoomProvider:
        async def generate(self, graph):
            raise RuntimeError("gpu exploded")
            yield  # pragma: no cover

    sio = FakeSio()
    hub = AssetHub(sio, store, BoomProvider(), MediaStore(tmp_path))
    await hub.request_generation("g1", asset.id)
    await _wait_for(sio, "asset_status")
    await asyncio.sleep(0.1)

    refreshed = await store.get_asset(asset.id)
    assert refreshed.status == "error"


@pytest.mark.asyncio
async def test_failed_generation_does_not_wedge_next_queued(mongo_db, tmp_path):
    """A generation that raises must not stall the rest of the game's queue."""
    store = AssetStore(mongo_db)
    bad = await store.create_asset(game_id="g1", name="Bad", prompt="p", width=64, height=64, workflow="schnell-opaque", seed=1)
    good = await store.create_asset(game_id="g1", name="Good", prompt="p", width=64, height=64, workflow="schnell-opaque", seed=2)

    class FlakyProvider:
        """Explodes on the first generation, succeeds on every one after."""

        def __init__(self):
            self.calls = 0

        async def generate(self, graph):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("first one explodes")
                yield  # pragma: no cover
            yield ProgressEvent(value=1, max=1)
            yield ImageEvent(data=FAKE_PNG)

    sio = FakeSio()
    hub = AssetHub(sio, store, FlakyProvider(), MediaStore(tmp_path))

    await hub.request_generation("g1", bad.id)
    await hub.request_generation("g1", good.id)
    await _wait_for(sio, "asset_completed")

    # the second (good) asset completed despite the first failing
    completed = next(e for e in sio.events if e[0] == "asset_completed")
    assert completed[1]["asset"]["id"] == good.id
    assert completed[1]["asset"]["status"] == "done"

    # the first (bad) asset is left in an error state, not stuck "generating"
    refreshed_bad = await store.get_asset(bad.id)
    assert refreshed_bad.status == "error"


@pytest.mark.asyncio
async def test_attach_subscriber_replays_active_progress(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-opaque", seed=1)
    sio = FakeSio()
    # slow provider so the generation is mid-flight when we attach
    hub = AssetHub(sio, store, ReplayComfyProvider(progress=[(1, 3), (2, 3), (3, 3)], image=_FAKE_PNG, delay=0.05), MediaStore(tmp_path))

    await hub.request_generation("g1", asset.id)
    # Wait until at least one real progress tick has been recorded, rather than
    # racing a fixed sleep against the provider's tick cadence.
    await _wait_until(lambda: (hub.active_snapshot("g1") or {}).get("value", 0) >= 1)
    await hub.attach_subscriber("g1", "sid-late")

    snap_to_sid = [e for e in sio.events if e[0] == "asset_progress" and e[2] == "sid-late"]
    assert snap_to_sid  # the late subscriber got a replayed snapshot


@pytest.mark.asyncio
async def test_generate_and_wait_completes_inline(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    sio = FakeSio()
    hub = AssetHub(sio, store, ReplayComfyProvider(progress=[(1, 2), (2, 2)], image=_FAKE_PNG, delay=0.0), MediaStore(tmp_path))
    asset = await store.create_asset("g1", "spr", "a knight", 512, 512, "schnell-transparent")
    await hub.generate_and_wait("g1", asset.id)
    done = await store.get_asset(asset.id)
    assert done.status == "done" and len(done.generations) == 1


@pytest.mark.asyncio
async def test_concurrent_generate_and_wait_same_game_both_complete(mongo_db, tmp_path):
    """Two generate_and_wait calls fired concurrently for ONE game must BOTH produce a
    generation. The scene-compose agent does exactly this (multiple generate_asset in a
    single ToolNode turn → asyncio.gather). The single-active-per-game slot must not be
    popped out from under a still-running generation (KeyError)."""
    store = AssetStore(mongo_db)
    a = await store.create_asset("g1", "bg", "a beach", 512, 512, "schnell-opaque", seed=1)
    b = await store.create_asset("g1", "logo", "a crest", 512, 512, "schnell-transparent", seed=2)

    class RacingProvider:
        """Deterministically forces the concurrent-write race on the single
        _active[game_id] slot, while staying deadlock-free if the hub serializes the two
        generations (the fix):

        1. Both generations emit a first progress event, so both are inside their _run's
           "active" region (each having set _active[game_id]).
        2. Generation #1 then completes, so _run pops _active[game_id] in its finally.
        3. Generation #2, released afterwards, emits another progress event whose
           `self._active[game_id].update(...)` hits the popped key → KeyError under the
           buggy direct-_run path. When the hub serializes (#1 fully finishes before #2
           starts), #2 simply runs alone and there is no popped-slot collision.

        Gen #1 waits (with a timeout) for #2 to reach its active region before finishing,
        so under true concurrency both are active together; the timeout means a serial hub
        — where #2 never runs concurrently — can never hang here, it just proceeds."""

        def __init__(self):
            self.calls = 0
            self.second_active = asyncio.Event()
            self.first_done = asyncio.Event()

        async def generate(self, graph):
            self.calls += 1
            mine = self.calls
            if mine == 1:
                yield ProgressEvent(value=1, max=2)
                # Wait until #2 is also active (true concurrency). The timeout keeps a
                # serial hub — where #2 only starts after #1 finishes — from hanging.
                try:
                    await asyncio.wait_for(self.second_active.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
                yield ImageEvent(data=_FAKE_PNG)  # #1 done → _run pops _active in finally
                self.first_done.set()
            else:
                yield ProgressEvent(value=1, max=2)  # #2 now in its active region
                self.second_active.set()
                await self.first_done.wait()  # wait until #1 has popped the shared slot
                yield ProgressEvent(value=2, max=2)  # update popped slot → KeyError (buggy)
                yield ImageEvent(data=_FAKE_PNG)

    sio = FakeSio()
    hub = AssetHub(sio, store, RacingProvider(), MediaStore(tmp_path))

    await asyncio.gather(
        hub.generate_and_wait("g1", a.id),
        hub.generate_and_wait("g1", b.id),
    )

    done_a = await store.get_asset(a.id)
    done_b = await store.get_asset(b.id)
    assert done_a.status == "done" and len(done_a.generations) == 1
    assert done_b.status == "done" and len(done_b.generations) == 1


@pytest.mark.asyncio
async def test_generate_and_wait_raises_on_failure(mongo_db, tmp_path):
    """generate_and_wait must report failure honestly (raise) so the agent tool surfaces
    it, even now that the work is routed through the shared per-game drain."""
    store = AssetStore(mongo_db)
    asset = await store.create_asset("g1", "spr", "a knight", 512, 512, "schnell-opaque", seed=1)

    class BoomProvider:
        async def generate(self, graph):
            raise RuntimeError("gpu exploded")
            yield  # pragma: no cover

    sio = FakeSio()
    hub = AssetHub(sio, store, BoomProvider(), MediaStore(tmp_path))

    with pytest.raises(Exception):
        await hub.generate_and_wait("g1", asset.id)

    refreshed = await store.get_asset(asset.id)
    assert refreshed.status == "error"


@pytest.mark.asyncio
async def test_failed_auto_select_does_not_poison_later_agent_generation(mongo_db, tmp_path):
    """auto_select=True with a failing generation must clear the flag so a subsequent
    agent-path generation (no auto_select) is NOT wrongly rebound."""
    store = AssetStore(mongo_db)
    game_id = "g1"
    asset = await store.create_asset(
        game_id, "Wild", "p", 64, 64, "schnell-transparent", slot="wild"
    )

    scene_doc = {
        "version": 1,
        "nodes": {
            "tex.wild": {
                "id": "tex.wild",
                "type": "Texture",
                "props": {"src": "/media/old.png", "assetId": asset.id},
            }
        },
        "edges": [],
    }

    class _SceneStore:
        async def get_document(self, gid):
            return scene_doc

    class _SceneHub:
        def __init__(self):
            self.ops = []

        async def apply_op(self, gid, op):
            self.ops.append((gid, op))

    class FailThenSucceedProvider:
        def __init__(self):
            self.calls = 0

        async def generate(self, graph):
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("gpu exploded")
                yield  # pragma: no cover
            yield ProgressEvent(value=1, max=1)
            yield ImageEvent(data=_FAKE_PNG)

    shub = _SceneHub()
    sio = FakeSio()
    hub = AssetHub(
        sio,
        store,
        FailThenSucceedProvider(),
        MediaStore(tmp_path),
        scene_store=_SceneStore(),
        scene_hub=shub,
    )

    # --- Phase 1: auto_select=True, generation FAILS ---
    await hub.request_generation(game_id, asset.id, auto_select=True)
    # Wait for drain to finish: error status emitted + hub no longer busy
    await _wait_until(
        lambda: any(
            e[0] == "asset_status" and e[1].get("status") == "error" for e in sio.events
        )
    )
    await _wait_until(lambda: game_id not in hub._busy)

    # Minimum check: flag must be cleared even after failure
    assert asset.id not in hub._auto_select

    # --- Phase 2: agent-path generation (no auto_select) succeeds → must NOT rebind ---
    sio.events.clear()
    await hub.request_generation(game_id, asset.id)  # no auto_select
    await _wait_for(sio, "asset_completed")
    # rebind is async-after-emit; allow a small window for any spurious op to arrive
    await asyncio.sleep(0.05)

    assert not shub.ops, "agent-path generation must not trigger a rebind (auto_select flag leak)"


@pytest.mark.asyncio
async def test_notify_deleted_emits_asset_deleted_to_game_room():
    class _Sio:
        def __init__(self): self.emits = []
        async def emit(self, event, data, room=None, to=None):
            self.emits.append((event, data, room))
    from app.assets.hub import AssetHub
    sio = _Sio()
    hub = AssetHub(sio, asset_store=None, comfy=None, media=None)
    await hub.notify_deleted("g1", "a1")
    assert ("asset_deleted", {"gameId": "g1", "assetId": "a1"}, "g1") in sio.emits


@pytest.mark.asyncio
async def test_request_generation_auto_select_rebinds_scene(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    game_id = "g1"
    asset = await store.create_asset(
        game_id, "Wild", "p", 64, 64, "schnell-transparent", slot="wild"
    )
    await store.add_generation(asset.id, "gen1", 1, "/media/g1/%s/gen1.png" % asset.id)

    scene_doc = {
        "version": 1,
        "nodes": {
            "tex.wild": {
                "id": "tex.wild",
                "type": "Texture",
                "props": {
                    "src": "/media/g1/%s/gen1.png" % asset.id,
                    "assetId": asset.id,
                },
            }
        },
        "edges": [],
    }

    class _SceneStore:
        async def get_document(self, gid):
            return scene_doc

    class _SceneHub:
        def __init__(self):
            self.ops = []

        async def apply_op(self, gid, op):
            self.ops.append((gid, op))

    shub = _SceneHub()
    sio = FakeSio()
    hub = AssetHub(
        sio,
        store,
        ReplayComfyProvider(progress=[(1, 2), (2, 2)], image=_FAKE_PNG, delay=0.0),
        MediaStore(tmp_path),
        scene_store=_SceneStore(),
        scene_hub=shub,
    )

    await hub.request_generation(game_id, asset.id, auto_select=True)
    await _wait_for(sio, "asset_completed")
    # rebind happens after the emit inside _drain; wait for it
    await _wait_until(lambda: bool(shub.ops))

    refreshed = await store.get_asset(asset.id)
    newest = refreshed.generations[-1]
    assert refreshed.selected_generation_id == newest.id
    assert shub.ops
    assert shub.ops[-1] == (
        game_id,
        {"kind": "setProp", "id": "tex.wild", "path": "src", "value": newest.image_ref},
    )


@pytest.mark.asyncio
async def test_run_forwards_params_into_the_graph(mongo_db, tmp_path):
    """The fake comfy records the graph it received; assert dev params are patched onto it."""
    from app.assets.models import GenParams

    class CapturingProvider:
        def __init__(self):
            self.last_graph = None

        async def generate(self, graph):
            self.last_graph = graph
            yield ProgressEvent(value=1, max=1)
            yield ImageEvent(data=_FAKE_PNG)

    store = AssetStore(mongo_db)
    comfy = CapturingProvider()
    sio = FakeSio()
    hub = AssetHub(sio, store, comfy, MediaStore(tmp_path))
    a = await store.create_asset("g", "logo", "a wordmark", 64, 64, "dev-transparent",
                                 params=GenParams(negative="blurry", steps=28, guidance=3.0, cfg=2.0))
    await hub.generate_and_wait("g", a.id)
    graph = comfy.last_graph
    assert graph["3"]["inputs"]["steps"] == 28 and graph["3"]["inputs"]["cfg"] == 2.0
    assert graph["7"]["inputs"]["text"] == "blurry"
    assert graph["11"]["inputs"]["guidance"] == 3.0
