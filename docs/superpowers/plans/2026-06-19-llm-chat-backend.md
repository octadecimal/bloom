# LLM Chat — Backend Realtime Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `studio/backend` as a FastAPI + Socket.IO service that hosts shared, multi-user, multi-room LLM conversations with real-time token streaming, turn-based serialization, and MongoDB persistence.

**Architecture:** A single ASGI app composes a FastAPI REST surface (room CRUD + history) with a `python-socketio` server (live events). A `RoomHub` owns per-room subscriber fan-out and a per-room turn lock/queue. A thin `ChatService` seam wraps a pluggable `LLMProvider` (Langchain→OpenRouter for real use; a deterministic `FakeProvider` for tests). `ConversationStore` persists rooms and messages in MongoDB via `motor`.

**Tech Stack:** Python 3.12, `uv`, FastAPI, `python-socketio` (asgi), `motor` (async MongoDB), `langchain-openai` + `langchain-core`, `pydantic` / `pydantic-settings`, `pytest` + `pytest-asyncio`, Docker Compose (MongoDB).

This is **Plan A** of two. Plan B (frontend `llm-chat` plugin) is written after this backend is built and merged. The authoritative behavioral contract for this plan is the **two-client Python Socket.IO e2e suite** (Task 7).

## Global Constraints

- **Commits:** Conventional Commits format, imperative mood. Scope `feat(backend): ...` etc.
- **Branching:** `main` is protected. All work lands via PR from a `feat/llm-chat-backend` branch (or per-task branches). Never push to `main`.
- **TDD is mandatory:** RED → GREEN → REFACTOR for every task. Write the failing test, watch it fail, write minimal code, watch it pass, commit.
- **CI cost policy:** the Python Socket.IO suite is **non-browser e2e** and IS run in CI (it is the authoritative contract). No browser/Playwright in this plan.
- **Identity is ephemeral:** display name only; no auth, no user persistence.
- **Single-worker assumption:** the in-memory `RoomHub` assumes one `uvicorn` worker. Multi-worker (Redis pub/sub + distributed lock) is explicitly out of scope.
- **Local MongoDB:** native MongoDB Windows service (installed via `winget MongoDB.Server`, service name `MongoDB`, listening on `mongodb://localhost:27017`), **not Docker Compose**. This is a deliberate deviation from ADR-0001's Compose orchestration — the datastore choice (MongoDB) is unchanged, only how it runs locally. CI (Task 8) still uses a Mongo **service container** on the Linux runner, which is unaffected.
- **Provider:** OpenRouter is the only real backend; key from `OPENROUTER_API_KEY` env, server-side only, never sent to clients.
- **Wire format:** all Socket.IO event payloads and REST JSON use **camelCase** keys (`roomId`, `messageId`, `isTyping`, `createdAt`). Python models are snake_case internally and serialized to camelCase via Pydantic alias generators.
- **Repo Prettier gate:** CI runs `npx prettier --check .` across the repo. Any YAML/JSON/Markdown added here must be Prettier-clean (run `npx prettier --write <files>` before committing). Prettier ignores `.py` files.
- **All paths below are relative to repo root `C:\code\bloom`.**

---

## File Structure

```
studio/backend/
├── pyproject.toml              # uv project, deps, pytest config
├── .python-version             # 3.12
├── .env.example                # documented env vars (no secrets)
├── .gitignore                  # .env, .venv, __pycache__
├── README.md                   # how to run/test the backend
├── app/
│   ├── __init__.py
│   ├── config.py               # Settings (pydantic-settings) + get_settings()
│   ├── models.py               # Room, Message (camelCase wire) + wire helpers
│   ├── store.py                # ConversationStore (motor)
│   ├── providers.py            # LLMProvider protocol, FakeProvider, LangchainOpenRouterProvider, build_provider()
│   ├── chat_service.py         # ChatService seam + build_turns()
│   ├── room_hub.py             # RoomHub: lock/queue + fan-out
│   ├── sockets.py              # register_socket_handlers(sio, hub, presence)
│   ├── presence.py             # PresenceRegistry (room -> {sid: displayName})
│   ├── rest.py                 # FastAPI router: rooms CRUD + history
│   └── main.py                 # build(settings) -> AppContext; module-level app
├── tests/
│   ├── __init__.py
│   ├── conftest.py             # settings, mongo_db, app context, fakes
│   ├── test_models.py
│   ├── test_store.py           # (Mongo)
│   ├── test_rest.py            # (Mongo, httpx)
│   ├── test_chat_service.py
│   ├── test_providers.py
│   ├── test_room_hub.py        # (pure; fakes)
│   └── e2e/
│       ├── __init__.py
│       ├── conftest.py         # live_server fixture (subprocess uvicorn)
│       ├── test_sockets.py     # single-client: join/presence/typing
│       └── test_realtime.py    # AUTHORITATIVE two-client streaming + serialization
justfile                        # add backend-* targets (incl. native mongo service control)
.github/workflows/ci.yml        # add backend job (Mongo service container, CI only)
```

---

## Task 1: Backend scaffold, config, and health endpoint

Stand up the `uv` project, the settings layer, Mongo via Compose, the `just` targets, and a composed ASGI app exposing `GET /health`. This proves the app boots and the FastAPI surface works before any domain logic.

**Files:**
- Create: `studio/backend/pyproject.toml`, `studio/backend/.python-version`, `studio/backend/.env.example`, `studio/backend/.gitignore`, `studio/backend/README.md`
- Create: `studio/backend/app/__init__.py`, `studio/backend/app/config.py`, `studio/backend/app/rest.py`, `studio/backend/app/main.py`
- Create: `studio/backend/tests/__init__.py`, `studio/backend/tests/conftest.py`, `studio/backend/tests/test_health.py`
- Modify: `justfile` (add backend targets, incl. native Mongo service control)

**Interfaces:**
- Produces: `app.config.Settings`, `app.config.get_settings() -> Settings`
- Produces: `app.main.AppContext` dataclass with fields `settings`, `fastapi_app`, `sio`, `asgi_app`, `store`, `chat_service`, `hub`, `presence`
- Produces: `app.main.build(settings: Settings) -> AppContext` and module-level `app.main.app` (the ASGI app for uvicorn)

- [ ] **Step 1: Create the uv project files**

`studio/backend/.python-version`:
```
3.12
```

