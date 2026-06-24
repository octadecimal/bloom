from app.scene.store import GameSceneStore


class GameSceneHub:
    def __init__(self, sio, store: GameSceneStore):
        self._sio = sio
        self._store = store

    async def attach(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get_or_create(game_id)
        await self._sio.emit(
            "scene_snapshot", {"gameId": game_id, "document": doc}, to=sid
        )

    async def apply_op(self, game_id: str, op: dict) -> dict:
        doc = await self._store.apply_op(game_id, op)
        await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc

    async def apply_batch(self, game_id: str, ops: list[dict]) -> dict:
        doc = await self._store.apply_batch(game_id, ops)
        for op in ops:
            await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc
