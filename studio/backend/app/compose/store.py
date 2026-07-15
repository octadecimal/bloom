import uuid
from datetime import datetime, timezone

from pymongo.errors import DuplicateKeyError

from app.compose import templates
from app.compose.models import GameDefinitionDoc


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_doc(doc: GameDefinitionDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> GameDefinitionDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return GameDefinitionDoc.model_validate(data)


class ComposeStore:
    def __init__(self, db, on_change=None):
        # on_change: async (doc, source) -> None; fired after any definition/
        # presentation write. Wired to a socket emit in main.py — the store
        # itself stays socket-free (same choke-point pattern as MathStore).
        self._docs = db["game_definitions"]
        self._on_change = on_change
        self._indexed = False

    async def _ensure_unique_index(self) -> None:
        if self._indexed:
            return
        await self._docs.create_index("game_id", unique=True)
        self._indexed = True

    async def get(self, game_id: str) -> GameDefinitionDoc | None:
        await self._ensure_unique_index()
        raw = await self._docs.find_one({"game_id": game_id})
        if raw is not None and "touched" not in raw:
            # Legacy doc predating the touched field: an authored definition
            # differs from the seed template; a stray auto-seeded doc is
            # byte-equal to it. Mirrors MathStore.get's legacy migration.
            computed = raw.get("definition") != templates.default_definition()
            await self._docs.update_one({"_id": raw["_id"]}, {"$set": {"touched": computed}})
            raw = {**raw, "touched": computed}
        return _from_doc(raw) if raw else None

    async def get_or_seed(self, game_id: str) -> GameDefinitionDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        doc, inserted = await self._insert_seed(game_id)
        if inserted and self._on_change is not None:
            await self._on_change(doc, "seed")
        return doc

    async def _insert_seed(self, game_id: str) -> tuple[GameDefinitionDoc, bool]:
        # Insert-if-missing with no on_change firing — shared by get_or_seed
        # (which fires "seed" itself, but only when inserted is True) and
        # put() (whose own source event already covers the write; firing here
        # too would double-fire on a brand-new game_id).
        # Returns (doc, inserted). The DuplicateKeyError path collapses the
        # concurrent-seeder race and returns inserted=False — the loser must
        # NOT fire "seed" for a doc it didn't insert (exactly-once per insert).
        now = _now()
        doc = GameDefinitionDoc(
            id=str(uuid.uuid4()),
            game_id=game_id,
            definition=templates.default_definition(),  # never {}
            presentation=templates.default_presentation(),
            created_at=now,
            updated_at=now,
        )
        try:
            await self._docs.insert_one(_to_doc(doc))
        except DuplicateKeyError:
            return await self.get(game_id), False  # concurrent seeder won
        return doc, True

    async def put(
        self,
        game_id: str,
        *,
        definition: dict | None = None,
        presentation: dict | None = None,
        source: str = "api",
    ) -> GameDefinitionDoc:
        existing = await self.get(game_id)
        if existing is None:
            await self._insert_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if definition is not None:
            fields["definition"] = definition
            fields["touched"] = True  # a deliberate write — see GameDefinitionDoc.touched
        if presentation is not None:
            fields["presentation"] = presentation
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        changed = definition is not None or presentation is not None
        if self._on_change is not None and changed:
            await self._on_change(doc, source)
        return doc
