from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Room(_WireModel):
    id: str
    name: str
    model: str
    game_id: Optional[str] = None
    created_at: datetime


class Message(_WireModel):
    id: str
    room_id: str
    author: str
    role: Literal["user", "assistant"]
    content: str
    status: Literal["streaming", "complete"]
    created_at: datetime


def room_wire(room: Room) -> dict:
    return room.model_dump(by_alias=True, mode="json")


def message_wire(message: Message) -> dict:
    return message.model_dump(by_alias=True, mode="json")
