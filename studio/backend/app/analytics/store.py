from app.analytics.models import MathRunDoc


def _to_doc(doc: MathRunDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> MathRunDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return MathRunDoc.model_validate(data)


class MathRunStore:
    """Append-only store over `math_runs`. Runs are never updated or deleted
    through this store — each call to `append` inserts a new document."""

    def __init__(self, db):
        self._docs = db["math_runs"]
        self._indexed = False

    async def _ensure_index(self) -> None:
        if self._indexed:
            return
        await self._docs.create_index([("game_id", 1), ("created_at", -1)])
        self._indexed = True

    async def append(self, run: MathRunDoc) -> MathRunDoc:
        await self._ensure_index()
        await self._docs.insert_one(_to_doc(run))
        return run

    async def list_for_game(self, game_id: str, limit: int = 50) -> list[MathRunDoc]:
        await self._ensure_index()
        cursor = (
            self._docs.find({"game_id": game_id})
            .sort("created_at", -1)
            .limit(limit)
        )
        return [_from_doc(raw) async for raw in cursor]

    async def get(self, run_id: str) -> MathRunDoc | None:
        raw = await self._docs.find_one({"_id": run_id})
        return _from_doc(raw) if raw else None
