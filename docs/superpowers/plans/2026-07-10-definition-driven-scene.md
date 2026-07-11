# Definition-Driven Game Scene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mechanics declared in the Game Structure plugin automatically render in the Game Scene, and the scene's Spin plays the authoritative composed math via the runtime server (trace playback), replacing the legacy "Add Reels" button and the broken SlotModel spin for composed games.

**Architecture:** The composed definition (`game_definitions` Mongo doc) becomes the source of truth: every definition write (including the first seed) derives scene modules server-side and broadcasts a `scene_snapshot`, and schedules a debounced background package build into `var/packages`. `scene_spin` for a game with a definition proxies to the Rust runtime server (dir-mode, mtime-cached) over HTTP and emits the outcome + trace; the engine plays it back through the same TraceWalker play-mode uses. Games without a definition keep the SlotModel `spin_json` path, now wrapped loop-safe so it works under `uvicorn --reload` on Windows.

**Tech Stack:** FastAPI + python-socketio + httpx (backend), React/hookstate/Dockview (studio frontend), Pixi engine in `runtime/client` (TypeScript), Rust axum runtime server (unchanged), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-10-definition-driven-scene-design.md`

## Global Constraints

- Semantic commit format (`feat(scope): ...`) on every commit; imperative mood.
- TDD mandatory: write the failing test, watch it fail, minimal code, watch it pass.
- TypeScript interfaces use the `I` prefix (`docs/coding-standards.md`).
- Studio UI follows `docs/design-language.md`; no raw colors outside `styles.css` (use existing classes like `text-danger`, `border-hairline`).
- Playwright e2e is the authoritative behavioral contract; it is run locally, never CI.
- This worktree is `C:\code\bloom.wt\definition-driven-scene`, branch `feat/definition-driven-scene`, `BLOOM_PORT_OFFSET=2` → backend :8002, frontend :4202, engine :4302, e2e runtime server :9302. **Never use the default ports.**
- Backend tests: `cd studio/backend && uv run pytest tests/<file> -q`. Frontend/engine tests: `npx nx run-many -t test` (or targeted `npx vitest run <file>` from the package dir). Run `npm install` + `cd studio/backend && uv sync` once (`just bootstrap`) if not yet done.
- The runtime server and Rust kernel are NOT modified by this plan.

### Plan deviations from spec (approved intent, sharper mechanics)

- The definition→scene sync fires on **every** `ComposeStore` write **including the first seed** (`source="seed"`), so merely opening the Game Structure pane on a fresh game populates the scene — no edit required. Auto-build fires on the same hook.
- The runtime-server URL defaults to `http://localhost:{9000 + BLOOM_PORT_OFFSET}`; the e2e replay backend overrides it via `RUNTIME_SERVER_URL` to the e2e server at `9300 + offset` (the port family the Playwright `webServer` already boots).

---

### Task 1: `derive_scene_modules` — mechanics → scene module declarations

**Files:**

- Create: `studio/backend/app/compose/scene_sync.py`
- Test: `studio/backend/tests/test_compose_scene_sync.py`

**Interfaces:**

- Consumes: nothing (pure functions).
- Produces: `derive_scene_modules(definition: dict | None, presentation: dict | None) -> list[dict]` and `async sync_scene_modules(scene_hub, game_id: str, definition: dict | None, presentation: dict | None) -> None`. Module dicts have the exact shape `GameSceneHub.set_modules` stores: `{"id": <mechanic instance id>, "type": "reels"|"meter", "config": {...}}`. Also exports `DEFAULT_CANVAS = (1080, 1920)`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_compose_scene_sync.py
import pytest

from app.compose.scene_sync import derive_scene_modules, sync_scene_modules, DEFAULT_CANVAS


def _definition():
    return {
        "family": "composed@1",
        "mechanics": [
            {"id": "main_reels", "type": "reels@1",
             "config": {"strips": [[0, 1], [1, 2], [2, 0]], "rows": 3,
                        "symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
                                    {"id": 2, "role": "normal"}, {"id": 9, "role": "scatter"}]}},
            {"id": "bonus_meter", "type": "meter@1",
             "config": {"target": 6, "count_symbol": 9, "reset_on_full": True}},
        ],
    }


def test_reels_config_prefers_the_presentation_manifest():
    pres = {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}
    mods = derive_scene_modules(_definition(), pres)
    reels = next(m for m in mods if m["type"] == "reels")
    assert reels["id"] == "main_reels"
    assert reels["config"] == {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}


def test_reels_config_falls_back_to_the_mechanic_config():
    mods = derive_scene_modules(_definition(), None)
    reels = next(m for m in mods if m["type"] == "reels")
    assert reels["config"] == {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}


def test_meter_maps_target_and_skips_non_numeric():
    mods = derive_scene_modules(_definition(), None)
    meter = next(m for m in mods if m["type"] == "meter")
    assert meter == {"id": "bonus_meter", "type": "meter", "config": {"target": 6}}
    broken = _definition()
    broken["mechanics"][1]["config"]["target"] = "six"
    assert all(m["type"] != "meter" for m in derive_scene_modules(broken, None))


def test_unknown_mechanics_and_empty_definitions_are_skipped():
    d = _definition()
    d["mechanics"].append({"id": "x", "type": "wheel@1", "config": {}})
    assert len(derive_scene_modules(d, None)) == 2
    assert derive_scene_modules(None, None) == []
    assert derive_scene_modules({}, None) == []


class FakeHub:
    def __init__(self):
        self.roots: list[tuple[str, tuple[int, int]]] = []
        self.modules: list[tuple[str, list[dict]]] = []

    async def ensure_root(self, game_id, canvas):
        self.roots.append((game_id, canvas))
        return {"root_id": "root", "canvas": canvas}

    async def set_modules(self, game_id, modules):
        self.modules.append((game_id, modules))
        return {}


