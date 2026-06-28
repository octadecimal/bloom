from app.scene.document import empty_document
from app.scene.graph_model import GraphModel


def _to_mongo(game_id: str, document: dict) -> dict:
    # Node ids may contain dots, which Mongo forbids in field names, so the
    # nodes dict is persisted as a list and rehydrated on read.
    return {
        "_id": game_id,
        "version": document["version"],
        "nodes": list(document["nodes"].values()),
        "edges": document["edges"],
        "modules": document.get("modules", []),
    }


def _from_mongo(raw: dict) -> dict:
    return {
        "version": raw["version"],
        "nodes": {n["id"]: n for n in raw["nodes"]},
        "edges": raw["edges"],
        "modules": raw.get("modules", []),
    }


class GameSceneStore:
    def __init__(self, db):
        self._scenes = db["game_scenes"]

    async def get_or_create(self, game_id: str) -> dict:
        raw = await self._scenes.find_one({"_id": game_id})
        if raw is None:
            doc = empty_document()
            await self._scenes.insert_one(_to_mongo(game_id, doc))
            return doc
        return _from_mongo(raw)

    async def get_document(self, game_id: str) -> dict | None:
        raw = await self._scenes.find_one({"_id": game_id})
        return _from_mongo(raw) if raw else None

    async def apply_op(self, game_id: str, op: dict) -> dict:
        current = await self.get_or_create(game_id)
        model = GraphModel()
        model.load(current)
        model.apply(op)  # raises OpError; nothing persisted
        doc = model.to_document()
        doc["modules"] = current.get("modules", [])
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc

    async def apply_batch(self, game_id: str, ops: list[dict]) -> dict:
        current = await self.get_or_create(game_id)
        model = GraphModel()
        model.load(current)
        model.apply_batch(ops)  # raises OpError, transactional
        doc = model.to_document()
        doc["modules"] = current.get("modules", [])
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc

    async def set_modules(self, game_id: str, modules: list[dict]) -> dict:
        doc = await self.get_or_create(game_id)
        doc["modules"] = modules
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc
