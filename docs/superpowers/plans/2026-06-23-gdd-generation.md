# GDD Generation & Gap-Driven Elicitation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user describe a casino game in chat and have the AI draft a full Game Design Document (one markdown doc per fixed aspect), then interview them — one blocking question at a time — to resolve the highest-impact gaps, with a live read-only viewer pane.

**Architecture:** Approach A — maximal reuse. The interview is a built-in `design-game` skill driving the existing `TurnRunner` react-agent. New backend surface: a `GddDoc`/`GddStore` (Mongo, mirrors `AssetStore`), a `GddHub` that writes + emits Socket.IO updates, six agent tools (doc CRUD + surgical `edit_gdd_doc` + `ask_user_question`), and a **generalized interrupt** — the existing approve/reject gate widened to carry a richer "question" payload through the same RoomHub future/resume plumbing. New frontend surface: a `QuestionCard` (suggestions / free-text / "you decide") rendered for a new `question` run-step, and a read-only `plugins/gdd` viewer pane (clones `plugins/assets`).

**Tech Stack:** Python 3 · FastAPI · python-socketio · LangGraph (`create_react_agent`, `interrupt`) · Motor (async MongoDB) · pydantic v2 · pytest/pytest-asyncio · React 18 + TypeScript · Hookstate · Dockview · Vitest + @testing-library/react · Playwright.

## Global Constraints

- **TDD mandatory** — write the failing test, watch it fail, minimal code to pass, refactor. Frequent semantic commits.
- **Commits use Conventional Commits** — `feat(...)`, `test(...)`, `docs(...)`, etc., imperative mood.
- **TypeScript interfaces use an `I` prefix** (`IGddDoc`, `IQuestion`).
- **No raw colors in component code** — only Tailwind utilities backed by `--token` CSS variables (`bg-surface`, `text-text-2`, `border-hairline`, `text-accent-text`, …). Raw hex/rgb/hsl is blocked by `src/design-language.guard.spec.ts`.
- **Backend wire models** subclass `_WireModel` (snake_case in Python, camelCase on the wire via `to_camel` alias generator); store docs use `_id` (map to `id`).
- **Browser e2e (Playwright) is NOT run in CI** — run locally. Backend unit + non-browser service e2e are CI-affordable.
- **Backend tests** run against a real local MongoDB via the `mongo_db` fixture (`studio/backend/tests/conftest.py`); service e2e spawns a replay backend via the `live_server` fixture (`tests/e2e/conftest.py`).
- **Skill files** live in `C:\code\bloom\skills\` and are git-tracked; `SkillRegistry` validates each skill's `tools` against `ToolFactory.known_tool_names()`.

**Backend commands** (run from `studio/backend`):

- Unit: `uv run pytest -m "not e2e" -q`
- Service e2e: `uv run pytest -m e2e -q`

**Frontend commands** (run from `studio/frontend`):

- Unit: `npx vitest run`
- CI gate quartet: `npx prettier --check .` · `npx nx run-many -t typecheck` · `npx nx run-many -t test` · `npx nx run-many -t build`

---

## File Structure

**Backend (new):**

- `studio/backend/app/gdd/__init__.py`
- `studio/backend/app/gdd/models.py` — `GddDoc`, `Status`, `GDD_TAXONOMY`, `GDD_TOOL_NAMES`, `gdd_wire()`
- `studio/backend/app/gdd/store.py` — `GddStore`, `GddEditError`
- `studio/backend/app/gdd/hub.py` — `GddHub` (write + emit)
- `studio/backend/app/gdd/sockets.py` — `register_gdd_handlers` (`join_gdd`/`leave_gdd`)
- `skills/design-game.md` — built-in interview skill
- Tests: `tests/test_gdd_models.py`, `tests/test_gdd_store.py`, `tests/test_gdd_tools.py`, `tests/test_question_interrupt.py`, `tests/test_design_game_skill.py`, `tests/e2e/test_gdd.py`

**Backend (modified):**

- `studio/backend/app/agent_tools.py` — extend `ToolContext`; add 6 tool builders; register in `_BUILDERS`; extend `ToolFactory.__init__`
- `studio/backend/app/runs.py` — add `"question"` to `RunStep.type`
- `studio/backend/app/room_hub.py` — branch interrupt handling (approval vs question); add `resolve_question`; seed taxonomy on a gdd-tool skill run; pass gdd into `ToolContext`
- `studio/backend/app/sockets.py` — add `resolve_question` handler
- `studio/backend/app/main.py` — construct + wire `GddStore`/`GddHub`; register gdd handlers
- `studio/backend/app/rest.py` — `GET /games/{game_id}/gdd/docs`

**Frontend (new):** `studio/frontend/src/plugins/gdd/` — `config.ts`, `state.ts`, `restClient.ts`, `socketClient.ts`, `reducers.ts`, `actions.ts`, `GddViewerPane.tsx`, `index.ts` (+ `*.spec.ts(x)`); and `studio/frontend/src/plugins/llm-chat/QuestionCard.tsx` (+ spec).

**Frontend (modified):** `plugins/llm-chat/state.ts` (add `question` type + `IQuestion`/`parseQuestion`), `plugins/llm-chat/actions.ts` (+ `resolveQuestion`), `plugins/llm-chat/socketClient.ts` (+ `resolveQuestion`), `plugins/llm-chat/RunTurnBlock.tsx` (route `question` → `QuestionCard`), `plugins/index.ts` (register `gdd`).

---

## Task 1: GddDoc model, taxonomy, and wire helper

**Files:**

- Create: `studio/backend/app/gdd/__init__.py` (empty)
- Create: `studio/backend/app/gdd/models.py`
- Test: `studio/backend/tests/test_gdd_models.py`

**Interfaces:**

- Produces: `GddDoc` (pydantic, `_WireModel`), `Status = Literal["empty","drafted","needs_input","complete"]`, `GDD_TAXONOMY: list[dict]` (each `{aspect, title, order}`), `GDD_TOOL_NAMES: set[str]`, `gdd_wire(doc) -> dict`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_models.py
from datetime import datetime, timezone
from app.gdd.models import GddDoc, GDD_TAXONOMY, GDD_TOOL_NAMES, gdd_wire


def _doc() -> GddDoc:
    now = datetime(2026, 6, 23, tzinfo=timezone.utc)
    return GddDoc(
        id="d1", game_id="g1", aspect="math-model", title="Math Model",
        order=2, body="RTP 96%", status="drafted", created_at=now, updated_at=now,
    )


def test_taxonomy_is_seven_ordered_aspects():
    aspects = [t["aspect"] for t in GDD_TAXONOMY]
    assert aspects == [
        "theme", "math-model", "symbols-reels", "paytable",
        "bonus-features", "ui-ux", "audio",
    ]
    assert [t["order"] for t in GDD_TAXONOMY] == [1, 2, 3, 4, 5, 6, 7]


def test_gdd_tool_names_cover_the_six_tools():
    assert GDD_TOOL_NAMES == {
        "list_gdd_docs", "read_gdd_doc", "write_gdd_doc",
        "edit_gdd_doc", "set_doc_status", "ask_user_question",
    }


def test_gdd_wire_uses_camelcase_aliases():
    wire = gdd_wire(_doc())
    assert wire["gameId"] == "g1"
    assert wire["aspect"] == "math-model"
    assert wire["status"] == "drafted"
    assert "game_id" not in wire
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_models.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.gdd'`.

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/gdd/models.py
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

Status = Literal["empty", "drafted", "needs_input", "complete"]


class _WireModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class GddDoc(_WireModel):
    id: str
    game_id: str
    aspect: str
    title: str
    order: int
    body: str = ""
    status: Status = "empty"
    created_at: datetime
    updated_at: datetime


GDD_TAXONOMY: list[dict] = [
    {"aspect": "theme", "title": "Theme & Narrative", "order": 1},
    {"aspect": "math-model", "title": "Math Model", "order": 2},
    {"aspect": "symbols-reels", "title": "Symbols & Reels", "order": 3},
    {"aspect": "paytable", "title": "Paytable", "order": 4},
    {"aspect": "bonus-features", "title": "Bonus Features", "order": 5},
    {"aspect": "ui-ux", "title": "UI / UX & Layout", "order": 6},
    {"aspect": "audio", "title": "Audio", "order": 7},
]

GDD_TOOL_NAMES: set[str] = {
    "list_gdd_docs", "read_gdd_doc", "write_gdd_doc",
    "edit_gdd_doc", "set_doc_status", "ask_user_question",
}


def gdd_wire(doc: GddDoc) -> dict:
    return doc.model_dump(by_alias=True, mode="json")
