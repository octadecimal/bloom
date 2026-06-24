from datetime import datetime, timezone
from uuid import uuid4

from app.gdd.models import GDD_TAXONOMY, GddDoc, Status


class GddEditError(Exception):
    """Raised when edit_doc's old_string is missing or not unique, or when a
    targeted (game, aspect) doc does not exist (e.g. upsert before seeding)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_doc(doc: GddDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> GddDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return GddDoc.model_validate(data)


class GddStore:
    def __init__(self, db):
        self._docs = db["gdd_docs"]

    async def seed_taxonomy(self, game_id: str) -> list[GddDoc]:
        for entry in GDD_TAXONOMY:
            existing = await self._docs.find_one(
                {"game_id": game_id, "aspect": entry["aspect"]}
            )
            if existing is not None:
                continue
            now = _now()
            doc = GddDoc(
                id=uuid4().hex, game_id=game_id, aspect=entry["aspect"],
                title=entry["title"], order=entry["order"],
                body="", status="empty", created_at=now, updated_at=now,
            )
            await self._docs.insert_one(_to_doc(doc))
        return await self.list_docs(game_id)

    async def list_docs(self, game_id: str) -> list[GddDoc]:
        cursor = self._docs.find({"game_id": game_id}).sort("order", 1)
        return [_from_doc(d) async for d in cursor]

    async def get_doc(self, game_id: str, aspect: str) -> GddDoc | None:
        raw = await self._docs.find_one({"game_id": game_id, "aspect": aspect})
        return _from_doc(raw) if raw else None

    async def upsert_doc(self, game_id: str, aspect: str, *, title=None,
                         body=None, status: Status | None = None) -> GddDoc:
        fields: dict = {"updated_at": _now().isoformat()}
        if title is not None:
            fields["title"] = title
        if body is not None:
            fields["body"] = body
        if status is not None:
            fields["status"] = status
        await self._docs.update_one(
            {"game_id": game_id, "aspect": aspect}, {"$set": fields}
        )
        doc = await self.get_doc(game_id, aspect)
        if doc is None:
            raise GddEditError(
                f"No GDD doc for ({game_id}, {aspect}); seed the taxonomy first."
            )
        return doc

    async def edit_doc(self, game_id: str, aspect: str, old_string: str,
                       new_string: str, replace_all: bool = False) -> GddDoc:
        doc = await self.get_doc(game_id, aspect)
        if doc is None:
            raise GddEditError(f"No GDD doc for aspect '{aspect}'.")
        count = doc.body.count(old_string)
        if count == 0:
            raise GddEditError(f"old_string not found in '{aspect}'.")
        if count > 1 and not replace_all:
            raise GddEditError(
                f"old_string is not unique in '{aspect}' ({count} matches); "
                "pass replace_all=true or a longer, unique string."
            )
        new_body = doc.body.replace(old_string, new_string)
        return await self.upsert_doc(game_id, aspect, body=new_body)

    async def set_status(self, game_id: str, aspect: str, status: Status) -> GddDoc:
        return await self.upsert_doc(game_id, aspect, status=status)
