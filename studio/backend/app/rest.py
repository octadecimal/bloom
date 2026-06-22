from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.catalog import build_model_catalog
from app.models import message_wire, room_wire

router = APIRouter()


class CreateRoomBody(BaseModel):
    name: str
    model: str | None = None


@router.get("/health")
async def health(request: Request) -> dict:
    settings = request.app.state.settings
    return {"status": "ok", "providerMode": settings.provider_mode}


@router.get("/models")
async def list_models(request: Request) -> list[dict]:
    settings = request.app.state.settings
    return build_model_catalog(settings)


@router.get("/rooms")
async def list_rooms(request: Request) -> list[dict]:
    store = request.app.state.store
    rooms = await store.list_rooms()
    return [room_wire(r) for r in rooms]


@router.post("/rooms", status_code=201)
async def create_room(body: CreateRoomBody, request: Request) -> dict:
    store = request.app.state.store
    settings = request.app.state.settings
    model = body.model or settings.default_model
    room = await store.create_room(name=body.name, model=model)
    return room_wire(room)


@router.get("/skills")
async def list_skills(request: Request) -> list[dict]:
    return request.app.state.skill_registry.list_skills()


@router.get("/rooms/{room_id}/messages")
async def list_messages(room_id: str, request: Request) -> list[dict]:
    store = request.app.state.store
    room = await store.get_room(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="room not found")
    messages = await store.list_messages(room_id)
    return [message_wire(m) for m in messages]
