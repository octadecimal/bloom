from dataclasses import dataclass
from pathlib import Path
from typing import Any

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from motor.motor_asyncio import AsyncIOMotorClient

from app.agent_tools import ToolFactory
from app.assets.comfy import build_provider as build_comfy_provider
from app.assets.hub import AssetHub
from app.assets.media import MediaStore
from app.assets.rest import router as assets_router
from app.assets.sockets import register_asset_handlers
from app.assets.store import AssetStore
from app.chat_service import ChatService
from app.config import Settings, get_settings
from app.gdd.hub import GddHub
from app.gdd.sockets import register_gdd_handlers
from app.gdd.store import GddStore
from app.scene.hub import GameSceneHub
from app.scene.capture import SceneCaptureBroker
from app.scene.critic import build_scene_critic
from app.scene.asset_critic import build_asset_critic
from app.scene.sockets import register_scene_handlers
from app.scene.reels_spin import build_spin_runner
from app.scene.store import GameSceneStore
from app.simulator.store import SlotModelStore
from app.simulator.hub import CurationHub
from app.simulator.runner import build_curation_runner
from app.simulator.sockets import register_sim_handlers
from app.simulator.rest import router as sim_router
from app.tuner.store import TunerStore
from app.tuner.hub import TunerHub
from app.tuner.runner import build_tuner_runner
from app.tuner.sockets import register_tuner_handlers
from app.tuner.rest import router as tuner_router
from app.presence import PresenceRegistry
from app.providers import build_provider, build_chat_model
from app.rest import router
from app.room_hub import RoomHub
from app.runs import RunStore
from app.skills import SkillRegistry
from app.sockets import register_socket_handlers
from app.turn_runner import TurnRunner
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
    asset_store: AssetStore
    asset_hub: AssetHub


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

    asset_store = AssetStore(mongo[settings.mongo_db])
    media_root = Path(settings.media_dir)
    media_root.mkdir(parents=True, exist_ok=True)
    media = MediaStore(media_root)
    comfy = build_comfy_provider(settings)

    scene_store = GameSceneStore(mongo[settings.mongo_db])
    scene_hub = GameSceneHub(sio, scene_store)

    asset_hub = AssetHub(sio, asset_store, comfy, media, scene_store=scene_store, scene_hub=scene_hub)

    gdd_store = GddStore(mongo[settings.mongo_db])
    gdd_hub = GddHub(sio, gdd_store)

    sim_store = SlotModelStore(mongo[settings.mongo_db])
    sim_hub = CurationHub(sio, sim_store, build_curation_runner(settings), gdd_store)
    tuner_store = TunerStore(mongo[settings.mongo_db])
    tuner_hub = TunerHub(sio, tuner_store, sim_store, build_tuner_runner(settings), gdd_store)

    run_store = RunStore(mongo[settings.mongo_db])
    fastapi_app.state.run_store = run_store
    tool_factory = ToolFactory(asset_store, asset_hub, gdd_store=gdd_store, gdd_hub=gdd_hub,
                               scene_store=scene_store, scene_hub=scene_hub,
                               sim_store=sim_store, tuner_store=tuner_store,
                               tuner_hub=tuner_hub)
    skill_registry = SkillRegistry(Path(settings.skills_dir), tool_factory.known_tool_names())
    skill_registry.load()
    turn_runner = TurnRunner(lambda model: build_chat_model(settings, model), tool_factory)

    presence = PresenceRegistry()
    capture_broker = SceneCaptureBroker(sio)
    scene_critic = build_scene_critic(settings)
    asset_critic = build_asset_critic(settings)
    hub = RoomHub(
        sio, store, chat_service,
        run_store=run_store, turn_runner=turn_runner,
        skills=skill_registry, tool_factory=tool_factory,
        asset_store=asset_store, asset_hub=asset_hub,
        gdd_store=gdd_store, gdd_hub=gdd_hub,
        scene_store=scene_store, scene_hub=scene_hub,
        sim_store=sim_store, tuner_store=tuner_store, tuner_hub=tuner_hub,
        scene_critic=scene_critic, capture_broker=capture_broker,
        asset_critic=asset_critic,
    )
    register_socket_handlers(sio, hub, presence)

    fastapi_app.state.game_store = games
    fastapi_app.state.asset_store = asset_store
    fastapi_app.state.gdd_store = gdd_store
    fastapi_app.state.skill_registry = skill_registry
    fastapi_app.state.sim_store = sim_store
    fastapi_app.state.sim_hub = sim_hub
    fastapi_app.state.tuner_store = tuner_store
    fastapi_app.state.tuner_hub = tuner_hub
    fastapi_app.state.scene_store = scene_store
    fastapi_app.state.scene_hub = scene_hub
    fastapi_app.state.gdd_hub = gdd_hub
    fastapi_app.state.asset_hub = asset_hub
    fastapi_app.state.scene_critic = scene_critic
    fastapi_app.state.asset_critic = asset_critic
    fastapi_app.include_router(assets_router)
    fastapi_app.include_router(sim_router)
    fastapi_app.include_router(tuner_router)
    fastapi_app.mount("/media", StaticFiles(directory=str(media_root)), name="media")

    register_asset_handlers(sio, asset_hub)
    register_gdd_handlers(sio, gdd_hub)
    fastapi_app.state.capture_broker = capture_broker
    spin_runner = build_spin_runner(settings)
    register_scene_handlers(sio, scene_hub, capture_broker, sim_store, spin_runner)
    register_sim_handlers(sio, sim_hub)
    register_tuner_handlers(sio, tuner_hub)

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
        asset_store=asset_store,
        asset_hub=asset_hub,
    )


app = build(get_settings()).asgi_app
