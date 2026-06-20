# LLM Chat — Backend Additions Implementation Plan (Plan B, subsystem 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two backend capabilities the `llm-chat` frontend plugin needs: a `GET /models` model catalogue and in-flight stream **resume** so a late-joining/reconnecting client catches up to a generation already in progress.

**Architecture:** `GET /models` is a pure, settings-derived catalogue (`build_model_catalog`) exposed by the existing FastAPI router. Resume adds a per-room **active-generation snapshot** to `RoomHub`: while a generation streams, the hub retains the accumulated content; `join_room` is routed through a new `RoomHub.attach_subscriber()` that **atomically** subscribes the client and emits a `stream_snapshot` under the same per-room lock that guards token emission — so snapshot + subsequent live tokens reconstruct the message exactly, with no gap or duplication.

**Tech Stack:** Python 3.12, `uv`, FastAPI, `python-socketio` (asgi + asyncio client for tests), `pytest` + `pytest-asyncio`, MongoDB (`motor`). Reuses the existing `FakeProvider` for deterministic streaming.

## Global Constraints

- **Commits:** Conventional Commits, imperative mood, scope `feat(backend): ...`.
- **Branching:** `main` is protected. All work lands via PR from `feat/llm-chat-backend-additions`. Never push to `main`.
- **TDD is mandatory:** RED → GREEN → REFACTOR per task. Write the failing test, watch it fail, write minimal code, watch it pass, commit.
- **CI cost policy:** the Python unit + Socket.IO e2e suites are **non-browser e2e** and ARE run in CI (they are the authoritative contract). No browser/Playwright here.
- **Wire format:** all Socket.IO payloads and REST JSON use **camelCase** keys (`roomId`, `messageId`, `isTyping`, `createdAt`). The new keys (`id`, `label`, `free`, `content`, `state`) are already single-word/camel.
- **Provider:** OpenRouter only for real calls; tests use `LLM_BACKEND=fake`. No network in tests.
- **Local MongoDB:** native Windows service `MongoDB` on `mongodb://localhost:27017`; ensure running with `just mongo-up` before store/REST/e2e tests.
- **Repo Prettier gate:** CI runs `npx prettier --check .`. Any Markdown/YAML/JSON touched here must be Prettier-clean (`npx prettier --write <files>`). Prettier ignores `.py`.
- **All paths below are relative to repo root `C:\code\bloom`.** Backend commands run from `studio/backend` via `uv run`.
- **Spec authority:** `docs/superpowers/specs/2026-06-19-llm-chat-design.md` §13.2 (`/models`) and §13.3 (resume) are the contract this plan implements.

---

## File Structure

```
studio/backend/
├── app/
│   ├── config.py        # MODIFY: add `available_models` setting
│   ├── catalog.py       # CREATE: build_model_catalog(settings) -> list[dict]
│   ├── rest.py          # MODIFY: add GET /models route
│   ├── room_hub.py      # MODIFY: active-generation snapshot + attach_subscriber()
│   └── sockets.py       # MODIFY: route join_room through hub.attach_subscriber()
├── tests/
│   ├── test_catalog.py  # CREATE: unit tests for build_model_catalog
│   ├── test_rest.py     # MODIFY: add GET /models route test
│   ├── test_room_hub.py # MODIFY: snapshot + attach_subscriber unit tests
│   └── e2e/
│       └── test_realtime.py  # MODIFY: three-client mid-stream resume test
└── .env.example         # MODIFY: document AVAILABLE_MODELS
```

Two tasks. Task 1 (`/models`) is independent and small. Task 2 (resume) is the concurrency-sensitive core and carries the authoritative e2e contract.

---

## Task 1: `GET /models` — model catalogue

Expose the configurable list of selectable models as `[{ id, label, free }]`, derived purely from settings. The Settings pane (subsystem 3) fetches this.

**Files:**

- Create: `studio/backend/app/catalog.py`
- Create: `studio/backend/tests/test_catalog.py`
- Modify: `studio/backend/app/config.py` (add `available_models`)
- Modify: `studio/backend/app/rest.py` (add route)
- Modify: `studio/backend/tests/test_rest.py` (route test)
- Modify: `studio/backend/.env.example` (document the env var)