`studio/backend/pyproject.toml`:
```toml
[project]
name = "bloom-studio-backend"
version = "0.0.0"
description = "Bloom studio backend: shared multi-room LLM chat"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "python-socketio>=5.11",
    "motor>=3.5",
    "langchain-openai>=0.2",
    "langchain-core>=0.3",
    "pydantic>=2.7",
    "pydantic-settings>=2.3",
]

[dependency-groups]
dev = [
    "pytest>=8.2",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
markers = [
    "e2e: end-to-end suite that spawns a live server (requires MongoDB)",
]

[tool.uv]
package = false
```

`studio/backend/.gitignore`:
```
.venv/
__pycache__/
*.pyc
.env
.pytest_cache/
```

`studio/backend/.env.example`:
```
# Copy to .env and fill in. .env is gitignored.
MONGO_URL=mongodb://localhost:27017
MONGO_DB=bloom_studio
# OpenRouter API key (https://openrouter.ai/keys). Required when LLM_BACKEND=openrouter.
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
DEFAULT_MODEL=meta-llama/llama-3.2-3b-instruct:free
# "openrouter" for real calls, "fake" for deterministic local/CI streaming.
LLM_BACKEND=openrouter
FAKE_TOKEN_DELAY=0.0
```

`studio/backend/README.md`:
```markdown
# Bloom Studio Backend

Shared, multi-user, multi-room LLM chat. FastAPI + Socket.IO + MongoDB + Langchain.

## Run

    just mongo-up            # ensure native MongoDB service is running
    cd studio/backend && uv sync
    cp .env.example .env     # fill OPENROUTER_API_KEY
    just backend-serve       # uvicorn on :8000

## Test

    just mongo-up
    just backend-test        # unit + integration (needs Mongo)
    just backend-e2e         # two-client realtime suite (needs Mongo)
```

- [ ] **Step 2: Write the config module**

`studio/backend/app/__init__.py`: (empty file)

`studio/backend/app/config.py`:
```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "bloom_studio"
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    default_model: str = "meta-llama/llama-3.2-3b-instruct:free"
    llm_backend: str = "openrouter"  # "openrouter" | "fake"
    fake_token_delay: float = 0.0


def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 3: Write the failing health test**

`studio/backend/tests/__init__.py`: (empty file)

`studio/backend/tests/conftest.py`:
```python
import pytest

from app.config import Settings
from app.main import build


@pytest.fixture
def settings() -> Settings:
    return Settings(llm_backend="fake", mongo_db="bloom_studio_test")


@pytest.fixture
def ctx(settings):
    return build(settings)
```

`studio/backend/tests/test_health.py`:
```python
import httpx
import pytest