```

Also create empty `studio/backend/app/gdd/__init__.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_models.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/__init__.py studio/backend/app/gdd/models.py studio/backend/tests/test_gdd_models.py
git commit -m "feat(gdd): GddDoc model, fixed taxonomy, and wire helper"
```

---

## Task 2: GddStore (persistence + surgical edit)

**Files:**

- Create: `studio/backend/app/gdd/store.py`
- Test: `studio/backend/tests/test_gdd_store.py`

**Interfaces:**

- Consumes: `GddDoc`, `Status`, `GDD_TAXONOMY` (Task 1).
- Produces:
  - `GddStore(db)` with async methods: `seed_taxonomy(game_id) -> list[GddDoc]`, `list_docs(game_id) -> list[GddDoc]`, `get_doc(game_id, aspect) -> GddDoc | None`, `upsert_doc(game_id, aspect, *, title=None, body=None, status=None) -> GddDoc`, `edit_doc(game_id, aspect, old_string, new_string, replace_all=False) -> GddDoc`, `set_status(game_id, aspect, status) -> GddDoc`.
  - `GddEditError(Exception)` — raised by `edit_doc` on no-match / ambiguous-match.

- [ ] **Step 1: Write the failing test**

The `mongo_db` fixture (real Motor db, cleaned per test) already exists in `tests/conftest.py`; add `"gdd_docs"` cleanup is NOT required for correctness because each test uses a fresh game id, but the fixture also wipes collections. If `gdd_docs` is not in the fixture's wipe list, tests still pass via unique game ids.

```python
# studio/backend/tests/test_gdd_store.py
import pytest
from app.gdd.store import GddStore, GddEditError


@pytest.mark.asyncio
async def test_seed_taxonomy_creates_seven_empty_docs_idempotently(mongo_db):
    store = GddStore(mongo_db)
    first = await store.seed_taxonomy("g1")
    assert [d.aspect for d in first] == [
        "theme", "math-model", "symbols-reels", "paytable",
        "bonus-features", "ui-ux", "audio",
    ]
    assert all(d.status == "empty" and d.body == "" for d in first)
    # Idempotent: seeding again does not duplicate.
    again = await store.seed_taxonomy("g1")
    assert len(again) == 7
    assert len(await store.list_docs("g1")) == 7


