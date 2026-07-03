from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from app.assets.models import Asset, Generation

_AUTHORING_FIELDS = {"name", "category", "prompt", "width", "height", "workflow", "seed", "slot"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_doc(asset: Asset) -> dict:
    doc = asset.model_dump(mode="json")  # snake_case keys (no by_alias)
    doc["_id"] = doc.pop("id")
    return doc


def _from_doc(doc: dict) -> Asset:
    data = dict(doc)
    data["id"] = data.pop("_id")
    return Asset.model_validate(data)


class AssetStore:
    def __init__(self, db):
        self._assets = db["assets"]

    async def create_asset(self, game_id, name, prompt, width, height, workflow, seed=None, category=None, slot=None, params=None) -> Asset:
        asset = Asset(
            id=uuid4().hex, game_id=game_id, name=name, category=category, slot=slot,
            prompt=prompt, width=width, height=height, workflow=workflow, seed=seed,
            params=params,
        )
        await self._assets.insert_one(_to_doc(asset))
        return asset

    async def get_by_slot(self, game_id, slot) -> Optional[Asset]:
        doc = await self._assets.find_one({"game_id": game_id, "slot": slot})
        return _from_doc(doc) if doc else None

    async def get_asset(self, asset_id) -> Optional[Asset]:
        doc = await self._assets.find_one({"_id": asset_id})
        return _from_doc(doc) if doc else None

    async def list_assets(self, game_id) -> list[Asset]:
        docs = await self._assets.find({"game_id": game_id}).to_list(length=None)
        return [_from_doc(d) for d in docs]

    async def update_asset(self, asset_id, **fields) -> Asset:
        update = {k: v for k, v in fields.items() if k in _AUTHORING_FIELDS}
        if update:
            await self._assets.update_one({"_id": asset_id}, {"$set": update})
        return await self.get_asset(asset_id)

    async def delete_asset(self, asset_id) -> None:
        await self._assets.delete_one({"_id": asset_id})

    async def set_status(self, asset_id, status, error=None) -> None:
        await self._assets.update_one({"_id": asset_id}, {"$set": {"status": status, "error": error}})

    async def add_generation(self, asset_id, gen_id, seed, image_ref) -> Asset:
        gen = Generation(id=gen_id, seed=seed, image_ref=image_ref, created_at=_now())
        asset = await self.get_asset(asset_id)
        set_fields = {"status": "done", "error": None}
        if asset.selected_generation_id is None:
            set_fields["selected_generation_id"] = gen_id
        await self._assets.update_one(
            {"_id": asset_id},
            {"$push": {"generations": gen.model_dump(mode="json")}, "$set": set_fields},
        )
        return await self.get_asset(asset_id)

    async def select_generation(self, asset_id, gen_id) -> Asset:
        await self._assets.update_one({"_id": asset_id}, {"$set": {"selected_generation_id": gen_id}})
        return await self.get_asset(asset_id)
