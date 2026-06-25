import uuid
from datetime import datetime, timezone
from app.tuner.models import TunerJobDoc, TuningParams, TuneResult, default_tuning_params


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_doc(doc: TunerJobDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> TunerJobDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return TunerJobDoc.model_validate(data)


class TunerStore:
    def __init__(self, db):
        self._docs = db["tuner_jobs"]

    async def get(self, game_id: str) -> TunerJobDoc | None:
        raw = await self._docs.find_one({"game_id": game_id})
        return _from_doc(raw) if raw else None

    async def get_or_seed(self, game_id: str) -> TunerJobDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = TunerJobDoc(
            id=str(uuid.uuid4()), game_id=game_id, params=default_tuning_params(),
            result=None, created_at=now, updated_at=now,
        )
        await self._docs.insert_one(_to_doc(doc))
        return doc

    async def put(self, game_id: str, *, params: TuningParams | None = None) -> TunerJobDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        return await self.get(game_id)

    async def save_result(self, game_id: str, result: TuneResult) -> TunerJobDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"result": result.model_dump(mode="json"), "updated_at": _now()}},
        )
        return await self.get(game_id)