**Interfaces:**

- Consumes: `app.config.Settings`.
- Produces: `app.catalog.build_model_catalog(settings: Settings) -> list[dict]`, where each dict is `{"id": str, "label": str, "free": bool}`. `free` is `id.endswith(":free")`; `label` is the id's last `/`-segment with a trailing `:free` stripped (e.g. `meta-llama/llama-3.2-3b-instruct:free` → `llama-3.2-3b-instruct`).
- Produces: `GET /models` → `[{ id, label, free }]` (200), order matches `available_models`.

- [ ] **Step 1: Write the failing catalog unit test**

`studio/backend/tests/test_catalog.py`:

```python
from app.catalog import build_model_catalog
from app.config import Settings


def test_catalog_derives_label_and_free_flag():
    settings = Settings(available_models="openai/gpt-4o-mini,meta-llama/llama-3.2-3b-instruct:free")
    catalog = build_model_catalog(settings)
    assert catalog == [
        {"id": "openai/gpt-4o-mini", "label": "gpt-4o-mini", "free": False},
        {"id": "meta-llama/llama-3.2-3b-instruct:free", "label": "llama-3.2-3b-instruct", "free": True},
    ]


def test_catalog_ignores_blank_entries_and_whitespace():
    settings = Settings(available_models=" openai/gpt-4o-mini , , foo/bar:free ")
    catalog = build_model_catalog(settings)
    assert [c["id"] for c in catalog] == ["openai/gpt-4o-mini", "foo/bar:free"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd studio/backend && uv run pytest tests/test_catalog.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'app.catalog'` (and `Settings` has no `available_models` yet).

- [ ] **Step 3: Add the `available_models` setting**

Modify `studio/backend/app/config.py` — add one field after `default_model`:

```python
    default_model: str = "openai/gpt-4o-mini"
    available_models: str = "openai/gpt-4o-mini,meta-llama/llama-3.2-3b-instruct:free"
    llm_backend: str = "openrouter"  # "openrouter" | "fake"
```

(Comma-separated so it round-trips cleanly through a single `AVAILABLE_MODELS` env var; the default keeps `default_model` in the catalogue.)

- [ ] **Step 4: Write the catalog module**

`studio/backend/app/catalog.py`:

```python
from app.config import Settings

_FREE_SUFFIX = ":free"


def _label_for(model_id: str) -> str:
    base = model_id.split("/")[-1]
    if base.endswith(_FREE_SUFFIX):
        base = base[: -len(_FREE_SUFFIX)]
    return base


def build_model_catalog(settings: Settings) -> list[dict]:
    ids = [m.strip() for m in settings.available_models.split(",") if m.strip()]
    return [
        {"id": mid, "label": _label_for(mid), "free": mid.endswith(_FREE_SUFFIX)}
        for mid in ids
    ]
```

- [ ] **Step 5: Run the catalog unit test to verify it passes**

Run:

```bash
cd studio/backend && uv run pytest tests/test_catalog.py -v
```

Expected: PASS (both tests).

- [ ] **Step 6: Write the failing REST route test**

Append to `studio/backend/tests/test_rest.py`:

```python
@pytest.mark.asyncio
async def test_models_endpoint_returns_catalog(ctx):
    async with _client(ctx) as client:
        resp = await client.get("/models")
        assert resp.status_code == 200
        catalog = resp.json()
        assert isinstance(catalog, list) and catalog
        first = catalog[0]
        assert set(first.keys()) == {"id", "label", "free"}
        assert any(item["free"] for item in catalog)  # at least one :free dev model
```

(No `mongo_db` fixture needed — `/models` is settings-only, not DB-backed.)

- [ ] **Step 7: Run the REST test to verify it fails**

Run:

```bash
cd studio/backend && uv run pytest tests/test_rest.py::test_models_endpoint_returns_catalog -v
```

Expected: FAIL — 404 (route not defined yet).

- [ ] **Step 8: Add the `GET /models` route**

Modify `studio/backend/app/rest.py` — add the import and the route. New import line near the top:

```python
from app.catalog import build_model_catalog
from app.models import message_wire, room_wire
```

Add the route (e.g. directly after the `health` route):

