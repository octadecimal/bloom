from datetime import datetime, timezone
from uuid import uuid4

from app.gdd.models import GDD_TAXONOMY, GddDoc, Status, derive_status
from app.gdd.schemas import ASPECT_SCHEMAS, schema_for
from app.gdd.normalize import normalize_value
from app.gdd.render import render


class GddEditError(Exception):
    """Raised when a targeted (game, aspect) doc does not exist
    (e.g. set_fields or upsert is called before the taxonomy is seeded)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_doc(doc: GddDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> GddDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    aspect = data.get("aspect")
    if aspect in ASPECT_SCHEMAS and isinstance(data.get("data"), dict):
        allowed = {f.key for f in ASPECT_SCHEMAS[aspect]}
        data["data"] = {k: v for k, v in data["data"].items() if k in allowed}
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

    async def set_fields(
        self, game_id: str, aspect: str, fields: dict
    ) -> tuple[GddDoc, list[str]]:
        doc = await self.get_doc(game_id, aspect)
        if doc is None:
            raise GddEditError(
                f"No GDD doc for ({game_id}, {aspect}); seed the taxonomy first."
            )
        schema = schema_for(aspect)
        by_key = {f.key: f for f in schema}
        new_data = dict(doc.data)
        warnings: list[str] = []
        for key, raw in fields.items():
            field = by_key.get(key)
            if field is None:
                warnings.append(f"unknown field '{key}' for aspect '{aspect}'")
                continue
            value, warn = normalize_value(field, raw)
            if warn:
                warnings.append(warn)
            new_data[key] = value
        status = derive_status(aspect, new_data)
        body = render(schema, new_data)
        await self._docs.update_one(
            {"game_id": game_id, "aspect": aspect},
            {"$set": {
                "data": new_data, "body": body, "status": status,
                "updated_at": _now().isoformat(),
            }},
        )
        updated = await self.get_doc(game_id, aspect)
        assert updated is not None
        return updated, warnings

    async def set_status(self, game_id: str, aspect: str, status: Status) -> GddDoc:
        return await self.upsert_doc(game_id, aspect, status=status)
