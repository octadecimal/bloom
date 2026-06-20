from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class Game(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    id: str
    name: str
    created_at: datetime


def game_wire(game: Game) -> dict:
    return game.model_dump(by_alias=True, mode="json")


def _doc(game: Game) -> dict:
    return {"_id": game.id, "name": game.name, "created_at": game.created_at}


def _from_doc(doc: dict) -> Game:
    return Game(id=doc["_id"], name=doc["name"], created_at=doc["created_at"])


class GameStore:
    def __init__(self, db):
        self._games = db["games"]

    async def create_game(self, name: str) -> Game:
        game = Game(id=uuid4().hex, name=name, created_at=datetime.now(timezone.utc))
        await self._games.insert_one(_doc(game))
        return game

    async def list_games(self) -> list[Game]:
        docs = await self._games.find().sort("created_at", 1).to_list(length=None)
        return [_from_doc(d) for d in docs]

    async def get_game(self, game_id: str) -> Optional[Game]:
        doc = await self._games.find_one({"_id": game_id})
        return _from_doc(doc) if doc else None