```python
@router.get("/models")
async def list_models(request: Request) -> list[dict]:
    settings = request.app.state.settings
    return build_model_catalog(settings)
```

- [ ] **Step 9: Run the REST test to verify it passes**

Run:

```bash
cd studio/backend && uv run pytest tests/test_rest.py -v
```

Expected: PASS (existing room tests + the new `/models` test).

- [ ] **Step 10: Document the env var**

Modify `studio/backend/.env.example` — add a line after `DEFAULT_MODEL=...`:

```
DEFAULT_MODEL=openai/gpt-4o-mini
# Comma-separated catalogue offered by GET /models (Settings pane model picker).
AVAILABLE_MODELS=openai/gpt-4o-mini,meta-llama/llama-3.2-3b-instruct:free
```

- [ ] **Step 11: Run the full unit suite (no e2e) to confirm nothing regressed**

Run:

```bash
just mongo-up
cd studio/backend && uv run pytest -m "not e2e" -v
```

Expected: PASS (all unit + integration tests).

- [ ] **Step 12: Commit**

```bash
git add studio/backend/app/catalog.py studio/backend/app/config.py studio/backend/app/rest.py \
        studio/backend/tests/test_catalog.py studio/backend/tests/test_rest.py studio/backend/.env.example
git commit -m "feat(backend): add GET /models catalogue endpoint"
```

---

## Task 2: In-flight stream resume (`stream_snapshot` on join)

While a generation streams, `RoomHub` retains the accumulated content per room. `join_room` is routed through `RoomHub.attach_subscriber()`, which subscribes the client **and** — if a generation is in progress — emits a `stream_snapshot` carrying the content-so-far, all under the same per-room lock that guards token emission. This makes snapshot + subsequent live tokens reconstruct the message **exactly**.

**Why the lock matters (correctness):** token emission does `content += token; emit(token, room=...)` inside the lock; `attach_subscriber` does `enter_room(sid); snapshot(content); emit(snapshot, to=sid)` inside the same lock. The two critical sections are mutually exclusive, so for any late joiner either (a) a token is in the snapshot and the joiner was not yet in the room for its live emit, or (b) the token is excluded from the snapshot and the joiner is in the room to receive it live — never both, never neither. No duplication, no gap.

**Files:**

- Modify: `studio/backend/app/room_hub.py` (active-generation snapshot + `attach_subscriber`)
- Modify: `studio/backend/app/sockets.py` (route `join_room` through the hub)
- Modify: `studio/backend/tests/test_room_hub.py` (snapshot + attach unit tests)
- Modify: `studio/backend/tests/e2e/test_realtime.py` (three-client resume — authoritative)

**Interfaces:**

- Consumes: existing `RoomHub(sio, store, chat_service)`, the `FakeProvider` echo stream, the `live_server` e2e fixture, the `Recorder` helper in `test_realtime.py`.
- Produces: `RoomHub.active_snapshot(room_id: str) -> dict | None` returning `{"roomId", "messageId", "content", "state"}` (a fresh copy) while generating, else `None`.
- Produces: `async RoomHub.attach_subscriber(room_id: str, sid: str) -> None` — enters `sid` into the Socket.IO room and, if generating, emits `stream_snapshot {roomId, messageId, content, state}` to that sid only.
- Produces: new server→client event `stream_snapshot { roomId, messageId, content, state }` (state is `"generating"`).
- Changes: `join_room` handler now calls `await hub.attach_subscriber(room_id, sid)` instead of `await sio.enter_room(sid, room_id)`; presence behavior is unchanged.

- [ ] **Step 1: Write the failing RoomHub unit tests (snapshot lifecycle + attach)**

Modify `studio/backend/tests/test_room_hub.py`. First, extend `FakeSio` to support targeted emits and room entry (keep the existing 3-tuple `events` shape so existing tests still unpack `e, d, _`):

```python
class FakeSio:
    def __init__(self):
        self.events: list[tuple] = []
        self.entered: list[tuple] = []

    async def emit(self, event, data=None, room=None, to=None, skip_sid=None):
        self.events.append((event, data, room))

    async def enter_room(self, sid, room):
        self.entered.append((sid, room))

    def names(self):
        return [e[0] for e in self.events]
```

