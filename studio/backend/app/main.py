from dataclasses import dataclass
from typing import Any

import socketio
from fastapi import FastAPI

from app.config import Settings, get_settings
from app.rest import router


@dataclass
class AppContext:
    settings: Settings
    fastapi_app: FastAPI
    sio: socketio.AsyncServer
    asgi_app: Any


def build(settings: Settings) -> AppContext:
    fastapi_app = FastAPI(title="Bloom Studio Backend")
    fastapi_app.include_router(router)

    sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
    asgi_app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

    return AppContext(
        settings=settings,
        fastapi_app=fastapi_app,
        sio=sio,
        asgi_app=asgi_app,
    )


app = build(get_settings()).asgi_app
