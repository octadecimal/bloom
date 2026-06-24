from app.gdd.models import GddDoc, Status, gdd_wire
from app.gdd.store import GddStore


class GddHub:
    def __init__(self, sio, store: GddStore):
        self._sio = sio
        self._store = store

    async def seed_taxonomy(self, game_id: str) -> list[GddDoc]:
        docs = await self._store.seed_taxonomy(game_id)
        for doc in docs:
            await self._emit_updated(game_id, doc)
        return docs

    async def set_fields(
        self, game_id: str, aspect: str, fields: dict
    ) -> tuple[GddDoc, list[str]]:
        doc, warnings = await self._store.set_fields(game_id, aspect, fields)
        await self._emit_updated(game_id, doc)
        return doc, warnings

    async def set_status(self, game_id: str, aspect: str, status: Status) -> GddDoc:
        doc = await self._store.set_status(game_id, aspect, status)
        await self._emit_updated(game_id, doc)
        return doc

    async def attach(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        docs = await self._store.list_docs(game_id)
        await self._sio.emit(
            "gdd_snapshot",
            {"gameId": game_id, "docs": [gdd_wire(d) for d in docs]},
            to=sid,
        )

    async def _emit_updated(self, game_id: str, doc: GddDoc) -> None:
        await self._sio.emit(
            "gdd_doc_updated",
            {"gameId": game_id, "doc": gdd_wire(doc)},
            room=game_id,
        )