@pytest.mark.asyncio
async def test_sync_scene_modules_ensures_root_then_sets_modules():
    hub = FakeHub()
    await sync_scene_modules(hub, "g1", _definition(), None)
    assert hub.roots == [("g1", DEFAULT_CANVAS)]
    assert hub.modules[0][0] == "g1"
    assert [m["id"] for m in hub.modules[0][1]] == ["main_reels", "bonus_meter"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_sync.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.compose.scene_sync'`

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/compose/scene_sync.py
"""Derive Game Scene module declarations from a composed definition.

Server-side twin of runtime/client/src/play/playMode.ts buildComposedPlayDocument:
the presentation manifest is the visual source of truth for the reels grid when
it is well-formed; otherwise geometry falls back to the reels@1 mechanic config.
Unknown mechanic types are skipped — the scene renders what it knows."""

DEFAULT_CANVAS = (1080, 1920)


def _reels_config(mechanic_config: dict, presentation: dict | None) -> dict:
    p = presentation or {}
    cols, rows, symbols = p.get("cols"), p.get("rows"), p.get("symbols")
    if (isinstance(cols, int) and isinstance(rows, int)
            and isinstance(symbols, list) and symbols
            and all(isinstance(s, str) for s in symbols)):
        return {"cols": cols, "rows": rows, "symbols": symbols, "parentId": "root"}
    strips = mechanic_config.get("strips") or []
    syms = [str(s.get("id")) for s in (mechanic_config.get("symbols") or [])]
    return {
        "cols": len(strips) or 5,
        "rows": int(mechanic_config.get("rows") or 3),
        "symbols": syms or [str(i) for i in range(5)],
        "parentId": "root",
    }


def derive_scene_modules(definition: dict | None, presentation: dict | None) -> list[dict]:
    modules: list[dict] = []
    for m in (definition or {}).get("mechanics") or []:
        mid, mtype = m.get("id"), m.get("type")
        cfg = m.get("config") or {}
        if not mid or not mtype:
            continue
        if mtype == "reels@1":
            modules.append({"id": mid, "type": "reels", "config": _reels_config(cfg, presentation)})
        elif mtype == "meter@1":
            target = cfg.get("target")
            if isinstance(target, (int, float)) and not isinstance(target, bool):
                modules.append({"id": mid, "type": "meter", "config": {"target": target}})
    return modules


async def sync_scene_modules(scene_hub, game_id: str, definition: dict | None,
                             presentation: dict | None) -> None:
    modules = derive_scene_modules(definition, presentation)
    await scene_hub.ensure_root(game_id, DEFAULT_CANVAS)
    await scene_hub.set_modules(game_id, modules)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_sync.py -q`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/compose/scene_sync.py studio/backend/tests/test_compose_scene_sync.py
git commit -m "feat(compose): derive scene modules from the composed definition"
```

---

### Task 2: Seed fires `on_change`; definition writes sync the scene

**Files:**

- Modify: `studio/backend/app/compose/store.py` (get_or_seed, ~line 46)
- Modify: `studio/backend/app/main.py` (`_on_game_definition_change`, ~line 117)
- Test: `studio/backend/tests/test_compose_store.py` (add cases)

**Interfaces:**

- Consumes: `sync_scene_modules` from Task 1; existing `ComposeStore._on_change` seam.
- Produces: `ComposeStore.get_or_seed` awaits `on_change(doc, "seed")` exactly once per actual insert (never on a plain read). `main.py`'s `_on_game_definition_change` calls `await sync_scene_modules(scene_hub, doc.game_id, doc.definition, doc.presentation)` after emitting `game_definition_changed`. Later tasks append to this same hook.

- [ ] **Step 1: Write the failing test** — add to `studio/backend/tests/test_compose_store.py` (mirror its existing fixture/DB setup — it already constructs a `ComposeStore`; follow the file's established pattern for the Mongo/fake-db fixture and `on_change` capture):

```python
@pytest.mark.asyncio
async def test_seeding_fires_on_change_once_with_source_seed(db):
    events: list[tuple[str, str]] = []

    async def on_change(doc, source):
        events.append((doc.game_id, source))

    store = ComposeStore(db, on_change=on_change)
    await store.get_or_seed("g-seed")          # inserts -> fires
    await store.get_or_seed("g-seed")          # read-only -> silent
    await store.get("g-seed")                  # read-only -> silent
    assert events == [("g-seed", "seed")]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_compose_store.py -q`
Expected: the new test FAILS (`events == []`); existing tests pass.

- [ ] **Step 3: Write minimal implementation** — in `store.py`, at the end of `get_or_seed` (after the successful `insert_one`, NOT on the `DuplicateKeyError` path):

```python
        try:
            await self._docs.insert_one(_to_doc(doc))
        except DuplicateKeyError:
            return await self.get(game_id)  # concurrent seeder won
        if self._on_change is not None:
            await self._on_change(doc, "seed")
        return doc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_compose_store.py -q`
Expected: all pass.

- [ ] **Step 5: Wire the scene sync into `main.py`** — extend `_on_game_definition_change` (imports go with the other `app.compose.*` imports):

```python
from app.compose.scene_sync import sync_scene_modules
```

```python
    async def _on_game_definition_change(doc, source: str) -> None:
        # Single choke point: every definition/presentation write reaches any
        # open Game Structure pane AND drives the Game Scene — the composed
        # definition is the source of truth for scene mechanics modules.
        await sio.emit(
            "game_definition_changed",
            {"gameId": doc.game_id, "updatedAt": doc.updated_at, "source": source},
            room=doc.game_id,
        )
        await sync_scene_modules(scene_hub, doc.game_id, doc.definition, doc.presentation)
```

`scene_hub` is constructed ~20 lines above the closure — already in scope.

- [ ] **Step 6: Run the compose + scene test files**

Run: `cd studio/backend && uv run pytest tests/test_compose_store.py tests/test_compose_rest.py tests/test_compose_scene_sync.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/compose/store.py studio/backend/app/main.py studio/backend/tests/test_compose_store.py
git commit -m "feat(compose): definition writes (incl. first seed) sync scene modules"
```

---

### Task 3: Auto-build on save — `jobs.py` extraction + `AutoBuilder`

**Files:**

- Create: `studio/backend/app/compose/jobs.py`
- Create: `studio/backend/app/compose/autobuild.py`
- Modify: `studio/backend/app/compose/rest.py` (delete `SEED_COUNT`, `_GAME_ID_RE`, `_master_seed`; import from jobs)
- Modify: `studio/backend/app/main.py` (construct `AutoBuilder`, schedule from `_on_game_definition_change`)
- Test: `studio/backend/tests/test_compose_autobuild.py`

**Interfaces:**

- Consumes: `FakeComposeRunner` from `app/compose/runner.py`; `REPO_ROOT` from `app/compose/templates.py`.
- Produces:
  - `jobs.py`: `SEED_COUNT = 10_000`, `GAME_ID_RE` (compiled regex `^[A-Za-z0-9_-]+$`), `master_seed(game_id: str) -> int`, `build_job(game_id: str, definition: dict, presentation: dict, settings) -> dict` (the exact job dict `rest.py`'s build endpoint sends today, including `out_path` under `REPO_ROOT / settings.packages_dir` and mkdir of the out dir).
  - `autobuild.py`: `class AutoBuilder` with `__init__(self, runner, settings, sio, *, debounce_s: float = 1.5)` and `schedule(self, game_id: str, definition: dict, presentation: dict) -> None` (sync; cancels any pending build for that game and spawns a new `asyncio.create_task`). Emits socket event `game_build_status` to `room=game_id` with payloads `{"gameId", "status": "building"}` then `{"gameId", "status": "done"|"error", "errors", "metrics", "packageId"}`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_compose_autobuild.py
import asyncio

import pytest

from app.compose.autobuild import AutoBuilder
from app.compose.jobs import SEED_COUNT, build_job, master_seed
from app.compose.runner import FakeComposeRunner
from app.config import Settings


class FakeSio:
    def __init__(self):
        self.emitted: list[tuple[str, dict, str | None]] = []

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room))


def test_build_job_matches_the_rest_build_shape(tmp_path):
    settings = Settings(packages_dir="var/packages")
    job = build_job("g1", {"family": "composed@1"}, {"cols": 3}, settings)
    assert job["package_id"] == "g1"
    assert job["seed_count"] == SEED_COUNT
    assert job["master_seed"] == master_seed("g1")
    assert job["validate_only"] is False
    assert job["out_path"].endswith("g1.pkg")


@pytest.mark.asyncio
async def test_debounced_build_emits_building_then_done():
    runner = FakeComposeRunner({"ok": True, "metrics": {"rtp": 0.96}})
    sio = FakeSio()
    b = AutoBuilder(runner, Settings(), sio, debounce_s=0.01)
    b.schedule("g1", {"family": "composed@1"}, {})
    b.schedule("g1", {"family": "composed@1"}, {})  # coalesces with the first
    await asyncio.sleep(0.2)
    assert len(runner.jobs) == 1
    statuses = [(e, d["status"]) for e, d, _ in sio.emitted if e == "game_build_status"]
    assert statuses == [("game_build_status", "building"), ("game_build_status", "done")]
    done = sio.emitted[-1][1]
    assert done["packageId"] == "g1" and done["metrics"] == {"rtp": 0.96}


@pytest.mark.asyncio
async def test_failed_build_emits_error_status():
    runner = FakeComposeRunner({"ok": False, "errors": ["UnknownState"]})
    sio = FakeSio()
    b = AutoBuilder(runner, Settings(), sio, debounce_s=0.01)
    b.schedule("g1", {}, {})
    await asyncio.sleep(0.2)
    assert sio.emitted[-1][1]["status"] == "error"
    assert sio.emitted[-1][1]["errors"] == ["UnknownState"]


@pytest.mark.asyncio
async def test_invalid_game_id_is_never_built():
    runner = FakeComposeRunner({"ok": True})
    b = AutoBuilder(runner, Settings(), FakeSio(), debounce_s=0.01)
    b.schedule("../evil", {}, {})
    await asyncio.sleep(0.2)
    assert runner.jobs == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_compose_autobuild.py -q`
Expected: FAIL — no module `app.compose.jobs` / `app.compose.autobuild`.

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/compose/jobs.py
"""The compose build job shape, shared by the REST build endpoint and the
auto-builder. game_id is a trust boundary: it becomes a file name — mirror the
Rust allow-list in runtime/server/src/state.rs resolve()."""
import hashlib
import re

from app.compose.templates import REPO_ROOT

SEED_COUNT = 10_000
GAME_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def master_seed(game_id: str) -> int:
    # Deterministic per game so rebuilds reproduce the same pool.
    return int.from_bytes(hashlib.sha256(game_id.encode()).digest()[:8], "big")


def build_job(game_id: str, definition: dict, presentation: dict, settings) -> dict:
    out_dir = REPO_ROOT / settings.packages_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    return {
        "definition": definition,
        "presentation": presentation,
        "package_id": game_id,
        "seed_count": SEED_COUNT,
        "master_seed": master_seed(game_id),
        "out_path": str(out_dir / f"{game_id}.pkg"),
        "validate_only": False,
    }
```

```python
# studio/backend/app/compose/autobuild.py
"""Debounced background package build, fired from the definition on_change
hook so the scene's composed spin always plays the latest saved definition."""
import asyncio

from app.compose.jobs import GAME_ID_RE, build_job


class AutoBuilder:
    def __init__(self, runner, settings, sio, *, debounce_s: float = 1.5):
        self._runner = runner
        self._settings = settings
        self._sio = sio
        self._debounce_s = debounce_s
        self._tasks: dict[str, asyncio.Task] = {}

    def schedule(self, game_id: str, definition: dict, presentation: dict) -> None:
        if not GAME_ID_RE.fullmatch(game_id or ""):
            return
        prev = self._tasks.get(game_id)
        if prev is not None and not prev.done():
            prev.cancel()
        self._tasks[game_id] = asyncio.create_task(
            self._run(game_id, definition, presentation)
        )

    async def _run(self, game_id: str, definition: dict, presentation: dict) -> None:
        await asyncio.sleep(self._debounce_s)
        await self._emit(game_id, {"status": "building"})
        try:
            res = await self._runner.run(build_job(game_id, definition, presentation, self._settings))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a crashed build must surface, not vanish
            await self._emit(game_id, {"status": "error", "errors": [str(exc)]})
            return
        ok = bool(res.get("ok"))
        await self._emit(game_id, {
            "status": "done" if ok else "error",
            "errors": res.get("errors") or [],
            "metrics": res.get("metrics"),
            "packageId": game_id,
        })

    async def _emit(self, game_id: str, fields: dict) -> None:
        await self._sio.emit("game_build_status", {"gameId": game_id, **fields}, room=game_id)
```

- [ ] **Step 4: Update `rest.py` to import from `jobs.py`** — delete its local `SEED_COUNT`, `_GAME_ID_RE`, `_master_seed`, and the `hashlib`/`re` imports; replace uses:

```python
from app.compose.jobs import GAME_ID_RE, SEED_COUNT, master_seed
```

`_validate_game_id` keeps its HTTPException but tests `GAME_ID_RE.fullmatch(game_id)`. The two `_master_seed(game_id)` call sites become `master_seed(game_id)`. The build endpoint may keep its inline job dict or call `build_job(game_id, doc.definition, doc.presentation, request.app.state.settings)` — prefer the latter (one shape, one owner).

- [ ] **Step 5: Wire into `main.py`** — construct after `compose_runner`, schedule from the hook:

```python
from app.compose.autobuild import AutoBuilder
```

```python
    compose_runner = build_compose_runner(settings)
    auto_builder = AutoBuilder(compose_runner, settings, sio)
```

`compose_store`'s `_on_game_definition_change` gains a final line (the closure sees `auto_builder` because Python closures bind late — but keep declaration order sane: move the `compose_store = ComposeStore(...)` line to AFTER `auto_builder` is constructed):

```python
        await sync_scene_modules(scene_hub, doc.game_id, doc.definition, doc.presentation)
        auto_builder.schedule(doc.game_id, doc.definition, doc.presentation)
```

- [ ] **Step 6: Run tests**

Run: `cd studio/backend && uv run pytest tests/test_compose_autobuild.py tests/test_compose_rest.py tests/test_compose_store.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/compose/jobs.py studio/backend/app/compose/autobuild.py studio/backend/app/compose/rest.py studio/backend/app/main.py studio/backend/tests/test_compose_autobuild.py
git commit -m "feat(compose): debounced auto-build on definition save with game_build_status"
```

---

### Task 4: Loop-safe SlotModel spin runner (fixes dead Spin on Windows `--reload`)

**Files:**

- Modify: `studio/backend/app/scene/reels_spin.py` (`build_spin_runner`, ~line 107)
- Test: `studio/backend/tests/test_reels_spin_loop_safe.py`

**Interfaces:**

- Consumes: the `_LoopSafeComposeRunner` pattern in `app/compose/runner.py:73` (copy the mechanism, adapt the `run` signature; read `tests/test_subprocess_loop_safe.py` and mirror its test technique for driving a `SelectorEventLoop`).
- Produces: `build_spin_runner(settings)` returns the `SubprocessSpinRunner` wrapped in `_LoopSafeSpinRunner`, whose `async run(self, model: dict, seed: int) -> dict` matches the `SpinRunner` protocol.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_reels_spin_loop_safe.py
import asyncio
import sys

import pytest

from app.scene.reels_spin import _LoopSafeSpinRunner, build_spin_runner
from app.config import Settings


class Inner:
    def __init__(self):
        self.calls: list[tuple[dict, int]] = []

    async def run(self, model, seed):
        self.calls.append((model, seed))
        return {"grid": [[0]]}


@pytest.mark.asyncio
async def test_passthrough_on_subprocess_capable_loops():
    inner = Inner()
    out = await _LoopSafeSpinRunner(inner).run({"m": 1}, 7)
    assert out == {"grid": [[0]]}
    assert inner.calls == [({"m": 1}, 7)]


@pytest.mark.skipif(sys.platform != "win32", reason="SelectorEventLoop subprocess gap is Windows-only")
def test_selector_loop_is_marshalled_to_a_worker_proactor_loop():
    inner = Inner()
    loop = asyncio.SelectorEventLoop()
    try:
        out = loop.run_until_complete(_LoopSafeSpinRunner(inner).run({"m": 1}, 7))
    finally:
        loop.close()
    assert out == {"grid": [[0]]}


def test_build_spin_runner_is_wrapped():
    assert isinstance(build_spin_runner(Settings()), _LoopSafeSpinRunner)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_reels_spin_loop_safe.py -q`
Expected: FAIL — `ImportError: cannot import name '_LoopSafeSpinRunner'`.

- [ ] **Step 3: Write minimal implementation** — append to `reels_spin.py` (add `import sys`, `import threading` at top):

```python
class _LoopSafeSpinRunner:
    """SpinRunner analogue of compose/runner._LoopSafeComposeRunner: under
    `uvicorn --reload` on Windows the app runs on a SelectorEventLoop, which
    cannot asyncio-spawn a subprocess (scene Spin died with NotImplementedError);
    drive the inner coroutine on a private ProactorEventLoop in a worker thread.
    Pure passthrough on subprocess-capable loops."""

    def __init__(self, inner):
        self._inner = inner

    async def run(self, model: dict, seed: int) -> dict:
        loop = asyncio.get_running_loop()
        if not (sys.platform == "win32" and isinstance(loop, asyncio.SelectorEventLoop)):
            return await self._inner.run(model, seed)

        result: list[dict] = []
        error: list[BaseException] = []
        ready = asyncio.Event()

        def worker():
            inner_loop = asyncio.ProactorEventLoop()
            try:
                result.append(inner_loop.run_until_complete(self._inner.run(model, seed)))
            except BaseException as exc:  # surfaced on the caller's loop below
                error.append(exc)
            finally:
                inner_loop.close()
                loop.call_soon_threadsafe(ready.set)

        threading.Thread(target=worker, daemon=True, name="loop-safe-spin-runner").start()
        await ready.wait()
        if error:
            raise error[0]
        return result[0]


def build_spin_runner(settings) -> SpinRunner:
    return _LoopSafeSpinRunner(SubprocessSpinRunner(settings))
```

(The second test drives the wrapper on a real `SelectorEventLoop`; `ready.set` via `call_soon_threadsafe` works because `loop.run_until_complete` is pumping that loop.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_reels_spin_loop_safe.py tests/test_reels_sockets.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/reels_spin.py studio/backend/tests/test_reels_spin_loop_safe.py
git commit -m "fix(scene): loop-safe SlotModel spin runner under Windows --reload"
```

---

### Task 5: `ComposedSpinClient` + `runtime_server_url` setting

**Files:**

- Modify: `studio/backend/app/config.py` (add one field)
- Create: `studio/backend/app/scene/composed_spin.py`
- Test: `studio/backend/tests/test_composed_spin.py`

**Interfaces:**

- Consumes: `httpx` (already a dependency).
- Produces:
  - `Settings.runtime_server_url: str = ""` — `""` means derive `http://localhost:{9000 + BLOOM_PORT_OFFSET}`.
  - `class ComposedSpinError(Exception)` — message is user-facing (shown in the scene pane).
  - `class ComposedSpinClient` with `__init__(self, base_url: str, *, timeout_s: float = 10.0, transport: httpx.AsyncBaseTransport | None = None)` and `async spin(self, package_id: str) -> dict` returning the runtime server's spin JSON (`{"seed": str, "bet": int, "outcome": {...}, "trace": [...]}`).
  - `build_composed_spin_client(settings) -> ComposedSpinClient`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_composed_spin.py
import httpx
import pytest

from app.config import Settings
from app.scene.composed_spin import ComposedSpinClient, ComposedSpinError, build_composed_spin_client


def _client(handler):
    return ComposedSpinClient("http://rt:9000", transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_spin_posts_bet_and_package_and_returns_the_round():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.content.decode()
        return httpx.Response(200, json={"seed": "11", "bet": 1,
                                         "outcome": {"mechanic": "composed@1", "total_payout": 5},
                                         "trace": [{"t": "round_start", "seed": "11"}]})

    res = await _client(handler).spin("g1")
    assert seen["url"] == "http://rt:9000/spin"
    assert '"package": "g1"' in seen["body"] or '"package":"g1"' in seen["body"]
    assert res["outcome"]["total_payout"] == 5


@pytest.mark.asyncio
async def test_404_maps_to_a_not_built_yet_message():
    with pytest.raises(ComposedSpinError, match="not built yet"):
        await _client(lambda r: httpx.Response(404)).spin("g1")


@pytest.mark.asyncio
async def test_connection_failure_names_the_fix():
    def handler(request):
        raise httpx.ConnectError("boom")

    with pytest.raises(ComposedSpinError, match="just runtime-serve-packages"):
        await _client(handler).spin("g1")


@pytest.mark.asyncio
async def test_5xx_surfaces_status():
    with pytest.raises(ComposedSpinError, match="500"):
        await _client(lambda r: httpx.Response(500, text="audit down")).spin("g1")


def test_default_url_derives_from_port_offset(monkeypatch):
    monkeypatch.setenv("BLOOM_PORT_OFFSET", "2")
    c = build_composed_spin_client(Settings(runtime_server_url=""))
    assert c.base_url == "http://localhost:9002"
    c2 = build_composed_spin_client(Settings(runtime_server_url="http://x:9302"))
    assert c2.base_url == "http://x:9302"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_composed_spin.py -q`
Expected: FAIL — no module `app.scene.composed_spin`.

- [ ] **Step 3: Write minimal implementation**

`config.py`, next to `packages_dir`:

```python
    runtime_server_url: str = ""  # "" => http://localhost:{9000+BLOOM_PORT_OFFSET}; e2e replay backend points at the 9300-family server
```

```python
# studio/backend/app/scene/composed_spin.py
"""HTTP seam to the authoritative Rust runtime server for composed@1 scene
spins. No subprocess anywhere on this path, so it cannot hit the Windows
--reload SelectorEventLoop gap the SlotModel spin runner needs wrapping for."""
import os

import httpx


class ComposedSpinError(Exception):
    """User-facing spin failure (message is rendered in the Game Scene pane)."""


class ComposedSpinClient:
    def __init__(self, base_url: str, *, timeout_s: float = 10.0,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._transport = transport

    async def spin(self, package_id: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=self._timeout_s, transport=self._transport) as client:
                r = await client.post(f"{self.base_url}/spin", json={"bet": 1, "package": package_id})
        except httpx.HTTPError as exc:
            raise ComposedSpinError(
                f"runtime server unreachable at {self.base_url} — start it with: just runtime-serve-packages"
            ) from exc
        if r.status_code == 404:
            raise ComposedSpinError(
                "package not built yet — it builds automatically after a Game Structure save; try again shortly"
            )
        if r.status_code != 200:
            raise ComposedSpinError(f"runtime server error {r.status_code}: {r.text[:200]}")
        return r.json()


def build_composed_spin_client(settings) -> ComposedSpinClient:
    url = settings.runtime_server_url
    if not url:
        offset = int(os.environ.get("BLOOM_PORT_OFFSET", "0") or 0)
        url = f"http://localhost:{9000 + offset}"
    return ComposedSpinClient(url)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_composed_spin.py tests/test_config.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/config.py studio/backend/app/scene/composed_spin.py studio/backend/tests/test_composed_spin.py
git commit -m "feat(scene): ComposedSpinClient seam to the runtime server"
```

---

### Task 6: `scene_spin` routes composed games to the runtime server; `scene_add_module` removed

**Files:**

- Modify: `studio/backend/app/scene/sockets.py`
- Modify: `studio/backend/app/scene/reels_spin.py` (delete `derive_reels_config`)
- Modify: `studio/backend/app/main.py` (wiring)
- Test: `studio/backend/tests/test_reels_sockets.py` (rewrite the add-module test; add routing tests)

**Interfaces:**

- Consumes: `ComposedSpinClient`/`ComposedSpinError` (Task 5); `ComposeStore.get` (returns `None` for games with no definition doc — NEVER `get_or_seed` here, a Spin must not conjure a definition).
- Produces: `register_scene_handlers(sio, hub, broker, model_store, spin_runner, compose_store, composed_spin)` (two new required positional params). Socket events emitted to `room=game_id`:
  - `scene_spin_trace` — `{"gameId", "seed", "outcome", "trace"}` (server response passed through; `trace` defaults to `[]`).
  - `scene_spin_error` — `{"gameId", "message"}`.
  - Legacy `scene_spin_outcome` unchanged for games without a definition doc.
  - `scene_add_module` no longer exists.

- [ ] **Step 1: Write the failing tests** — in `test_reels_sockets.py`, reuse its `FakeSio`/`FakeHub`/`FakeModelStore` and add:

```python
class FakeComposeStore:
    def __init__(self, doc=None):
        self._doc = doc

    async def get(self, game_id):
        return self._doc


class FakeDoc:
    def __init__(self):
        self.definition = {"family": "composed@1"}
        self.presentation = {}


class FakeComposedSpin:
    def __init__(self, result=None, error=None):
        self._result, self._error = result, error
        self.calls: list[str] = []

    async def spin(self, package_id):
        self.calls.append(package_id)
        if self._error:
            raise self._error
        return self._result


@pytest.mark.asyncio
async def test_composed_game_spin_proxies_to_the_runtime_server():
    sio, hub = FakeSio(), FakeHub()
    round_ = {"seed": "11", "outcome": {"mechanic": "composed@1", "total_payout": 5},
              "trace": [{"t": "round_end", "total_payout": 5}]}
    spin = FakeComposedSpin(result=round_)
    register_scene_handlers(sio, hub, None, FakeModelStore(), FailingSpinRunner(),
                            FakeComposeStore(FakeDoc()), spin)
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1"})
    assert spin.calls == ["g1"]
    event, data, room = sio.emitted[-1]
    assert event == "scene_spin_trace" and room == "g1"
    assert data["trace"][-1]["t"] == "round_end"


@pytest.mark.asyncio
async def test_composed_spin_failure_emits_scene_spin_error():
    from app.scene.composed_spin import ComposedSpinError
    sio, hub = FakeSio(), FakeHub()
    spin = FakeComposedSpin(error=ComposedSpinError("runtime server unreachable"))
    register_scene_handlers(sio, hub, None, FakeModelStore(), FailingSpinRunner(),
                            FakeComposeStore(FakeDoc()), spin)
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1"})
    event, data, _ = sio.emitted[-1]
    assert event == "scene_spin_error"
    assert "unreachable" in data["message"]


@pytest.mark.asyncio
async def test_game_without_definition_keeps_the_legacy_slotmodel_spin():
    # keep/adapt the existing spin test: compose_store.get -> None must land on
    # spin_runner + scene_spin_outcome exactly as before
    ...


@pytest.mark.asyncio
async def test_scene_add_module_handler_is_gone():
    sio, hub = FakeSio(), FakeHub()
    register_scene_handlers(sio, hub, None, FakeModelStore(), FakeSpinRunner(),
                            FakeComposeStore(None), FakeComposedSpin())
    assert "scene_add_module" not in sio.handlers
```

`FailingSpinRunner` = a runner whose `run` raises `AssertionError("legacy spin must not run for composed games")`. Adapt the file's existing `scene_add_module` test (line ~57) — it is deleted with the handler; its FakeHub/derive assertions move to nothing (Task 1 covers derivation). Update every `register_scene_handlers(...)` call in `tests/` to the 7-arg form (grep: `tests/test_reels_sockets.py`, `tests/test_scene_apply_op_handler.py`, `tests/test_scene_capture.py`, `tests/test_scene_sockets.py` — pass `FakeComposeStore(None), FakeComposedSpin()` or equivalent stubs).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_reels_sockets.py -q`
Expected: FAIL — `register_scene_handlers` takes 5 args; new events missing.

- [ ] **Step 3: Write minimal implementation** — `sockets.py`:

```python
import secrets
from app.scene.document import OpError
from app.scene.composed_spin import ComposedSpinError
from app.scene.reels_spin import map_grid


def register_scene_handlers(sio, hub, broker, model_store, spin_runner, compose_store, composed_spin):
```

Delete the `scene_add_module` handler and `_DEFAULT_CANVAS` (now owned by `scene_sync.DEFAULT_CANVAS`). Replace `scene_spin`:

```python
    @sio.on("scene_spin")
    async def scene_spin(sid, data):
        game_id = data.get("gameId")
        # A game WITH a composed definition plays the real math: the runtime
        # server draws/audits the round and returns a walkable trace. get(),
        # not get_or_seed(): a Spin must never conjure a definition.
        doc = await compose_store.get(game_id)
        if doc is not None:
            try:
                res = await composed_spin.spin(game_id)
            except ComposedSpinError as e:
                await sio.emit("scene_spin_error",
                               {"gameId": game_id, "message": str(e)}, room=game_id)
                return
            await sio.emit("scene_spin_trace",
                           {"gameId": game_id, "seed": res.get("seed"),
                            "outcome": res.get("outcome"), "trace": res.get("trace") or []},
                           room=game_id)
            return
        # Legacy SlotModel-era games: evaluate one round via spin_json.
        seed = data.get("seed")
        if seed is None:
            seed = secrets.randbelow(2 ** 63)
        result = await spin_runner.run(await _model_for(game_id), int(seed))
        grid = map_grid(result["grid"])
        await sio.emit("scene_spin_outcome",
                       {"gameId": game_id, "outcome": {"grid": grid}}, room=game_id)
```

Delete `derive_reels_config` from `reels_spin.py` (its only caller was the removed handler; keep `map_grid`). `main.py` wiring:

```python
from app.scene.composed_spin import build_composed_spin_client
```

```python
    spin_runner = build_spin_runner(settings)
    register_scene_handlers(sio, scene_hub, capture_broker, math_store, spin_runner,
                            compose_store, build_composed_spin_client(settings))
```

- [ ] **Step 4: Run the backend suite**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: all pass (fix any remaining `register_scene_handlers` call sites or `derive_reels_config` imports the run surfaces).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/sockets.py studio/backend/app/scene/reels_spin.py studio/backend/app/main.py studio/backend/tests/
git commit -m "feat(scene): composed games spin via the runtime server; drop scene_add_module"
```

---

### Task 7: Engine `trace` protocol message → TraceWalker playback

**Files:**

- Modify: `runtime/client/src/protocol/messages.ts`
- Modify: `runtime/client/src/protocol/protocolHost.ts`
- Modify: `runtime/client/src/engine.ts`
- Test: `runtime/client/src/protocol/protocolHost.trace.spec.ts` (new; mirror `protocolHost.spin.spec.ts`'s fakes)

**Interfaces:**

- Consumes: `TraceWalker`, `ITriggerTarget` from `../orchestration/traceWalker`; `ITraceEntry` from `../play/composedTypes`; `ModuleManager.byId`.
- Produces: inbound message `{ v: 1; kind: 'trace'; id: string; entries: ITraceEntry[] }`; `IProtocolDeps.onTrace?: (entries: ITraceEntry[]) => Promise<void>`; `createEngine` wires `onTrace` to a `TraceWalker` resolving modules **by instance id** (same resolve as play-mode in `main.ts:94-97`). The host awaits the walk, then acks.

- [ ] **Step 1: Write the failing test**

```typescript
// runtime/client/src/protocol/protocolHost.trace.spec.ts
import { describe, expect, it, vi } from 'vitest';
import { ProtocolHost } from './protocolHost';
import type { ITraceEntry } from '../play/composedTypes';

// Reuse the minimal fakes from protocolHost.spin.spec.ts (model/reconciler/post) —
// copy its makeDeps helper shape.

describe('trace message', () => {
  it('dispatches entries to onTrace, awaits it, then acks', async () => {
    const posted: unknown[] = [];
    const order: string[] = [];
    const onTrace = vi.fn(async (entries: ITraceEntry[]) => {
      order.push(`walk:${entries.length}`);
    });
    const host = new ProtocolHost({
      model: { load: () => [], apply: () => [], applyBatch: () => [] } as never,
      reconciler: { applyChanges: async () => {}, capture: async () => '' } as never,
      post: (m) => {
        posted.push(m);
        order.push((m as { kind: string }).kind);
      },
      onTrace,
    });
    await host.handle({ v: 1, kind: 'trace', id: 't1', entries: [{ t: 'round_end', total_payout: 5 }] });
    expect(onTrace).toHaveBeenCalledOnce();
    expect(order).toEqual(['walk:1', 'ack']);
    expect(posted.at(-1)).toEqual({ v: 1, kind: 'ack', id: 't1' });
  });

  it('a throwing walk posts a protocol error, not an unhandled rejection', async () => {
    const posted: Array<{ kind: string }> = [];
    const host = new ProtocolHost({
      model: { load: () => [], apply: () => [], applyBatch: () => [] } as never,
      reconciler: { applyChanges: async () => {}, capture: async () => '' } as never,
      post: (m) => posted.push(m as { kind: string }),
      onTrace: async () => {
        throw new Error('no module for mechanic: ghost');
      },
    });
    await host.handle({ v: 1, kind: 'trace', id: 't2', entries: [] });
    expect(posted.at(-1)?.kind).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/protocol/protocolHost.trace.spec.ts` (from `runtime/client`)
Expected: FAIL — `kind: 'trace'` not assignable / onTrace unknown.

- [ ] **Step 3: Write minimal implementation**

`messages.ts`:

```typescript
import type { ITraceEntry } from '../play/composedTypes';
// ...
export type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: IGameDocument }
  | { v: 1; kind: 'op'; id: string; op: Op }
  | { v: 1; kind: 'batch'; id: string; ops: Op[] }
  | { v: 1; kind: 'spin'; id: string; outcome: IOutcome }
  | { v: 1; kind: 'trace'; id: string; entries: ITraceEntry[] }
  | { v: 1; kind: 'capture'; id: string };
```

`protocolHost.ts` — add to `IProtocolDeps`:

```typescript
  onTrace?: (entries: import('../play/composedTypes').ITraceEntry[]) => Promise<void>;
```

and to `handle` (before the `capture` branch):

```typescript
      } else if (msg.kind === 'trace') {
        await this.deps.onTrace?.(msg.entries);
```

`engine.ts` — after `manager` is built:

```typescript
import { TraceWalker, type ITriggerTarget } from './orchestration/traceWalker';
// ...
const walker = new TraceWalker({
  bus,
  resolve: (id) => {
    const m = manager.byId(id) as unknown as Partial<ITriggerTarget> | undefined;
    return m && typeof m.invoke === 'function' ? (m as ITriggerTarget) : null;
  },
});
const host = new ProtocolHost({
  model,
  reconciler,
  post: deps.post,
  onSpin: (o) => orchestrator.spin(o),
  onTrace: (entries) => walker.walk(entries),
  onModules: (decls) => manager.sync(decls),
});
```

- [ ] **Step 4: Run the engine tests**

Run: `npx vitest run` (from `runtime/client`)
Expected: all pass, including existing `protocolHost.*.spec.ts` and `goldenWalk.spec.ts`.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/protocol/messages.ts runtime/client/src/protocol/protocolHost.ts runtime/client/src/engine.ts runtime/client/src/protocol/protocolHost.trace.spec.ts
git commit -m "feat(runtime-client): trace protocol message drives TraceWalker playback"
```

---

### Task 8: Studio game plugin — trace/error plumbing, Add Reels removed

**Files:**

- Modify: `studio/frontend/src/plugins/game/protocolBridge.ts` (trace variant + method)
- Modify: `studio/frontend/src/plugins/game/socketClient.ts` (new events; delete `emitSceneAddModule`)
- Modify: `studio/frontend/src/plugins/game/state.ts` (`spinError` field)
- Modify: `studio/frontend/src/plugins/game/GamePreviewPane.tsx` (drop button, error bar)
- Test: `studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx`, plus the socket handling test file colocated with `socketClient` (if none exists, add `socketClient.spin.spec.ts` with hookstate + bridge fakes following `GamePreviewPane.spec.tsx`'s mocking style)

**Interfaces:**

- Consumes: backend events from Task 6 (`scene_spin_trace` `{gameId, seed, outcome, trace}`, `scene_spin_error` `{gameId, message}`); engine `trace` message from Task 7.
- Produces:
  - `ProtocolBridge.trace(entries: unknown[]): void` → posts `{ v: 1, kind: 'trace', id, entries }`.
  - `applySpinTrace(payload: { gameId: string; trace: unknown[] })` and `applySpinError(payload: { gameId: string; message: string })` exported from `socketClient.ts`.
  - `IGameState.spinError: string | null` (initial `null`).
  - Pane renders `data-testid="game-spin-error"` when set; **no `game-add-reels` testid anywhere**; dev global `__gameLastSpinTrace`.

- [ ] **Step 1: Write the failing tests**

`GamePreviewPane.spec.tsx` — replace the Add-Reels assertion (line ~40) with:

```tsx
it('has no Add Reels button — mechanics come from Game Structure', () => {
  renderPane();
  expect(screen.queryByTestId('game-add-reels')).toBeNull();
  expect(screen.getByTestId('game-spin')).toBeInTheDocument();
});

it('renders the spin error bar when spinError is set, and spinning clears it', () => {
  renderPane();
  act(() => gameSlice().spinError.set('runtime server unreachable'));
  expect(screen.getByTestId('game-spin-error')).toHaveTextContent('runtime server unreachable');
  fireEvent.click(screen.getByTestId('game-spin'));
  expect(screen.queryByTestId('game-spin-error')).toBeNull();
});
```

(Adapt to the file's existing render/mocks: it already mocks `./socketClient` — drop `emitSceneAddModule` from the mock, keep `emitSceneSpin`.)

New socket-level test (same directory), asserting routing + inactive-game guard:

```typescript
// socketClient.trace.spec.ts — mock ./protocolBridge getBridge() with a spy object
it('applySpinTrace forwards the trace to the bridge and clears spinError', () => {
  gameSlice().activeGameId.set('g1');
  gameSlice().spinError.set('old');
  applySpinTrace({ gameId: 'g1', trace: [{ t: 'round_end', total_payout: 5 }] });
  expect(bridgeSpy.trace).toHaveBeenCalledWith([{ t: 'round_end', total_payout: 5 }]);
  expect(gameSlice().spinError.get()).toBeNull();
});

it('applySpinError sets spinError only for the active game', () => {
  gameSlice().activeGameId.set('g1');
  applySpinError({ gameId: 'other', message: 'nope' });
  expect(gameSlice().spinError.get()).toBeNull();
  applySpinError({ gameId: 'g1', message: 'runtime server unreachable' });
  expect(gameSlice().spinError.get()).toBe('runtime server unreachable');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx nx test frontend` (or targeted vitest on the two spec files)
Expected: FAIL — `spinError` missing, `applySpinTrace` undefined, pane still renders the button.

- [ ] **Step 3: Write minimal implementation**

`state.ts`: add `spinError: string | null` to `IGameState` and `spinError: null` to `makeInitialState()`.

`protocolBridge.ts`: add the message variant and method:

```typescript
  | { v: 1; kind: 'trace'; id: string; entries: unknown[] }
```

```typescript
  /** Play back a served composed round: the engine walks the trace through its modules. */
  trace(entries: unknown[]): void {
    this.send({ v: 1, kind: 'trace', id: this.nextId(), entries });
  }
```

`socketClient.ts`: delete `emitSceneAddModule`; add:

```typescript
export function applySpinTrace(payload: { gameId: string; trace: unknown[] }): void {
  if (!isActive(payload.gameId)) return;
  gameSlice().spinError.set(null);
  if (!import.meta.env.PROD) {
    (window as unknown as { __gameLastSpinTrace?: unknown }).__gameLastSpinTrace = payload;
  }
  getBridge()?.trace(payload.trace);
}

export function applySpinError(payload: { gameId: string; message: string }): void {
  if (!isActive(payload.gameId)) return;
  gameSlice().spinError.set(payload.message);
}
```

and in `connect()`:

```typescript
sock.on('scene_spin_trace', (p) => applySpinTrace(p as { gameId: string; trace: unknown[] }));
sock.on('scene_spin_error', (p) => applySpinError(p as { gameId: string; message: string }));
```

`GamePreviewPane.tsx`: delete the Add Reels `<button>` and the `emitSceneAddModule` import; spin click becomes:

```tsx
          onClick={() => {
            gameSlice().spinError.set(null);
            emitSceneSpin(activeGameId);
          }}
```

(import `gameSlice` from `./state`); under the toolbar div:

```tsx
{
  spinError && (
    <div data-testid="game-spin-error" className="border-b border-hairline px-3 py-1 text-[11px] text-danger">
      {spinError}
    </div>
  );
}
```

with `const spinError = s.spinError.get();` beside the existing state reads.

- [ ] **Step 4: Run all frontend gates** (vitest green ≠ types valid — run all four):

```bash
node_modules/.bin/prettier --check .
npx nx run-many -t typecheck
npx nx run-many -t test
npx nx run-many -t build
```

Expected: all pass. (Three game-plugin tests hardcode ports and fail in offset≠0 worktrees — pre-existing, ignore only those exact failures.)

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game/
git commit -m "feat(studio): scene spin plays composed traces; remove Add Reels button"
```

---

### Task 9: Game Structure pane shows auto-build status

**Files:**

- Modify: `studio/frontend/src/plugins/game-structure/socketClient.ts`
- Modify: `studio/frontend/src/plugins/game-structure/actions.ts` (register the handler in `initGameStructure`, next to `setDefinitionChangedHandler`)
- Test: `studio/frontend/src/plugins/game-structure/actions.spec.ts` (add cases)

**Interfaces:**

- Consumes: `game_build_status` event (Task 3): `{gameId, status: 'building'|'done'|'error', errors?, metrics?, packageId?}`; existing `IGameStructureState.build` slice (`{status, metrics, errors}` — `state.ts:24`).
- Produces: `setBuildStatusHandler(h)` + socket subscription in `createGameStructureSocket`; `applyBuildStatus(p)` exported from `actions.ts` that maps the event into the same `s.build` state the manual Build button uses (ignoring events for non-active games).

- [ ] **Step 1: Write the failing test** — in `actions.spec.ts` (mirror its existing state-seeding style):

```typescript
it('applyBuildStatus mirrors auto-build progress into the build slice', () => {
  state().activeGameId.set('g1');
  applyBuildStatus({ gameId: 'g1', status: 'building' });
  expect(state().build.status.get()).toBe('building');
  applyBuildStatus({ gameId: 'g1', status: 'done', metrics: { rtp: 0.96 } as never, packageId: 'g1' });
  expect(state().build.status.get()).toBe('done');
  applyBuildStatus({ gameId: 'other', status: 'error', errors: ['x'] });
  expect(state().build.status.get()).toBe('done'); // inactive game ignored
  applyBuildStatus({ gameId: 'g1', status: 'error', errors: ['UnknownState'] });
  expect(state().build.errors.get({ noproxy: true })).toEqual(['UnknownState']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend` (targeted at the spec)
Expected: FAIL — `applyBuildStatus` not exported.

- [ ] **Step 3: Write minimal implementation**

`socketClient.ts` — alongside the definition-changed seam:

```typescript
export interface IBuildStatusEvent {
  gameId: string;
  status: 'building' | 'done' | 'error';
  errors?: string[];
  metrics?: unknown;
  packageId?: string;
}

let buildHandler: ((p: IBuildStatusEvent) => void) | null = null;

export function setBuildStatusHandler(h: (p: IBuildStatusEvent) => void): void {
  buildHandler = h;
}
```

and in `connect()`: `sock.on('game_build_status', (p: IBuildStatusEvent) => buildHandler?.(p));`

`actions.ts`:

```typescript
export function applyBuildStatus(p: IBuildStatusEvent): void {
  const s = slice();
  if (s.activeGameId.get() !== p.gameId) return;
  if (p.status === 'building') s.build.set({ status: 'building', metrics: null, errors: [] });
  else if (p.status === 'done') s.build.set({ status: 'done', metrics: (p.metrics as IComposeMetrics) ?? null, errors: [] });
  else s.build.set({ status: 'error', metrics: null, errors: p.errors ?? ['build failed'] });
}
```

registered wherever `setDefinitionChangedHandler` is (in `initGameStructure`): `setBuildStatusHandler(applyBuildStatus);` — adapt names to the file's actual state accessor (`slice()`/`gameStructureSlice()`; read the file).

- [ ] **Step 4: Run the frontend gates** (same four commands as Task 8, Step 4). Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game-structure/
git commit -m "feat(game-structure): surface auto-build status in the pane"
```

---

### Task 10: justfile/docs + e2e contract rewrite + full verification

**Files:**

- Modify: `justfile` (`backend-serve-replay` recipe)
- Modify: `AGENTS.md` (worktree port list)
- Rewrite: `studio/frontend/e2e/reels.spec.ts`
- Test: the rewritten spec itself + the neighboring suites

**Interfaces:**

- Consumes: everything above, running as a stack.
- Produces: the new authoritative e2e contract: opening Game Structure populates the Game Scene; Spin plays a served trace.

- [ ] **Step 1: Point the e2e replay backend at the e2e runtime server** — in `justfile`, `backend-serve-replay` gains `RUNTIME_SERVER_URL` (the Playwright `webServer` already boots a dir-mode server on the 9300 family):

```make
backend-serve-replay:
    cd studio/backend && off="${BLOOM_PORT_OFFSET:-0}"; if [ "$off" = "0" ]; then db=bloom_studio; media=var/media; else db=bloom_studio_wt$off; media=var/media_wt$off; fi; PROVIDER_MODE=replay RUNTIME_SERVER_URL="http://localhost:$((9300 + off))" MONGO_DB="$db" MEDIA_DIR="$media" uv run uvicorn app.main:app --port $((8000 + off))
```

In `AGENTS.md`, extend the per-worktree port bullet: after `runtime client \`4300+N\``add`, runtime game server \`9000+N\` (the e2e harness boots its own on \`9300+N\`)`.

- [ ] **Step 2: Rewrite `studio/frontend/e2e/reels.spec.ts`** — the old spec drove Add Reels + SlotModel spin; the new contract is structure-driven. Full replacement:

```typescript
import { test, expect, type Page } from '@playwright/test';
import { BACKEND_URL, seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the worktree-offset stack:
// engine, replay backend (which points RUNTIME_SERVER_URL at the e2e runtime
// server below), studio frontend; Playwright's webServer boots the dir-mode
// runtime server on 9300+offset. Contract: mechanics declared in Game Structure
// ARE the scene (no manual Add Reels), and Spin plays the authoritative
// composed round via a served trace.

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const RUNTIME = `http://localhost:${9300 + offset}`;

async function setupRoom(page: Page): Promise<string> {
  const roomName = `reels ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const resp = await fetch(`${BACKEND_URL}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: roomName }),
  });
  expect(resp.ok).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openGameScene(page: Page) {
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
}

async function engineFrame(page: Page) {
  const handle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await handle!.contentFrame();
  expect(frame).toBeTruthy();
  return frame!;
}

test('Game Structure mechanics render in the scene and Spin plays a served trace', async ({ page }) => {
  test.setTimeout(420_000); // first auto-build may compile compose_json + mint a 10k-seed pool
  const gameId = await setupRoom(page);
  await openGameScene(page);
  const frame = await engineFrame(page);

  // No Add Reels button — mechanics are declared in Game Structure.
  await expect(page.getByTestId('game-add-reels')).toHaveCount(0);

  // Opening Game Structure seeds the definition -> the scene grows the
  // template's mechanics (main_reels + bonus_meter) with no manual step.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game-structure/editor').click();
  await expect(page.getByTestId('gs-tab-mechanics')).toBeVisible();
  await expect
    .poll(() => frame.evaluate(() => (window as any).__engineModel?.toDocument().nodes['main_reels:cell:0:0'] != null), { timeout: 30000 })
    .toBe(true);
  expect(await frame.evaluate(() => Object.keys((window as any).__engineModel.toDocument().nodes).some((k) => k.startsWith('bonus_meter')))).toBe(true);

  // The definition save (seed) auto-builds the package; wait for the dir-mode
  // runtime server to serve it.
  await expect.poll(async () => (await fetch(`${RUNTIME}/handshake?package=${gameId}`)).status, { timeout: 360_000, intervals: [3000] }).toBe(200);

  // Spin -> the backend proxies the authoritative server and broadcasts a trace.
  await page.getByTestId('game-spin').click();
  await expect.poll(() => page.evaluate(() => (window as any).__gameLastSpinTrace ?? null), { timeout: 30000 }).not.toBeNull();
  const trace = await page.evaluate(() => (window as any).__gameLastSpinTrace.trace as Array<any>);
  expect(trace.at(-1)?.t).toBe('round_end');

  // End-state: reels settle to idle on the trace's grid (assert reconciliation,
  // not dispatch) and no error bar is shown.
  await expect.poll(() => frame.evaluate(() => (window as any).__engineModules.state().phase), { timeout: 20000 }).toBe('idle');
  const trigger = trace.find((e) => e.t === 'trigger' && e.data?.kind === 'reels');
  expect(trigger).toBeTruthy();
  const rendered = await frame.evaluate(() => (window as any).__engineModules.state().grid);
  expect(rendered).toEqual(trigger.data.grid.map((reel: number[]) => reel.map(String)));
  await expect(page.getByTestId('game-spin-error')).toHaveCount(0);
});
```

Before finalizing, verify two conventions against the code (adjust the spec if they differ): (a) module node ids are prefixed `<module id>:cell:<col>:<row>` — check `ReelsModule.buildDesired` (`runtime/client/src/modules/reels/reelsModule.ts:65`); (b) the reels trigger data grid is column-major `number[][]` mapped to strings — check `ReelsModule.invoke` (`reelsModule.ts:170`) and `map_grid`'s shape.

- [ ] **Step 3: Grep for stragglers**

Run: `grep -rn "game-add-reels\|scene_add_module\|emitSceneAddModule\|derive_reels_config" studio runtime --include=*.py --include=*.ts --include=*.tsx`
Expected: no hits outside this plan/spec's docs.

- [ ] **Step 4: Full local verification** (this worktree = offset 2; export it for every command):

```bash
just bootstrap                      # if not yet run in this worktree
cd studio/backend && uv run pytest -m "not e2e" -q && cd ../..
cargo test --workspace              # should be untouched-green (no Rust changes)
node_modules/.bin/prettier --check .
npx nx run-many -t typecheck && npx nx run-many -t test && npx nx run-many -t build
# stack for e2e (three shells / background):
just backend-serve-replay           # :8002, RUNTIME_SERVER_URL -> :9302
just e2e                            # boots frontend :4202 + runtime server :9302
```

Expected: the rewritten `reels.spec.ts` passes along with `game-structure.spec.ts` and `game-scene.spec.ts`; run the full suite and compare failures against `main`'s baseline (the 3 port-hardcoded game-plugin unit tests are the only known offset≠0 pre-existing reds — unit, not e2e).

- [ ] **Step 5: Commit**

```bash
git add justfile AGENTS.md studio/frontend/e2e/reels.spec.ts
git commit -m "test(e2e): structure-driven scene + composed spin contract; wire e2e runtime server URL"
```

---

## Self-Review (performed while writing)

- **Spec coverage:** §1 sync → Tasks 1–2; §2 button removal → Tasks 6, 8, 10; §3 auto-build → Task 3 (+9 for the status seam); §4 runtime-server spin → Tasks 5–8; §5 legacy loop-safe spin → Task 4; §6 playback unification → Task 7; testing section → every task + Task 10. Out-of-scope items untouched.
- **Type consistency:** `register_scene_handlers(sio, hub, broker, model_store, spin_runner, compose_store, composed_spin)` used identically in Tasks 6 and its tests; `scene_spin_trace` payload `{gameId, seed, outcome, trace}` matches `applySpinTrace` consumption (`payload.trace`); `game_build_status` payload matches `IBuildStatusEvent`; `trace` protocol message `entries` field used by bridge (`entries`), host, and walker.
- **Known judgment calls (not placeholders):** two spec files instruct "mirror the existing fixture/mocking style" for test scaffolding (`test_compose_store.py`, `actions.spec.ts`) because the fixtures already exist in those files; Task 10 flags two engine conventions to verify against source before finalizing the spec assertions.