@pytest.mark.asyncio
async def test_upsert_doc_replaces_body_in_place(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc = await store.upsert_doc("g1", "theme", title="Theme & Narrative",
                                 body="Ancient Egypt", status="drafted")
    assert doc.body == "Ancient Egypt" and doc.status == "drafted"
    # No duplicate row for the same (game, aspect).
    assert len([d for d in await store.list_docs("g1") if d.aspect == "theme"]) == 1


@pytest.mark.asyncio
async def test_edit_doc_replaces_unique_block(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    await store.upsert_doc("g1", "math-model", body="RTP: TBD\nVolatility: high")
    doc = await store.edit_doc("g1", "math-model", "RTP: TBD", "RTP: 96%")
    assert doc.body == "RTP: 96%\nVolatility: high"


@pytest.mark.asyncio
async def test_edit_doc_raises_when_missing_or_ambiguous(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    await store.upsert_doc("g1", "paytable", body="row\nrow")
    with pytest.raises(GddEditError):
        await store.edit_doc("g1", "paytable", "missing", "x")
    with pytest.raises(GddEditError):
        await store.edit_doc("g1", "paytable", "row", "x")  # 2 matches, no replace_all
    doc = await store.edit_doc("g1", "paytable", "row", "x", replace_all=True)
    assert doc.body == "x\nx"


@pytest.mark.asyncio
async def test_set_status(mongo_db):
    store = GddStore(mongo_db)
    await store.seed_taxonomy("g1")
    doc = await store.set_status("g1", "audio", "complete")
    assert doc.status == "complete"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_store.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.gdd.store'`.

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/gdd/store.py
from datetime import datetime, timezone
from uuid import uuid4

from app.gdd.models import GDD_TAXONOMY, GddDoc, Status


class GddEditError(Exception):
    """Raised when edit_doc's old_string is missing or not unique."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _to_doc(doc: GddDoc) -> dict:
    raw = doc.model_dump(mode="json")
    raw["_id"] = raw.pop("id")
    return raw


def _from_doc(raw: dict) -> GddDoc:
    data = dict(raw)
    data["id"] = data.pop("_id")
    return GddDoc.model_validate(data)


class GddStore:
    def __init__(self, db):
        self._docs = db["gdd_docs"]

    async def seed_taxonomy(self, game_id: str) -> list[GddDoc]:
        for entry in GDD_TAXONOMY:
            existing = await self._docs.find_one(
                {"game_id": game_id, "aspect": entry["aspect"]}
            )
            if existing is not None:
                continue
            now = _now()
            doc = GddDoc(
                id=uuid4().hex, game_id=game_id, aspect=entry["aspect"],
                title=entry["title"], order=entry["order"],
                body="", status="empty", created_at=now, updated_at=now,
            )
            await self._docs.insert_one(_to_doc(doc))
        return await self.list_docs(game_id)

    async def list_docs(self, game_id: str) -> list[GddDoc]:
        cursor = self._docs.find({"game_id": game_id}).sort("order", 1)
        return [_from_doc(d) async for d in cursor]

    async def get_doc(self, game_id: str, aspect: str) -> GddDoc | None:
        raw = await self._docs.find_one({"game_id": game_id, "aspect": aspect})
        return _from_doc(raw) if raw else None

    async def upsert_doc(self, game_id: str, aspect: str, *, title=None,
                         body=None, status: Status | None = None) -> GddDoc:
        fields: dict = {"updated_at": _now().isoformat()}
        if title is not None:
            fields["title"] = title
        if body is not None:
            fields["body"] = body
        if status is not None:
            fields["status"] = status
        await self._docs.update_one(
            {"game_id": game_id, "aspect": aspect}, {"$set": fields}
        )
        doc = await self.get_doc(game_id, aspect)
        assert doc is not None  # seeded before any write
        return doc

    async def edit_doc(self, game_id: str, aspect: str, old_string: str,
                       new_string: str, replace_all: bool = False) -> GddDoc:
        doc = await self.get_doc(game_id, aspect)
        if doc is None:
            raise GddEditError(f"No GDD doc for aspect '{aspect}'.")
        count = doc.body.count(old_string)
        if count == 0:
            raise GddEditError(f"old_string not found in '{aspect}'.")
        if count > 1 and not replace_all:
            raise GddEditError(
                f"old_string is not unique in '{aspect}' ({count} matches); "
                "pass replace_all=true or a longer, unique string."
            )
        new_body = doc.body.replace(old_string, new_string)
        return await self.upsert_doc(game_id, aspect, body=new_body)

    async def set_status(self, game_id: str, aspect: str, status: Status) -> GddDoc:
        return await self.upsert_doc(game_id, aspect, status=status)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_store.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/store.py studio/backend/tests/test_gdd_store.py
git commit -m "feat(gdd): GddStore with idempotent seeding and surgical edit_doc"
```

---

## Task 3: GddHub (write + emit) and socket handlers

**Files:**

- Create: `studio/backend/app/gdd/hub.py`
- Create: `studio/backend/app/gdd/sockets.py`
- Test: `studio/backend/tests/test_gdd_hub.py`

**Interfaces:**

- Consumes: `GddStore`, `GddEditError` (Task 2), `gdd_wire` (Task 1).
- Produces:
  - `GddHub(sio, store)` async methods: `seed_taxonomy(game_id) -> list[GddDoc]`, `write_doc(game_id, aspect, title, body, status) -> GddDoc`, `edit_doc(game_id, aspect, old_string, new_string, replace_all=False) -> GddDoc`, `set_status(game_id, aspect, status) -> GddDoc`, `attach(game_id, sid)`. Each mutation emits `gdd_doc_updated` to `room=game_id`; `attach` emits `gdd_snapshot` to the sid.
  - `register_gdd_handlers(sio, hub)` — `join_gdd` / `leave_gdd` socket events.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_hub.py
import pytest
from app.gdd.hub import GddHub
from app.gdd.store import GddStore


class FakeSio:
    def __init__(self):
        self.emitted = []
        self.rooms = []

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room, to))

    async def enter_room(self, sid, room):
        self.rooms.append((sid, room))


@pytest.mark.asyncio
async def test_write_doc_persists_and_emits_update(mongo_db):
    sio, store = FakeSio(), GddStore(mongo_db)
    hub = GddHub(sio, store)
    await hub.seed_taxonomy("g1")
    doc = await hub.write_doc("g1", "theme", "Theme & Narrative", "Egypt", "drafted")
    assert doc.body == "Egypt"
    events = [e for e in sio.emitted if e[0] == "gdd_doc_updated"]
    last = events[-1]
    assert last[1]["gameId"] == "g1"
    assert last[1]["doc"]["aspect"] == "theme"
    assert last[2] == "g1"  # room


@pytest.mark.asyncio
async def test_attach_enters_room_and_sends_snapshot(mongo_db):
    sio, store = FakeSio(), GddStore(mongo_db)
    hub = GddHub(sio, store)
    await hub.seed_taxonomy("g1")
    await hub.attach("g1", "sid-1")
    assert ("sid-1", "g1") in sio.rooms
    snap = [e for e in sio.emitted if e[0] == "gdd_snapshot"][-1]
    assert snap[1]["gameId"] == "g1"
    assert len(snap[1]["docs"]) == 7
    assert snap[3] == "sid-1"  # to=sid
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_hub.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.gdd.hub'`.

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/gdd/hub.py
from app.gdd.models import GddDoc, Status, gdd_wire
from app.gdd.store import GddStore


class GddHub:
    def __init__(self, sio, store: GddStore):
        self._sio = sio
        self._store = store

    async def seed_taxonomy(self, game_id: str) -> list[GddDoc]:
        docs = await self._store.seed_taxonomy(game_id)
        for doc in docs:
            await self._emit_updated(game_id, doc)
        return docs

    async def write_doc(self, game_id: str, aspect: str, title: str,
                        body: str, status: Status) -> GddDoc:
        doc = await self._store.upsert_doc(
            game_id, aspect, title=title, body=body, status=status
        )
        await self._emit_updated(game_id, doc)
        return doc

    async def edit_doc(self, game_id: str, aspect: str, old_string: str,
                       new_string: str, replace_all: bool = False) -> GddDoc:
        doc = await self._store.edit_doc(
            game_id, aspect, old_string, new_string, replace_all
        )
        await self._emit_updated(game_id, doc)
        return doc

    async def set_status(self, game_id: str, aspect: str, status: Status) -> GddDoc:
        doc = await self._store.set_status(game_id, aspect, status)
        await self._emit_updated(game_id, doc)
        return doc

    async def attach(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        docs = await self._store.list_docs(game_id)
        await self._sio.emit(
            "gdd_snapshot",
            {"gameId": game_id, "docs": [gdd_wire(d) for d in docs]},
            to=sid,
        )

    async def _emit_updated(self, game_id: str, doc: GddDoc) -> None:
        await self._sio.emit(
            "gdd_doc_updated",
            {"gameId": game_id, "doc": gdd_wire(doc)},
            room=game_id,
        )
```

```python
# studio/backend/app/gdd/sockets.py
def register_gdd_handlers(sio, hub):
    @sio.on("join_gdd")
    async def join_gdd(sid, data):
        await hub.attach(data["gameId"], sid)

    @sio.on("leave_gdd")
    async def leave_gdd(sid, data):
        await sio.leave_room(sid, data["gameId"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_hub.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/hub.py studio/backend/app/gdd/sockets.py studio/backend/tests/test_gdd_hub.py
git commit -m "feat(gdd): GddHub write+emit and join_gdd/leave_gdd socket handlers"
```

---

## Task 4: GDD document agent tools

**Files:**

- Modify: `studio/backend/app/agent_tools.py`
- Test: `studio/backend/tests/test_gdd_tools.py`

**Interfaces:**

- Consumes: `GddStore`, `GddEditError`, `GddHub`.
- Modifies `ToolContext` to add `gdd_store` and `gdd_hub` fields (default `None`); adds builders `build_list_gdd_docs_tool`, `build_read_gdd_doc_tool`, `build_write_gdd_doc_tool`, `build_edit_gdd_doc_tool`, `build_set_doc_status_tool` and registers them in `ToolFactory._BUILDERS`. Extends `ToolFactory.__init__(self, asset_store, asset_hub, gdd_store=None, gdd_hub=None)`.
- Produces tool names: `list_gdd_docs`, `read_gdd_doc`, `write_gdd_doc`, `edit_gdd_doc`, `set_doc_status` (the 6th, `ask_user_question`, is Task 5).

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_tools.py
import pytest
from app.agent_tools import ToolContext, ToolFactory
from app.gdd.hub import GddHub
from app.gdd.store import GddStore


def _ctx(store, hub):
    return ToolContext(room_id="r1", game_id="g1", asset_store=None,
                       asset_hub=None, gdd_store=store, gdd_hub=hub)


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


def _factory(store, hub):
    return ToolFactory(asset_store=None, asset_hub=None, gdd_store=store, gdd_hub=hub)


@pytest.mark.asyncio
async def test_write_then_list_then_edit(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    factory = _factory(store, hub)
    ctx = _ctx(store, hub)

    write = factory.build(["write_gdd_doc"], ctx)[0]
    await write.ainvoke({"aspect": "math-model", "title": "Math Model",
                         "body": "RTP: TBD", "status": "drafted"})

    list_tool = factory.build(["list_gdd_docs"], ctx)[0]
    listing = await list_tool.ainvoke({})
    assert "math-model" in listing and "drafted" in listing

    edit = factory.build(["edit_gdd_doc"], ctx)[0]
    await edit.ainvoke({"aspect": "math-model", "old_string": "RTP: TBD",
                        "new_string": "RTP: 96%"})
    assert (await store.get_doc("g1", "math-model")).body == "RTP: 96%"


@pytest.mark.asyncio
async def test_edit_returns_error_string_when_unmatched(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    edit = _factory(store, hub).build(["edit_gdd_doc"], ctx)[0]
    result = await edit.ainvoke({"aspect": "theme", "old_string": "nope",
                                 "new_string": "x"})
    assert "not found" in result.lower()  # surfaced to the agent, not raised


@pytest.mark.asyncio
async def test_set_doc_status(mongo_db):
    store = GddStore(mongo_db)
    hub = GddHub(_SilentSio(), store)
    await store.seed_taxonomy("g1")
    ctx = _ctx(store, hub)
    tool = _factory(store, hub).build(["set_doc_status"], ctx)[0]
    await tool.ainvoke({"aspect": "audio", "status": "complete"})
    assert (await store.get_doc("g1", "audio")).status == "complete"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_tools.py -q`
Expected: FAIL — `TypeError: ToolContext.__init__() got an unexpected keyword argument 'gdd_store'`.

- [ ] **Step 3: Write minimal implementation**

In `studio/backend/app/agent_tools.py`, extend `ToolContext` (add the two fields with defaults):

```python
@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object
    gdd_store: object = None
    gdd_hub: object = None
```

Add the five builders (place near the existing asset builders). Import `GddEditError` at top: `from app.gdd.store import GddEditError`.

```python
def build_list_gdd_docs_tool(ctx: ToolContext) -> BaseTool:
    async def list_gdd_docs() -> str:
        docs = await ctx.gdd_store.list_docs(ctx.game_id)
        if not docs:
            return "No GDD docs yet."
        lines = []
        for d in docs:
            lines.append(f"## {d.title} (aspect={d.aspect}, status={d.status})")
            lines.append(d.body or "(empty)")
        return "\n\n".join(lines)

    return StructuredTool.from_function(
        coroutine=list_gdd_docs, name="list_gdd_docs",
        description="List every GDD doc for the current game with its aspect, "
                    "status, and full markdown body.",
    )


def build_read_gdd_doc_tool(ctx: ToolContext) -> BaseTool:
    async def read_gdd_doc(aspect: str) -> str:
        doc = await ctx.gdd_store.get_doc(ctx.game_id, aspect)
        if doc is None:
            return f"No GDD doc for aspect '{aspect}'."
        return f"status={doc.status}\n\n{doc.body or '(empty)'}"

    return StructuredTool.from_function(
        coroutine=read_gdd_doc, name="read_gdd_doc",
        description="Read one GDD doc's exact current markdown by aspect. "
                    "Always read before editing so old_string matches real text.",
    )


def build_write_gdd_doc_tool(ctx: ToolContext) -> BaseTool:
    async def write_gdd_doc(aspect: str, title: str, body: str,
                            status: str = "drafted") -> str:
        await ctx.gdd_hub.write_doc(ctx.game_id, aspect, title, body, status)
        return f"Wrote '{title}' (aspect {aspect}, status {status})."

    return StructuredTool.from_function(
        coroutine=write_gdd_doc, name="write_gdd_doc",
        description="Create or fully overwrite a GDD doc's markdown body. Use for "
                    "the initial draft of each aspect. status is one of "
                    "empty|drafted|needs_input|complete.",
    )


def build_edit_gdd_doc_tool(ctx: ToolContext) -> BaseTool:
    async def edit_gdd_doc(aspect: str, old_string: str, new_string: str,
                           replace_all: bool = False) -> str:
        try:
            await ctx.gdd_hub.edit_doc(ctx.game_id, aspect, old_string,
                                       new_string, replace_all)
        except GddEditError as e:
            return f"Edit failed: {e} Read the doc again and retry."
        return f"Edited '{aspect}'."

    return StructuredTool.from_function(
        coroutine=edit_gdd_doc, name="edit_gdd_doc",
        description="Surgically replace a unique block of a GDD doc. old_string "
                    "must match the current body exactly and uniquely (or set "
                    "replace_all=true). Prefer this over rewriting a whole doc.",
    )


def build_set_doc_status_tool(ctx: ToolContext) -> BaseTool:
    async def set_doc_status(aspect: str, status: str) -> str:
        await ctx.gdd_hub.set_status(ctx.game_id, aspect, status)
        return f"Set '{aspect}' status to {status}."

    return StructuredTool.from_function(
        coroutine=set_doc_status, name="set_doc_status",
        description="Set a GDD doc's status (empty|drafted|needs_input|complete) "
                    "without changing its body.",
    )
```

Extend `ToolFactory`:

```python
class ToolFactory:
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "delete_asset": build_delete_asset_tool,
        "list_gdd_docs": build_list_gdd_docs_tool,
        "read_gdd_doc": build_read_gdd_doc_tool,
        "write_gdd_doc": build_write_gdd_doc_tool,
        "edit_gdd_doc": build_edit_gdd_doc_tool,
        "set_doc_status": build_set_doc_status_tool,
        # ask_user_question added in Task 5
    }

    def __init__(self, asset_store, asset_hub, gdd_store=None, gdd_hub=None):
        self._asset_store = asset_store
        self._asset_hub = asset_hub
        self._gdd_store = gdd_store
        self._gdd_hub = gdd_hub
```

(`known_tool_names` and `build` are unchanged — they read `_BUILDERS`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_tools.py -q`
Expected: PASS (3 passed). Also run `uv run pytest tests/test_agent_tools.py -q` — existing asset-tool tests still PASS (ToolContext gained defaulted fields only).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_gdd_tools.py
git commit -m "feat(gdd): document CRUD + surgical edit agent tools"
```

---

## Task 5: `ask_user_question` tool + generalized question interrupt

This generalizes the approve/reject gate so the same RoomHub future/resume plumbing carries a richer question payload. Approval behavior is preserved unchanged (parity).

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (add `ask_user_question` builder + register)
- Modify: `studio/backend/app/runs.py` (add `"question"` step type)
- Modify: `studio/backend/app/room_hub.py` (branch interrupt handling; add `resolve_question`)
- Modify: `studio/backend/app/sockets.py` (add `resolve_question` handler)
- Test: `studio/backend/tests/test_question_interrupt.py`

**Interfaces:**

- Consumes: `interrupt` (LangGraph, already imported in `agent_tools.py`), the existing `ApprovalRequired` event + `on_approval` callback + `_pending_approvals` registry.
- Produces:
  - Tool `ask_user_question(question, suggestions=[], allow_free_text=True, allow_delegate=True, aspect=None) -> str`. Raises `interrupt(payload)` where `payload = {"kind":"question","tool":"ask_user_question","question",...}`. On resume: `{"type":"delegate"}` → returns a "use your judgment" sentence; otherwise returns `answer["value"]`.
  - `RoomHub.resolve_question(room_id, run_id, answer: dict)` — resolves the parked future with the answer dict.
  - Run step `type="question"`; on completion its `content` is `json.dumps({**payload, "answer": answer})`.

- [ ] **Step 1: Write the failing test** (tool-level resume behavior, no sockets)

```python
# studio/backend/tests/test_question_interrupt.py
import pytest
from langgraph.types import Command
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START
from typing import TypedDict

from app.agent_tools import ToolContext, ToolFactory


def _question_tool():
    factory = ToolFactory(asset_store=None, asset_hub=None)
    ctx = ToolContext("r1", "g1", None, None)
    return factory.build(["ask_user_question"], ctx)[0]


@pytest.mark.asyncio
async def test_ask_user_question_is_registered():
    tool = _question_tool()
    assert tool.name == "ask_user_question"


@pytest.mark.asyncio
async def test_resume_with_suggestion_returns_value():
    """Drive the tool through a tiny LangGraph so interrupt() can resume."""
    tool = _question_tool()

    class S(TypedDict):
        out: str

    async def node(state: S) -> S:
        ans = await tool.ainvoke({"question": "RTP target?",
                                  "suggestions": ["96%", "94%"]})
        return {"out": ans}

    g = StateGraph(S)
    g.add_node("ask", node)
    g.add_edge(START, "ask")
    app = g.compile(checkpointer=MemorySaver())
    cfg = {"configurable": {"thread_id": "t1"}}

    # First pass parks at the interrupt.
    await app.ainvoke({"out": ""}, cfg)
    # Resume with a chosen suggestion.
    final = await app.ainvoke(
        Command(resume={"type": "suggestion", "value": "96%"}), cfg
    )
    assert final["out"] == "96%"


@pytest.mark.asyncio
async def test_resume_with_delegate_returns_sentinel():
    tool = _question_tool()

    class S(TypedDict):
        out: str

    async def node(state: S) -> S:
        return {"out": await tool.ainvoke({"question": "Volatility?"})}

    g = StateGraph(S)
    g.add_node("ask", node)
    g.add_edge(START, "ask")
    app = g.compile(checkpointer=MemorySaver())
    cfg = {"configurable": {"thread_id": "t2"}}
    await app.ainvoke({"out": ""}, cfg)
    final = await app.ainvoke(Command(resume={"type": "delegate"}), cfg)
    assert "judgment" in final["out"].lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_question_interrupt.py -q`
Expected: FAIL — `ask_user_question` is not in `_BUILDERS` (empty tool list → `IndexError`).

- [ ] **Step 3: Write minimal implementation**

In `agent_tools.py`, add the builder and register it in `_BUILDERS` (key `"ask_user_question": build_ask_user_question_tool`). `interrupt` is already imported (used by `delete_asset`).

```python
def build_ask_user_question_tool(ctx: ToolContext) -> BaseTool:
    async def ask_user_question(
        question: str,
        suggestions: list[str] = None,
        allow_free_text: bool = True,
        allow_delegate: bool = True,
        aspect: str = None,
    ) -> str:
        payload = {
            "kind": "question",
            "tool": "ask_user_question",
            "question": question,
            "suggestions": suggestions or [],
            "allowFreeText": allow_free_text,
            "allowDelegate": allow_delegate,
            "aspect": aspect,
        }
        answer = interrupt(payload)
        if isinstance(answer, dict) and answer.get("type") == "delegate":
            return ("The user delegated this decision to you. Use your best "
                    "judgment to choose, apply it, and note in the doc that you "
                    "made this call.")
        if isinstance(answer, dict):
            return str(answer.get("value", ""))
        return str(answer)

    return StructuredTool.from_function(
        coroutine=ask_user_question, name="ask_user_question",
        description="Ask the user ONE focused question to resolve a material "
                    "design gap. Provide 2-4 concrete suggestions. The run pauses "
                    "until the user picks one, types their own, or delegates "
                    "('you decide'). aspect is the related GDD doc aspect.",
    )
```

In `runs.py`, widen the step type Literal:

```python
class RunStep(_WireModel):
    index: int
    type: Literal["thinking", "tool_call", "tool_result", "final",
                  "approval", "question"]
    tool_name: str | None = None
    content: str = ""
    status: Literal["running", "complete", "error"] = "running"
```

In `room_hub.py`, branch on the interrupt payload's `kind`. Where `ApprovalRequired` is currently turned into a step (`_begin_approval`) and where the decision callback (`_make_approval_cb`) and `_complete_approval` live, generalize:

```python
# When the runner yields ApprovalRequired(action, index), branch on kind:
async def _begin_interrupt(self, room_id, run_id, action, index):
    if action.get("kind") == "question":
        await self._begin_question(room_id, run_id, action, index)
    else:
        await self._begin_approval(room_id, run_id, action, index)

async def _begin_question(self, room_id, run_id, action, index):
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    self._pending_approvals[run_id] = {
        "future": fut, "step_index": index, "action": action, "kind": "question",
    }
    await self._run_store.append_step(
        run_id, RunStep(index=index, type="question",
                        content=json.dumps(action), status="running"),
    )
    await self._sio.emit(
        "run_step_started",
        {"roomId": room_id, "runId": run_id,
         "step": {"index": index, "type": "question", "toolName": None,
                  "content": json.dumps(action), "status": "running"}},
        room=room_id,
    )
```

Generalize the decision callback so questions park without the 300s timeout:

```python
async def _cb(action: dict) -> object:
    entry = self._pending_approvals.get(run_id)
    if entry is None:
        return "deny"
    fut = entry["future"]
    if entry.get("kind") == "question":
        answer = await fut  # park indefinitely until resolved
        await self._complete_question(room_id, run_id, action, answer)
        return answer
    try:
        decision = await asyncio.wait_for(fut, timeout=self._approval_timeout)
    except asyncio.TimeoutError:
        decision = "deny"
    await self._complete_approval(room_id, run_id, decision)
    return decision
```

Add completion + resolve for questions (mirrors `_complete_approval` / `resolve_approval`):

```python
async def _complete_question(self, room_id, run_id, action, answer):
    content = json.dumps({**action, "answer": answer})
    await self._run_store.complete_step(run_id, action_index := self._pending_approvals[run_id]["step_index"],
                                        "complete", content)
    await self._sio.emit(
        "run_step_completed",
        {"roomId": room_id, "runId": run_id, "stepIndex": action_index,
         "status": "complete", "content": content},
        room=room_id,
    )

async def resolve_question(self, room_id: str, run_id: str, answer: dict) -> None:
    entry = self._pending_approvals.get(run_id)
    if entry is None or entry["future"].done():
        return
    if entry.get("kind") != "question":
        return
    entry["future"].set_result(answer)
```

Wire `_begin_interrupt` in place of the direct `_begin_approval` call in the event-projection loop (where `ApprovalRequired` is handled).

In `sockets.py`, add the inbound handler:

```python
@sio.on("resolve_question")
async def resolve_question(sid, data):
    await hub.resolve_question(data["roomId"], data["runId"], data["answer"])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_question_interrupt.py -q`
Expected: PASS (3 passed).
Run: `uv run pytest tests/test_turn_runner.py tests/test_room_hub.py -q`
Expected: PASS — existing approval flow unchanged (parity).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/runs.py studio/backend/app/room_hub.py studio/backend/app/sockets.py studio/backend/tests/test_question_interrupt.py
git commit -m "feat(gdd): generalize the interrupt into a question gate (ask_user_question)"
```

---

## Task 6: Wire stores/hub into the app + REST endpoint + kickoff seeding

**Files:**

- Modify: `studio/backend/app/main.py`
- Modify: `studio/backend/app/rest.py`
- Modify: `studio/backend/app/room_hub.py` (seed taxonomy + pass gdd into `ToolContext`)
- Test: `studio/backend/tests/test_gdd_rest.py`

**Interfaces:**

- Consumes: `GddStore`, `GddHub`, `register_gdd_handlers`, `GDD_TOOL_NAMES`, `gdd_wire`.
- Produces: `GET /games/{game_id}/gdd/docs -> list[dict]` (wired docs); `app.state.gdd_store`; `RoomHub` seeds the taxonomy when a started skill's tools intersect `GDD_TOOL_NAMES`, and builds `ToolContext` with `gdd_store`/`gdd_hub`.

- [ ] **Step 1: Write the failing test** (REST endpoint via the e2e live server)

```python
# studio/backend/tests/test_gdd_rest.py
import httpx
import pytest


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_gdd_docs_endpoint_returns_empty_list_for_new_game(live_server):
    async with httpx.AsyncClient(base_url=live_server) as http:
        game = (await http.post("/games", json={"name": "Slot A"})).json()
        res = await http.get(f"/games/{game['id']}/gdd/docs")
        assert res.status_code == 200
        assert res.json() == []  # nothing seeded until a design-game run starts
```

(If the games POST shape differs, mirror `_make_game_and_asset` in `tests/e2e/test_assets.py`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_rest.py -q -m e2e`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Write minimal implementation**

In `rest.py`:

```python
@router.get("/games/{game_id}/gdd/docs")
async def list_gdd_docs(game_id: str, request: Request) -> list[dict]:
    from app.gdd.models import gdd_wire
    store = request.app.state.gdd_store
    docs = await store.list_docs(game_id)
    return [gdd_wire(d) for d in docs]
```

In `main.py` (in `build()`), construct and wire alongside the asset store:

```python
from app.gdd.store import GddStore
from app.gdd.hub import GddHub
from app.gdd.sockets import register_gdd_handlers

gdd_store = GddStore(mongo[settings.mongo_db])
gdd_hub = GddHub(sio, gdd_store)

tool_factory = ToolFactory(asset_store, asset_hub, gdd_store=gdd_store, gdd_hub=gdd_hub)

fastapi_app.state.gdd_store = gdd_store

hub = RoomHub(
    sio, store, chat_service,
    run_store=run_store, turn_runner=turn_runner,
    skills=skill_registry, tool_factory=tool_factory,
    asset_store=asset_store, asset_hub=asset_hub,
    gdd_store=gdd_store, gdd_hub=gdd_hub,
)
register_asset_handlers(sio, asset_hub)
register_gdd_handlers(sio, gdd_hub)
```

In `room_hub.py`: accept `gdd_store=None, gdd_hub=None` in `__init__` and store them. Where `ToolContext(...)` is built for a skill run, add `gdd_store=self._gdd_store, gdd_hub=self._gdd_hub`. In `handle_skill_run`, after resolving the room and its `game_id`, seed the taxonomy when the skill touches GDD:

```python
from app.gdd.models import GDD_TOOL_NAMES
...
if (self._gdd_hub is not None and room.game_id
        and set(skill.tools) & GDD_TOOL_NAMES):
    await self._gdd_hub.seed_taxonomy(room.game_id)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_rest.py -q -m e2e`
Expected: PASS (1 passed). Also run `uv run pytest -m "not e2e" -q` — full unit suite green.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/main.py studio/backend/app/rest.py studio/backend/app/room_hub.py studio/backend/tests/test_gdd_rest.py
git commit -m "feat(gdd): wire GddStore/GddHub, REST docs endpoint, kickoff seeding"
```

---

## Task 7: The `design-game` built-in skill

**Files:**

- Create: `skills/design-game.md`
- Test: `studio/backend/tests/test_design_game_skill.py`

**Interfaces:**

- Consumes: `SkillRegistry`, `ToolFactory.known_tool_names()` (all 6 GDD tool names now registered).
- Produces: a loadable `SkillSpec` named `design-game` whose `tools` are all known.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_design_game_skill.py
from pathlib import Path
from app.skills import SkillRegistry
from app.gdd.models import GDD_TOOL_NAMES

SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def test_design_game_skill_loads_with_known_gdd_tools():
    known = GDD_TOOL_NAMES | {"generate_asset", "list_assets", "delete_asset"}
    reg = SkillRegistry(SKILLS_DIR, known)
    reg.load()  # raises if any skill declares an unknown tool
    spec = reg.get("design-game")
    assert spec is not None
    assert set(spec.tools) == GDD_TOOL_NAMES
    assert "gap" in spec.body.lower()  # encodes the gap-driven loop
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_design_game_skill.py -q`
Expected: FAIL — `reg.get("design-game")` is `None`.

- [ ] **Step 3: Write minimal implementation**

```markdown
## <!-- skills/design-game.md -->

name: design-game
description: Draft the game's Game Design Document from your description, then
interview you to resolve the highest-impact gaps until the design is solid.
args:

- { name: focus, type: string, required: false, description: "Optionally target one aspect (e.g. math-model)." }
  tools: [list_gdd_docs, read_gdd_doc, write_gdd_doc, edit_gdd_doc, set_doc_status, ask_user_question]

---

You are designing a casino slot game with the user. The GDD is a fixed set of
markdown docs, one per aspect: theme, math-model, symbols-reels, paytable,
bonus-features, ui-ux, audio. Empty docs for every aspect already exist.

Work in this order:

1. DRAFT-ALL. For each aspect, write a best-effort draft from the user's
   description using `write_gdd_doc` (status "drafted"). Where information is
   missing, apply a sensible casino-genre default, but call `set_doc_status`
   with "needs_input" for that aspect and remember the gap.

2. RANK GAPS. Review the drafts and order the unresolved ambiguities by how much
   they materially shape the game. Bonus trigger, RTP target, and volatility
   rank high; flavour wording ranks low.

3. INTERVIEW — one question at a time. For the single highest-impact gap, call
   `ask_user_question` with a crisp question and 2-4 concrete options. Never ask
   open-ended "what do you want?" questions; always offer real, opinionated
   casino-design choices. When the answer arrives, read the relevant doc, apply
   it with a surgical `edit_gdd_doc` (never rewrite the whole doc), and set the
   doc's status. If the user delegates the decision, choose the best option
   yourself and note in the doc that it was an AI-made call. Then re-rank the
   remaining gaps and continue. Ask only about material gaps; never re-ask
   something already answered.

4. FINALIZE. When no material gaps remain, `set_doc_status` "complete" for the
   resolved docs and summarise in one short message what was decided and which
   defaults you assumed.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_design_game_skill.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add skills/design-game.md studio/backend/tests/test_design_game_skill.py
git commit -m "feat(gdd): built-in design-game interview skill"
```

---

## Task 8: Backend service e2e — a full `design-game` run (replay)

**Files:**

- Create: `studio/backend/tests/e2e/test_gdd.py`
- Possibly: record a replay cassette (`just record-fixtures`) if the design-game model turn is not yet captured.

**Interfaces:**

- Consumes: the `live_server` fixture, Socket.IO client patterns from `tests/e2e/test_skill_runs.py`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/e2e/test_gdd.py
import asyncio
import httpx
import pytest
import socketio


async def _make_room_with_game(base):
    async with httpx.AsyncClient(base_url=base) as http:
        game = (await http.post("/games", json={"name": "Slot E2E"})).json()
        room = (await http.post("/rooms",
                json={"name": "Design", "gameId": game["id"]})).json()
    return room["id"], game["id"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_design_game_seeds_docs_and_asks_a_question(live_server):
    room_id, game_id = await _make_room_with_game(live_server)
    client = socketio.AsyncClient()
    seen = {"gdd": [], "question_steps": []}
    client.on("gdd_snapshot", lambda d: seen["gdd"].append(d))
    client.on("gdd_doc_updated", lambda d: seen["gdd"].append(d))

    def _on_step(d):
        if d.get("step", {}).get("type") == "question":
            seen["question_steps"].append(d)
    client.on("run_step_started", _on_step)

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)
    await client.emit("run_skill", {
        "roomId": room_id, "skillName": "design-game",
        "args": {}, "text": "A neon cyberpunk slot with a free-spins bonus.",
    })

    # Seeding makes 7 docs visible; the agent should reach a question gate.
    for _ in range(200):
        if seen["question_steps"]:
            break
        await asyncio.sleep(0.05)

    async with httpx.AsyncClient(base_url=live_server) as http:
        docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
    assert len(docs) == 7
    assert seen["question_steps"], "expected at least one question interrupt"
    payload = __import__("json").loads(seen["question_steps"][0]["step"]["content"])
    assert payload["kind"] == "question"
    await client.disconnect()
```

- [ ] **Step 2: Run test to verify it fails / record fixtures if needed**

Run: `uv run pytest tests/e2e/test_gdd.py -q -m e2e`
Expected: FAIL initially if no replay cassette exists for this design-game turn. If the failure is a replay miss, record once against live providers:
`just record-fixtures` then re-run. Expected after recording: the run reaches a `question` step and 7 docs exist.

- [ ] **Step 3: (No new product code)** — this task validates Tasks 1–7 end-to-end. If it surfaces a defect, fix in the owning module with its own unit test first.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/e2e/test_gdd.py -q -m e2e`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tests/e2e/test_gdd.py
# include any new/updated replay cassette files under the replay fixtures dir
git commit -m "test(gdd): service e2e for design-game seeding + question gate"
```

---

## Task 9: Frontend — `question` run-step type + `QuestionCard`

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/state.ts` (add `question` to `RunStepType`; add `IQuestion` + `parseQuestion`)
- Modify: `studio/frontend/src/plugins/llm-chat/socketClient.ts` (add `resolveQuestion`)
- Modify: `studio/frontend/src/plugins/llm-chat/actions.ts` (add `resolveQuestion`)
- Create: `studio/frontend/src/plugins/llm-chat/QuestionCard.tsx`
- Modify: `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx` (route `question` → `QuestionCard`)
- Test: `studio/frontend/src/plugins/llm-chat/QuestionCard.spec.tsx`

**Interfaces:**

- Consumes: `IRunStep` (existing), the socket emit pattern, `chatSlice`.
- Produces:
  - `RunStepType` includes `'question'`.
  - `IQuestion { question: string; suggestions: string[]; allowFreeText: boolean; allowDelegate: boolean; aspect: string | null; answer?: { type: string; value?: string } }`.
  - `parseQuestion(step: IRunStep): IQuestion | null`.
  - `resolveQuestion(runId: string, answer: { type: 'suggestion' | 'freetext' | 'delegate'; value?: string }): void` (action) → `sock().resolveQuestion(roomId, runId, answer)` → emits `resolve_question` `{ roomId, runId, answer }`.

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/plugins/llm-chat/QuestionCard.spec.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuestionCard } from './QuestionCard';
import * as actions from './actions';

const open = {
  index: 2,
  type: 'question' as const,
  toolName: null,
  content: JSON.stringify({
    kind: 'question',
    question: 'Bonus trigger?',
    suggestions: ['3+ scatters', 'random multiplier'],
    allowFreeText: true,
    allowDelegate: true,
    aspect: 'bonus-features',
  }),
  status: 'running' as const,
};

describe('QuestionCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the question and suggestion chips', () => {
    render(<QuestionCard runId="r1" step={open} />);
    expect(screen.getByText('Bonus trigger?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3+ scatters' })).toBeInTheDocument();
  });

  it('wires a suggestion click', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    fireEvent.click(screen.getByRole('button', { name: '3+ scatters' }));
    expect(spy).toHaveBeenCalledWith('r1', { type: 'suggestion', value: '3+ scatters' });
  });

  it('wires "you decide"', () => {
    const spy = vi.spyOn(actions, 'resolveQuestion').mockReturnValue(undefined);
    render(<QuestionCard runId="r1" step={open} />);
    fireEvent.click(screen.getByRole('button', { name: /you decide/i }));
    expect(spy).toHaveBeenCalledWith('r1', { type: 'delegate' });
  });

  it('collapses to the answered state when resolved', () => {
    const answered = {
      ...open,
      status: 'complete' as const,
      content: JSON.stringify({
        kind: 'question',
        question: 'Bonus trigger?',
        answer: { type: 'suggestion', value: '3+ scatters' },
      }),
    };
    render(<QuestionCard runId="r1" step={answered} />);
    expect(screen.getByText(/3\+ scatters/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /you decide/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/QuestionCard.spec.tsx`
Expected: FAIL — cannot find `./QuestionCard`.

- [ ] **Step 3: Write minimal implementation**

In `state.ts`, widen the union and add the interface + parser:

```typescript
export type RunStepType = 'thinking' | 'tool_call' | 'tool_result' | 'final' | 'approval' | 'question';

export interface IQuestion {
  question: string;
  suggestions: string[];
  allowFreeText: boolean;
  allowDelegate: boolean;
  aspect: string | null;
  answer?: { type: string; value?: string };
}

export function parseQuestion(step: IRunStep): IQuestion | null {
  try {
    const p = JSON.parse(step.content) as Partial<IQuestion> & { kind?: string };
    if (p.kind !== 'question') return null;
    return {
      question: p.question ?? '',
      suggestions: p.suggestions ?? [],
      allowFreeText: p.allowFreeText ?? true,
      allowDelegate: p.allowDelegate ?? true,
      aspect: p.aspect ?? null,
      answer: p.answer,
    };
  } catch {
    return null;
  }
}
```

In `socketClient.ts`, add to the returned client object:

```typescript
resolveQuestion: (
  roomId: string,
  runId: string,
  answer: { type: string; value?: string },
) => emit('resolve_question', { roomId, runId, answer }),
```

In `actions.ts`:

```typescript
export function resolveQuestion(runId: string, answer: { type: 'suggestion' | 'freetext' | 'delegate'; value?: string }): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().resolveQuestion(roomId, runId, answer);
}
```

Create `QuestionCard.tsx`:

```tsx
import { useState } from 'react';
import type { IRunStep } from './state';
import { parseQuestion } from './state';
import { resolveQuestion } from './actions';
import { Button } from '../../components/ui/button';

export function QuestionCard({ runId, step }: { runId: string; step: IRunStep }) {
  const q = parseQuestion(step);
  const [text, setText] = useState('');
  if (!q) return null;

  const resolved = step.status === 'complete' || !!q.answer;
  if (resolved) {
    const value = q.answer?.value ?? '(you decide)';
    return (
      <div data-testid="question-card" className="rounded-md border border-hairline bg-surface p-2">
        <p className="text-sm text-text-2">{q.question}</p>
        <p className="mt-1 text-sm text-text-1">→ {value}</p>
      </div>
    );
  }

  return (
    <div data-testid="question-card" className="rounded-md border border-hairline bg-surface p-2">
      <p className="text-sm text-text-1">{q.question}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {q.suggestions.map((s) => (
          <Button key={s} onClick={() => resolveQuestion(runId, { type: 'suggestion', value: s })}>
            {s}
          </Button>
        ))}
      </div>
      {q.allowFreeText && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) resolveQuestion(runId, { type: 'freetext', value: text.trim() });
          }}
        >
          <input
            className="flex-1 rounded border border-hairline bg-raised px-2 py-1 text-sm text-text-1"
            placeholder="Type your own…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" variant="ghost">
            Send
          </Button>
        </form>
      )}
      {q.allowDelegate && (
        <Button variant="ghost" className="mt-2 text-accent-text" onClick={() => resolveQuestion(runId, { type: 'delegate' })}>
          You decide
        </Button>
      )}
    </div>
  );
}
```

In `RunTurnBlock.tsx`, route the new step type in `RunStepCard` (next to the existing `approval` branch):

```tsx
if (step.type === 'question') {
  return <QuestionCard runId={runId} step={step as IRunStep} />;
}
```

(Add `import { QuestionCard } from './QuestionCard';` at the top.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/QuestionCard.spec.tsx`
Expected: PASS (4 passed). Also run the existing `ApprovalCard.spec.tsx` — still PASS (untouched).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/actions.ts studio/frontend/src/plugins/llm-chat/QuestionCard.tsx studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx studio/frontend/src/plugins/llm-chat/QuestionCard.spec.tsx
git commit -m "feat(gdd): question run-step type and QuestionCard (suggestions/free-text/you-decide)"
```

---

## Task 10: Frontend — `gdd` plugin scaffolding (state, REST, socket, reducers)

**Files:**

- Create: `studio/frontend/src/plugins/gdd/config.ts`, `state.ts`, `restClient.ts`, `socketClient.ts`, `reducers.ts`, `actions.ts`
- Test: `studio/frontend/src/plugins/gdd/reducers.spec.ts`

**Interfaces:**

- Produces:
  - `IGddDoc { id; gameId; aspect; title; order; body; status: 'empty'|'drafted'|'needs_input'|'complete'; createdAt; updatedAt }`.
  - `IGddState { connection; activeGameId: string | null; docs: IGddDoc[]; docsStatus: 'idle'|'loading'|'error' }`.
  - `GDD_PLUGIN_ID = 'gdd'`, `makeInitialState()`, `gddSlice()`, `gddHooks`.
  - `getGddDocs(gameId): Promise<IGddDoc[]>` (REST `GET /games/{id}/gdd/docs`).
  - `upsertDoc(docs, doc): IGddDoc[]` (replace by aspect, keep `order` sort).
  - socket client with `connect`, `disconnect`, `joinGdd(gameId)`, `leaveGdd(gameId)`; inbound `gdd_snapshot` / `gdd_doc_updated` handlers writing the gdd slice.
  - `initGdd()` (connects socket on plugin boot).

- [ ] **Step 1: Write the failing test** (pure reducer)

```typescript
// studio/frontend/src/plugins/gdd/reducers.spec.ts
import { describe, it, expect } from 'vitest';
import type { IGddDoc } from './state';
import { upsertDoc } from './reducers';

const doc = (aspect: string, order: number, body = ''): IGddDoc => ({
  id: aspect,
  gameId: 'g1',
  aspect,
  title: aspect,
  order,
  body,
  status: 'empty',
  createdAt: '',
  updatedAt: '',
});

describe('gdd reducers', () => {
  it('upsertDoc replaces by aspect and keeps order sort', () => {
    const seeded = [doc('theme', 1), doc('math-model', 2)];
    const updated = upsertDoc(seeded, doc('math-model', 2, 'RTP 96%'));
    expect(updated).toHaveLength(2);
    expect(updated.find((d) => d.aspect === 'math-model')!.body).toBe('RTP 96%');
    expect(updated.map((d) => d.order)).toEqual([1, 2]);
  });

  it('upsertDoc inserts a new aspect in order position', () => {
    const out = upsertDoc([doc('math-model', 2)], doc('theme', 1));
    expect(out.map((d) => d.aspect)).toEqual(['theme', 'math-model']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/gdd/reducers.spec.ts`
Expected: FAIL — cannot find `./reducers` / `./state`.

- [ ] **Step 3: Write minimal implementation**

Mirror `plugins/assets`. Use `plugins/assets/config.ts` for `BACKEND_URL` and `plugins/assets/state.ts` for the `makePluginHooks`/slice accessor pattern.

```typescript
// studio/frontend/src/plugins/gdd/config.ts
export { BACKEND_URL } from '../assets/config';
```

```typescript
// studio/frontend/src/plugins/gdd/state.ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const GDD_PLUGIN_ID = 'gdd';

export type GddStatus = 'empty' | 'drafted' | 'needs_input' | 'complete';

export interface IGddDoc {
  id: string;
  gameId: string;
  aspect: string;
  title: string;
  order: number;
  body: string;
  status: GddStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IGddState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  docs: IGddDoc[];
  docsStatus: 'idle' | 'loading' | 'error';
  selectedAspect: string | null;
}

export function makeInitialState(): IGddState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    docs: [],
    docsStatus: 'idle',
    selectedAspect: null,
  };
}

export const gddHooks = makePluginHooks<IGddState>(GDD_PLUGIN_ID);

export function gddSlice(): State<IGddState> {
  return rootStore.plugins.nested(GDD_PLUGIN_ID) as unknown as State<IGddState>;
}
```

(Confirm the import path of `makePluginHooks` matches `plugins/assets/state.ts`; reuse the exact same import.)

```typescript
// studio/frontend/src/plugins/gdd/reducers.ts
import type { IGddDoc } from './state';

export function upsertDoc(docs: IGddDoc[], doc: IGddDoc): IGddDoc[] {
  const next = docs.some((d) => d.aspect === doc.aspect) ? docs.map((d) => (d.aspect === doc.aspect ? doc : d)) : [...docs, doc];
  return next.slice().sort((a, b) => a.order - b.order);
}
```

```typescript
// studio/frontend/src/plugins/gdd/restClient.ts
import { BACKEND_URL } from './config';
import type { IGddDoc } from './state';

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getGddDocs(gameId: string): Promise<IGddDoc[]> {
  return okJson<IGddDoc[]>(await fetch(`${BACKEND_URL}/games/${gameId}/gdd/docs`));
}
```

```typescript
// studio/frontend/src/plugins/gdd/socketClient.ts
import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { gddSlice, type IGddDoc } from './state';
import { upsertDoc } from './reducers';

let sock: Socket | null = null;

function read(): IGddDoc[] {
  return gddSlice().docs.get({ noproxy: true }) as IGddDoc[];
}
function isActive(gameId: string): boolean {
  return gddSlice().activeGameId.get() === gameId;
}

export function createGddSocket() {
  function connect(): void {
    if (sock) return;
    sock = io(BACKEND_URL, { auth: { displayName: 'gdd-viewer' } });
    sock.on('gdd_snapshot', (p: { gameId: string; docs: IGddDoc[] }) => {
      if (!isActive(p.gameId)) return;
      gddSlice().docs.set(p.docs.slice().sort((a, b) => a.order - b.order));
    });
    sock.on('gdd_doc_updated', (p: { gameId: string; doc: IGddDoc }) => {
      if (!isActive(p.gameId)) return;
      gddSlice().docs.set(upsertDoc(read(), p.doc));
    });
  }
  function disconnect(): void {
    sock?.disconnect();
    sock = null;
  }
  return {
    connect,
    disconnect,
    joinGdd: (gameId: string) => sock?.emit('join_gdd', { gameId }),
    leaveGdd: (gameId: string) => sock?.emit('leave_gdd', { gameId }),
  };
}

let client: ReturnType<typeof createGddSocket> | null = null;
export function gddSock() {
  if (!client) client = createGddSocket();
  return client;
}
```

```typescript
// studio/frontend/src/plugins/gdd/actions.ts
import { gddSlice } from './state';
import { getGddDocs } from './restClient';
import { gddSock } from './socketClient';

export function initGdd(): void {
  gddSock().connect();
}

export async function openGameDocs(gameId: string): Promise<void> {
  gddSlice().activeGameId.set(gameId);
  gddSlice().docsStatus.set('loading');
  gddSock().joinGdd(gameId);
  try {
    const docs = await getGddDocs(gameId);
    gddSlice().docs.set(docs.slice().sort((a, b) => a.order - b.order));
    gddSlice().docsStatus.set('idle');
  } catch {
    gddSlice().docsStatus.set('error');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/gdd/reducers.spec.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/gdd/config.ts studio/frontend/src/plugins/gdd/state.ts studio/frontend/src/plugins/gdd/reducers.ts studio/frontend/src/plugins/gdd/restClient.ts studio/frontend/src/plugins/gdd/socketClient.ts studio/frontend/src/plugins/gdd/actions.ts studio/frontend/src/plugins/gdd/reducers.spec.ts
git commit -m "feat(gdd): frontend gdd plugin scaffolding (state, rest, socket, reducers)"
```

---

## Task 11: Frontend — `GddViewerPane` + plugin registration

**Files:**

- Create: `studio/frontend/src/plugins/gdd/GddViewerPane.tsx`
- Create: `studio/frontend/src/plugins/gdd/index.ts`
- Modify: `studio/frontend/src/plugins/index.ts`
- Test: `studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx`

**Interfaces:**

- Consumes: `gddHooks`, `gddSlice`, `makeInitialState`, `openGameDocs`, the chat hooks (`llmChatHooks`) to derive the active game from the active room.
- Produces: `GddViewerPane` component; `gdd` plugin (`IPlugin<IGddState>`) with pane `gdd/viewer` and command `gdd/open-viewer`; registered in `PLUGINS`.

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GDD_PLUGIN_ID, gddSlice, makeInitialState, type IGddDoc } from './state';
import { GddViewerPane } from './GddViewerPane';

vi.mock('./actions', () => ({ openGameDocs: vi.fn(), initGdd: vi.fn() }));

const fakeProps = {} as Parameters<typeof GddViewerPane>[0];

const doc = (aspect: string, order: number, status: IGddDoc['status']): IGddDoc => ({
  id: aspect,
  gameId: 'g1',
  aspect,
  title: aspect,
  order,
  body: `# ${aspect}`,
  status,
  createdAt: '',
  updatedAt: '',
});

beforeEach(() => {
  rootStore.plugins.nested(GDD_PLUGIN_ID).set(makeInitialState() as never);
});

describe('GddViewerPane', () => {
  it('shows an empty state when no game is active', () => {
    render(<GddViewerPane {...fakeProps} />);
    expect(screen.getByTestId('gdd-no-game')).toBeTruthy();
  });

  it('lists the seeded aspects with status markers', () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([doc('theme', 1, 'complete'), doc('math-model', 2, 'needs_input')]);
    });
    render(<GddViewerPane {...fakeProps} />);
    expect(screen.getByTestId('gdd-aspect-theme')).toBeTruthy();
    expect(screen.getByTestId('gdd-aspect-math-model')).toBeTruthy();
    expect(screen.getByTestId('gdd-status-math-model').textContent).toMatch(/needs input/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/gdd/GddViewerPane.spec.tsx`
Expected: FAIL — cannot find `./GddViewerPane`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// studio/frontend/src/plugins/gdd/GddViewerPane.tsx
import type { IDockviewPanelProps } from 'dockview-react';
import { gddHooks } from './state';

const STATUS_LABEL: Record<string, string> = {
  empty: 'empty',
  drafted: 'drafted',
  needs_input: 'needs input',
  complete: 'complete',
};

export function GddViewerPane(_props: IDockviewPanelProps) {
  const s = gddHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  const docs = s.docs.get();
  const selected = s.selectedAspect.get();

  if (!activeGameId) {
    return (
      <div data-testid="gdd-no-game" className="flex h-full items-center justify-center bg-surface text-text-2">
        Open a game to see its Game Design Document.
      </div>
    );
  }

  const current = docs.find((d) => d.aspect === selected) ?? docs[0];

  return (
    <div className="flex h-full bg-surface">
      <ul className="w-56 flex-none overflow-auto border-r border-hairline p-1">
        {docs.map((d) => (
          <li key={d.aspect}>
            <button
              data-testid={`gdd-aspect-${d.aspect}`}
              onClick={() =>
                gddHooks.usePluginState // selection set below
                  ? undefined
                  : undefined
              }
              className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm text-text-1 hover:bg-raised-hover"
              onClickCapture={() => s.selectedAspect.set(d.aspect)}
            >
              <span>{d.title}</span>
              <span data-testid={`gdd-status-${d.aspect}`} className={d.status === 'needs_input' ? 'text-accent-text' : 'text-text-3'}>
                {STATUS_LABEL[d.status]}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex-1 overflow-auto p-3">
        <pre className="whitespace-pre-wrap text-sm text-text-1">{current?.body || ''}</pre>
      </div>
    </div>
  );
}
```

Note: simplify the selection handler to a single `onClick={() => s.selectedAspect.set(d.aspect)}` (remove the placeholder ternary above when implementing — it is shown only to flag where selection is wired). The markdown reader uses a `<pre>` for v1; a markdown renderer can replace it later without changing the contract.

```typescript
// studio/frontend/src/plugins/gdd/index.ts
import type { IPlugin } from '../../host/types';
import { GddViewerPane } from './GddViewerPane';
import { GDD_PLUGIN_ID, makeInitialState, type IGddState } from './state';
import { initGdd } from './actions';

export const gdd: IPlugin<IGddState> = {
  id: GDD_PLUGIN_ID,
  title: 'Game Design Doc',
  persist: false,
  initialState: makeInitialState(),
  panes: [{ id: 'gdd/viewer', title: 'Game Design Doc', component: GddViewerPane as never }],
  commands: [{ id: 'gdd/open-viewer', title: 'Open Game Design Doc', run: (host) => host.openPane('gdd/viewer') }],
  init: () => initGdd(),
};
```

```typescript
// studio/frontend/src/plugins/index.ts  (add gdd)
import { gdd } from './gdd';
export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets, gdd];
```

To make the pane track the active game, wire `openGameDocs(gameId)` to the active room's `gameId`. Mirror exactly how `plugins/assets` derives `activeGameId` from the active room (see `plugins/assets/actions.ts`); apply the same subscription in `initGdd` (call `openGameDocs(gameId)` whenever the active room's `gameId` changes). This keeps the viewer and Asset Board in lock-step on the same game.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/gdd/GddViewerPane.spec.tsx`
Expected: PASS (2 passed). Then run the full quartet:
`npx prettier --check .` · `npx nx run-many -t typecheck` · `npx nx run-many -t test` · `npx nx run-many -t build` — all green (includes the design-language guard, which passes because the pane uses only `--token` utilities).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/gdd/GddViewerPane.tsx studio/frontend/src/plugins/gdd/index.ts studio/frontend/src/plugins/index.ts studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx
git commit -m "feat(gdd): read-only GDD viewer pane and plugin registration"
```

---

## Task 12: Playwright e2e — full GDD design flow (authoritative)

**Files:**

- Create: `studio/frontend/e2e/gdd.spec.ts` (mirror existing specs in `studio/frontend/e2e/`)

**Interfaces:**

- Consumes: the running replay backend on :8000 (`just backend-serve-replay`) and the e2e harness (`just e2e`).

- [ ] **Step 1: Write the failing test**

```typescript
// studio/frontend/e2e/gdd.spec.ts
import { test, expect } from '@playwright/test';

test('design-game seeds the GDD and asks a question in chat', async ({ page }) => {
  await page.goto('/');

  // Open the GDD viewer and a chat room linked to a game (reuse existing helpers/testids).
  await page.getByRole('button', { name: /open game design doc/i }).click();
  // ...select/create a room with a linked game, per existing e2e helpers...

  // Kick off the interview.
  await page.getByTestId('chat-input').fill('A neon cyberpunk slot with a free-spins bonus.');
  await page.getByTestId('chat-input').press('Enter');
  await page.getByRole('button', { name: /design-game/i }).click();

  // The 7-section skeleton appears in the viewer.
  await expect(page.getByTestId('gdd-aspect-theme')).toBeVisible();
  await expect(page.getByTestId('gdd-aspect-math-model')).toBeVisible();

  // A question card appears; pick the first suggestion.
  const card = page.getByTestId('question-card').first();
  await expect(card).toBeVisible();
  await card.getByRole('button').first().click();

  // The related doc updates (status marker leaves "needs input" eventually).
  await expect(page.getByTestId('question-card').first()).toContainText('→');
});
```

- [ ] **Step 2: Run test to verify it fails**

Start the replay backend, then run the suite:

```bash
just backend-serve-replay   # in one shell
just e2e                    # in another (BLOOM_E2E_TIER unset → replay)
```

Expected: FAIL where assertions reference not-yet-wired UI; iterate on testids/helpers to match the existing e2e patterns.

- [ ] **Step 3: Adjust selectors/helpers to existing e2e conventions**

Align room/game setup with the helpers already used by `studio/frontend/e2e/*.spec.ts` (room creation, game linking). No new product code unless a genuine gap is found — if so, fix it in the owning module with a unit test first, then return here.

- [ ] **Step 4: Run test to verify it passes**

Run: `just e2e`
Expected: PASS — the GDD flow is green against the replay backend. Restore the backend mode afterward (the careful :8000 live→replay swap, then restore).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/gdd.spec.ts
git commit -m "test(gdd): Playwright e2e for the design-game flow"
```

---

## Self-Review

**Spec coverage (each spec section → task):**

- §5 data model / taxonomy → Task 1; `GddStore` → Task 2.
- §6 doc-mutation tools incl. surgical `edit_gdd_doc` (read-before-edit, unique match) → Tasks 2 (store) + 4 (tools).
- §7 question interrupt (generalizes approval; `question` step; resume payload; park-no-timeout; persisted answer) → Tasks 5 (backend) + 9 (frontend).
- §8 `design-game` skill (kickoff seeding; draft-all → rank → interview → finalize) → Tasks 6 (seeding) + 7 (skill).
- §9 viewer pane (TOC + status markers, accent rationed to `needs_input`, live socket updates, read-only) → Tasks 10–11.
- §10 testing (backend unit, service e2e, frontend unit, Playwright) → embedded in every task + Tasks 8 & 12.
- §11 future seams — intentionally NOT built (documented as deferred).
- "you decide" = AI judgment with no external data source → Task 5 (delegate sentinel) + Task 7 (skill instruction).
- Approval parity (delete_asset still works through the generalized gate) → Task 5 Step 4 (existing tests stay green; `ApprovalCard` untouched).

**Placeholder scan:** Two intentional pointers to existing code remain (the active-game subscription in Tasks 10–11 "mirror `plugins/assets`", and e2e room/game setup helpers in Task 12). These reference concrete existing files an implementer reads, not undefined behavior. The `GddViewerPane` selection handler in Task 11 Step 3 carries an explicit "replace the placeholder ternary with `onClick={() => s.selectedAspect.set(d.aspect)}`" instruction — fix on implementation.

**Type consistency:** `Status` values (`empty|drafted|needs_input|complete`) match across `GddDoc` (Task 1), `GddStore` (Task 2), the tools (Task 4), `IGddDoc`/`GddStatus` (Task 10), and the viewer markers (Task 11). The question payload shape (`kind|tool|question|suggestions|allowFreeText|allowDelegate|aspect`) and resume shape (`{type, value?}`) are identical in the tool (Task 5), `parseQuestion`/`QuestionCard` (Task 9), and `resolveQuestion` (Task 9). Tool names match `GDD_TOOL_NAMES` (Task 1), the `_BUILDERS` registry (Tasks 4–5), and the skill frontmatter (Task 7). Socket event names (`gdd_snapshot`, `gdd_doc_updated`, `join_gdd`, `resolve_question`) match between backend emit/handlers (Tasks 3, 5, 6) and the frontend clients (Tasks 9–10).
