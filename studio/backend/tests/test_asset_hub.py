# studio/backend/tests/test_asset_hub.py
import asyncio

import pytest

from app.assets.comfy import FakeComfyProvider
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


@pytest.mark.asyncio
async def test_generation_emits_status_progress_completed(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-transparent", seed=5)
    sio = FakeSio()
    hub = AssetHub(sio, store, FakeComfyProvider(ticks=2), MediaStore(tmp_path))

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
async def test_attach_subscriber_replays_active_progress(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-opaque", seed=1)
    sio = FakeSio()
    # slow provider so the generation is mid-flight when we attach
    hub = AssetHub(sio, store, FakeComfyProvider(ticks=3, delay=0.05), MediaStore(tmp_path))

    await hub.request_generation("g1", asset.id)
    await asyncio.sleep(0.06)  # at least one progress tick recorded
    await hub.attach_subscriber("g1", "sid-late")

    snap_to_sid = [e for e in sio.events if e[0] == "asset_progress" and e[2] == "sid-late"]
    assert snap_to_sid  # the late subscriber got a replayed snapshot