Then add a controllable chat service and two tests (append to the file):

```python
class StepChatService:
    """Yields tokens one at a time, each gated, so a test can observe mid-stream state."""

    def __init__(self, tokens):
        self._tokens = tokens
        self.go = [asyncio.Event() for _ in tokens]
        self.emitted = [asyncio.Event() for _ in tokens]

    async def stream(self, messages, model):
        for i, tok in enumerate(self._tokens):
            await self.go[i].wait()
            yield tok
            self.emitted[i].set()


@pytest.mark.asyncio
async def test_active_snapshot_tracks_then_clears():
    sio, store, chat = FakeSio(), FakeStore(), StepChatService(["a", "b"])
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "hi")
    chat.go[0].set()
    await asyncio.wait_for(chat.emitted[0].wait(), timeout=1)

    snap = hub.active_snapshot("r1")
    assert snap is not None
    assert snap["content"] == "a"
    assert snap["state"] == "generating"
    assert snap["messageId"] == "msg2"  # msg1 = user prompt, msg2 = assistant

    chat.go[1].set()
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=1)
    assert hub.active_snapshot("r1") is None


@pytest.mark.asyncio
async def test_attach_subscriber_emits_snapshot_to_late_joiner():
    sio, store, chat = FakeSio(), FakeStore(), StepChatService(["a", "b"])
    hub = RoomHub(sio, store, chat)

    await hub.handle_prompt("r1", "Alice", "hi")
    chat.go[0].set()
    await asyncio.wait_for(chat.emitted[0].wait(), timeout=1)

    await hub.attach_subscriber("r1", "sidCarol")
    assert ("sidCarol", "r1") in sio.entered
    snaps = [d for e, d, _ in sio.events if e == "stream_snapshot"]
    assert snaps, "late joiner must receive a stream_snapshot during generation"
    assert snaps[-1]["messageId"] == "msg2"
    assert snaps[-1]["content"] == "a"
    assert snaps[-1]["state"] == "generating"

    chat.go[1].set()
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=1)


@pytest.mark.asyncio
async def test_attach_subscriber_when_idle_enters_without_snapshot():
    sio, store, chat = FakeSio(), FakeStore(), StepChatService(["a"])
    hub = RoomHub(sio, store, chat)

    await hub.attach_subscriber("r1", "sidEarly")
    assert ("sidEarly", "r1") in sio.entered
    assert [e for e, _, _ in sio.events if e == "stream_snapshot"] == []
```

These rely on the existing `FakeStore`, `_wait_event`, and `import asyncio` already at the top of `test_room_hub.py`.

- [ ] **Step 2: Run to verify the new unit tests fail**

Run:

```bash
cd studio/backend && uv run pytest tests/test_room_hub.py -v
```

Expected: FAIL — `AttributeError: 'RoomHub' object has no attribute 'active_snapshot'` / `attach_subscriber` (the two existing serialization tests still pass).

- [ ] **Step 3: Rewrite `room_hub.py` with the active-generation snapshot**

