from dataclasses import dataclass
from typing import Any

import socketio
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient

from app.config import Settings, get_settings
from app.rest import router
from app.store import ConversationStore


@dataclass
class AppContext:
    settings: Settings
    fastapi_app: FastAPI
    sio: socketio.AsyncServer
    asgi_app: Any
    store: ConversationStore


def build(settings: Settings) -> AppContext:
    mongo = AsyncIOMotorClient(settings.mongo_url)
    store = ConversationStore(mongo[settings.mongo_db])

    fastapi_app = FastAPI(title="Bloom Studio Backend")
    fastapi_app.state.store = store
    fastapi_app.state.settings = settings
    fastapi_app.include_router(router)

    sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
    asgi_app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

    return AppContext(
        settings=settings,
        fastapi_app=fastapi_app,
        sio=sio,
        asgi_app=asgi_app,
        store=store,
    )


app = build(get_settings()).asgi_app
