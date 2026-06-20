from dataclasses import dataclass
from typing import Any

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient

from app.chat_service import ChatService
from app.config import Settings, get_settings
from app.presence import PresenceRegistry
from app.providers import build_provider
from app.rest import router
from app.room_hub import RoomHub
from app.sockets import register_socket_handlers
from app.games import GameStore
from app.store import ConversationStore


@dataclass
class AppContext:
    settings: Settings
    fastapi_app: FastAPI
    sio: socketio.AsyncServer
    asgi_app: Any
    store: ConversationStore
    chat_service: ChatService
    hub: RoomHub
    presence: PresenceRegistry
    games: GameStore


def build(settings: Settings) -> AppContext:
    mongo = AsyncIOMotorClient(settings.mongo_url)
    games = GameStore(mongo[settings.mongo_db])
    store = ConversationStore(mongo[settings.mongo_db], games)
    chat_service = ChatService(build_provider(settings))

    fastapi_app = FastAPI(title="Bloom Studio Backend")
    # The browser frontend is served from a different origin (e.g. :4200) than
    # this API (:8000), so REST routes must answer CORS preflights and echo the
    # allow-origin header — mirroring the Socket.IO server's allow-all policy
    # below. Without this the browser blocks every fetch (room list/create).
    fastapi_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    fastapi_app.state.store = store
    fastapi_app.state.settings = settings
    fastapi_app.include_router(router)

    sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
    presence = PresenceRegistry()
    hub = RoomHub(sio, store, chat_service)
    register_socket_handlers(sio, hub, presence)

    asgi_app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

    return AppContext(
        settings=settings,
        fastapi_app=fastapi_app,
        sio=sio,
        asgi_app=asgi_app,
        store=store,
        chat_service=chat_service,
        hub=hub,
        presence=presence,
        games=games,
    )


app = build(get_settings()).asgi_app
