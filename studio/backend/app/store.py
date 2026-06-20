from datetime import datetime, timezone
from uuid import uuid4

from app.models import Message, Room


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return uuid4().hex


def _room_to_doc(room: Room) -> dict:
    return {
        "_id": room.id,
        "name": room.name,
        "model": room.model,
        "game_id": room.game_id,
        "created_at": room.created_at,
    }


def _room_from_doc(doc: dict) -> Room:
    return Room(
        id=doc["_id"],
        name=doc["name"],
        model=doc["model"],
        game_id=doc.get("game_id"),
        created_at=doc["created_at"],
    )


def _message_to_doc(message: Message) -> dict:
    return {
        "_id": message.id,
        "room_id": message.room_id,
        "author": message.author,
        "role": message.role,
        "content": message.content,
        "status": message.status,
        "created_at": message.created_at,
    }


def _message_from_doc(doc: dict) -> Message:
    return Message(
        id=doc["_id"],
        room_id=doc["room_id"],
        author=doc["author"],
        role=doc["role"],
        content=doc["content"],
        status=doc["status"],
        created_at=doc["created_at"],
    )


class ConversationStore:
    def __init__(self, db, games=None):
        self._rooms = db["rooms"]
        self._messages = db["messages"]
        self._games = games

    async def create_room(self, name: str, model: str, game_id: str | None = None) -> Room:
        if game_id is None and self._games is not None:
            game = await self._games.create_game(name=name)
            game_id = game.id
        room = Room(id=_new_id(), name=name, model=model, game_id=game_id, created_at=_now())
        await self._rooms.insert_one(_room_to_doc(room))
        return room

    async def list_rooms(self) -> list[Room]:
        docs = await self._rooms.find().sort("created_at", 1).to_list(length=None)
        return [_room_from_doc(d) for d in docs]

    async def get_room(self, room_id: str) -> Room | None:
        doc = await self._rooms.find_one({"_id": room_id})
        return _room_from_doc(doc) if doc else None

    async def list_messages(self, room_id: str) -> list[Message]:
        docs = await self._messages.find({"room_id": room_id}).sort("created_at", 1).to_list(length=None)
        return [_message_from_doc(d) for d in docs]

    async def add_message(self, room_id: str, author: str, role: str, content: str, status: str) -> Message:
        message = Message(
            id=_new_id(),
            room_id=room_id,
            author=author,
            role=role,
            content=content,
            status=status,
            created_at=_now(),
        )
        await self._messages.insert_one(_message_to_doc(message))
        return message

    async def complete_message(self, message_id: str, content: str) -> None:
        await self._messages.update_one(
            {"_id": message_id},
            {"$set": {"content": content, "status": "complete"}},
        )
