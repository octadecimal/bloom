# studio/backend/app/assets/hub.py
import asyncio
from uuid import uuid4

from app.assets.comfy import ImageEvent, ProgressEvent
from app.assets.graph import build_graph, random_seed
from app.config import get_settings
from app.assets.models import asset_wire
from app.scene.rebind import rebind_asset_textures


class AssetHub:
    def __init__(self, sio, asset_store, comfy, media, scene_store=None, scene_hub=None):
        self._sio = sio
        self._store = asset_store
        self._comfy = comfy
        self._media = media
        self._scene_store = scene_store
        self._scene_hub = scene_hub
        self._queues: dict[str, list[str]] = {}
        self._busy: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._active: dict[str, dict] = {}  # game_id -> {assetId, value, max}
        self._waiters: dict[str, dict] = {}  # asset_id -> {event, error} (generate_and_wait)
        self._auto_select: set[str] = set()  # asset_ids whose newest gen should auto-select + rebind

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

    async def request_generation(self, game_id: str, asset_id: str, auto_select: bool = False) -> None:
        await self._store.set_status(asset_id, "queued")
        async with self._lock(game_id):
            self._queues.setdefault(game_id, []).append(asset_id)
            if auto_select:
                self._auto_select.add(asset_id)
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
            error: str | None = None
            try:
                await self._run(game_id, asset_id)
            except Exception:
                error = "generation failed"
                await self._store.set_status(asset_id, "error", error=error)
                await self._emit_status(game_id, asset_id, "error")
            finally:
                self._auto_select.discard(asset_id)
                # Unblock any generate_and_wait() awaiting this asset — on success or error.
                self._signal_done(asset_id, error)

    async def _run(self, game_id: str, asset_id: str) -> None:
        asset = await self._store.get_asset(asset_id)
        seed = asset.seed if asset.seed is not None else random_seed()
        p = asset.params
        graph = build_graph(
            asset.workflow, asset.prompt, asset.width, asset.height, seed,
            negative=(p.negative or None) if p else None,
            steps=p.steps if p else None,
            guidance=p.guidance if p else None,
            cfg=p.cfg if p else None,
            upscale=bool(p.upscale) if p else False,
            upscale_model=get_settings().upscale_model,
        )

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
        do_rebind = asset_id in self._auto_select
        if do_rebind:
            self._auto_select.discard(asset_id)
            asset = await self._store.select_generation(asset_id, gen_id)
        await self._sio.emit("asset_completed", {"gameId": game_id, "asset": asset_wire(asset)}, room=game_id)
        if do_rebind and self._scene_store is not None and self._scene_hub is not None:
            await rebind_asset_textures(self._scene_store, self._scene_hub, game_id, asset)

    def _signal_done(self, asset_id: str, error: str | None) -> None:
        rec = self._waiters.get(asset_id)
        if rec is not None:
            rec["error"] = error
            rec["event"].set()

    async def generate_and_wait(self, game_id: str, asset_id: str) -> None:
        """Generate an asset and block until it finishes, reporting failure honestly.

        Routes through the same per-game queue as request_generation so concurrent
        agent-driven generations for one game serialize (one GPU runs them sequentially),
        preserving the single-active-per-game invariant. The work itself runs in _drain;
        we register a per-asset completion signal first, then await it.
        """
        event = asyncio.Event()
        self._waiters[asset_id] = {"event": event, "error": None}
        try:
            await self.request_generation(game_id, asset_id)
            await event.wait()
            error = self._waiters[asset_id]["error"]
            if error is not None:
                raise RuntimeError(error)
        finally:
            self._waiters.pop(asset_id, None)

    async def notify_deleted(self, game_id: str, asset_id: str) -> None:
        await self._sio.emit("asset_deleted", {"gameId": game_id, "assetId": asset_id}, room=game_id)

    async def _emit_status(self, game_id: str, asset_id: str, status: str) -> None:
        depth = len(self._queues.get(game_id, []))
        await self._sio.emit(
            "asset_status",
            {"gameId": game_id, "assetId": asset_id, "status": status, "queueDepth": depth},
            room=game_id,
        )
