"""Per-game region overrides — the human-editable geometry layer (HITL Surface 4).

Reproducibility input #2 (spec §Reproducibility): a small per-game store of
`role -> {set fields}` that `bind()` applies as its final layer. Absolute,
per-field-optional; only the fields a human set are stored. Role keys are
already-canonical (the REST/service boundary canonicalizes before calling here).
"""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class RegionOverride:
    x: float | None = None
    y: float | None = None
    region_w: int | None = None
    region_h: int | None = None
    anchor_x: float | None = None
    anchor_y: float | None = None

    def as_set_fields(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


class RegionOverrideStore:
    """Mongo-backed `game_id -> {role -> {set fields}}`. One collection, _id=game_id,
    mirroring GameSceneStore's single-document-per-game shape."""

    def __init__(self, db):
        self._c = db["region_overrides"]

    async def get(self, game_id: str) -> dict[str, RegionOverride]:
        raw = await self._c.find_one({"_id": game_id})
        if not raw:
            return {}
        return {role: RegionOverride(**fields)
                for role, fields in raw.get("overrides", {}).items()}

    async def set_role(self, game_id: str, role: str, override: RegionOverride) -> None:
        raw = await self._c.find_one({"_id": game_id})
        overrides = dict(raw.get("overrides", {})) if raw else {}
        merged = {**overrides.get(role, {}), **override.as_set_fields()}
        overrides[role] = merged
        await self._c.replace_one(
            {"_id": game_id}, {"_id": game_id, "overrides": overrides}, upsert=True)

    async def clear_role(self, game_id: str, role: str) -> None:
        raw = await self._c.find_one({"_id": game_id})
        if not raw:
            return
        overrides = dict(raw.get("overrides", {}))
        if role in overrides:
            del overrides[role]
            await self._c.replace_one(
                {"_id": game_id}, {"_id": game_id, "overrides": overrides}, upsert=True)
