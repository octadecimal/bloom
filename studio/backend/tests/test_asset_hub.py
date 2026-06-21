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
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if any(e[0] == event for e in sio.events):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"event {event} not emitted; got {[e[0] for e in sio.events]}")


async def _wait_until(predicate, timeout=2.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
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