Replace `studio/backend/app/room_hub.py` in full:

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
        # room_id -> {"messageId", "content", "state"} while a generation streams
        self._active: dict[str, dict] = {}

    def _lock(self, room_id: str) -> asyncio.Lock:
        return self._locks.setdefault(room_id, asyncio.Lock())

    def active_snapshot(self, room_id: str) -> dict | None:
        active = self._active.get(room_id)
        if active is None:
            return None
        return {
            "roomId": room_id,
            "messageId": active["messageId"],
            "content": active["content"],
            "state": active["state"],
        }

    async def attach_subscriber(self, room_id: str, sid: str) -> None:
        # Atomic wrt the token loop: either a token is in the snapshot (and this
        # client was not yet in the room for its live emit) or it is excluded and
        # this client is in the room to receive it live — never both, never neither.
        async with self._lock(room_id):
            await self._sio.enter_room(sid, room_id)
            snapshot = self.active_snapshot(room_id)
            if snapshot is not None:
                await self._sio.emit("stream_snapshot", snapshot, to=sid)

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
        while True:
            async with self._lock(room_id):
                queue = self._queues.get(room_id, [])
                if not queue:
                    self._busy.discard(room_id)
                    await self._emit_status(room_id, "idle")
                    return
                queue.pop(0)
            try:
                await self._run_generation(room_id)
            except Exception:
                await self._sio.emit(
                    "error",
                    {"roomId": room_id, "message": "generation failed"},
                    room=room_id,
                )
                # keep draining remaining queued prompts rather than orphaning them

    async def _run_generation(self, room_id: str) -> None:
        room = await self._store.get_room(room_id)
        await self._emit_status(room_id, "generating")

        assistant = await self._store.add_message(room_id, "assistant", "assistant", "", "streaming")
        await self._sio.emit("message_created", {"message": message_wire(assistant)}, room=room_id)

        history = await self._store.list_messages(room_id)
        context = [m for m in history if m.id != assistant.id]

        async with self._lock(room_id):
            self._active[room_id] = {
                "messageId": assistant.id,
                "content": "",
                "state": "generating",
            }

        content = ""
        try:
            async for token in self._chat.stream(context, room.model):
                content += token
                async with self._lock(room_id):
                    self._active[room_id]["content"] = content
                    await self._sio.emit(
                        "token",
                        {"roomId": room_id, "messageId": assistant.id, "delta": token},
                        room=room_id,
                    )
        finally:
            async with self._lock(room_id):
                self._active.pop(room_id, None)

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

Note: the `finally` clears `_active` even if the stream raises — a subsequent join then gets no stale snapshot (the failed generation already emitted `error` via `_drain`). Existing behavior is preserved: token order to the room is unchanged, and per-room serialization is intact (the lock is short-held per token).

- [ ] **Step 4: Run the RoomHub unit tests to verify they pass**

Run:

```bash
cd studio/backend && uv run pytest tests/test_room_hub.py -v
```

Expected: PASS — the two existing serialization tests **and** the three new snapshot/attach tests. If `test_concurrent_prompts_are_serialized` is flaky, the settling waits in that test (unchanged) are the contract; re-run.

- [ ] **Step 5: Route `join_room` through `attach_subscriber`**

Replace the `join_room` handler in `studio/backend/app/sockets.py` (only this handler changes):

```python
    @sio.on("join_room")
    async def join_room(sid, data):
        room_id = data["roomId"]
        session = await sio.get_session(sid)
        await hub.attach_subscriber(room_id, sid)
        presence.join(room_id, sid, session["displayName"])
        await sio.emit("presence", {"roomId": room_id, "members": presence.members(room_id)}, room=room_id)
```

(The hub now owns `enter_room` so the snapshot can be sent atomically with the subscription. Presence join + broadcast are unchanged.)

- [ ] **Step 6: Run the single-client socket e2e to confirm join/presence still works**

Run:

```bash
just mongo-up
cd studio/backend && uv run pytest tests/e2e/test_sockets.py -v
```

Expected: PASS (presence-on-join and typing broadcast unaffected by the routing change).

- [ ] **Step 7: Write the failing three-client resume e2e test**

