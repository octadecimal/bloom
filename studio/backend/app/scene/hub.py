import asyncio

from app.scene.document import empty_document
from app.scene.store import GameSceneStore


class GameSceneHub:
    def __init__(self, sio, store: GameSceneStore):
        self._sio = sio
        self._store = store
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, game_id: str) -> asyncio.Lock:
        return self._locks.setdefault(game_id, asyncio.Lock())

    async def ensure_root(self, game_id: str, canvas: tuple[int, int]) -> dict:
        """Idempotently guarantee a Root node, under the per-game lock.

        Returns ``{"root_id": <id>, "canvas": (w, h)}``. If a Root already
        exists its props give the canvas (each dim defaulting to ``canvas`` when
        missing); otherwise a single ``addNode root`` op creates it and the
        op is broadcast like every other hub mutation. Concurrent callers
        serialize on the lock, so the second sees the first's Root and creates
        nothing — this is what makes parallel ``add_sprite`` calls safe.
        """
        cw, ch = int(canvas[0]), int(canvas[1])
        async with self._lock(game_id):
            doc = await self._store.get_document(game_id) or empty_document()
            nodes = doc.get("nodes", {})
            for nid, n in nodes.items():
                if n.get("type") == "Root":
                    props = n.get("props") or {}
                    ow = int(props.get("width", cw))
                    oh = int(props.get("height", ch))
                    if (ow, oh) == (cw, ch):
                        return {"root_id": nid, "canvas": (ow, oh)}
                    resize_ops = [
                        {"kind": "setProp", "id": nid, "path": "width", "value": cw},
                        {"kind": "setProp", "id": nid, "path": "height", "value": ch},
                    ]
                    await self._store.apply_batch(game_id, resize_ops)
                    broadcast_ops = resize_ops
                    break
            else:
                op = {"kind": "addNode", "id": "root", "type": "Root",
                      "props": {"width": cw, "height": ch}}
                await self._store.apply_op(game_id, op)
                broadcast_ops = [op]
                nid = "root"
        for op in broadcast_ops:
            await self._sio.emit(
                "scene_op", {"gameId": game_id, "op": op}, room=game_id
            )
        return {"root_id": nid, "canvas": (cw, ch)}

    async def attach(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get_or_create(game_id)
        await self._sio.emit(
            "scene_snapshot", {"gameId": game_id, "document": doc}, to=sid
        )

    async def apply_op(self, game_id: str, op: dict) -> dict:
        async with self._lock(game_id):
            doc = await self._store.apply_op(game_id, op)
        await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc

    async def apply_batch(self, game_id: str, ops: list[dict]) -> dict:
        async with self._lock(game_id):
            doc = await self._store.apply_batch(game_id, ops)
        for op in ops:
            await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc

    async def set_modules(self, game_id: str, modules: list[dict]) -> dict:
        async with self._lock(game_id):
            doc = await self._store.set_modules(game_id, modules)
        await self._sio.emit("scene_snapshot", {"gameId": game_id, "document": doc}, room=game_id)
        return doc