@pytest.mark.asyncio
async def test_health_ok(ctx):
    transport = httpx.ASGITransport(app=ctx.fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
```

- [ ] **Step 4: Run the test to verify it fails**

Run:
```bash
cd studio/backend && uv sync && uv run pytest tests/test_health.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'` (and `app.rest`).

- [ ] **Step 5: Write the REST router and app factory (minimal)**

`studio/backend/app/rest.py`:
```python
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}
```

`studio/backend/app/main.py`:
```python
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
cd studio/backend && uv run pytest tests/test_health.py -v
```
Expected: PASS.

- [ ] **Step 7: Add justfile targets (native Mongo, no Docker)**

MongoDB is installed natively as a Windows service named `MongoDB` (via `winget MongoDB.Server`), listening on `mongodb://localhost:27017`. It auto-starts on boot; the `mongo-up`/`mongo-down` targets just ensure the service is in the desired state. No `compose.yaml` is created (deliberate deviation from ADR-0001 — see Global Constraints).

Append to `justfile`:
```
# Python / studio backend
mongo-up:
    powershell -NoProfile -Command "if ((Get-Service MongoDB).Status -ne 'Running') { Start-Service MongoDB }"

mongo-down:
    powershell -NoProfile -Command "Stop-Service MongoDB"

backend-install:
    cd studio/backend && uv sync

backend-serve:
    cd studio/backend && uv run uvicorn app.main:app --reload --port 8000

backend-test:
    cd studio/backend && uv run pytest -m "not e2e"

backend-e2e:
    cd studio/backend && uv run pytest -m e2e
```

Verify the target works (service should already be running post-install):
```bash
just mongo-up
```
Expected: no error (service running).

- [ ] **Step 8: Commit**

```bash
git add studio/backend justfile
git commit -m "feat(backend): scaffold studio backend with health endpoint"
```

---

## Task 2: Pydantic models + ConversationStore (MongoDB)

Define the `Room` and `Message` domain models (camelCase wire serialization) and the `ConversationStore` that persists them via `motor`. Requires MongoDB (`just mongo-up`).

**Files:**
- Create: `studio/backend/app/models.py`, `studio/backend/app/store.py`
- Create: `studio/backend/tests/test_models.py`, `studio/backend/tests/test_store.py`
- Modify: `studio/backend/tests/conftest.py` (add `mongo_db` fixture)

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `app.models.Room`, `app.models.Message`, `app.models.message_wire(m) -> dict`, `app.models.room_wire(r) -> dict`
- Produces: `app.store.ConversationStore(db)` with async methods:
  - `create_room(name: str, model: str, game_id: str | None = None) -> Room`
  - `list_rooms() -> list[Room]`
  - `get_room(room_id: str) -> Room | None`
  - `list_messages(room_id: str) -> list[Message]`
  - `add_message(room_id: str, author: str, role: str, content: str, status: str) -> Message`
  - `complete_message(message_id: str, content: str) -> None`

- [ ] **Step 1: Write the failing models test**

`studio/backend/tests/test_models.py`:
```python
from datetime import datetime, timezone

from app.models import Message, message_wire


def test_message_wire_is_camel_case():
    msg = Message(
        id="m1",
        room_id="r1",
        author="Alice",
        role="user",
        content="hi",
        status="complete",
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
    )
    wire = message_wire(msg)
    assert wire["roomId"] == "r1"
    assert wire["createdAt"] == "2026-01-01T00:00:00Z"
    assert "room_id" not in wire
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd studio/backend && uv run pytest tests/test_models.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.models'`.

- [ ] **Step 3: Write the models module**

`studio/backend/app/models.py`:
```python
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
```

Note: `mode="json"` renders the `datetime` as ISO-8601. To get the trailing `Z`, store UTC datetimes; Pydantic emits `+00:00`. Adjust the assertion if your Pydantic version emits `+00:00` instead of `Z` — both are valid ISO-8601; the frontend parses either. If you want to force `Z`, the store always uses timezone-aware UTC (Step 6) and you may keep the assertion as `wire["createdAt"].startswith("2026-01-01T00:00:00")`.

- [ ] **Step 4: Run the models test to verify it passes**

Run:
```bash
cd studio/backend && uv run pytest tests/test_models.py -v
```
Expected: PASS. If the `Z`/`+00:00` assertion fails, relax it to `.startswith("2026-01-01T00:00:00")` and re-run.

- [ ] **Step 5: Add the `mongo_db` fixture**

Append to `studio/backend/tests/conftest.py`:
```python
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient


@pytest_asyncio.fixture
async def mongo_db(settings):
    client = AsyncIOMotorClient(settings.mongo_url)
    db = client[settings.mongo_db]
    await db["rooms"].delete_many({})
    await db["messages"].delete_many({})
    yield db
    await db["rooms"].delete_many({})
    await db["messages"].delete_many({})
    client.close()
```

- [ ] **Step 6: Write the failing store test**

`studio/backend/tests/test_store.py`:
```python
import pytest

from app.store import ConversationStore


@pytest.mark.asyncio
async def test_create_and_get_room(mongo_db):
    store = ConversationStore(mongo_db)
    room = await store.create_room(name="General", model="m:free")
    assert room.id
    assert room.game_id is None

    fetched = await store.get_room(room.id)
    assert fetched is not None
    assert fetched.name == "General"


@pytest.mark.asyncio
async def test_messages_round_trip_in_order(mongo_db):
    store = ConversationStore(mongo_db)
    room = await store.create_room(name="R", model="m:free")

    await store.add_message(room.id, "Alice", "user", "hello", "complete")
    assistant = await store.add_message(room.id, "assistant", "assistant", "", "streaming")
    await store.complete_message(assistant.id, "hi there")

    messages = await store.list_messages(room.id)
    assert [m.content for m in messages] == ["hello", "hi there"]
    assert messages[1].status == "complete"
```

- [ ] **Step 7: Run the store test to verify it fails**

Run:
```bash
just mongo-up
cd studio/backend && uv run pytest tests/test_store.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.store'`.

- [ ] **Step 8: Write the store module**

`studio/backend/app/store.py`:
```python
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
    def __init__(self, db):
        self._rooms = db["rooms"]
        self._messages = db["messages"]

    async def create_room(self, name: str, model: str, game_id: str | None = None) -> Room:
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
```

Note on ordering: `created_at` is generated per insert. If two messages land within the same clock tick the sort may tie. For the deterministic-ordering tests this is not observed, but if you ever see flakiness, add a monotonically increasing `seq` field. Not needed now (YAGNI).

- [ ] **Step 9: Run the store test to verify it passes**

Run:
```bash
cd studio/backend && uv run pytest tests/test_store.py tests/test_models.py -v
```
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add studio/backend/app/models.py studio/backend/app/store.py studio/backend/tests
git commit -m "feat(backend): add Room/Message models and Mongo ConversationStore"
```

---

## Task 3: REST endpoints — room CRUD + history

Expose `GET /rooms`, `POST /rooms`, and `GET /rooms/{id}/messages`. Wire the store into the FastAPI app via dependency state on the `AppContext`.

**Files:**
- Modify: `studio/backend/app/main.py` (construct store, attach to app state)
- Modify: `studio/backend/app/rest.py` (room routes)
- Create: `studio/backend/tests/test_rest.py`

**Interfaces:**
- Consumes: `ConversationStore`, `Settings`, `room_wire`, `message_wire`.
- Produces: `AppContext.store: ConversationStore`; REST endpoints returning camelCase JSON:
  - `GET /rooms` → `[room_wire, ...]`
  - `POST /rooms` body `{ "name": str, "model"?: str }` → `room_wire` (201)
  - `GET /rooms/{room_id}/messages` → `[message_wire, ...]`; 404 if room missing.

- [ ] **Step 1: Write the failing REST test**

`studio/backend/tests/test_rest.py`:
```python
import httpx
import pytest


def _client(ctx):
    transport = httpx.ASGITransport(app=ctx.fastapi_app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_create_then_list_rooms(ctx, mongo_db):
    async with _client(ctx) as client:
        created = await client.post("/rooms", json={"name": "General"})
        assert created.status_code == 201
        body = created.json()
        assert body["name"] == "General"
        assert body["model"]  # defaulted
        assert "createdAt" in body

        listed = await client.get("/rooms")
        assert listed.status_code == 200
        assert [r["name"] for r in listed.json()] == ["General"]


@pytest.mark.asyncio
async def test_history_endpoint_and_404(ctx, mongo_db):
    async with _client(ctx) as client:
        created = await client.post("/rooms", json={"name": "R", "model": "m:free"})
        room_id = created.json()["id"]
        await ctx.store.add_message(room_id, "Alice", "user", "hello", "complete")

        history = await client.get(f"/rooms/{room_id}/messages")
        assert history.status_code == 200
        assert history.json()[0]["content"] == "hello"
        assert history.json()[0]["author"] == "Alice"

        missing = await client.get("/rooms/nope/messages")
        assert missing.status_code == 404
```

The `ctx` fixture must now expose `ctx.store` and share the same Mongo DB as `mongo_db`. Update the fixture in the next step.

- [ ] **Step 2: Point the app factory at the test DB and expose the store**

Modify `studio/backend/app/main.py` — add the store to `AppContext` and build it inside `build()`:
```python
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
```

- [ ] **Step 3: Write the room routes**

Replace `studio/backend/app/rest.py`:
```python
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.models import message_wire, room_wire

router = APIRouter()


class CreateRoomBody(BaseModel):
    name: str
    model: str | None = None


@router.get("/health")
async def health() -> dict:
    return {"status": "ok"}


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


@router.get("/rooms/{room_id}/messages")
async def list_messages(room_id: str, request: Request) -> list[dict]:
    store = request.app.state.store
    room = await store.get_room(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="room not found")
    messages = await store.list_messages(room_id)
    return [message_wire(m) for m in messages]
```

- [ ] **Step 4: Run the REST test to verify it passes**

Run:
```bash
just mongo-up
cd studio/backend && uv run pytest tests/test_rest.py -v
```
Expected: PASS (3 assertions across 2 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/main.py studio/backend/app/rest.py studio/backend/tests/test_rest.py
git commit -m "feat(backend): add room CRUD and history REST endpoints"
```

---

## Task 4: ChatService seam + providers (Fake + Langchain/OpenRouter)

Build the thin `ChatService` that converts a room's message history into provider turns (with author attribution) and streams tokens. Provide a deterministic `FakeProvider` (tests/CI) and a `LangchainOpenRouterProvider` (real use), selected by settings.

**Files:**
- Create: `studio/backend/app/providers.py`, `studio/backend/app/chat_service.py`
- Create: `studio/backend/tests/test_providers.py`, `studio/backend/tests/test_chat_service.py`

**Interfaces:**
- Consumes: `app.models.Message`, `app.config.Settings`.
- Produces: `app.providers.LLMProvider` (Protocol with `stream(turns: list[dict], model: str) -> AsyncIterator[str]`), `app.providers.FakeProvider(delay: float = 0.0)`, `app.providers.LangchainOpenRouterProvider(api_key, base_url)`, `app.providers.build_provider(settings) -> LLMProvider`.
- Produces: `app.chat_service.build_turns(messages: list[Message]) -> list[dict]`, `app.chat_service.ChatService(provider)` with `stream(messages: list[Message], model: str) -> AsyncIterator[str]`.
- Turn shape: `{"role": "user" | "assistant", "content": str}`. User turns are attributed: `content = f"{author}: {text}"`.

- [ ] **Step 1: Write the failing providers test**

`studio/backend/tests/test_providers.py`:
```python
import pytest

from app.config import Settings
from app.providers import FakeProvider, build_provider


@pytest.mark.asyncio
async def test_fake_provider_echoes_last_turn():
    provider = FakeProvider(delay=0.0)
    turns = [{"role": "user", "content": "Alice: hello"}]
    tokens = [tok async for tok in provider.stream(turns, "m:free")]
    assert "".join(tokens).strip() == "echo: Alice: hello"
    assert len(tokens) > 1  # streamed as multiple tokens


def test_build_provider_selects_fake_when_configured():
    provider = build_provider(Settings(llm_backend="fake"))
    assert isinstance(provider, FakeProvider)
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
cd studio/backend && uv run pytest tests/test_providers.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.providers'`.

- [ ] **Step 3: Write the providers module**

`studio/backend/app/providers.py`:
```python
import asyncio
from typing import AsyncIterator, Protocol

from app.config import Settings


class LLMProvider(Protocol):
    def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]: ...


class FakeProvider:
    """Deterministic streaming provider for tests/CI. Echoes the last turn."""

    def __init__(self, delay: float = 0.0):
        self._delay = delay

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        last = turns[-1]["content"] if turns else ""
        reply = f"echo: {last}"
        for word in reply.split(" "):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield word + " "


class LangchainOpenRouterProvider:
    """Streams via langchain-openai's ChatOpenAI pointed at OpenRouter."""

    def __init__(self, api_key: str, base_url: str):
        self._api_key = api_key
        self._base_url = base_url

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        from langchain_core.messages import AIMessage, HumanMessage
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(
            model=model,
            api_key=self._api_key,
            base_url=self._base_url,
            streaming=True,
        )
        lc_messages = [
            HumanMessage(t["content"]) if t["role"] == "user" else AIMessage(t["content"])
            for t in turns
        ]
        async for chunk in llm.astream(lc_messages):
            text = chunk.content
            if text:
                yield text


def build_provider(settings: Settings) -> LLMProvider:
    if settings.llm_backend == "fake":
        return FakeProvider(delay=settings.fake_token_delay)
    return LangchainOpenRouterProvider(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )
```

- [ ] **Step 4: Run providers test to verify it passes**

Run:
```bash
cd studio/backend && uv run pytest tests/test_providers.py -v
```
Expected: PASS.

- [ ] **Step 5: Write the failing chat_service test**

`studio/backend/tests/test_chat_service.py`:
```python
from datetime import datetime, timezone

import pytest

from app.chat_service import ChatService, build_turns
from app.models import Message
from app.providers import FakeProvider


def _msg(author, role, content):
    return Message(
        id=f"{author}-{content}",
        room_id="r1",
        author=author,
        role=role,
        content=content,
        status="complete",
        created_at=datetime.now(timezone.utc),
    )


def test_build_turns_attributes_user_messages():
    messages = [
        _msg("Alice", "user", "hello"),
        _msg("assistant", "assistant", "hi"),
    ]
    turns = build_turns(messages)
    assert turns == [
        {"role": "user", "content": "Alice: hello"},
        {"role": "assistant", "content": "hi"},
    ]


@pytest.mark.asyncio
async def test_chat_service_streams_tokens():
    service = ChatService(FakeProvider(delay=0.0))
    messages = [_msg("Bob", "user", "ping")]
    tokens = [tok async for tok in service.stream(messages, "m:free")]
    assert "".join(tokens).strip() == "echo: Bob: ping"
```

- [ ] **Step 6: Run to verify it fails**

Run:
```bash
cd studio/backend && uv run pytest tests/test_chat_service.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.chat_service'`.

- [ ] **Step 7: Write the chat_service module**

`studio/backend/app/chat_service.py`:
```python
from typing import AsyncIterator

from app.models import Message
from app.providers import LLMProvider


def build_turns(messages: list[Message]) -> list[dict]:
    turns: list[dict] = []
    for m in messages:
        if m.role == "user":
            turns.append({"role": "user", "content": f"{m.author}: {m.content}"})
        else:
            turns.append({"role": "assistant", "content": m.content})
    return turns


class ChatService:
    def __init__(self, provider: LLMProvider):
        self._provider = provider

    async def stream(self, messages: list[Message], model: str) -> AsyncIterator[str]:
        async for token in self._provider.stream(build_turns(messages), model):
            yield token
```

- [ ] **Step 8: Run chat_service test to verify it passes**

Run:
```bash
cd studio/backend && uv run pytest tests/test_chat_service.py tests/test_providers.py -v
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add studio/backend/app/providers.py studio/backend/app/chat_service.py studio/backend/tests/test_providers.py studio/backend/tests/test_chat_service.py
git commit -m "feat(backend): add ChatService seam and Fake/OpenRouter providers"
```

---

## Task 5: RoomHub — turn lock/queue + token fan-out

The concurrency core. `RoomHub` persists the user message, broadcasts it, and serializes generations per room: one assistant completion at a time; concurrent prompts queue and run in order. Tested in isolation with fake `sio`, store, and chat service for deterministic control.

**Files:**
- Create: `studio/backend/app/room_hub.py`
- Create: `studio/backend/tests/test_room_hub.py`

**Interfaces:**
- Consumes: `ConversationStore` (duck-typed: `add_message`, `get_room`, `list_messages`, `complete_message`), `ChatService.stream`, and an `sio`-like object with `async emit(event, data=None, room=None)`.
- Produces: `app.room_hub.RoomHub(sio, store, chat_service)` with `async handle_prompt(room_id: str, author: str, text: str) -> None`.
- Emits these events (all with `room=room_id`): `message_created {message}`, `token {roomId, messageId, delta}`, `message_completed {roomId, messageId}`, `ai_status {roomId, state, queueDepth}` where state ∈ `{"idle","generating","queued"}`.

- [ ] **Step 1: Write the failing RoomHub tests**

`studio/backend/tests/test_room_hub.py`:
```python
import asyncio
from datetime import datetime, timezone

import pytest

from app.models import Message
from app.room_hub import RoomHub


class FakeSio:
    def __init__(self):
        self.events: list[tuple] = []

    async def emit(self, event, data=None, room=None):
        self.events.append((event, data, room))

    def names(self):
        return [e[0] for e in self.events]


class FakeStore:
    def __init__(self, model="m:free"):
        self._model = model
        self.messages: list[Message] = []
        self._n = 0

    async def get_room(self, room_id):
        from app.models import Room

        return Room(id=room_id, name="R", model=self._model, created_at=datetime.now(timezone.utc))

    async def add_message(self, room_id, author, role, content, status):
        self._n += 1
        msg = Message(
            id=f"msg{self._n}",
            room_id=room_id,
            author=author,
            role=role,
            content=content,
            status=status,
            created_at=datetime.now(timezone.utc),
        )
        self.messages.append(msg)
        return msg

    async def list_messages(self, room_id):
        return [m for m in self.messages if m.room_id == room_id]

    async def complete_message(self, message_id, content):
        for m in self.messages:
            if m.id == message_id:
                m.content = content
                m.status = "complete"


class GatedChatService:
    """Each stream() call gates on its own release event so tests control timing."""

    def __init__(self):
        self.calls: list[dict] = []

    def new_call(self):
        gate = {"started": asyncio.Event(), "release": asyncio.Event()}
        self.calls.append(gate)
        return gate

    async def stream(self, messages, model):
        gate = self.new_call()
        gate["started"].set()
        await gate["release"].wait()
        for tok in ["a", "b"]:
            yield tok


@pytest.mark.asyncio
async def test_single_prompt_streams_and_completes():
    sio, store, chat = FakeSio(), FakeStore(), GatedChatService()
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "hello")
    await asyncio.wait_for(_wait_calls(chat, 1), timeout=1)
    chat.calls[0]["release"].set()
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=1)

    names = sio.names()
    # user message, generating status, assistant message, 2 tokens, completed, idle status
    assert names.count("message_created") == 2
    assert names.count("token") == 2
    assert "message_completed" in names
    statuses = [d["state"] for e, d, _ in sio.events if e == "ai_status"]
    assert statuses[0] == "generating"
    assert statuses[-1] == "idle"


@pytest.mark.asyncio
async def test_concurrent_prompts_are_serialized():
    sio, store, chat = FakeSio(), FakeStore(), GatedChatService()
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "first")
    await asyncio.wait_for(_wait_calls(chat, 1), timeout=1)  # gen 1 running

    await hub.handle_prompt("r1", "Bob", "second")  # arrives mid-generation
    await asyncio.sleep(0.05)
    # second generation must NOT have started yet
    assert len(chat.calls) == 1
    assert any(e == "ai_status" and d["state"] == "queued" for e, d, _ in sio.events)

    chat.calls[0]["release"].set()  # finish gen 1
    await asyncio.wait_for(_wait_calls(chat, 2), timeout=1)  # gen 2 starts
    chat.calls[1]["release"].set()
    await asyncio.sleep(0.05)

    completed = [d["messageId"] for e, d, _ in sio.events if e == "message_completed"]
    assert len(completed) == 2  # both answered, in order


async def _wait_calls(chat, n):
    while len(chat.calls) < n:
        await asyncio.sleep(0.01)


async def _wait_event(sio, name):
    while name not in sio.names():
        await asyncio.sleep(0.01)
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
cd studio/backend && uv run pytest tests/test_room_hub.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'app.room_hub'`.

- [ ] **Step 3: Write the RoomHub module**

`studio/backend/app/room_hub.py`:
```python
import asyncio

from app.models import message_wire


class RoomHub:
    def __init__(self, sio, store, chat_service):
        self._sio = sio
        self._store = store
        self._chat = chat_service
        self._queues: dict[str, list[str]] = {}
        self._busy: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, room_id: str) -> asyncio.Lock:
        return self._locks.setdefault(room_id, asyncio.Lock())

    async def handle_prompt(self, room_id: str, author: str, text: str) -> None:
        user_msg = await self._store.add_message(room_id, author, "user", text, "complete")
        await self._sio.emit("message_created", {"message": message_wire(user_msg)}, room=room_id)

        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append(user_msg.id)
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
                return
            self._busy.add(room_id)

        asyncio.create_task(self._drain(room_id))

    async def _drain(self, room_id: str) -> None:
        try:
            while True:
                async with self._lock(room_id):
                    queue = self._queues.get(room_id, [])
                    if not queue:
                        self._busy.discard(room_id)
                        await self._emit_status(room_id, "idle")
                        return
                    queue.pop(0)
                await self._run_generation(room_id)
        except Exception:
            async with self._lock(room_id):
                self._busy.discard(room_id)
            await self._emit_status(room_id, "idle")
            raise

    async def _run_generation(self, room_id: str) -> None:
        room = await self._store.get_room(room_id)
        await self._emit_status(room_id, "generating")

        assistant = await self._store.add_message(room_id, "assistant", "assistant", "", "streaming")
        await self._sio.emit("message_created", {"message": message_wire(assistant)}, room=room_id)

        history = await self._store.list_messages(room_id)
        context = [m for m in history if m.id != assistant.id]

        content = ""
        async for token in self._chat.stream(context, room.model):
            content += token
            await self._sio.emit(
                "token",
                {"roomId": room_id, "messageId": assistant.id, "delta": token},
                room=room_id,
            )

        await self._store.complete_message(assistant.id, content)
        await self._sio.emit(
            "message_completed",
            {"roomId": room_id, "messageId": assistant.id},
            room=room_id,
        )

    async def _emit_status(self, room_id: str, state: str) -> None:
        depth = len(self._queues.get(room_id, []))
        await self._sio.emit(
            "ai_status",
            {"roomId": room_id, "state": state, "queueDepth": depth},
            room=room_id,
        )
```

- [ ] **Step 4: Run the RoomHub tests to verify they pass**

Run:
```bash
cd studio/backend && uv run pytest tests/test_room_hub.py -v
```
Expected: PASS (both tests). If `test_concurrent_prompts_are_serialized` is flaky, increase the `asyncio.sleep(0.05)` settling waits to `0.1`; the assertions (only one `chat.calls` entry while busy; two completions after release) are the contract.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/room_hub.py studio/backend/tests/test_room_hub.py
git commit -m "feat(backend): add RoomHub with per-room turn lock and token fan-out"
```

---

## Task 6: Socket.IO handlers, presence, and the live-server harness

Wire Socket.IO events to the hub and a `PresenceRegistry`, compose everything in `build()`, and establish the e2e harness (a subprocess uvicorn fixture). First socket coverage: connect with a display name, join a room, receive presence, broadcast typing.

**Files:**
- Create: `studio/backend/app/presence.py`, `studio/backend/app/sockets.py`
- Modify: `studio/backend/app/main.py` (construct chat_service, hub, presence; register handlers)
- Create: `studio/backend/tests/e2e/__init__.py`, `studio/backend/tests/e2e/conftest.py`, `studio/backend/tests/e2e/test_sockets.py`
- Modify: `studio/backend/pyproject.toml` (add `python-socketio[asyncio_client]` to dev deps)

**Interfaces:**
- Consumes: `RoomHub.handle_prompt`, `ConversationStore`, `ChatService`, `build_provider`.
- Produces: `app.presence.PresenceRegistry` with `join(room_id, sid, name)`, `leave_all(sid) -> list[str]`, `leave(room_id, sid)`, `members(room_id) -> list[str]`.
- Produces: `app.sockets.register_socket_handlers(sio, hub, presence)`.
- Produces: `AppContext.chat_service`, `AppContext.hub`, `AppContext.presence`.
- Socket events handled: `connect` (auth `{displayName}`), `join_room {roomId}`, `leave_room {roomId}`, `send_prompt {roomId, text}`, `typing {roomId, isTyping}`, `disconnect`.
- Socket events emitted to clients: `presence {roomId, members}`, `typing {roomId, author, isTyping}`, plus all `RoomHub` events.

- [ ] **Step 1: Add the async socket.io client dev dependency**

In `studio/backend/pyproject.toml`, change the dev group to include the asyncio client extra:
```toml
[dependency-groups]
dev = [
    "pytest>=8.2",
    "pytest-asyncio>=0.23",
    "httpx>=0.27",
    "python-socketio[asyncio_client]>=5.11",
]
```
Then:
```bash
cd studio/backend && uv sync
```

- [ ] **Step 2: Write the PresenceRegistry (with a quick unit test)**

`studio/backend/app/presence.py`:
```python
class PresenceRegistry:
    def __init__(self):
        self._rooms: dict[str, dict[str, str]] = {}

    def join(self, room_id: str, sid: str, name: str) -> None:
        self._rooms.setdefault(room_id, {})[sid] = name

    def leave(self, room_id: str, sid: str) -> None:
        room = self._rooms.get(room_id)
        if room:
            room.pop(sid, None)

    def leave_all(self, sid: str) -> list[str]:
        affected = []
        for room_id, members in self._rooms.items():
            if sid in members:
                members.pop(sid, None)
                affected.append(room_id)
        return affected

    def members(self, room_id: str) -> list[str]:
        return sorted(self._rooms.get(room_id, {}).values())
```

`studio/backend/tests/test_presence.py`:
```python
from app.presence import PresenceRegistry


def test_presence_tracks_and_removes_members():
    p = PresenceRegistry()
    p.join("r1", "sidA", "Alice")
    p.join("r1", "sidB", "Bob")
    assert p.members("r1") == ["Alice", "Bob"]

    affected = p.leave_all("sidA")
    assert affected == ["r1"]
    assert p.members("r1") == ["Bob"]
```

Run:
```bash
cd studio/backend && uv run pytest tests/test_presence.py -v
```
Expected: PASS.

- [ ] **Step 3: Write the socket handlers**

`studio/backend/app/sockets.py`:
```python
def register_socket_handlers(sio, hub, presence):
    @sio.event
    async def connect(sid, environ, auth):
        name = (auth or {}).get("displayName") or "anon"
        await sio.save_session(sid, {"displayName": name})

    @sio.event
    async def disconnect(sid):
        for room_id in presence.leave_all(sid):
            await sio.emit("presence", {"roomId": room_id, "members": presence.members(room_id)}, room=room_id)

    @sio.on("join_room")
    async def join_room(sid, data):
        room_id = data["roomId"]
        session = await sio.get_session(sid)
        await sio.enter_room(sid, room_id)
        presence.join(room_id, sid, session["displayName"])
        await sio.emit("presence", {"roomId": room_id, "members": presence.members(room_id)}, room=room_id)

    @sio.on("leave_room")
    async def leave_room(sid, data):
        room_id = data["roomId"]
        await sio.leave_room(sid, room_id)
        presence.leave(room_id, sid)
        await sio.emit("presence", {"roomId": room_id, "members": presence.members(room_id)}, room=room_id)

    @sio.on("send_prompt")
    async def send_prompt(sid, data):
        session = await sio.get_session(sid)
        await hub.handle_prompt(data["roomId"], session["displayName"], data["text"])

    @sio.on("typing")
    async def typing(sid, data):
        room_id = data["roomId"]
        session = await sio.get_session(sid)
        await sio.emit(
            "typing",
            {"roomId": room_id, "author": session["displayName"], "isTyping": bool(data["isTyping"])},
            room=room_id,
            skip_sid=sid,
        )
```

Note: `skip_sid=sid` on `typing` means the sender does not receive their own typing echo (other room members do). The `presence` broadcast intentionally includes the joining client so it learns the current member list immediately.

- [ ] **Step 4: Compose everything in build()**

Replace `studio/backend/app/main.py`:
```python
from dataclasses import dataclass
from typing import Any

import socketio
from fastapi import FastAPI
from motor.motor_asyncio import AsyncIOMotorClient

from app.chat_service import ChatService
from app.config import Settings, get_settings
from app.presence import PresenceRegistry
from app.providers import build_provider
from app.rest import router
from app.room_hub import RoomHub
from app.sockets import register_socket_handlers
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


def build(settings: Settings) -> AppContext:
    mongo = AsyncIOMotorClient(settings.mongo_url)
    store = ConversationStore(mongo[settings.mongo_db])
    chat_service = ChatService(build_provider(settings))

    fastapi_app = FastAPI(title="Bloom Studio Backend")
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
    )


app = build(get_settings()).asgi_app
```

- [ ] **Step 5: Write the live-server e2e harness**

`studio/backend/tests/e2e/__init__.py`: (empty file)

`studio/backend/tests/e2e/conftest.py`:
```python
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def live_server():
    port = _free_port()
    env = {
        **os.environ,
        "LLM_BACKEND": "fake",
        "FAKE_TOKEN_DELAY": "0.15",
        "MONGO_DB": "bloom_studio_e2e",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=str(BACKEND_DIR),
        env=env,
    )
    base_url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            if httpx.get(f"{base_url}/health", timeout=1).status_code == 200:
                break
        except Exception:
            time.sleep(0.2)
    else:
        proc.terminate()
        raise RuntimeError("live server did not start")

    yield base_url

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
```

- [ ] **Step 6: Write the failing single-client socket test**

`studio/backend/tests/e2e/test_sockets.py`:
```python
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> str:
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/rooms", json={"name": "E2E"})
        return resp.json()["id"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_join_emits_presence(live_server):
    room_id = await _make_room(live_server)
    client = socketio.AsyncClient()
    presence_events = []
    client.on("presence", lambda data: presence_events.append(data))

    await client.connect(live_server, auth={"displayName": "Alice"})
    await client.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.3)

    assert presence_events
    assert "Alice" in presence_events[-1]["members"]
    await client.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_typing_is_broadcast_to_other_members(live_server):
    room_id = await _make_room(live_server)
    alice = socketio.AsyncClient()
    bob = socketio.AsyncClient()
    bob_typing = []
    bob.on("typing", lambda data: bob_typing.append(data))

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("typing", {"roomId": room_id, "isTyping": True})
    await asyncio.sleep(0.2)

    assert bob_typing
    assert bob_typing[-1]["author"] == "Alice"
    assert bob_typing[-1]["isTyping"] is True
    await alice.disconnect()
    await bob.disconnect()
```

- [ ] **Step 7: Run to verify it fails, then passes**

Run:
```bash
just mongo-up
cd studio/backend && uv run pytest -m e2e tests/e2e/test_sockets.py -v
```
First run (before Steps 3–4 were saved) would fail; with all steps saved, expected: PASS. If the handlers/build were already written, confirm PASS here. If presence events are empty, increase the `asyncio.sleep` waits to `0.5`.

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/presence.py studio/backend/app/sockets.py studio/backend/app/main.py studio/backend/pyproject.toml studio/backend/tests/test_presence.py studio/backend/tests/e2e
git commit -m "feat(backend): wire Socket.IO handlers, presence, and e2e harness"
```

---

## Task 7: Authoritative two-client realtime suite

The behavioral contract for this plan: two clients in one room, A sends a prompt, **both** receive ordered tokens and the completed message; concurrent prompts serialize; messages carry attribution. This is the suite that decides correctness.

**Files:**
- Create: `studio/backend/tests/e2e/test_realtime.py`

**Interfaces:**
- Consumes: the `live_server` fixture (Task 6), the full socket/REST surface.
- Produces: no new code — this is the contract suite over existing behavior.

- [ ] **Step 1: Write the two-client streaming test**

`studio/backend/tests/e2e/test_realtime.py`:
```python
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> str:
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/rooms", json={"name": "Realtime"})
        return resp.json()["id"]


class Recorder:
    def __init__(self, client: socketio.AsyncClient):
        self.tokens: list[dict] = []
        self.created: list[dict] = []
        self.completed: list[dict] = []
        client.on("token", lambda d: self.tokens.append(d))
        client.on("message_created", lambda d: self.created.append(d))
        client.on("message_completed", lambda d: self.completed.append(d))

    def text_for(self, message_id: str) -> str:
        return "".join(t["delta"] for t in self.tokens if t["messageId"] == message_id)


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_both_clients_receive_streamed_tokens(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra, rb = Recorder(alice), Recorder(bob)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    # wait for completion on both sides
    deadline = asyncio.get_event_loop().time() + 5
    while (not ra.completed or not rb.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert ra.completed and rb.completed, "both clients must see completion"
    assistant_id = ra.completed[-1]["messageId"]

    # both clients reconstruct the same streamed assistant text
    assert ra.text_for(assistant_id) == rb.text_for(assistant_id)
    assert ra.text_for(assistant_id).strip() == "echo: Alice: hello"

    # Alice's user message is attributed to Alice and seen by Bob
    user_msgs = [c["message"] for c in rb.created if c["message"]["role"] == "user"]
    assert user_msgs[-1]["author"] == "Alice"

    await alice.disconnect()
    await bob.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_concurrent_prompts_serialize_into_two_answers(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra = Recorder(alice)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    # fire two prompts almost simultaneously; FAKE_TOKEN_DELAY=0.15 keeps gen 1 busy
    await alice.emit("send_prompt", {"roomId": room_id, "text": "first"})
    await bob.emit("send_prompt", {"roomId": room_id, "text": "second"})

    deadline = asyncio.get_event_loop().time() + 8
    while len(ra.completed) < 2 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert len(ra.completed) == 2, "both prompts answered exactly once each"

    # verify history persisted: 2 user + 2 assistant messages, all complete
    async with httpx.AsyncClient(base_url=live_server) as client:
        history = (await client.get(f"/rooms/{room_id}/messages")).json()
    roles = [m["role"] for m in history]
    assert roles.count("user") == 2
    assert roles.count("assistant") == 2
    assert all(m["status"] == "complete" for m in history)

    await alice.disconnect()
    await bob.disconnect()
```

- [ ] **Step 2: Run the authoritative suite**

Run:
```bash
just mongo-up
cd studio/backend && uv run pytest -m e2e -v
```
Expected: PASS (all e2e tests across `test_sockets.py` and `test_realtime.py`). If timing-sensitive assertions flake, the contract is the assertion content, not the sleeps — bump `FAKE_TOKEN_DELAY` (in `e2e/conftest.py`) and the polling deadlines, never weaken an assertion.

- [ ] **Step 3: Run the full suite (unit + integration + e2e)**

Run:
```bash
cd studio/backend && uv run pytest -v
```
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add studio/backend/tests/e2e/test_realtime.py
git commit -m "test(backend): add authoritative two-client realtime e2e suite"
```

---

## Task 8: CI integration

Add a `backend` job to the existing CI workflow that provisions MongoDB, installs deps with `uv`, and runs the full Python suite (unit + integration + non-browser e2e) per the repo's CI cost policy.

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the full backend test suite.
- Produces: a CI job that gates PRs on backend tests.

- [ ] **Step 1: Add the backend CI job**

Append this job under `jobs:` in `.github/workflows/ci.yml` (sibling to `rust` and `frontend`):
```yaml
  backend:
    name: Backend (pytest unit + e2e)
    runs-on: ubuntu-latest
    services:
      mongo:
        image: mongo:7
        ports:
          - 27017:27017
    steps:
      - uses: actions/checkout@v4

      - uses: astral-sh/setup-uv@v5
        with:
          enable-cache: true

      - name: Install dependencies
        working-directory: studio/backend
        run: uv sync

      - name: Test (unit + integration)
        working-directory: studio/backend
        env:
          MONGO_URL: mongodb://localhost:27017
          MONGO_DB: bloom_studio_ci
        run: uv run pytest -m "not e2e" -v

      - name: Test (non-browser e2e)
        working-directory: studio/backend
        env:
          MONGO_URL: mongodb://localhost:27017
        run: uv run pytest -m e2e -v
```

Note: the e2e `live_server` fixture sets `LLM_BACKEND=fake` and `MONGO_DB=bloom_studio_e2e` in the subprocess env itself, and inherits `MONGO_URL` from `os.environ` — so the job-level `MONGO_URL` reaches the spawned server. No OpenRouter key is needed in CI (the fake provider is used throughout).

- [ ] **Step 2: Validate the workflow YAML formatting**

Run:
```bash
npx prettier --write .github/workflows/ci.yml
```
Confirm no other files were reformatted (the plan's earlier Prettier runs kept YAML clean). Re-read the file to confirm the `backend` job is well-formed and indentation matches the existing jobs.

- [ ] **Step 3: Commit and open the PR**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run studio backend tests (unit + non-browser e2e) with Mongo"
git push -u origin feat/llm-chat-backend
gh pr create --fill
```

- [ ] **Step 4: Verify CI is green**

After the PR run completes:
```bash
gh pr checks
```
Expected: the `Backend (pytest unit + e2e)` check passes alongside `rust` and `frontend`. If it fails, read the logs (`gh run view --log-failed`), fix, and push — do not merge on red.

---

## Self-Review

**1. Spec coverage** (checked against `docs/superpowers/specs/2026-06-19-llm-chat-design.md`):

| Spec section | Covered by |
|---|---|
| §4 Architecture (FastAPI + Socket.IO composed ASGI) | Task 1 (`build`/`asgi_app`), Task 6 (compose all) |
| §5 Data model (`rooms`, `messages`, nullable `gameId`, not-persisted users) | Task 2 (`Room.game_id`, `Message`, store) |
| §6 Realtime protocol (all events, camelCase) | Task 5 (hub events), Task 6 (presence/typing), Task 7 (contract) |
| §6 History via REST, not sockets | Task 3 (`GET /rooms/{id}/messages`), Task 7 (history assertion) |
| §7 Turn-based lock/queue (4 steps) | Task 5 (`RoomHub`), Task 7 (serialization contract) |
| §8 Provider/config (OpenRouter env, per-room model) | Task 1 (`Settings`), Task 3 (per-room `model`), Task 4 (providers) |
| §10 Testing (pytest unit + Python Socket.IO e2e, CI-gated) | Tasks 2,4,5 (unit), Tasks 6,7 (e2e), Task 8 (CI) |
| §11 Scope (Mongo, justfile, uv) | Task 1 (native Mongo service, justfile, uv) |
| §11 Scaling seam documented (single worker) | Global Constraints + this plan's header |

Frontend plugin (§9) is intentionally Plan B — not in scope here.

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling"/"similar to Task N". Every code step contains complete code; every command lists its expected result.

**3. Type consistency:** `ConversationStore` method names (`create_room`, `list_rooms`, `get_room`, `list_messages`, `add_message`, `complete_message`) are identical in Tasks 2, 3, 5, 6. `RoomHub.handle_prompt(room_id, author, text)` is identical in Tasks 5 and 6. `ChatService.stream(messages, model)` and provider `stream(turns, model)` are consistent across Tasks 4, 5. Event payload key casing (`roomId`, `messageId`, `isTyping`, `createdAt`) is consistent across Tasks 5, 6, 7 and the wire helpers in Task 2. `build(settings) -> AppContext` grows fields across Tasks 1, 3, 6 without renaming existing ones.

---

## Open follow-ups (Plan B and beyond — not this plan)

- Frontend `llm-chat` plugin (Plan B): panes, `socket.io-client`, hookstate slice, Settings model picker.
- In-flight stream resume on reconnect (a client joining mid-generation sees completed history via REST but not the partial in-progress stream). Acceptable for MVP; specify if needed.
- Crash recovery for messages left in `streaming` status after an ungraceful shutdown.
- Multi-worker scaling: Redis pub/sub fan-out + distributed per-room lock.
```
