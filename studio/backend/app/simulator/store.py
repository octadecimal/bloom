import uuid
from datetime import datetime, timezone
from app.simulator.models import (
    SlotModelDoc, CurationParams, CurationResult, default_params,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_doc(doc: SlotModelDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> SlotModelDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return SlotModelDoc.model_validate(data)


class SlotModelStore:
    def __init__(self, db, on_change=None):
        # on_change: async (doc: SlotModelDoc, source: str) -> None; fired after any
        # model/presentation write. Wired to a socket emit in main.py — the store
        # itself stays socket-free.
        self._docs = db["slot_models"]
        self._on_change = on_change

    async def get(self, game_id: str) -> SlotModelDoc | None:
        raw = await self._docs.find_one({"game_id": game_id})
        return _from_doc(raw) if raw else None

    async def get_or_seed(self, game_id: str) -> SlotModelDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = SlotModelDoc(
            id=str(uuid.uuid4()), game_id=game_id, model={}, params=default_params(),
            result=None, created_at=now, updated_at=now,
        )
        await self._docs.insert_one(_to_doc(doc))
        return doc

    async def put(self, game_id: str, *, model: dict | None = None,
                  params: CurationParams | None = None,
                  presentation: dict | None = None,
                  source: str = "api") -> SlotModelDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if model is not None:
            fields["model"] = model
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        if presentation is not None:
            fields["presentation"] = presentation
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        if self._on_change is not None and (model is not None or presentation is not None):
            await self._on_change(doc, source)
        return doc

    async def save_result(self, game_id: str, result: CurationResult) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"result": result.model_dump(mode="json"), "updated_at": _now()}},
        )
        return await self.get(game_id)
