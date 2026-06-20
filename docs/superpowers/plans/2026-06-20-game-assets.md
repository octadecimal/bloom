# Game Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an `assets` plugin (studio backend + frontend) where a designer authors **Asset** entities under a **Game** and generates images through the ComfyUI pipeline with real-time progress over Socket.IO, keeping a selectable history of candidate generations.

**Architecture:** A shared thin `Game` spine (`app/games.py`) created when a chat room is created; an `app/assets/` backend subpackage (models, store, graph-patching, ComfyUI provider seam, an `AssetHub` mirroring the chat `RoomHub`, REST + socket handlers, static media serving); and a frontend `src/plugins/assets/` plugin mirroring `llm-chat` (pure reducers, REST client, its own Socket.IO client, actions, an Asset Board pane with per-asset scoped-subscription cards).

**Tech Stack:** Python (FastAPI + python-socketio + motor/MongoDB + pydantic), Rust untouched, TypeScript/React (hookstate, dockview, socket.io-client, sonner), pytest, vitest, Playwright.

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IAsset`, `IGame`) — `docs/coding-standards.md`.
- **Conventional Commits** for every commit (`feat:`, `test:`, `fix:`, …) — `AGENTS.md`.
- **TDD is mandatory**: failing test → watch fail → minimal code → pass → commit.
- **Wire shapes are camelCase** (pydantic `to_camel` alias generator), mirroring `app/models.py`.
- **Browser e2e (Playwright) is NOT run in CI**; runs locally. Backend unit + non-browser e2e are CI-affordable.
- **`COMFY_BACKEND=fake`** in all tests/CI — never a real GPU.
- **Plugins import `notify` (`src/lib/notify.ts`), never `sonner` directly.**
- Backend tests run from `studio/backend` via `uv run pytest`; mark non-browser e2e with `@pytest.mark.e2e`.
- `imageRef` is a backend-relative path (`/media/...`); the frontend renders it as `${BACKEND_URL}${imageRef}`.

---

## File Structure

**Backend (`studio/backend/`):**

- `app/games.py` — _create_ — `Game` model + `GameStore` (games collection).
- `app/assets/__init__.py` — _create_ — package marker.
- `app/assets/models.py` — _create_ — `Asset`, `Generation` wire models + `asset_wire`.
- `app/assets/store.py` — _create_ — `AssetStore` (assets collection): CRUD, status, generations.
- `app/assets/graph.py` — _create_ — workflow registry + pure graph patching + `random_seed`.
- `app/assets/workflows/*.json` — _create_ — bundled copies of the three base graphs.
- `app/assets/comfy.py` — _create_ — `ComfyProvider` Protocol, `FakeComfyProvider`, `RealComfyProvider`, `build_provider`, event types.
- `app/assets/media.py` — _create_ — `MediaStore` (save bytes → relative URL).
- `app/assets/hub.py` — _create_ — `AssetHub` (queue/lock/active + generation flow).
- `app/assets/sockets.py` — _create_ — `register_asset_handlers`.
- `app/assets/rest.py` — _create_ — games (read) + assets (CRUD) router.
- `app/store.py`, `app/rest.py`, `app/main.py`, `app/config.py` — _modify_ — game-on-room-create, wiring, settings.
- `tests/test_games.py`, `tests/test_assets_store.py`, `tests/test_graph.py`, `tests/test_comfy.py`, `tests/test_media.py`, `tests/test_asset_hub.py`, `tests/test_assets_rest.py` — _create_ — unit.
- `tests/e2e/test_assets.py` — _create_ — non-browser socket e2e.
- `tests/conftest.py`, `tests/e2e/conftest.py` — _modify_ — clean new collections; pass `COMFY_BACKEND=fake`.

**Frontend (`studio/frontend/src/`):**

- `plugins/assets/{state.ts,reducers.ts,config.ts,restClient.ts,socketClient.ts,actions.ts,AssetBoardPane.tsx,AssetCard.tsx,index.ts}` — _create_.
- `plugins/index.ts`, `app/workbenchSetup.ts` — _modify_ — register plugin + default layout.
- `plugins/assets/*.spec.ts` — _create_ — vitest unit.
- `e2e/assets.spec.ts` — _create_ — Playwright (local-only).
- `justfile` — _modify_ — add `e2e-assets` recipe.

---

## Task 1: Shared Game spine + game-on-room-create

**Files:**

- Create: `studio/backend/app/games.py`
- Modify: `studio/backend/app/store.py` (`ConversationStore.create_room`)
- Modify: `studio/backend/app/rest.py` (`create_room` handler)
- Modify: `studio/backend/app/main.py` (build a `GameStore`, pass into store/handler path)
- Modify: `studio/backend/tests/conftest.py` (clean `games` collection)
- Test: `studio/backend/tests/test_games.py`

**Interfaces:**

- Produces: `Game(id, name, created_at)`; `game_wire(game) -> dict`; `GameStore(db)` with
  `async create_game(name: str) -> Game`, `async list_games() -> list[Game]`, `async get_game(game_id: str) -> Game | None`.
- Consumes: nothing (foundation).

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_games.py
import pytest

from app.games import GameStore


@pytest.mark.asyncio
async def test_create_and_list_games(mongo_db):
    store = GameStore(mongo_db)
    game = await store.create_game(name="Zombie Slots")
    assert game.id
    assert game.name == "Zombie Slots"

    games = await store.list_games()
    assert [g.id for g in games] == [game.id]

    fetched = await store.get_game(game.id)
    assert fetched is not None and fetched.name == "Zombie Slots"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_games.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.games'`.

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/games.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_games.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test for game-on-room-create**

```python
# append to studio/backend/tests/test_games.py
from app.games import GameStore
from app.store import ConversationStore


@pytest.mark.asyncio
async def test_create_room_also_creates_game(mongo_db):
    games = GameStore(mongo_db)
    store = ConversationStore(mongo_db, games)
    room = await store.create_room(name="My Slot", model="m:free")

    assert room.game_id is not None
    game = await games.get_game(room.game_id)
    assert game is not None and game.name == "My Slot"
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_games.py::test_create_room_also_creates_game -v`
Expected: FAIL — `ConversationStore.__init__()` takes no `games` argument.

- [ ] **Step 7: Wire the game into room creation**

In `studio/backend/app/store.py`, give `ConversationStore` an optional `GameStore` and create a game when a room is created:

```python
# studio/backend/app/store.py — modify ConversationStore
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
```

In `studio/backend/app/main.py`, build a `GameStore` and pass it to `ConversationStore`:

```python
# studio/backend/app/main.py — modify imports + build()
from app.games import GameStore
# ...
    mongo = AsyncIOMotorClient(settings.mongo_url)
    games = GameStore(mongo[settings.mongo_db])
    store = ConversationStore(mongo[settings.mongo_db], games)
```

Add `games: GameStore` to the `AppContext` dataclass and to the returned `AppContext(...)`.

In `studio/backend/tests/conftest.py`, clean the new collection in the `mongo_db` fixture (add alongside the existing deletes, both before `yield` and after):

```python
    await db["games"].delete_many({})
```

- [ ] **Step 8: Run the full games test file to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_games.py -v`
Expected: PASS (both tests).

- [ ] **Step 9: Run the existing suite to confirm nothing broke**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS (existing room/store tests still pass; `test_create_room_also_creates_game` exercises the new path, while the old `test_store.py` builds `ConversationStore(mongo_db)` with no game store and still gets `game_id is None`).

- [ ] **Step 10: Commit**

```bash
git add studio/backend/app/games.py studio/backend/app/store.py studio/backend/app/main.py studio/backend/tests/test_games.py studio/backend/tests/conftest.py
git commit -m "feat(backend): add Game spine and create a game on room creation"
```

---

## Task 2: Asset models + AssetStore

**Files:**

- Create: `studio/backend/app/assets/__init__.py` (empty)
- Create: `studio/backend/app/assets/models.py`
- Create: `studio/backend/app/assets/store.py`
- Modify: `studio/backend/tests/conftest.py` (clean `assets` collection)
- Test: `studio/backend/tests/test_assets_store.py`

**Interfaces:**

- Produces:
  - `Generation(id, seed, image_ref, created_at)`, `Asset(id, game_id, name, category, prompt, width, height, workflow, seed, status, generations, selected_generation_id, error)`, `asset_wire(asset) -> dict`.
  - `AssetStore(db)` with:
    - `async create_asset(game_id, name, prompt, width, height, workflow, seed=None, category=None) -> Asset`
    - `async get_asset(asset_id) -> Asset | None`
    - `async list_assets(game_id) -> list[Asset]`
    - `async update_asset(asset_id, **fields) -> Asset` (only authoring fields)
    - `async delete_asset(asset_id) -> None`
    - `async set_status(asset_id, status, error=None) -> None`
    - `async add_generation(asset_id, gen_id, seed, image_ref) -> Asset` (append; auto-select if first; status="done"; error=None)
    - `async select_generation(asset_id, gen_id) -> Asset`
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_assets_store.py
import pytest

from app.assets.store import AssetStore


async def _mk(store):
    return await store.create_asset(
        game_id="g1", name="Wild", prompt="a wild symbol",
        width=512, height=512, workflow="schnell-transparent",
    )


@pytest.mark.asyncio
async def test_create_defaults(mongo_db):
    store = AssetStore(mongo_db)
    asset = await _mk(store)
    assert asset.id and asset.game_id == "g1"
    assert asset.status == "idle"
    assert asset.generations == []
    assert asset.selected_generation_id is None
    assert asset.seed is None and asset.category is None


@pytest.mark.asyncio
async def test_list_by_game(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    await store.create_asset(game_id="other", name="X", prompt="p", width=64, height=64, workflow="schnell-opaque")
    listed = await store.list_assets("g1")
    assert [x.id for x in listed] == [a.id]


@pytest.mark.asyncio
async def test_update_authoring_fields(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    updated = await store.update_asset(a.id, prompt="new prompt", seed=42)
    assert updated.prompt == "new prompt" and updated.seed == 42


@pytest.mark.asyncio
async def test_add_generation_autoselects_first_and_sets_done(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    after = await store.add_generation(a.id, gen_id="gen1", seed=7, image_ref="/media/g1/" + a.id + "/gen1.png")
    assert after.status == "done"
    assert [g.id for g in after.generations] == ["gen1"]
    assert after.selected_generation_id == "gen1"

    after2 = await store.add_generation(a.id, gen_id="gen2", seed=8, image_ref="/x/gen2.png")
    assert [g.id for g in after2.generations] == ["gen1", "gen2"]
    assert after2.selected_generation_id == "gen1"  # second does NOT auto-select


@pytest.mark.asyncio
async def test_select_generation_and_status(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    await store.add_generation(a.id, "gen1", 7, "/a.png")
    await store.add_generation(a.id, "gen2", 8, "/b.png")
    sel = await store.select_generation(a.id, "gen2")
    assert sel.selected_generation_id == "gen2"

    await store.set_status(a.id, "error", error="boom")
    err = await store.get_asset(a.id)
    assert err.status == "error" and err.error == "boom"


@pytest.mark.asyncio
async def test_delete(mongo_db):
    store = AssetStore(mongo_db)
    a = await _mk(store)
    await store.delete_asset(a.id)
    assert await store.get_asset(a.id) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_assets_store.py -v`
Expected: FAIL — `No module named 'app.assets'`.

- [ ] **Step 3: Write the models**

```python
# studio/backend/app/assets/models.py
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

Status = Literal["idle", "queued", "generating", "done", "error"]
Workflow = Literal["schnell-opaque", "schnell-transparent", "dev-transparent"]


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Generation(_WireModel):
    id: str
    seed: int
    image_ref: str
    created_at: datetime


class Asset(_WireModel):
    id: str
    game_id: str
    name: str
    category: Optional[str] = None
    prompt: str
    width: int
    height: int
    workflow: Workflow
    seed: Optional[int] = None
    status: Status = "idle"
    generations: list[Generation] = Field(default_factory=list)
    selected_generation_id: Optional[str] = None
    error: Optional[str] = None


def asset_wire(asset: Asset) -> dict:
    return asset.model_dump(by_alias=True, mode="json")
```

- [ ] **Step 4: Write the store**

```python
# studio/backend/app/assets/store.py
from datetime import datetime, timezone
from typing import Optional
from uuid import uuid4

from app.assets.models import Asset, Generation

_AUTHORING_FIELDS = {"name", "category", "prompt", "width", "height", "workflow", "seed"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_doc(asset: Asset) -> dict:
    doc = asset.model_dump(mode="json")  # snake_case keys (no by_alias)
    doc["_id"] = doc.pop("id")
    return doc


def _from_doc(doc: dict) -> Asset:
    data = dict(doc)
    data["id"] = data.pop("_id")
    return Asset.model_validate(data)


class AssetStore:
    def __init__(self, db):
        self._assets = db["assets"]

    async def create_asset(self, game_id, name, prompt, width, height, workflow, seed=None, category=None) -> Asset:
        asset = Asset(
            id=uuid4().hex, game_id=game_id, name=name, category=category,
            prompt=prompt, width=width, height=height, workflow=workflow, seed=seed,
        )
        await self._assets.insert_one(_to_doc(asset))
        return asset

    async def get_asset(self, asset_id) -> Optional[Asset]:
        doc = await self._assets.find_one({"_id": asset_id})
        return _from_doc(doc) if doc else None

    async def list_assets(self, game_id) -> list[Asset]:
        docs = await self._assets.find({"game_id": game_id}).to_list(length=None)
        return [_from_doc(d) for d in docs]

    async def update_asset(self, asset_id, **fields) -> Asset:
        update = {k: v for k, v in fields.items() if k in _AUTHORING_FIELDS}
        if update:
            await self._assets.update_one({"_id": asset_id}, {"$set": update})
        return await self.get_asset(asset_id)

    async def delete_asset(self, asset_id) -> None:
        await self._assets.delete_one({"_id": asset_id})

    async def set_status(self, asset_id, status, error=None) -> None:
        await self._assets.update_one({"_id": asset_id}, {"$set": {"status": status, "error": error}})

    async def add_generation(self, asset_id, gen_id, seed, image_ref) -> Asset:
        gen = Generation(id=gen_id, seed=seed, image_ref=image_ref, created_at=_now())
        asset = await self.get_asset(asset_id)
        set_fields = {"status": "done", "error": None}
        if asset.selected_generation_id is None:
            set_fields["selected_generation_id"] = gen_id
        await self._assets.update_one(
            {"_id": asset_id},
            {"$push": {"generations": gen.model_dump(mode="json")}, "$set": set_fields},
        )
        return await self.get_asset(asset_id)

    async def select_generation(self, asset_id, gen_id) -> Asset:
        await self._assets.update_one({"_id": asset_id}, {"$set": {"selected_generation_id": gen_id}})
        return await self.get_asset(asset_id)
```

Create the empty package marker `studio/backend/app/assets/__init__.py`.

- [ ] **Step 5: Clean the new collection in conftest**

In `studio/backend/tests/conftest.py`, add `await db["assets"].delete_many({})` to the `mongo_db` fixture (before `yield` and after).

- [ ] **Step 6: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_assets_store.py -v`
Expected: PASS (all six tests).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/assets/__init__.py studio/backend/app/assets/models.py studio/backend/app/assets/store.py studio/backend/tests/test_assets_store.py studio/backend/tests/conftest.py
git commit -m "feat(backend): add Asset/Generation models and AssetStore"
```

---

## Task 3: Workflow registry + graph patching

**Files:**

- Create: `studio/backend/app/assets/workflows/ai_slots_neon.json`, `ai_slots_transparent.json`, `ai_slots_dev_transparent.json` (copies of `comfyui/workflows/*.json`)
- Create: `studio/backend/app/assets/graph.py`
- Test: `studio/backend/tests/test_graph.py`

**Interfaces:**

- Produces: `WORKFLOWS: dict[str,str]`; `random_seed() -> int`; `patch_graph(base: dict, prompt, width, height, seed) -> dict` (pure, deep-copies); `build_graph(workflow, prompt, width, height, seed) -> dict`.
- Consumes: nothing.

- [ ] **Step 1: Copy the base workflow JSONs into the backend**

```bash
mkdir -p studio/backend/app/assets/workflows
cp comfyui/workflows/ai_slots_neon.json studio/backend/app/assets/workflows/ai_slots_neon.json
cp comfyui/workflows/ai_slots_transparent.json studio/backend/app/assets/workflows/ai_slots_transparent.json
cp comfyui/workflows/ai_slots_dev_transparent.json studio/backend/app/assets/workflows/ai_slots_dev_transparent.json
```

- [ ] **Step 2: Write the failing test**

```python
# studio/backend/tests/test_graph.py
from app.assets.graph import build_graph, patch_graph, random_seed


def _base():
    return {
        "6": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["4", 1], "text": "OLD"}},
        "5": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1216, "height": 832, "batch_size": 1}},
        "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 4}},
    }


def test_patch_sets_prompt_size_seed_without_mutating_base():
    base = _base()
    out = patch_graph(base, prompt="NEW", width=512, height=768, seed=99)
    assert out["6"]["inputs"]["text"] == "NEW"
    assert out["5"]["inputs"]["width"] == 512 and out["5"]["inputs"]["height"] == 768
    assert out["3"]["inputs"]["seed"] == 99
    assert out["3"]["inputs"]["steps"] == 4  # untouched fields preserved
    # base is not mutated
    assert base["6"]["inputs"]["text"] == "OLD" and base["3"]["inputs"]["seed"] == 1


def test_build_graph_loads_each_named_workflow():
    for wf in ("schnell-opaque", "schnell-transparent", "dev-transparent"):
        g = build_graph(wf, prompt="hello", width=256, height=256, seed=5)
        assert g["6"]["inputs"]["text"] == "hello"
        assert g["5"]["inputs"]["width"] == 256
        assert g["3"]["inputs"]["seed"] == 5


def test_random_seed_in_range():
    s = random_seed()
    assert 0 <= s <= 2**32 - 1
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_graph.py -v`
Expected: FAIL — `No module named 'app.assets.graph'`.

- [ ] **Step 4: Write the implementation**

```python
# studio/backend/app/assets/graph.py
import copy
import json
import random
from pathlib import Path

WORKFLOWS = {
    "schnell-opaque": "ai_slots_neon.json",
    "schnell-transparent": "ai_slots_transparent.json",
    "dev-transparent": "ai_slots_dev_transparent.json",
}

_WORKFLOW_DIR = Path(__file__).parent / "workflows"


def random_seed() -> int:
    return random.randint(0, 2**32 - 1)


def load_base(workflow: str) -> dict:
    path = _WORKFLOW_DIR / WORKFLOWS[workflow]
    return json.loads(path.read_text(encoding="utf-8"))


def patch_graph(base: dict, prompt: str, width: int, height: int, seed: int) -> dict:
    graph = copy.deepcopy(base)
    graph["6"]["inputs"]["text"] = prompt
    graph["5"]["inputs"]["width"] = width
    graph["5"]["inputs"]["height"] = height
    graph["3"]["inputs"]["seed"] = seed
    return graph


def build_graph(workflow: str, prompt: str, width: int, height: int, seed: int) -> dict:
    return patch_graph(load_base(workflow), prompt, width, height, seed)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_graph.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/assets/workflows studio/backend/app/assets/graph.py studio/backend/tests/test_graph.py
git commit -m "feat(backend): add ComfyUI workflow registry and graph patching"
```

---

## Task 4: ComfyUI provider seam + settings

**Files:**

- Create: `studio/backend/app/assets/comfy.py`
- Modify: `studio/backend/app/config.py` (new settings)
- Test: `studio/backend/tests/test_comfy.py`

**Interfaces:**

- Produces:
  - `@dataclass ProgressEvent(value: int, max: int)`, `@dataclass ImageEvent(data: bytes)`, `ComfyEvent = ProgressEvent | ImageEvent`.
  - `class ComfyProvider(Protocol): def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]: ...`
  - `FakeComfyProvider(ticks: int = 2)` — yields `ticks` `ProgressEvent`s then one `ImageEvent` with a valid 1×1 PNG.
  - `RealComfyProvider(base_url: str)` — talks to ComfyUI.
  - `build_provider(settings) -> ComfyProvider`.
  - `FAKE_PNG: bytes` (a minimal valid PNG) for reuse in tests.
- Consumes: `Settings.comfy_backend`, `Settings.comfyui_url`.

- [ ] **Step 1: Add settings**

```python
# studio/backend/app/config.py — add fields to Settings
    comfy_backend: str = "real"  # "real" | "fake"
    comfyui_url: str = "http://127.0.0.1:8188"
    media_dir: str = "var/media"
```

- [ ] **Step 2: Write the failing test**

```python
# studio/backend/tests/test_comfy.py
import pytest

from app.assets.comfy import FakeComfyProvider, ImageEvent, ProgressEvent, build_provider
from app.config import Settings


@pytest.mark.asyncio
async def test_fake_provider_streams_progress_then_image():
    provider = FakeComfyProvider(ticks=3)
    events = [ev async for ev in provider.generate({"any": "graph"})]

    progress = [e for e in events if isinstance(e, ProgressEvent)]
    images = [e for e in events if isinstance(e, ImageEvent)]
    assert len(progress) == 3
    assert progress[-1].value == progress[-1].max  # ends at 100%
    assert len(images) == 1
    assert images[0].data.startswith(b"\x89PNG")  # valid PNG header


def test_build_provider_selects_fake():
    provider = build_provider(Settings(comfy_backend="fake"))
    assert isinstance(provider, FakeComfyProvider)
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_comfy.py -v`
Expected: FAIL — `No module named 'app.assets.comfy'`.

- [ ] **Step 4: Write the implementation**

```python
# studio/backend/app/assets/comfy.py
import asyncio
import base64
from dataclasses import dataclass
from typing import AsyncIterator, Protocol

from app.config import Settings

# Minimal valid 1x1 transparent PNG.
FAKE_PNG: bytes = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42m" "NkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


@dataclass
class ProgressEvent:
    value: int
    max: int


@dataclass
class ImageEvent:
    data: bytes


ComfyEvent = ProgressEvent | ImageEvent


class ComfyProvider(Protocol):
    def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]: ...


class FakeComfyProvider:
    """Deterministic provider for tests/CI: a few progress ticks then a PNG. No GPU."""

    def __init__(self, ticks: int = 2, delay: float = 0.0):
        self._ticks = ticks
        self._delay = delay

    async def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]:
        for i in range(1, self._ticks + 1):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield ProgressEvent(value=i, max=self._ticks)
        yield ImageEvent(data=FAKE_PNG)


class RealComfyProvider:
    """Submits a graph to ComfyUI, relays progress, then yields the produced image.

    Protocol (ComfyUI 0.25.x): POST /prompt {prompt, client_id} -> {prompt_id};
    a websocket at /ws?clientId=<id> emits {"type":"progress","data":{"value","max"}}
    and {"type":"executing","data":{"node":null,"prompt_id":...}} when done; the image
    filename comes from GET /history/<prompt_id> and bytes from
    GET /view?filename=&subfolder=&type=output.
    """

    def __init__(self, base_url: str):
        self._base = base_url.rstrip("/")

    async def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]:
        import json
        from uuid import uuid4

        import httpx
        import websockets

        client_id = uuid4().hex
        async with httpx.AsyncClient(base_url=self._base, timeout=None) as http:
            ws_url = self._base.replace("http", "ws", 1) + f"/ws?clientId={client_id}"
            async with websockets.connect(ws_url) as ws:
                resp = await http.post("/prompt", json={"prompt": graph, "client_id": client_id})
                resp.raise_for_status()
                prompt_id = resp.json()["prompt_id"]

                async for raw in ws:
                    if isinstance(raw, bytes):
                        continue
                    msg = json.loads(raw)
                    if msg.get("type") == "progress":
                        d = msg["data"]
                        yield ProgressEvent(value=int(d["value"]), max=int(d["max"]))
                    elif msg.get("type") == "executing" and msg["data"].get("node") is None \
                            and msg["data"].get("prompt_id") == prompt_id:
                        break

            hist = (await http.get(f"/history/{prompt_id}")).json()[prompt_id]
            images = [
                img
                for out in hist["outputs"].values()
                for img in out.get("images", [])
            ]
            last = images[-1]
            params = {"filename": last["filename"], "subfolder": last.get("subfolder", ""), "type": last.get("type", "output")}
            img_resp = await http.get("/view", params=params)
            img_resp.raise_for_status()
            yield ImageEvent(data=img_resp.content)


def build_provider(settings: Settings) -> ComfyProvider:
    if settings.comfy_backend == "fake":
        return FakeComfyProvider()
    return RealComfyProvider(base_url=settings.comfyui_url)
```

- [ ] **Step 5: Add `websockets` to backend deps**

Add `websockets` to `studio/backend/pyproject.toml` `dependencies` (httpx is already present, used by e2e). Then:

```bash
cd studio/backend && uv add websockets
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_comfy.py -v`
Expected: PASS. (Only the `Fake` provider is unit-tested; `RealComfyProvider` is exercised manually against a live ComfyUI.)

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/assets/comfy.py studio/backend/app/config.py studio/backend/pyproject.toml studio/backend/uv.lock studio/backend/tests/test_comfy.py
git commit -m "feat(backend): add ComfyUI provider seam with fake provider"
```

---

## Task 5: MediaStore

**Files:**

- Create: `studio/backend/app/assets/media.py`
- Test: `studio/backend/tests/test_media.py`

**Interfaces:**

- Produces: `MediaStore(root: str | Path)` with `save(game_id, asset_id, gen_id, data: bytes) -> str` returning the relative URL `/media/<game>/<asset>/<gen>.png`, and `root: Path` attribute (for the StaticFiles mount).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_media.py
from pathlib import Path

from app.assets.media import MediaStore


def test_save_writes_file_and_returns_url(tmp_path):
    store = MediaStore(tmp_path)
    ref = store.save("g1", "a1", "gen1", b"\x89PNGdata")
    assert ref == "/media/g1/a1/gen1.png"
    written = tmp_path / "g1" / "a1" / "gen1.png"
    assert written.read_bytes() == b"\x89PNGdata"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_media.py -v`
Expected: FAIL — `No module named 'app.assets.media'`.

- [ ] **Step 3: Write the implementation**

```python
# studio/backend/app/assets/media.py
from pathlib import Path


class MediaStore:
    def __init__(self, root):
        self.root = Path(root)

    def save(self, game_id: str, asset_id: str, gen_id: str, data: bytes) -> str:
        directory = self.root / game_id / asset_id
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{gen_id}.png").write_bytes(data)
        return f"/media/{game_id}/{asset_id}/{gen_id}.png"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_media.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/assets/media.py studio/backend/tests/test_media.py
git commit -m "feat(backend): add MediaStore for generated images"
```

---

## Task 6: AssetHub (queue + generation flow + resume)

**Files:**

- Create: `studio/backend/app/assets/hub.py`
- Test: `studio/backend/tests/test_asset_hub.py`

**Interfaces:**

- Consumes: `AssetStore` (Task 2), `build_graph`/`random_seed` (Task 3), `ComfyProvider`/`ProgressEvent`/`ImageEvent` (Task 4), `MediaStore` (Task 5), `asset_wire` (Task 2).
- Produces: `AssetHub(sio, asset_store, comfy, media)` with:
  - `async request_generation(game_id, asset_id) -> None`
  - `async attach_subscriber(game_id, sid) -> None`
  - `active_snapshot(game_id) -> dict | None`
  - emits socket events: `asset_status {gameId, assetId, status, queueDepth}`, `asset_progress {gameId, assetId, value, max}`, `asset_completed {gameId, asset}`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_asset_hub.py
import asyncio

import pytest

from app.assets.comfy import FakeComfyProvider
from app.assets.hub import AssetHub
from app.assets.media import MediaStore
from app.assets.store import AssetStore


class FakeSio:
    def __init__(self):
        self.events = []  # (event, payload, room/to)
        self.rooms = []

    async def emit(self, event, payload, room=None, to=None):
        self.events.append((event, payload, room or to))

    async def enter_room(self, sid, room):
        self.rooms.append((sid, room))


async def _wait_for(sio, event, timeout=2.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if any(e[0] == event for e in sio.events):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"event {event} not emitted; got {[e[0] for e in sio.events]}")


@pytest.mark.asyncio
async def test_generation_emits_status_progress_completed(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-transparent", seed=5)
    sio = FakeSio()
    hub = AssetHub(sio, store, FakeComfyProvider(ticks=2), MediaStore(tmp_path))

    await hub.request_generation("g1", asset.id)
    await _wait_for(sio, "asset_completed")

    kinds = [e[0] for e in sio.events]
    assert "asset_status" in kinds and "asset_progress" in kinds and "asset_completed" in kinds

    completed = next(e for e in sio.events if e[0] == "asset_completed")
    payload = completed[1]
    assert payload["gameId"] == "g1"
    assert payload["asset"]["status"] == "done"
    assert len(payload["asset"]["generations"]) == 1
    assert payload["asset"]["generations"][0]["seed"] == 5
    assert payload["asset"]["selectedGenerationId"] == payload["asset"]["generations"][0]["id"]

    # the image file exists on disk
    ref = payload["asset"]["generations"][0]["imageRef"]
    assert (tmp_path / ref.removeprefix("/media/")).exists()


@pytest.mark.asyncio
async def test_failure_sets_error_status(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-opaque", seed=1)

    class BoomProvider:
        async def generate(self, graph):
            raise RuntimeError("gpu exploded")
            yield  # pragma: no cover

    sio = FakeSio()
    hub = AssetHub(sio, store, BoomProvider(), MediaStore(tmp_path))
    await hub.request_generation("g1", asset.id)
    await _wait_for(sio, "asset_status")
    await asyncio.sleep(0.1)

    refreshed = await store.get_asset(asset.id)
    assert refreshed.status == "error"


@pytest.mark.asyncio
async def test_attach_subscriber_replays_active_progress(mongo_db, tmp_path):
    store = AssetStore(mongo_db)
    asset = await store.create_asset(game_id="g1", name="W", prompt="p", width=64, height=64, workflow="schnell-opaque", seed=1)
    sio = FakeSio()
    # slow provider so the generation is mid-flight when we attach
    hub = AssetHub(sio, store, FakeComfyProvider(ticks=3, delay=0.05), MediaStore(tmp_path))

    await hub.request_generation("g1", asset.id)
    await asyncio.sleep(0.06)  # at least one progress tick recorded
    await hub.attach_subscriber("g1", "sid-late")

    snap_to_sid = [e for e in sio.events if e[0] == "asset_progress" and e[2] == "sid-late"]
    assert snap_to_sid  # the late subscriber got a replayed snapshot
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_asset_hub.py -v`
Expected: FAIL — `No module named 'app.assets.hub'`.

- [ ] **Step 3: Write the implementation**

```python
# studio/backend/app/assets/hub.py
import asyncio
from uuid import uuid4

from app.assets.comfy import ImageEvent, ProgressEvent
from app.assets.graph import build_graph, random_seed
from app.assets.models import asset_wire


class AssetHub:
    def __init__(self, sio, asset_store, comfy, media):
        self._sio = sio
        self._store = asset_store
        self._comfy = comfy
        self._media = media
        self._queues: dict[str, list[str]] = {}
        self._busy: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._active: dict[str, dict] = {}  # game_id -> {assetId, value, max}

    def _lock(self, game_id: str) -> asyncio.Lock:
        return self._locks.setdefault(game_id, asyncio.Lock())

    def active_snapshot(self, game_id: str) -> dict | None:
        a = self._active.get(game_id)
        if a is None:
            return None
        return {"gameId": game_id, "assetId": a["assetId"], "value": a["value"], "max": a["max"]}

    async def attach_subscriber(self, game_id: str, sid: str) -> None:
        async with self._lock(game_id):
            await self._sio.enter_room(sid, game_id)
            snap = self.active_snapshot(game_id)
            if snap is not None:
                await self._sio.emit("asset_progress", snap, to=sid)

    async def request_generation(self, game_id: str, asset_id: str) -> None:
        await self._store.set_status(asset_id, "queued")
        async with self._lock(game_id):
            self._queues.setdefault(game_id, []).append(asset_id)
            await self._emit_status(game_id, asset_id, "queued")
            if game_id in self._busy:
                return
            self._busy.add(game_id)
        asyncio.create_task(self._drain(game_id))

    async def _drain(self, game_id: str) -> None:
        while True:
            async with self._lock(game_id):
                queue = self._queues.get(game_id, [])
                if not queue:
                    self._busy.discard(game_id)
                    return
                asset_id = queue.pop(0)
            try:
                await self._run(game_id, asset_id)
            except Exception:
                await self._store.set_status(asset_id, "error", error="generation failed")
                await self._emit_status(game_id, asset_id, "error")

    async def _run(self, game_id: str, asset_id: str) -> None:
        asset = await self._store.get_asset(asset_id)
        seed = asset.seed if asset.seed is not None else random_seed()
        graph = build_graph(asset.workflow, asset.prompt, asset.width, asset.height, seed)

        await self._store.set_status(asset_id, "generating")
        await self._emit_status(game_id, asset_id, "generating")
        async with self._lock(game_id):
            self._active[game_id] = {"assetId": asset_id, "value": 0, "max": 0}

        image_bytes = None
        try:
            async for ev in self._comfy.generate(graph):
                if isinstance(ev, ProgressEvent):
                    async with self._lock(game_id):
                        self._active[game_id].update(value=ev.value, max=ev.max)
                    await self._sio.emit(
                        "asset_progress",
                        {"gameId": game_id, "assetId": asset_id, "value": ev.value, "max": ev.max},
                        room=game_id,
                    )
                elif isinstance(ev, ImageEvent):
                    image_bytes = ev.data
        finally:
            async with self._lock(game_id):
                self._active.pop(game_id, None)

        gen_id = uuid4().hex
        image_ref = self._media.save(game_id, asset_id, gen_id, image_bytes)
        asset = await self._store.add_generation(asset_id, gen_id, seed, image_ref)
        await self._sio.emit("asset_completed", {"gameId": game_id, "asset": asset_wire(asset)}, room=game_id)

    async def _emit_status(self, game_id: str, asset_id: str, status: str) -> None:
        depth = len(self._queues.get(game_id, []))
        await self._sio.emit(
            "asset_status",
            {"gameId": game_id, "assetId": asset_id, "status": status, "queueDepth": depth},
            room=game_id,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_asset_hub.py -v`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/assets/hub.py studio/backend/tests/test_asset_hub.py
git commit -m "feat(backend): add AssetHub generation orchestration with progress + resume"
```

---

## Task 7: Assets REST router (games read + assets CRUD)

**Files:**

- Create: `studio/backend/app/assets/rest.py`
- Test: `studio/backend/tests/test_assets_rest.py`

**Interfaces:**

- Consumes: `request.app.state.game_store` (`GameStore`), `request.app.state.asset_store` (`AssetStore`).
- Produces an `APIRouter` with:
  - `GET /games` → `[game_wire]`
  - `GET /games/{game_id}/assets` → `[asset_wire]`
  - `POST /games/{game_id}/assets {name, prompt, width, height, workflow, seed?, category?}` → `asset_wire` (201)
  - `PATCH /assets/{asset_id} {<authoring fields>}` → `asset_wire`
  - `DELETE /assets/{asset_id}` → 204
  - `POST /assets/{asset_id}/select {generationId}` → `asset_wire`

- [ ] **Step 1: Write the failing test**

The REST router is exercised through the built app with FastAPI's `TestClient`, using the test Mongo DB. Add a fixture that points `app.state` stores at `mongo_db`.

```python
# studio/backend/tests/test_assets_rest.py
import pytest
from fastapi.testclient import TestClient

from app.assets.rest import router as assets_router
from app.assets.store import AssetStore
from app.games import GameStore
from fastapi import FastAPI


@pytest.fixture
def client(mongo_db):
    app = FastAPI()
    app.state.game_store = GameStore(mongo_db)
    app.state.asset_store = AssetStore(mongo_db)
    app.include_router(assets_router)
    return TestClient(app)


def test_games_and_asset_crud_flow(client, mongo_db, event_loop):
    # seed a game directly
    game = event_loop.run_until_complete(GameStore(mongo_db).create_game("Slots"))

    games = client.get("/games").json()
    assert [g["id"] for g in games] == [game.id]

    created = client.post(
        f"/games/{game.id}/assets",
        json={"name": "Wild", "prompt": "a wild", "width": 512, "height": 512, "workflow": "schnell-transparent"},
    )
    assert created.status_code == 201
    asset = created.json()
    assert asset["status"] == "idle" and asset["gameId"] == game.id

    listed = client.get(f"/games/{game.id}/assets").json()
    assert [a["id"] for a in listed] == [asset["id"]]

    patched = client.patch(f"/assets/{asset['id']}", json={"prompt": "edited", "seed": 9}).json()
    assert patched["prompt"] == "edited" and patched["seed"] == 9

    assert client.delete(f"/assets/{asset['id']}").status_code == 204
    assert client.get(f"/games/{game.id}/assets").json() == []
```

> Note: if the test runner lacks an `event_loop` fixture, replace `event_loop.run_until_complete(...)` with `asyncio.get_event_loop().run_until_complete(...)` and `import asyncio`. The `select` endpoint is covered by the e2e in Task 9.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_assets_rest.py -v`
Expected: FAIL — `No module named 'app.assets.rest'`.

- [ ] **Step 3: Write the implementation**

```python
# studio/backend/app/assets/rest.py
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from app.assets.models import asset_wire
from app.games import game_wire

router = APIRouter()


class CreateAssetBody(BaseModel):
    name: str
    prompt: str
    width: int
    height: int
    workflow: str
    seed: int | None = None
    category: str | None = None


class UpdateAssetBody(BaseModel):
    name: str | None = None
    prompt: str | None = None
    width: int | None = None
    height: int | None = None
    workflow: str | None = None
    seed: int | None = None
    category: str | None = None


class SelectBody(BaseModel):
    # Frontend sends {"generationId": ...}; accept that camelCase alias.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    generation_id: str


@router.get("/games")
async def list_games(request: Request) -> list[dict]:
    games = await request.app.state.game_store.list_games()
    return [game_wire(g) for g in games]


@router.get("/games/{game_id}/assets")
async def list_assets(game_id: str, request: Request) -> list[dict]:
    assets = await request.app.state.asset_store.list_assets(game_id)
    return [asset_wire(a) for a in assets]


@router.post("/games/{game_id}/assets", status_code=201)
async def create_asset(game_id: str, body: CreateAssetBody, request: Request) -> dict:
    asset = await request.app.state.asset_store.create_asset(
        game_id=game_id, name=body.name, prompt=body.prompt,
        width=body.width, height=body.height, workflow=body.workflow,
        seed=body.seed, category=body.category,
    )
    return asset_wire(asset)


@router.patch("/assets/{asset_id}")
async def update_asset(asset_id: str, body: UpdateAssetBody, request: Request) -> dict:
    fields = body.model_dump(exclude_none=True)
    asset = await request.app.state.asset_store.update_asset(asset_id, **fields)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return asset_wire(asset)


@router.delete("/assets/{asset_id}", status_code=204)
async def delete_asset(asset_id: str, request: Request) -> Response:
    await request.app.state.asset_store.delete_asset(asset_id)
    return Response(status_code=204)


@router.post("/assets/{asset_id}/select")
async def select_generation(asset_id: str, body: SelectBody, request: Request) -> dict:
    asset = await request.app.state.asset_store.select_generation(asset_id, body.generation_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    return asset_wire(asset)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_assets_rest.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/assets/rest.py studio/backend/tests/test_assets_rest.py
git commit -m "feat(backend): add assets REST router (games read + asset CRUD + select)"
```

---

## Task 8: Asset socket handlers + full app wiring

**Files:**

- Create: `studio/backend/app/assets/sockets.py`
- Modify: `studio/backend/app/main.py` (build asset stores/provider/hub, register handlers, include router, mount media)
- Test: covered by Task 9 e2e (this task's deliverable is wiring; verify via app boot + existing suite)

**Interfaces:**

- Produces: `register_asset_handlers(sio, hub)` registering `join_game`, `leave_game`, `generate_asset`.
- `AppContext` gains `game_store`, `asset_store`, `asset_hub`; `app.state.game_store` / `app.state.asset_store` are set for the REST router; `/media` is a `StaticFiles` mount.

- [ ] **Step 1: Write the socket handlers**

```python
# studio/backend/app/assets/sockets.py
def register_asset_handlers(sio, hub):
    @sio.on("join_game")
    async def join_game(sid, data):
        await hub.attach_subscriber(data["gameId"], sid)

    @sio.on("leave_game")
    async def leave_game(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("generate_asset")
    async def generate_asset(sid, data):
        await hub.request_generation(data["gameId"], data["assetId"])
```

- [ ] **Step 2: Wire everything in `app/main.py`**

```python
# studio/backend/app/main.py — additions
from pathlib import Path

from fastapi.staticfiles import StaticFiles

from app.assets.comfy import build_provider as build_comfy_provider
from app.assets.hub import AssetHub
from app.assets.media import MediaStore
from app.assets.rest import router as assets_router
from app.assets.sockets import register_asset_handlers
from app.assets.store import AssetStore
```

Add fields to `AppContext` (`games: GameStore` was already added in Task 1):

```python
    asset_store: AssetStore
    asset_hub: AssetHub
```

In `build()` after the chat wiring:

```python
    asset_store = AssetStore(mongo[settings.mongo_db])
    media_root = Path(settings.media_dir)
    media_root.mkdir(parents=True, exist_ok=True)
    media = MediaStore(media_root)
    comfy = build_comfy_provider(settings)
    asset_hub = AssetHub(sio, asset_store, comfy, media)

    fastapi_app.state.game_store = games
    fastapi_app.state.asset_store = asset_store
    fastapi_app.include_router(assets_router)
    fastapi_app.mount("/media", StaticFiles(directory=str(media_root)), name="media")

    register_asset_handlers(sio, asset_hub)
```

> `register_asset_handlers` must be called **before** `socketio.ASGIApp(sio, ...)` is constructed (same place the chat handlers are registered). Add `asset_store=asset_store, asset_hub=asset_hub` to the returned `AppContext(...)` (`games=games` was already added in Task 1). `app.state.game_store` is set to the same `games` instance for the REST router.

- [ ] **Step 3: Verify the app boots and existing tests pass**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS (whole non-e2e suite, including a smoke import of `app.main`).

Run (manual boot check): `cd studio/backend && COMFY_BACKEND=fake uv run python -c "from app.config import Settings; from app.main import build; build(Settings(comfy_backend='fake', llm_backend='fake')); print('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Add `var/` to gitignore**

Add `studio/backend/var/` to `studio/backend/.gitignore` (so generated media is never committed).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/assets/sockets.py studio/backend/app/main.py studio/backend/.gitignore
git commit -m "feat(backend): wire asset sockets, REST, hub, and media serving into the app"
```

---

## Task 9: Backend non-browser e2e (socket flow + resume)

**Files:**

- Modify: `studio/backend/tests/e2e/conftest.py` (pass `COMFY_BACKEND=fake`, clean media)
- Create: `studio/backend/tests/e2e/test_assets.py`

**Interfaces:**

- Consumes: the `live_server` fixture (spawns `uvicorn app.main:app`).

- [ ] **Step 1: Make the live server use the fake ComfyUI provider**

In `studio/backend/tests/e2e/conftest.py`, add to the `env` dict inside the `live_server` fixture:

```python
        "COMFY_BACKEND": "fake",
        "MEDIA_DIR": "var/media_e2e",
```

- [ ] **Step 2: Write the failing e2e test**

```python
# studio/backend/tests/e2e/test_assets.py
import asyncio

import httpx
import pytest
import socketio


async def _make_game_and_asset(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as client:
        room = (await client.post("/rooms", json={"name": "AssetE2E"})).json()
        game_id = room["gameId"]
        asset = (await client.post(
            f"/games/{game_id}/assets",
            json={"name": "Wild", "prompt": "p", "width": 64, "height": 64, "workflow": "schnell-transparent", "seed": 3},
        )).json()
        return game_id, asset["id"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_generate_streams_status_progress_completed(live_server):
    game_id, asset_id = await _make_game_and_asset(live_server)
    client = socketio.AsyncClient()
    got = {"status": [], "progress": [], "completed": []}
    client.on("asset_status", lambda d: got["status"].append(d))
    client.on("asset_progress", lambda d: got["progress"].append(d))
    client.on("asset_completed", lambda d: got["completed"].append(d))

    await client.connect(live_server, auth={"displayName": "Artist"})
    await client.emit("join_game", {"gameId": game_id})
    await client.emit("generate_asset", {"gameId": game_id, "assetId": asset_id})

    for _ in range(100):
        if got["completed"]:
            break
        await asyncio.sleep(0.05)

    assert got["status"] and got["progress"] and got["completed"]
    asset = got["completed"][-1]["asset"]
    assert asset["status"] == "done"
    assert asset["generations"][0]["seed"] == 3

    # the served image is reachable
    async with httpx.AsyncClient(base_url=live_server) as http:
        img = await http.get(asset["generations"][0]["imageRef"])
        assert img.status_code == 200 and img.content.startswith(b"\x89PNG")

    await client.disconnect()
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_assets.py -v`
Expected first run (before Tasks 7–8 are merged): FAIL. After Tasks 7–8: PASS.

- [ ] **Step 4: Run the whole backend suite**

Run: `cd studio/backend && uv run pytest -q` (includes e2e)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tests/e2e/test_assets.py studio/backend/tests/e2e/conftest.py
git commit -m "test(backend): non-browser e2e for asset generation over Socket.IO"
```

---

## Task 10: Frontend state slice + reducers

**Files:**

- Create: `studio/frontend/src/plugins/assets/config.ts`
- Create: `studio/frontend/src/plugins/assets/state.ts`
- Create: `studio/frontend/src/plugins/assets/reducers.ts`
- Test: `studio/frontend/src/plugins/assets/reducers.spec.ts`

**Interfaces:**

- Produces:
  - `IGeneration {id, seed, imageRef, createdAt}`, `IAsset {...}`, `IGame {id, name, createdAt}`, `IAssetsState`, `ASSETS_PLUGIN_ID = 'assets'`, `makeInitialState()`, `assetsHooks`, `assetsSlice()`.
  - Pure reducers: `upsertAsset(assets, asset)`, `setAssetStatus(assets, assetId, status, queueDepth?)`, `setAssetProgress(assets, assetId, value, max)`.
- Consumes: `rootStore`, `makePluginHooks` (existing host infra).

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/assets/reducers.spec.ts
import { describe, it, expect } from 'vitest';
import type { IAsset } from './state';
import { upsertAsset, setAssetStatus, setAssetProgress } from './reducers';

const base: IAsset = {
  id: 'a1',
  gameId: 'g1',
  name: 'Wild',
  category: null,
  prompt: 'p',
  width: 64,
  height: 64,
  workflow: 'schnell-transparent',
  seed: null,
  status: 'idle',
  generations: [],
  selectedGenerationId: null,
  error: null,
  progress: null,
};

describe('assets reducers', () => {
  it('upsertAsset adds then replaces by id', () => {
    const added = upsertAsset([], base);
    expect(added).toHaveLength(1);
    const replaced = upsertAsset(added, { ...base, name: 'Renamed' });
    expect(replaced).toHaveLength(1);
    expect(replaced[0].name).toBe('Renamed');
  });

  it('setAssetStatus updates only the target asset', () => {
    const out = setAssetStatus([base, { ...base, id: 'a2' }], 'a1', 'generating');
    expect(out.find((a) => a.id === 'a1')!.status).toBe('generating');
    expect(out.find((a) => a.id === 'a2')!.status).toBe('idle');
  });

  it('setAssetProgress sets a {value,max} on the target asset', () => {
    const out = setAssetProgress([base], 'a1', 2, 4);
    expect(out[0].progress).toEqual({ value: 2, max: 4 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/reducers.spec.ts`
Expected: FAIL — cannot resolve `./state` / `./reducers`.

- [ ] **Step 3: Write config + state**

```ts
// studio/frontend/src/plugins/assets/config.ts
export const BACKEND_URL: string = (import.meta.env.VITE_BLOOM_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';
```

```ts
// studio/frontend/src/plugins/assets/state.ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const ASSETS_PLUGIN_ID = 'assets';

export type AssetStatus = 'idle' | 'queued' | 'generating' | 'done' | 'error';
export type Workflow = 'schnell-opaque' | 'schnell-transparent' | 'dev-transparent';

export interface IGame {
  id: string;
  name: string;
  createdAt: string;
}

export interface IGeneration {
  id: string;
  seed: number;
  imageRef: string;
  createdAt: string;
}

export interface IProgress {
  value: number;
  max: number;
}

export interface IAsset {
  id: string;
  gameId: string;
  name: string;
  category: string | null;
  prompt: string;
  width: number;
  height: number;
  workflow: Workflow;
  seed: number | null;
  status: AssetStatus;
  generations: IGeneration[];
  selectedGenerationId: string | null;
  error: string | null;
  progress: IProgress | null; // transient, client-only (from asset_progress)
}

export interface IAssetsState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  games: IGame[];
  gamesStatus: 'idle' | 'loading' | 'error';
  activeGameId: string | null;
  assets: IAsset[];
  assetsStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(): IAssetsState {
  return {
    connection: 'connecting',
    games: [],
    gamesStatus: 'idle',
    activeGameId: null,
    assets: [],
    assetsStatus: 'idle',
  };
}

export const assetsHooks = makePluginHooks<IAssetsState>(ASSETS_PLUGIN_ID);

export function assetsSlice(): State<IAssetsState> {
  return rootStore.plugins.nested(ASSETS_PLUGIN_ID) as unknown as State<IAssetsState>;
}
```

- [ ] **Step 4: Write reducers**

```ts
// studio/frontend/src/plugins/assets/reducers.ts
import type { IAsset, AssetStatus } from './state';

export function upsertAsset(assets: IAsset[], asset: IAsset): IAsset[] {
  const idx = assets.findIndex((a) => a.id === asset.id);
  if (idx === -1) return [...assets, asset];
  const next = assets.slice();
  next[idx] = asset;
  return next;
}

export function setAssetStatus(assets: IAsset[], assetId: string, status: AssetStatus): IAsset[] {
  const idx = assets.findIndex((a) => a.id === assetId);
  if (idx === -1) return assets;
  const next = assets.slice();
  next[idx] = { ...next[idx], status };
  return next;
}

export function setAssetProgress(assets: IAsset[], assetId: string, value: number, max: number): IAsset[] {
  const idx = assets.findIndex((a) => a.id === assetId);
  if (idx === -1) return assets;
  const next = assets.slice();
  next[idx] = { ...next[idx], progress: { value, max } };
  return next;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/reducers.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/assets/config.ts studio/frontend/src/plugins/assets/state.ts studio/frontend/src/plugins/assets/reducers.ts studio/frontend/src/plugins/assets/reducers.spec.ts
git commit -m "feat(frontend): add assets plugin state slice and pure reducers"
```

---

## Task 11: Frontend REST client

**Files:**

- Create: `studio/frontend/src/plugins/assets/restClient.ts`
- Test: `studio/frontend/src/plugins/assets/restClient.spec.ts`

**Interfaces:**

- Produces: `getGames()`, `getAssets(gameId)`, `createAsset(gameId, input)`, `updateAsset(assetId, patch)`, `deleteAsset(assetId)`, `selectGeneration(assetId, generationId)` and `ICreateAssetInput`.
- Consumes: `BACKEND_URL`, `IGame`, `IAsset`.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/assets/restClient.spec.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getGames, createAsset } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('assets restClient', () => {
  it('getGames fetches /games', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 'g1', name: 'G', createdAt: '' }] });
    vi.stubGlobal('fetch', fetchMock);
    const games = await getGames();
    expect(games[0].id).toBe('g1');
    expect(fetchMock.mock.calls[0][0]).toContain('/games');
  });

  it('createAsset POSTs to /games/{id}/assets', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'a1' }) });
    vi.stubGlobal('fetch', fetchMock);
    await createAsset('g1', { name: 'W', prompt: 'p', width: 64, height: 64, workflow: 'schnell-opaque' });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/games/g1/assets');
    expect(opts.method).toBe('POST');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/restClient.spec.ts`
Expected: FAIL — cannot resolve `./restClient`.

- [ ] **Step 3: Write the implementation**

```ts
// studio/frontend/src/plugins/assets/restClient.ts
import type { IGame, IAsset, Workflow } from './state';
import { BACKEND_URL } from './config';

export interface ICreateAssetInput {
  name: string;
  prompt: string;
  width: number;
  height: number;
  workflow: Workflow;
  seed?: number | null;
  category?: string | null;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getGames(): Promise<IGame[]> {
  return okJson<IGame[]>(await fetch(`${BACKEND_URL}/games`));
}

export async function getAssets(gameId: string): Promise<IAsset[]> {
  return okJson<IAsset[]>(await fetch(`${BACKEND_URL}/games/${gameId}/assets`));
}

export async function createAsset(gameId: string, input: ICreateAssetInput): Promise<IAsset> {
  return okJson<IAsset>(
    await fetch(`${BACKEND_URL}/games/${gameId}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

export async function updateAsset(assetId: string, patch: Partial<ICreateAssetInput>): Promise<IAsset> {
  return okJson<IAsset>(
    await fetch(`${BACKEND_URL}/assets/${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteAsset(assetId: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/assets/${assetId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
}

export async function selectGeneration(assetId: string, generationId: string): Promise<IAsset> {
  return okJson<IAsset>(
    await fetch(`${BACKEND_URL}/assets/${assetId}/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generationId }),
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/restClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/restClient.ts studio/frontend/src/plugins/assets/restClient.spec.ts
git commit -m "feat(frontend): add assets REST client"
```

---

## Task 12: Frontend socket client

**Files:**

- Create: `studio/frontend/src/plugins/assets/socketClient.ts`
- Test: `studio/frontend/src/plugins/assets/socketClient.spec.ts`

**Interfaces:**

- Consumes: `assetsSlice`, reducers (Task 10), `notify` (`../../lib/notify`), `ISocketLike` pattern (mirrors chat).
- Produces: `createSocketClient(makeSocket)` returning `{ connect, disconnect, getSocket, joinGame, leaveGame, generateAsset }`; `initSocketClient()`, `getSocketClient()`, `ISocketLike`, `SocketClient`.

Event handling (all guarded by `gameId === activeGameId`, mirroring chat):

| Event             | Effect                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| `asset_status`    | `setAssetStatus(assets, assetId, status)`                                 |
| `asset_progress`  | `setAssetProgress(assets, assetId, value, max)`                           |
| `asset_completed` | `upsertAsset(assets, asset)` (full asset replaces; clears progress impl.) |
| `error`           | `notify.error(message)`                                                   |

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/assets/socketClient.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState, type IAsset } from './state';
import { createSocketClient, type ISocketLike } from './socketClient';

vi.mock('../../lib/notify', () => ({ notify: { error: vi.fn(), info: vi.fn() } }));

function fakeSocket(): ISocketLike & { fire: (e: string, p: unknown) => void } {
  const handlers: Record<string, (p: unknown) => void> = {};
  return {
    auth: {},
    connected: true,
    on: (e, cb) => {
      handlers[e] = cb;
    },
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    fire: (e, p) => handlers[e]?.(p),
  };
}

const asset: IAsset = {
  id: 'a1',
  gameId: 'g1',
  name: 'W',
  category: null,
  prompt: 'p',
  width: 64,
  height: 64,
  workflow: 'schnell-opaque',
  seed: null,
  status: 'idle',
  generations: [],
  selectedGenerationId: null,
  error: null,
  progress: null,
};

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  assetsSlice().activeGameId.set('g1');
  assetsSlice().assets.set([asset]);
});

describe('assets socketClient', () => {
  it('applies asset_progress for the active game', () => {
    let sock!: ReturnType<typeof fakeSocket>;
    const client = createSocketClient(() => (sock = fakeSocket()));
    client.connect();
    sock.fire('asset_progress', { gameId: 'g1', assetId: 'a1', value: 2, max: 4 });
    expect(assetsSlice().assets.get({ noproxy: true })[0].progress).toEqual({ value: 2, max: 4 });
  });

  it('ignores events for a non-active game', () => {
    let sock!: ReturnType<typeof fakeSocket>;
    const client = createSocketClient(() => (sock = fakeSocket()));
    client.connect();
    sock.fire('asset_status', { gameId: 'other', assetId: 'a1', status: 'generating' });
    expect(assetsSlice().assets.get({ noproxy: true })[0].status).toBe('idle');
  });

  it('asset_completed replaces the asset', () => {
    let sock!: ReturnType<typeof fakeSocket>;
    const client = createSocketClient(() => (sock = fakeSocket()));
    client.connect();
    const done = { ...asset, status: 'done' as const, generations: [{ id: 'gen1', seed: 1, imageRef: '/x.png', createdAt: '' }], selectedGenerationId: 'gen1' };
    sock.fire('asset_completed', { gameId: 'g1', asset: done });
    expect(assetsSlice().assets.get({ noproxy: true })[0].status).toBe('done');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/socketClient.spec.ts`
Expected: FAIL — cannot resolve `./socketClient`.

- [ ] **Step 3: Write the implementation**

```ts
// studio/frontend/src/plugins/assets/socketClient.ts
import { io } from 'socket.io-client';
import { BACKEND_URL } from './config';
import type { IAsset } from './state';
import { assetsSlice } from './state';
import { upsertAsset, setAssetStatus, setAssetProgress } from './reducers';
import { notify } from '../../lib/notify';

export interface ISocketLike {
  auth: Record<string, unknown>;
  readonly connected: boolean;
  on(event: string, cb: (payload: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
  connect(): void;
  disconnect(): void;
}

type MakeSocket = (url: string) => ISocketLike;

function registerInboundHandlers(s: ISocketLike): void {
  const slice = assetsSlice;
  const isActive = (gameId: string) => slice().activeGameId.get() === gameId;
  const read = () => slice().assets.get({ noproxy: true }) as IAsset[];

  s.on('asset_status', (p) => {
    const { gameId, assetId, status } = p as { gameId: string; assetId: string; status: IAsset['status'] };
    if (!isActive(gameId)) return;
    slice().assets.set(setAssetStatus(read(), assetId, status));
  });
  s.on('asset_progress', (p) => {
    const { gameId, assetId, value, max } = p as { gameId: string; assetId: string; value: number; max: number };
    if (!isActive(gameId)) return;
    slice().assets.set(setAssetProgress(read(), assetId, value, max));
  });
  s.on('asset_completed', (p) => {
    const { gameId, asset } = p as { gameId: string; asset: IAsset };
    if (!isActive(gameId)) return;
    slice().assets.set(upsertAsset(read(), { ...asset, progress: null }));
  });
  s.on('error', (p) => {
    const { message } = p as { message: string };
    notify.error(message ?? 'asset error');
  });
}

export function createSocketClient(makeSocket: MakeSocket) {
  let sock: ISocketLike | null = null;

  function wire(s: ISocketLike): void {
    s.on('connect', () => {
      assetsSlice().connection.set('connected');
      const active = assetsSlice().activeGameId.get();
      if (active) s.emit('join_game', { gameId: active });
    });
    s.on('disconnect', () => {
      assetsSlice().connection.set('reconnecting');
    });
    registerInboundHandlers(s);
  }

  function connect(): void {
    assetsSlice().connection.set('connecting');
    sock = makeSocket(BACKEND_URL);
    wire(sock);
  }

  function disconnect(): void {
    sock?.disconnect();
    assetsSlice().connection.set('disconnected');
  }

  const emit = (event: string, payload: unknown) => sock?.emit(event, payload);

  return {
    connect,
    disconnect,
    getSocket: () => sock,
    joinGame: (gameId: string) => emit('join_game', { gameId }),
    leaveGame: (gameId: string) => emit('leave_game', { gameId }),
    generateAsset: (gameId: string, assetId: string) => emit('generate_asset', { gameId, assetId }),
  };
}

export type SocketClient = ReturnType<typeof createSocketClient>;

let singleton: SocketClient | null = null;

export function initSocketClient(): SocketClient {
  singleton = createSocketClient((url) => io(url, { autoConnect: true }) as unknown as ISocketLike);
  return singleton;
}

export function getSocketClient(): SocketClient {
  if (!singleton) throw new Error('assets socket client not initialised');
  return singleton;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/socketClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/socketClient.ts studio/frontend/src/plugins/assets/socketClient.spec.ts
git commit -m "feat(frontend): add assets socket client wiring events to reducers"
```

---

## Task 13: Frontend actions (orchestration)

**Files:**

- Create: `studio/frontend/src/plugins/assets/actions.ts`
- Test: `studio/frontend/src/plugins/assets/actions.spec.ts`

**Interfaces:**

- Consumes: `assetsSlice`, `restClient` (Task 11), `socketClient` (Task 12), `upsertAsset`.
- Produces: `initAssets()`, `loadGames()`, `openGame(gameId)`, `createAsset(input)`, `updateAsset(assetId, patch)`, `deleteAsset(assetId)`, `generateAsset(assetId)`, `selectGeneration(assetId, generationId)`, and `__setDeps(...)` for tests.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/plugins/assets/actions.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState, type IAsset } from './state';
import * as actions from './actions';

const asset: IAsset = {
  id: 'a1',
  gameId: 'g1',
  name: 'W',
  category: null,
  prompt: 'p',
  width: 64,
  height: 64,
  workflow: 'schnell-opaque',
  seed: null,
  status: 'idle',
  generations: [],
  selectedGenerationId: null,
  error: null,
  progress: null,
};

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
});

describe('assets actions', () => {
  it('openGame loads assets, sets active, and joins the game', async () => {
    const joinGame = vi.fn();
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([asset]),
        createAsset: vi.fn(),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame, leaveGame: vi.fn(), generateAsset: vi.fn() },
    });
    await actions.openGame('g1');
    expect(assetsSlice().activeGameId.get()).toBe('g1');
    expect(assetsSlice().assets.get({ noproxy: true })).toHaveLength(1);
    expect(joinGame).toHaveBeenCalledWith('g1');
  });

  it('generateAsset emits via the socket for the asset', async () => {
    const generateAsset = vi.fn();
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([asset]),
        createAsset: vi.fn(),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame: vi.fn(), generateAsset },
    });
    await actions.openGame('g1');
    actions.generateAsset('a1');
    expect(generateAsset).toHaveBeenCalledWith('g1', 'a1');
  });

  it('createAsset appends the new asset to the slice', async () => {
    const created = { ...asset, id: 'a2' };
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([]),
        createAsset: vi.fn().mockResolvedValue(created),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame: vi.fn(), generateAsset: vi.fn() },
    });
    await actions.openGame('g1');
    await actions.createAsset({ name: 'W', prompt: 'p', width: 64, height: 64, workflow: 'schnell-opaque' });
    expect(
      assetsSlice()
        .assets.get({ noproxy: true })
        .map((a) => a.id),
    ).toContain('a2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/actions.spec.ts`
Expected: FAIL — cannot resolve `./actions`.

- [ ] **Step 3: Write the implementation**

```ts
// studio/frontend/src/plugins/assets/actions.ts
import { assetsSlice, type IAsset } from './state';
import { upsertAsset } from './reducers';
import * as realRest from './restClient';
import type { ICreateAssetInput } from './restClient';
import { getSocketClient, initSocketClient, type SocketClient } from './socketClient';

interface IRestDeps {
  getGames: typeof realRest.getGames;
  getAssets: typeof realRest.getAssets;
  createAsset: typeof realRest.createAsset;
  updateAsset: typeof realRest.updateAsset;
  deleteAsset: typeof realRest.deleteAsset;
  selectGeneration: typeof realRest.selectGeneration;
}

type SocketDeps = Pick<SocketClient, 'connect' | 'disconnect' | 'joinGame' | 'leaveGame' | 'generateAsset'>;

let rest: IRestDeps = realRest;
let socket: SocketDeps | null = null;
let started = false;

export function __setDeps(deps: { rest?: IRestDeps; socket?: SocketDeps | null }): void {
  if (deps.rest) rest = deps.rest;
  if (deps.socket !== undefined) {
    socket = deps.socket;
    started = false;
  }
}

function sock(): SocketDeps {
  return socket ?? getSocketClient();
}

function ensureConnected(): void {
  if (started) return;
  if (socket === null) initSocketClient();
  started = true;
  sock().connect();
}

const read = () => assetsSlice().assets.get({ noproxy: true }) as IAsset[];

export async function loadGames(): Promise<void> {
  assetsSlice().gamesStatus.set('loading');
  try {
    assetsSlice().games.set(await rest.getGames());
    assetsSlice().gamesStatus.set('idle');
  } catch {
    assetsSlice().gamesStatus.set('error');
  }
}

export async function openGame(gameId: string): Promise<void> {
  const s = assetsSlice();
  if (s.activeGameId.get() === gameId) return;

  const prev = s.activeGameId.get();
  if (prev) sock().leaveGame(prev);

  s.activeGameId.set(gameId);
  s.assets.set([]);
  s.assetsStatus.set('loading');

  try {
    const assets = await rest.getAssets(gameId);
    if (assetsSlice().activeGameId.get() !== gameId) return; // a newer openGame won
    s.assets.set(assets);
    s.assetsStatus.set('idle');
  } catch {
    if (assetsSlice().activeGameId.get() !== gameId) return;
    s.assetsStatus.set('error');
  }
  sock().joinGame(gameId);
}

export async function createAsset(input: ICreateAssetInput): Promise<void> {
  const gameId = assetsSlice().activeGameId.get();
  if (!gameId) return;
  const created = await rest.createAsset(gameId, input);
  assetsSlice().assets.set(upsertAsset(read(), created));
}

export async function updateAsset(assetId: string, patch: Partial<ICreateAssetInput>): Promise<void> {
  const updated = await rest.updateAsset(assetId, patch);
  assetsSlice().assets.set(upsertAsset(read(), { ...updated, progress: null }));
}

export async function deleteAsset(assetId: string): Promise<void> {
  await rest.deleteAsset(assetId);
  assetsSlice().assets.set(read().filter((a) => a.id !== assetId));
}

export function generateAsset(assetId: string): void {
  const gameId = assetsSlice().activeGameId.get();
  if (gameId) sock().generateAsset(gameId, assetId);
}

export async function selectGeneration(assetId: string, generationId: string): Promise<void> {
  const updated = await rest.selectGeneration(assetId, generationId);
  assetsSlice().assets.set(upsertAsset(read(), { ...updated, progress: null }));
}

export function initAssets(): void {
  ensureConnected();
  void loadGames();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/actions.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/actions.ts studio/frontend/src/plugins/assets/actions.spec.ts
git commit -m "feat(frontend): add assets actions (game open, CRUD, generate, select)"
```

---

## Task 14: Asset Board pane + Asset card

**Files:**

- Create: `studio/frontend/src/plugins/assets/AssetCard.tsx`
- Create: `studio/frontend/src/plugins/assets/AssetBoardPane.tsx`
- Test: `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`

**Interfaces:**

- Consumes: `assetsHooks`, `assetsSlice`, actions (Task 13), `BACKEND_URL`.
- Produces: `AssetBoardPane` (default-exported-style component used in the manifest), `AssetCard`.

The render-count discipline (a progress tick re-renders only the one card) is enforced by each `AssetCard` subscribing to **its own** asset node via `assetsHooks.usePluginState().assets[index]` and reading individual leaves with `.get()` — mirroring chat's per-bubble subscription (`ChatRoomPane.tsx`). The board container subscribes only to `s.assets.length`, and each card calls `bumpRenderCount('AssetCard')` (the same test instrumentation chat uses).

- [ ] **Step 1: Write the failing tests (render + scoped re-render discipline)**

```tsx
// studio/frontend/src/plugins/assets/AssetCard.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState, type IAsset } from './state';
import { setAssetProgress } from './reducers';
import { AssetCard } from './AssetCard';

vi.mock('./actions', () => ({
  generateAsset: vi.fn(),
  updateAsset: vi.fn(),
  deleteAsset: vi.fn(),
  selectGeneration: vi.fn(),
}));

const mk = (over: Partial<IAsset>): IAsset => ({
  id: 'a1',
  gameId: 'g1',
  name: 'Wild',
  category: null,
  prompt: 'p',
  width: 64,
  height: 64,
  workflow: 'schnell-opaque',
  seed: null,
  status: 'generating',
  generations: [],
  selectedGenerationId: null,
  error: null,
  progress: { value: 2, max: 4 },
  ...over,
});

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  assetsSlice().assets.set([mk({})]);
  window.__renderCounts = {};
});

describe('AssetCard', () => {
  it('shows a progress indicator while generating', () => {
    render(<AssetCard index={0} />);
    expect(screen.getByTestId('asset-progress')).toBeTruthy();
  });

  it('shows the selected generation image when done', () => {
    assetsSlice().assets.set([
      mk({
        status: 'done',
        generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
        selectedGenerationId: 'gen1',
        progress: null,
      }),
    ]);
    render(<AssetCard index={0} />);
    const img = screen.getByTestId('asset-selected-image') as HTMLImageElement;
    expect(img.src).toContain('/media/g1/a1/gen1.png');
  });

  it('a progress tick re-renders only the targeted card', () => {
    assetsSlice().assets.set([mk({ id: 'a1', progress: null, status: 'queued' }), mk({ id: 'a2', progress: null, status: 'queued' })]);
    render(
      <>
        <AssetCard index={0} />
        <AssetCard index={1} />
      </>,
    );
    window.__renderCounts = {}; // reset after mount
    act(() => {
      const cur = assetsSlice().assets.get({ noproxy: true }) as IAsset[];
      assetsSlice().assets.set(setAssetProgress(cur, 'a1', 1, 4));
    });
    // Exactly one card re-rendered (the one whose node changed), not both.
    expect(window.__renderCounts['AssetCard'] ?? 0).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/AssetCard.spec.tsx`
Expected: FAIL — cannot resolve `./AssetCard`.

- [ ] **Step 3: Write `AssetCard` (per-node scoped subscription)**

```tsx
// studio/frontend/src/plugins/assets/AssetCard.tsx
import { assetsHooks } from './state';
import type { IGeneration } from './state';
import { BACKEND_URL } from './config';
import { generateAsset, deleteAsset, selectGeneration } from './actions';
import { bumpRenderCount } from '../../app/renderCount';

// Subscribes to ITS OWN asset node (s.assets[index]) and reads individual leaves,
// so an asset_progress tick re-renders only this card — not its siblings, not the board.
export function AssetCard({ index }: { index: number }) {
  const s = assetsHooks.usePluginState();
  const a = s.assets[index];
  bumpRenderCount('AssetCard');

  const id = a.id.get();
  const status = a.status.get();
  const generations = a.generations.get() as IGeneration[];
  const selectedId = a.selectedGenerationId.get();
  const progress = a.progress.get();
  const selected = generations.find((g) => g.id === selectedId);

  return (
    <div className="asset-card" data-testid={`asset-card-${id}`}>
      <header>
        <strong>{a.name.get()}</strong> <span>{a.workflow.get()}</span>
      </header>

      {selected && (
        <img
          data-testid="asset-selected-image"
          src={`${BACKEND_URL}${selected.imageRef}`}
          alt={a.name.get()}
          width={a.width.get()}
          height={a.height.get()}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      )}

      {status === 'generating' && progress && <progress data-testid="asset-progress" value={progress.value} max={progress.max} />}
      {status === 'queued' && <span data-testid="asset-queued">queued…</span>}
      {status === 'error' && <span data-testid="asset-error">{a.error.get() ?? 'error'}</span>}

      {generations.length > 0 && (
        <div className="asset-candidates" data-testid="asset-candidates">
          {generations.map((g) => (
            <img
              key={g.id}
              src={`${BACKEND_URL}${g.imageRef}`}
              alt={`seed ${g.seed}`}
              width={48}
              height={48}
              onClick={() => void selectGeneration(id, g.id)}
              style={{ outline: g.id === selectedId ? '2px solid currentColor' : 'none', cursor: 'pointer' }}
            />
          ))}
        </div>
      )}

      <div className="asset-actions">
        <button onClick={() => generateAsset(id)} disabled={status === 'generating' || status === 'queued'}>
          Generate
        </button>
        <button onClick={() => void deleteAsset(id)}>Delete</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write `AssetBoardPane`**

```tsx
// studio/frontend/src/plugins/assets/AssetBoardPane.tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { assetsHooks } from './state';
import type { IGame, Workflow } from './state';
import { openGame, createAsset, loadGames } from './actions';
import { AssetCard } from './AssetCard';
import { bumpRenderCount } from '../../app/renderCount';

const WORKFLOWS: Workflow[] = ['schnell-opaque', 'schnell-transparent', 'dev-transparent'];

export function AssetBoardPane(_props: IDockviewPanelProps) {
  const s = assetsHooks.usePluginState();
  const games = s.games.get({ noproxy: true }) as IGame[];
  const activeGameId = s.activeGameId.get();
  // Subscribe only to the COUNT so adding/removing assets re-renders the grid, but a
  // progress tick (which mutates one asset node) does not re-render the board shell.
  const assetCount = s.assets.length;
  bumpRenderCount('AssetBoardPane');

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState<Workflow>('schnell-transparent');

  return (
    <div className="asset-board" style={{ padding: 12 }}>
      <label>
        Game:{' '}
        <select data-testid="game-select" value={activeGameId ?? ''} onChange={(e) => void openGame(e.target.value)}>
          <option value="" disabled>
            Select a game…
          </option>
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>{' '}
      <button data-testid="refresh-games" onClick={() => void loadGames()}>
        ↻ Refresh games
      </button>
      {activeGameId && (
        <form
          data-testid="new-asset-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !prompt.trim()) return;
            void createAsset({ name, prompt, width: 1024, height: 1024, workflow });
            setName('');
            setPrompt('');
          }}
        >
          <input data-testid="asset-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input data-testid="asset-prompt" placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <select data-testid="asset-workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
            {WORKFLOWS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
          <button type="submit">Add asset</button>
        </form>
      )}
      <div className="asset-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {Array.from({ length: assetCount }, (_, i) => (
          <AssetCard key={i} index={i} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/AssetCard.spec.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/assets/AssetCard.tsx studio/frontend/src/plugins/assets/AssetBoardPane.tsx studio/frontend/src/plugins/assets/AssetCard.spec.tsx
git commit -m "feat(frontend): add Asset Board pane and Asset card with candidate strip"
```

---

## Task 15: Plugin manifest + registration + default layout

**Files:**

- Create: `studio/frontend/src/plugins/assets/index.ts`
- Create: `studio/frontend/src/plugins/assets/index.spec.ts`
- Modify: `studio/frontend/src/plugins/index.ts` (add `assets` to `PLUGINS`)
- Modify: `studio/frontend/src/app/workbenchSetup.ts` (add the board to the default layout)

**Interfaces:**

- Produces: `export const assets: IPlugin<IAssetsState>` with id `assets`, one pane `assets/board`, one command `assets/open-board`, `init: () => initAssets()`.

- [ ] **Step 1: Write the failing manifest test**

```ts
// studio/frontend/src/plugins/assets/index.spec.ts
import { describe, it, expect } from 'vitest';
import { assets } from './index';

describe('assets plugin manifest', () => {
  it('declares id, pane, and command', () => {
    expect(assets.id).toBe('assets');
    expect(assets.persist).toBe(false);
    expect(assets.panes.map((p) => p.id)).toEqual(['assets/board']);
    expect(assets.commands?.map((c) => c.id)).toEqual(['assets/open-board']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/index.spec.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Write the manifest**

```ts
// studio/frontend/src/plugins/assets/index.ts
import type { IPlugin } from '../../host/types';
import type { IAssetsState } from './state';
import { ASSETS_PLUGIN_ID, makeInitialState } from './state';
import { initAssets } from './actions';
import { AssetBoardPane } from './AssetBoardPane';

export const assets: IPlugin<IAssetsState> = {
  id: ASSETS_PLUGIN_ID,
  title: 'Game Assets',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'assets/board', title: 'Asset Board', component: AssetBoardPane as never }],
  commands: [{ id: 'assets/open-board', title: 'Open Asset Board', run: (host) => host.openPane('assets/board') }],
  init: () => initAssets(),
};
```

- [ ] **Step 4: Register the plugin and add it to the default layout**

```ts
// studio/frontend/src/plugins/index.ts — modify
import { assets } from './assets';
// ...
export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets];
```

```ts
// studio/frontend/src/app/workbenchSetup.ts — add inside DEFAULT_LAYOUT, after the chat panels
add('assets/board', { direction: 'below', referencePanel: 'llm-chat/room' });
```

- [ ] **Step 5: Run manifest test + full frontend unit suite**

Run: `cd studio/frontend && npx vitest run src/plugins/assets`
Expected: PASS (manifest + all assets unit specs).

Run: `cd studio/frontend && npx nx test frontend`
Expected: PASS (whole frontend unit suite; existing boot/layout specs still green).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/assets/index.ts studio/frontend/src/plugins/assets/index.spec.ts studio/frontend/src/plugins/index.ts studio/frontend/src/app/workbenchSetup.ts
git commit -m "feat(frontend): register assets plugin and add Asset Board to default layout"
```

---

## Task 16: Browser e2e (Playwright, local-only)

**Files:**

- Create: `studio/frontend/e2e/assets.spec.ts`
- Modify: `justfile` (add `e2e-assets` recipe)

**Interfaces:**

- Consumes: the running frontend (Playwright config) + a backend started with `LLM_BACKEND=fake COMFY_BACKEND=fake`.

- [ ] **Step 1: Add a justfile recipe**

```make
# Browser e2e for the assets plugin. Start a fake backend in another terminal:
#   cd studio/backend && LLM_BACKEND=fake COMFY_BACKEND=fake uv run uvicorn app.main:app --port 8000
# Local-only; not in CI.
e2e-assets:
    npx playwright test --config=studio/frontend/playwright.config.ts assets
```

- [ ] **Step 2: Write the e2e spec**

This mirrors the exact harness in `studio/frontend/e2e/llm-chat.spec.ts` (session seeding via `seedLocalStorage`, the room-picker, and the create-room control). Creating a room creates the game; the board then refreshes its game list and selects it.

```ts
// studio/frontend/e2e/assets.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

async function openApp(page: Page, username: string) {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
}

async function createGameViaRoom(page: Page, name: string) {
  await page.getByPlaceholder(/new room/i).fill(name);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

async function selectGameOnBoard(page: Page, gameName: string) {
  // The board is in the default layout (added in Task 15). The game was created
  // after the assets plugin booted, so refresh its game list first.
  await page.getByTestId('refresh-games').click();
  await expect(page.getByTestId('game-select').locator('option', { hasText: gameName })).toHaveCount(1);
  await page.getByTestId('game-select').selectOption({ label: gameName });
}

async function addAsset(page: Page) {
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page.getByTestId(/^asset-card-/)).toBeVisible();
}

test('author a game asset and generate it with live progress', async ({ page }) => {
  const name = `E2E Slot ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  await selectGameOnBoard(page, name);
  await addAsset(page);

  await page.getByRole('button', { name: 'Generate' }).click();

  // Live progress appears, then the produced image (fake provider returns a PNG fast).
  await expect(page.getByTestId('asset-progress')).toBeVisible();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });

  // Generate a second candidate and confirm the candidate strip grows to >= 2.
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(async () => {
    const thumbs = await page.getByTestId('asset-candidates').locator('img').count();
    expect(thumbs).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });
});

test('two clients in the same game both see a generation live', async ({ browser }) => {
  const name = `Shared Slot ${Date.now()}`;
  const a = await browser.newPage();
  const b = await browser.newPage();

  await openApp(a, 'alice');
  await createGameViaRoom(a, name);
  await selectGameOnBoard(a, name);
  await addAsset(a);

  // bob opens the same game on his board.
  await openApp(b, 'bob');
  await selectGameOnBoard(b, name);

  // alice generates; both boards show the produced image (proves real-time fan-out).
  await a.getByRole('button', { name: 'Generate' }).click();
  await expect(a.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });
  await expect(b.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });

  await a.close();
  await b.close();
});
```

> Note: `selectGameOnBoard` on bob's page assumes bob's board shows the asset alice added. Because asset state is server-owned and bob `join_game`s + `GET /assets` on `openGame`, bob's board lists the asset after selection. If bob selects before alice's `addAsset` commits, add a short `await expect(b.getByTestId(/^asset-card-/)).toBeVisible()` before the generate assertions.

- [ ] **Step 3: Run the e2e locally**

Terminal 1: `cd studio/backend && LLM_BACKEND=fake COMFY_BACKEND=fake uv run uvicorn app.main:app --port 8000`
Terminal 2: `just e2e-assets`
Expected: both tests PASS (progress shows, image renders, candidate strip grows, two contexts both update).

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/assets.spec.ts justfile
git commit -m "test(frontend): browser e2e for asset authoring and generation"
```

---

## Final verification

- [ ] Backend: `cd studio/backend && uv run pytest -q` → all green (unit + non-browser e2e).
- [ ] Frontend unit: `cd studio/frontend && npx nx test frontend` → all green.
- [ ] Frontend e2e (local): `just e2e-assets` with a fake backend → all green.
- [ ] Manual smoke: run `just backend-serve-fake` (add `COMFY_BACKEND=fake`) + `just serve-frontend`, create a room, select the game on the Asset Board, add an asset, Generate, confirm live progress + image + candidate selection.

## Self-Review notes (coverage map)

- Spec §3 data model → Tasks 2, 10. §4 game lifecycle/ownership → Task 1 (create-on-room), Task 7 (`GET /games`, no mutation), Task 14 (read-only selector). §5 backend split → Tasks 1–9. §5.1 socket scope=game → Tasks 6–8. §5.2 generation flow → Task 6. §5.3 media → Tasks 5, 8. §5.4 provider seam → Task 4. §6 frontend → Tasks 10–15. §6.1 event application + guards → Tasks 10, 12. §8 testing → unit tasks throughout + Tasks 9, 16. §9 out-of-scope honored (no LLM auto-pop, no game mutation UI, free-form category, fake in CI).
