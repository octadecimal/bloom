# studio/backend/app/assets/hub.py
import asyncio
from uuid import uuid4

from app.assets.comfy import ImageEvent, ProgressEvent
from app.assets.graph import build_graph, random_seed
from app.assets.models import asset_wire


class AssetHub:
    def __init__(self, sio, asset_store, comfy, media):
        self._sio = sio
        self._store = asset_store
        self._comfy = comfy
        self._media = media
        self._queues: dict[str, list[str]] = {}
        self._busy: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._active: dict[str, dict] = {}  # game_id -> {assetId, value, max}

    def _lock(self, game_id: str) -> asyncio.Lock:
        return self._locks.setdefault(game_id, asyncio.Lock())

    def active_snapshot(self, game_id: str) -> dict | None:
        a = self._active.get(game_id)
        if a is None:
            return None
        return {"gameId": game_id, "assetId": a["assetId"], "value": a["value"], "max": a["max"]}

    async def attach_subscriber(self, game_id: str, sid: str) -> None:
        async with self._lock(game_id):
            await self._sio.enter_room(sid, game_id)
            snap = self.active_snapshot(game_id)
            if snap is not None:
                await self._sio.emit("asset_progress", snap, to=sid)

    async def request_generation(self, game_id: str, asset_id: str) -> None:
        await self._store.set_status(asset_id, "queued")
        async with self._lock(game_id):
            self._queues.setdefault(game_id, []).append(asset_id)
            await self._emit_status(game_id, asset_id, "queued")
            if game_id in self._busy:
                return
            self._busy.add(game_id)
        asyncio.create_task(self._drain(game_id))

    async def _drain(self, game_id: str) -> None:
        while True:
            async with self._lock(game_id):
                queue = self._queues.get(game_id, [])
                if not queue:
                    self._busy.discard(game_id)
                    return
                asset_id = queue.pop(0)
            try:
                await self._run(game_id, asset_id)
            except Exception:
                await self._store.set_status(asset_id, "error", error="generation failed")
                await self._emit_status(game_id, asset_id, "error")

    async def _run(self, game_id: str, asset_id: str) -> None:
        asset = await self._store.get_asset(asset_id)
        seed = asset.seed if asset.seed is not None else random_seed()
        graph = build_graph(asset.workflow, asset.prompt, asset.width, asset.height, seed)

        await self._store.set_status(asset_id, "generating")
        await self._emit_status(game_id, asset_id, "generating")
        async with self._lock(game_id):
            self._active[game_id] = {"assetId": asset_id, "value": 0, "max": 0}

        image_bytes = None
        try:
            async for ev in self._comfy.generate(graph):
                if isinstance(ev, ProgressEvent):
                    async with self._lock(game_id):
                        self._active[game_id].update(value=ev.value, max=ev.max)
                    await self._sio.emit(
                        "asset_progress",
                        {"gameId": game_id, "assetId": asset_id, "value": ev.value, "max": ev.max},
                        room=game_id,
                    )
                elif isinstance(ev, ImageEvent):
                    image_bytes = ev.data
        finally:
            async with self._lock(game_id):
                self._active.pop(game_id, None)

        gen_id = uuid4().hex
        image_ref = self._media.save(game_id, asset_id, gen_id, image_bytes)
        asset = await self._store.add_generation(asset_id, gen_id, seed, image_ref)
        await self._sio.emit("asset_completed", {"gameId": game_id, "asset": asset_wire(asset)}, room=game_id)

    async def generate_and_wait(self, game_id: str, asset_id: str) -> None:
        await self._run(game_id, asset_id)

    async def _emit_status(self, game_id: str, asset_id: str, status: str) -> None:
        depth = len(self._queues.get(game_id, []))
        await self._sio.emit(
            "asset_status",
            {"gameId": game_id, "assetId": asset_id, "status": status, "queueDepth": depth},
            room=game_id,
        )
