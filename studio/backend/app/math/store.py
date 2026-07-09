"""The one source-of-truth accessor for a game's math config. Was
app/simulator/store.py (SlotModelStore) + app/tuner/store.py (folded in as
tuner_params/tune_result on the same doc) + app/analytics/store.py (MathRunStore).
Collection names are unchanged: slot_models, math_runs. tuner_jobs survives
read-only as the lazy-migration source."""
import uuid
from datetime import datetime, timezone

from pymongo.errors import DuplicateKeyError

from app.math import templates
from app.math.models import (
    CurationParams, CurationResult, MathRunDoc, SectionLocks, SlotModelDoc,
    TuneResult, TuningParams, default_params, default_tuning_params,
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


class MathStore:
    def __init__(self, db, on_change=None):
        # on_change: async (doc: SlotModelDoc, source: str) -> None; fired after
        # any model/presentation/locks write. Wired to a socket emit in main.py —
        # the store itself stays socket-free.
        self._docs = db["slot_models"]
        self._legacy_tuner_jobs = db["tuner_jobs"]  # migration source only
        self._on_change = on_change
        self._indexed = False

    async def _ensure_unique_index(self) -> None:
        """One-time per process: heal race-twin docs (the old check-then-insert
        get_or_seed could double-insert), keeping the natural-first doc — the one
        every unsorted find_one/update_one has always hit — then enforce
        uniqueness at the DB level so the race is impossible from here on."""
        if self._indexed:
            return
        seen: set[str] = set()
        twins: list = []
        async for raw in self._docs.find({}, {"game_id": 1}):
            if raw["game_id"] in seen:
                twins.append(raw["_id"])
            else:
                seen.add(raw["game_id"])
        if twins:
            await self._docs.delete_many({"_id": {"$in": twins}})
        await self._docs.create_index("game_id", unique=True)
        self._indexed = True

    async def get(self, game_id: str) -> SlotModelDoc | None:
        await self._ensure_unique_index()
        raw = await self._docs.find_one({"game_id": game_id})
        if raw is None:
            return None
        if "tuner_params" not in raw:
            raw = await self._migrate_legacy_tuner(raw)
        if not raw.get("model"):
            # Legacy dev docs (old SlotModelStore.get_or_seed stamped model={})
            # must never reach the spin path empty — the DEMO fallback that made
            # {} spinnable is gone. Backfill the default template idempotently.
            model = templates.default_model()
            await self._docs.update_one({"_id": raw["_id"]}, {"$set": {"model": model}})
            raw = {**raw, "model": model}
        if "touched" not in raw:
            # Pre-rework doc: conservatively treat as human-shaped so the
            # re-realize gate applies (spec §9 migration).
            legacy = {"touched": True, "origin": "template",
                      "verdict_stale": False, "shape_stale": False}
            await self._docs.update_one({"_id": raw["_id"]}, {"$set": legacy})
            raw = {**raw, **legacy}
        return _from_doc(raw)

    async def _migrate_legacy_tuner(self, raw: dict) -> dict:
        """One-shot per-doc: fold the legacy tuner_jobs params/result into the
        unified doc and stamp default locks. Idempotent — after the $set the
        'tuner_params' key exists and this never runs again for the doc."""
        legacy = await self._legacy_tuner_jobs.find_one(
            {"game_id": raw["game_id"]}) or {}
        fields = {
            "tuner_params": legacy.get("params")
                or default_tuning_params().model_dump(mode="json"),
            "tune_result": legacy.get("result"),
            "locks": SectionLocks().model_dump(mode="json"),
        }
        await self._docs.update_one({"_id": raw["_id"]}, {"$set": fields})
        return {**raw, **fields}

    async def get_or_seed(self, game_id: str) -> SlotModelDoc:
        existing = await self.get(game_id)
        if existing is not None:
            return existing
        now = _now()
        doc = SlotModelDoc(
            id=str(uuid.uuid4()), game_id=game_id,
            model=templates.default_model(),   # never {}: spec decision 5
            params=default_params(),
            tuner_params=default_tuning_params(),
            locks=SectionLocks(),
            result=None, tune_result=None,
            created_at=now, updated_at=now,
        )
        try:
            await self._docs.insert_one(_to_doc(doc))
        except DuplicateKeyError:
            # A concurrent get_or_seed won the insert; theirs is the doc.
            return await self.get(game_id)
        return doc

    async def put(self, game_id: str, *, model: dict | None = None,
                  params: CurationParams | None = None,
                  tuner_params: TuningParams | None = None,
                  locks: SectionLocks | None = None,
                  presentation: dict | None = None,
                  source: str = "api") -> SlotModelDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if model is not None:
            fields["model"] = model
        if params is not None:
            fields["params"] = params.model_dump(mode="json")
        if tuner_params is not None:
            fields["tuner_params"] = tuner_params.model_dump(mode="json")
        if locks is not None:
            fields["locks"] = locks.model_dump(mode="json")
        if presentation is not None:
            fields["presentation"] = presentation
        if source != "realize" and model is not None:
            fields["touched"] = True
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        changed = model is not None or presentation is not None or locks is not None
        if self._on_change is not None and changed:
            await self._on_change(doc, source)
        return doc

    async def save_realized(self, game_id: str, model: dict) -> SlotModelDoc:
        existing = await self.get_or_seed(game_id)
        fields = {
            "model": model, "origin": "realized", "shape_stale": False,
            "updated_at": _now(),
        }
        if existing.result is not None or existing.tune_result is not None:
            fields["verdict_stale"] = True
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        if self._on_change is not None:
            await self._on_change(doc, "realize")
        return doc

    async def set_stale_flags(self, game_id: str, *,
                              verdict_stale: bool | None = None,
                              shape_stale: bool | None = None) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        fields: dict = {"updated_at": _now()}
        if verdict_stale is not None:
            fields["verdict_stale"] = verdict_stale
        if shape_stale is not None:
            fields["shape_stale"] = shape_stale
        await self._docs.update_one({"game_id": game_id}, {"$set": fields})
        doc = await self.get(game_id)
        if self._on_change is not None:
            await self._on_change(doc, "flags")
        return doc

    async def save_result(self, game_id: str, result: CurationResult) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"result": result.model_dump(mode="json"), "verdict_stale": False, "updated_at": _now()}},
        )
        return await self.get(game_id)

    async def save_tune_result(self, game_id: str, result: TuneResult) -> SlotModelDoc:
        await self.get_or_seed(game_id)
        await self._docs.update_one(
            {"game_id": game_id},
            {"$set": {"tune_result": result.model_dump(mode="json"),
                      "verdict_stale": False,
                      "updated_at": _now()}},
        )
        return await self.get(game_id)


def _run_to_doc(doc: MathRunDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _run_from_doc(raw: dict) -> MathRunDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return MathRunDoc.model_validate(data)


class MathRunStore:
    """Append-only store over `math_runs` (verbatim from app/analytics/store.py)."""

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
        await self._docs.insert_one(_run_to_doc(run))
        return run

    async def list_for_game(self, game_id: str, limit: int = 50) -> list[MathRunDoc]:
        await self._ensure_index()
        cursor = (self._docs.find({"game_id": game_id})
                  .sort("created_at", -1).limit(limit))
        return [_run_from_doc(raw) async for raw in cursor]

    async def get(self, run_id: str) -> MathRunDoc | None:
        raw = await self._docs.find_one({"_id": run_id})
        return _run_from_doc(raw) if raw else None