Append to `studio/backend/tests/e2e/test_realtime.py` (reuses the module's `_make_room` and `Recorder`):

```python
@pytest.mark.e2e
@pytest.mark.asyncio
async def test_late_joiner_resumes_in_flight_stream(live_server):
    room_id = await _make_room(live_server)
    alice = socketio.AsyncClient()
    ra = Recorder(alice)
    await alice.connect(live_server, auth={"displayName": "Alice"})
    await alice.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    # Wait until the stream is genuinely mid-flight: Alice has >=1 token, no completion yet.
    deadline = asyncio.get_event_loop().time() + 5
    while (len(ra.tokens) < 1 or ra.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.02)
    assert ra.tokens and not ra.completed, "need an in-flight stream to resume"

    # Carol joins mid-stream and must catch up via stream_snapshot.
    carol = socketio.AsyncClient()
    snapshots: list[dict] = []
    carol.on("stream_snapshot", lambda d: snapshots.append(d))
    rc = Recorder(carol)
    await carol.connect(live_server, auth={"displayName": "Carol"})
    await carol.emit("join_room", {"roomId": room_id})

    deadline = asyncio.get_event_loop().time() + 5
    while (not ra.completed or not rc.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert rc.completed, "late joiner must see completion"

    assistant_id = ra.completed[-1]["messageId"]
    assert snapshots, "late joiner must receive a stream_snapshot"
    snap = snapshots[-1]
    assert snap["messageId"] == assistant_id
    assert snap["state"] == "generating"
    assert snap["content"], "snapshot carries the partial content accumulated so far"

    full = "echo: Alice: hello"
    # snapshot content + tokens Carol received AFTER joining == full text, exactly (no gap/dup)
    assert (snap["content"] + rc.text_for(assistant_id)).strip() == full
    # and Alice (present from the start) reconstructs the same text
    assert ra.text_for(assistant_id).strip() == full

    await alice.disconnect()
    await carol.disconnect()
```

The `live_server` fixture sets `FAKE_TOKEN_DELAY=0.15`, so the echo reply (`"echo: Alice: hello"`, 3 word-tokens) takes ~0.45s — ample to join mid-stream. Gating Carol's join on Alice's first token makes the timing deterministic.

- [ ] **Step 8: Run to verify the resume e2e fails, then passes**

First confirm RED was meaningful by running only the new test:

```bash
cd studio/backend && uv run pytest tests/e2e/test_realtime.py::test_late_joiner_resumes_in_flight_stream -v
```

Expected after Steps 3 & 5 are in place: PASS. (If you run this test _before_ Steps 3/5, it fails because no `stream_snapshot` is ever emitted — that is the RED state this test encodes.)

- [ ] **Step 9: Run the full e2e realtime suite**

Run:

```bash
just mongo-up
cd studio/backend && uv run pytest -m e2e -v
```

Expected: PASS — both original realtime tests, both socket tests, and the new resume test.

- [ ] **Step 10: Run the entire backend suite (unit + e2e)**

Run:

```bash
just mongo-up
cd studio/backend && uv run pytest -v
```

Expected: PASS (everything).

- [ ] **Step 11: Commit**

```bash
git add studio/backend/app/room_hub.py studio/backend/app/sockets.py \
        studio/backend/tests/test_room_hub.py studio/backend/tests/e2e/test_realtime.py
git commit -m "feat(backend): resume in-flight stream for late joiners via stream_snapshot"
```

---

## Verification & PR

- [ ] **Update the spec status note** (the resume open-item is now implemented). In `docs/superpowers/specs/2026-06-19-llm-chat-design.md`, this plan satisfies §13.2 and §13.3 — no spec edit required beyond what is already recorded; skip if no change is warranted.

- [ ] **Full suite green:**

```bash
just mongo-up
cd studio/backend && uv run pytest -v
```

Expected: all unit + e2e tests pass.

- [ ] **Prettier-clean any Markdown touched** (this plan doc, if edited):

```bash
npx prettier --write docs/superpowers/plans/2026-06-19-llm-chat-backend-additions.md
npx prettier --check docs/superpowers/plans/2026-06-19-llm-chat-backend-additions.md
```

- [ ] **Open the PR:**

```bash
git push -u origin feat/llm-chat-backend-additions
gh pr create --fill
gh pr merge --squash --delete-branch
```

(0 approvals required; self-merge once CI is green. CI runs the non-browser Python suite — including the resume e2e — per the cost policy.)

---

## Self-review (coverage)

- **§13.2 `GET /models`** → Task 1 (catalog helper + settings field + route + unit/REST tests). ✓
- **§13.3 in-flight resume** → Task 2 (`active_snapshot`, `attach_subscriber`, `stream_snapshot` event, `join_room` routing, unit + authoritative three-client e2e). ✓
- **Wire format camelCase** → `stream_snapshot {roomId, messageId, content, state}`; `/models {id,label,free}`. ✓
- **No network in tests** → `LLM_BACKEND=fake` (e2e fixture) + pure settings for `/models`. ✓
- **Concurrency correctness** → snapshot+subscribe and token-append+emit share the per-room lock; documented and asserted by the exact-splice e2e assertion. ✓
- **Type/name consistency** → `attach_subscriber`, `active_snapshot`, `stream_snapshot`, `available_models`, `build_model_catalog` used identically across tasks and tests. ✓
- **No placeholders** → every step shows complete code/commands and expected output. ✓
