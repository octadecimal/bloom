# Reels in the Game — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer add a reels module to a game in the studio, see it render immediately as a grid of color-coded labeled rectangles, and Spin to land on an outcome computed by the server's trusted math kernel from the game's `SlotModel`.

**Architecture:** The `modules: [{id,type,config}]` declaration is persisted on the scene document (server-authoritative); the runtime reads it on `init`, instantiates the module from the registry via a new `ModuleManager`, and **projects the reel cells locally** (idempotent). A studio "Add Reels" button writes the declaration; a "Spin" button asks the backend to evaluate one round (a new Rust `spin_json` binary over the kernel's `evaluate()`), which broadcasts the landed grid; the runtime drives the existing #103 settle animation onto it.

**Tech Stack:** Rust (`bloom-math`, `bloom-simulator`), Python (FastAPI + python-socketio + Motor/Mongo, pytest), TypeScript (Pixi.js runtime client, React studio frontend, Vitest, Playwright).

## Global Constraints

- **Commits:** Conventional Commits, imperative mood (`feat(reels): ...`, `test(reels): ...`). One commit per task step group as indicated.
- **TypeScript interfaces use an `I` prefix** (`IModuleDecl`, `IModuleManager`). (`docs/coding-standards.md`.)
- **TDD is mandatory:** write the failing test, run it red, implement minimally, run it green, commit.
- **Ports follow `BLOOM_PORT_OFFSET`.** This worktree is offset **1** → backend `8001`, studio `4201`, runtime `4301`. Never hardcode `localhost` in browser-facing URLs.
- **Browser e2e (Playwright) is NEVER in CI** — run locally (`just e2e` against a replay backend on the offset port). Unit + non-browser (pytest, Rust) suites are CI-affordable.
- **Studio UI follows `docs/design-language.md`** — no raw colors in components; use the existing token classes (`bg-surface`, `text-text-2`, etc.). Reel-cell *fill* colors are runtime-canvas (Pixi), not studio DOM, so the design-language color guard does not apply to them.
- **Frontend gates before any push:** `node_modules/.bin/prettier --check .`, `nx typecheck`, `nx test`, `nx build`. Vitest passing ≠ types valid — run all four.
- **Symbol grid orientation is fixed:** the kernel returns `base_grid[reel][row]`; the reels module consumes `grid[col][row]` with `col == reel`. No transpose anywhere.

---

## File structure

**Rust (new):**
- `studio/simulator/src/bin/spin_json.rs` — single-round `evaluate()` → one JSON line.

**Backend (modify):**
- `studio/backend/app/scene/document.py` — `empty_document()` carries `modules`.
- `studio/backend/app/scene/store.py` — persist + preserve `modules`; `set_modules()`.
- `studio/backend/app/scene/hub.py` — `set_modules()` (persist + broadcast snapshot).
- `studio/backend/app/scene/reels_spin.py` (new) — `DEMO_SLOT_MODEL`, `derive_reels_config()`, `map_grid()`, `SubprocessSpinRunner`, `FakeSpinRunner`, `build_spin_runner()`.
- `studio/backend/app/scene/sockets.py` — `scene_add_module`, `scene_spin` handlers.
- `studio/backend/app/main.py` — pass `sim_store` + a spin runner into `register_scene_handlers`.

**Runtime client (modify/new):**
- `runtime/client/src/model/document.ts` — `IModuleDecl`, `IGameDocument.modules?`.
- `runtime/client/src/protocol/protocolHost.ts` — `onModules` callback on `init`.
- `runtime/client/src/modules/moduleManager.ts` (new) — declaration-driven instantiate/project/mount.
- `runtime/client/src/orchestration/orchestrator.ts` — resolve the reels control lazily.
- `runtime/client/src/engine.ts` — wire registry + manager + orchestrator.
- `runtime/client/src/main.ts` — standalone seed; `__engineModules` via the manager.
- `runtime/client/src/modules/reels/symbolColor.ts` (new) — `colorForSymbol()`.
- `runtime/client/src/modules/reels/reelsModule.ts` — emit `fill`/`size`/`label`; land colors on settle.
- `runtime/client/src/render/pixiRenderer.ts` — rectangle fill/size + label child.

**Studio frontend (modify):**
- `studio/frontend/src/scene/types.ts` — `IModuleDecl`, `ISceneDocument.modules?`.
- `studio/frontend/src/scene/reducers.ts` — `loadDocument` preserves `modules`.
- `studio/frontend/src/plugins/game/protocolBridge.ts` — `spin()` + `spin` message.
- `studio/frontend/src/plugins/game/socketClient.ts` — handle `scene_spin_outcome`; emit add/spin.
- `studio/frontend/src/plugins/game/GamePreviewPane.tsx` — Add Reels + Spin buttons.

**e2e (new):**
- `studio/frontend/e2e/reels.spec.ts` — authoritative add → grid → spin → landed-outcome.

---

## Task 1: Rust `spin_json` — single-round evaluate → JSON

**Files:**
- Create: `studio/simulator/src/bin/spin_json.rs`

**Interfaces:**
- Produces (CLI): `spin_json <model.json> <seed>` prints one JSON line `{"grid": number[][], "basePayout": number, "totalPayout": number}` where `grid[reel][row]` is the symbol id. Exit 2 on bad input.
- Produces (testable fn): `spin_result_json(model: &SlotModel, seed: u64) -> String`.

Bins under `studio/simulator/src/bin/*.rs` are auto-discovered by Cargo (no `[[bin]]` entry needed — mirrors `curate_json.rs`).

- [ ] **Step 1: Write the failing test + skeleton**

Create `studio/simulator/src/bin/spin_json.rs`:

```rust
//! Single-round spin: evaluate one round of a SlotModel at a seed and emit the
//! base grid (+ payouts) as one JSON line on stdout. Deterministic.
//! Usage: spin_json <model.json> <seed>

use bloom_math::mechanics::slots::{evaluate, SlotModel};
use serde_json::json;
use std::fs;

fn spin_result_json(model: &SlotModel, seed: u64) -> String {
    let out = evaluate(model, seed);
    json!({
        "grid": out.base_grid,
        "basePayout": out.base_payout,
        "totalPayout": out.total_payout,
    })
    .to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: spin_json <model.json> <seed>");
        std::process::exit(2);
    }
    let model: SlotModel = match fs::read_to_string(&args[1])
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(m) => m,
        Err(e) => {
            eprintln!("bad model json: {e}");
            std::process::exit(2);
        }
    };
    let seed: u64 = match args[2].parse() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("bad seed: {e}");
            std::process::exit(2);
        }
    };
    println!("{}", spin_result_json(&model, seed));
}

#[cfg(test)]
mod tests {
    use super::*;
    use bloom_math::mechanics::slots::{Paytable, SymbolDef, SymbolRole};

    fn tiny_model() -> SlotModel {
        // 3 reels, each strip [0], 3 rows -> every cell is symbol 0, deterministic.
        SlotModel {
            symbols: vec![SymbolDef { id: 0, role: SymbolRole::Normal }],
            reels: vec![vec![0], vec![0], vec![0]],
            rows: 3,
            paylines: vec![],
            paytable: Paytable { entries: vec![] },
            bonuses: vec![],
        }
    }

    #[test]
    fn grid_is_reel_by_row_shaped() {
        let v: serde_json::Value =
            serde_json::from_str(&spin_result_json(&tiny_model(), 42)).unwrap();
        let grid = v["grid"].as_array().unwrap();
        assert_eq!(grid.len(), 3); // 3 reels (cols)
        for col in grid {
            assert_eq!(col.as_array().unwrap().len(), 3); // 3 rows
        }
    }

    #[test]
    fn all_zero_strip_is_golden() {
        let v: serde_json::Value =
            serde_json::from_str(&spin_result_json(&tiny_model(), 7)).unwrap();
        assert_eq!(v["grid"], json!([[0, 0, 0], [0, 0, 0], [0, 0, 0]]));
        assert_eq!(v["basePayout"], 0);
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(spin_result_json(&tiny_model(), 123), spin_result_json(&tiny_model(), 123));
    }
}
```

- [ ] **Step 2: Run the tests — expect RED then GREEN**

Run: `cargo test -p bloom-simulator --bin spin_json`
Expected: compiles and all three tests PASS. (If any `slots` name fails to import, it is re-exported at `bloom_math::mechanics::slots::` — verify the path.)

- [ ] **Step 3: Smoke-run the binary**

```bash
echo '{"symbols":[{"id":0,"role":"normal"}],"reels":[[0],[0],[0]],"rows":3,"paylines":[],"paytable":{"entries":[]},"bonuses":[]}' > /tmp/m.json
cargo run -q -p bloom-simulator --bin spin_json -- /tmp/m.json 7
```
Expected: `{"basePayout":0,"grid":[[0,0,0],[0,0,0],[0,0,0]],"totalPayout":0}`

- [ ] **Step 4: Commit**

```bash
git add studio/simulator/src/bin/spin_json.rs
git commit -m "feat(reels): single-round spin_json kernel binary"
```

---

## Task 2: Backend — persist `modules` on the scene document

**Files:**
- Modify: `studio/backend/app/scene/document.py`
- Modify: `studio/backend/app/scene/store.py`
- Modify: `studio/backend/app/scene/hub.py`
- Test: `studio/backend/tests/test_scene_modules.py` (new)

**Interfaces:**
- Produces: `empty_document()` returns `{"version":1,"nodes":{},"edges":[],"modules":[]}`.
- Produces: `GameSceneStore.set_modules(game_id, modules: list[dict]) -> dict` — persists and returns the full document with `modules` set.
- Produces: `GameSceneStore.apply_op` / `apply_batch` preserve the existing `modules` (node/edge ops never wipe them).
- Produces: `GameSceneHub.set_modules(game_id, modules) -> dict` — persists then `emit("scene_snapshot", {"gameId", "document"}, room=game_id)`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_scene_modules.py`:

```python
import pytest
from app.scene.document import empty_document
from app.scene.store import GameSceneStore


def test_empty_document_has_modules_list():
    assert empty_document()["modules"] == []


@pytest.mark.asyncio
async def test_set_modules_persists_and_survives_node_ops(mongo_db):
    store = GameSceneStore(mongo_db)
    decl = [{"id": "reels", "type": "reels", "config": {"cols": 3, "rows": 3}}]
    await store.set_modules("g1", decl)

    # A subsequent node op must NOT wipe the modules declaration.
    await store.apply_op("g1", {"kind": "addNode", "id": "root", "type": "Root", "props": {}})
    doc = await store.get_document("g1")
    assert doc["modules"] == decl
    assert "root" in doc["nodes"]
```

> `mongo_db` is the existing async Mongo fixture used by `test_scene_*` suites. If the
> fixture name differs in `conftest.py`, use that name — do not invent a new fixture.

- [ ] **Step 2: Run it — expect RED**

Run: `cd studio/backend && uv run pytest tests/test_scene_modules.py -q`
Expected: FAIL (`KeyError: 'modules'` / missing `set_modules`).

- [ ] **Step 3: Implement**

In `studio/backend/app/scene/document.py`, change `empty_document`:

```python
def empty_document() -> dict:
    return {"version": 1, "nodes": {}, "edges": [], "modules": []}
```

In `studio/backend/app/scene/store.py`, update `_to_mongo`, `_from_mongo`, and the appliers to carry `modules`:

```python
def _to_mongo(game_id: str, document: dict) -> dict:
    return {
        "_id": game_id,
        "version": document["version"],
        "nodes": list(document["nodes"].values()),
        "edges": document["edges"],
        "modules": document.get("modules", []),
    }


def _from_mongo(raw: dict) -> dict:
    return {
        "version": raw["version"],
        "nodes": {n["id"]: n for n in raw["nodes"]},
        "edges": raw["edges"],
        "modules": raw.get("modules", []),
    }
```

Then make the appliers preserve `modules` and add `set_modules`:

```python
    async def apply_op(self, game_id: str, op: dict) -> dict:
        current = await self.get_or_create(game_id)
        model = GraphModel()
        model.load(current)
        model.apply(op)  # raises OpError; nothing persisted
        doc = model.to_document()
        doc["modules"] = current.get("modules", [])
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc

    async def apply_batch(self, game_id: str, ops: list[dict]) -> dict:
        current = await self.get_or_create(game_id)
        model = GraphModel()
        model.load(current)
        model.apply_batch(ops)  # raises OpError, transactional
        doc = model.to_document()
        doc["modules"] = current.get("modules", [])
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc

    async def set_modules(self, game_id: str, modules: list[dict]) -> dict:
        doc = await self.get_or_create(game_id)
        doc["modules"] = modules
        await self._scenes.replace_one({"_id": game_id}, _to_mongo(game_id, doc), upsert=True)
        return doc
```

> Note: `model.to_document()` (Python `GraphModel`) emits only `version/nodes/edges`, so `modules`
> is re-attached from `current` after every node/edge mutation.

In `studio/backend/app/scene/hub.py`, add to `GameSceneHub`:

```python
    async def set_modules(self, game_id: str, modules: list[dict]) -> dict:
        async with self._lock(game_id):
            doc = await self._store.set_modules(game_id, modules)
        await self._sio.emit("scene_snapshot", {"gameId": game_id, "document": doc}, room=game_id)
        return doc
```

- [ ] **Step 4: Run it — expect GREEN**

Run: `cd studio/backend && uv run pytest tests/test_scene_modules.py -q`
Expected: PASS.

- [ ] **Step 5: Guard against regressions in the existing scene suites**

Run: `cd studio/backend && uv run pytest tests/test_scene_hub.py tests/test_scene_apply_op_handler.py -q`
Expected: PASS (the `modules` key is additive).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/document.py studio/backend/app/scene/store.py studio/backend/app/scene/hub.py studio/backend/tests/test_scene_modules.py
git commit -m "feat(reels): persist modules declaration on the scene document"
```

---

## Task 3: Backend — demo model, config derivation, symbol mapping, spin runner

**Files:**
- Create: `studio/backend/app/scene/reels_spin.py`
- Test: `studio/backend/tests/test_reels_spin.py` (new)

**Interfaces:**
- Produces: `DEMO_SLOT_MODEL: dict` — a valid `slots@1` model (3 reels × 3 rows, symbols `0,1,2,9`).
- Produces: `derive_reels_config(model: dict) -> dict` → `{"cols","rows","symbols","parentId":"root"}`.
- Produces: `map_grid(numeric_grid: list[list[int]]) -> list[list[str]]` — ids → strings, no transpose.
- Produces: `class SubprocessSpinRunner` with `async def run(self, model: dict, seed: int) -> dict` returning `{"grid": list[list[int]], "basePayout": int, "totalPayout": int}`.
- Produces: `class FakeSpinRunner` (constructed with a fixed result dict) for tests/handlers.
- Produces: `build_spin_runner(settings) -> SpinRunner`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_reels_spin.py`:

```python
import pytest
from app.scene.reels_spin import (
    DEMO_SLOT_MODEL, derive_reels_config, map_grid, FakeSpinRunner,
)


def test_demo_model_shape():
    assert len(DEMO_SLOT_MODEL["reels"]) == 3
    assert DEMO_SLOT_MODEL["rows"] == 3
    assert {s["id"] for s in DEMO_SLOT_MODEL["symbols"]} == {0, 1, 2, 9}


def test_derive_config_from_model():
    cfg = derive_reels_config(DEMO_SLOT_MODEL)
    assert cfg == {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}


def test_derive_config_falls_back_on_empty_model():
    cfg = derive_reels_config({})
    assert cfg["cols"] == 5 and cfg["rows"] == 3 and cfg["parentId"] == "root"
    assert cfg["symbols"] == ["0", "1", "2", "3", "4"]


def test_map_grid_ids_to_strings_without_transpose():
    assert map_grid([[0, 1, 2], [9, 0, 1]]) == [["0", "1", "2"], ["9", "0", "1"]]


@pytest.mark.asyncio
async def test_fake_runner_returns_its_result():
    runner = FakeSpinRunner(result={"grid": [[0, 0, 0]], "basePayout": 0, "totalPayout": 0})
    out = await runner.run(DEMO_SLOT_MODEL, 7)
    assert out["grid"] == [[0, 0, 0]]
```

- [ ] **Step 2: Run it — expect RED**

Run: `cd studio/backend && uv run pytest tests/test_reels_spin.py -q`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement**

Create `studio/backend/app/scene/reels_spin.py`:

```python
"""Server-side reels round: pick a model, evaluate one round via the trusted
kernel binary `spin_json`, and shape it for the runtime reels module.

The declaration's grid shape and the round's grid shape both derive from the
same SlotModel, so the outcome always fills the projected grid."""
import asyncio
import json
import shutil
import tempfile
from pathlib import Path
from typing import Protocol
from app.subprocess_guard import watch_proc_tree

# A valid slots@1 model used when a game has no realized SlotModel yet, so the
# feature is demoable before a GDD->realize/tune cycle. 3 reels x 3 rows.
DEMO_SLOT_MODEL: dict = {
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
    ],
    "rows": 3,
    "paylines": [[0, 0, 0], [1, 1, 1], [2, 2, 2]],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 5},
        {"symbol": 1, "count": 3, "payout": 3},
        {"symbol": 2, "count": 3, "payout": 2},
    ]},
    "bonuses": [],
}

# Repo root = .../app/scene/reels_spin.py -> parents[4].
_REPO_ROOT = Path(__file__).resolve().parents[4]


def derive_reels_config(model: dict) -> dict:
    reels = model.get("reels") or []
    cols = len(reels) if reels else 5
    rows = int(model.get("rows") or 3)
    symbols = [str(s["id"]) for s in (model.get("symbols") or [])]
    if not symbols:
        symbols = [str(i) for i in range(5)]
    return {"cols": cols, "rows": rows, "symbols": symbols, "parentId": "root"}


def map_grid(numeric_grid: list[list[int]]) -> list[list[str]]:
    return [[str(s) for s in col] for col in numeric_grid]


class SpinRunner(Protocol):
    async def run(self, model: dict, seed: int) -> dict: ...


class SubprocessSpinRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "spin_bin", "") or ""
        self._mem_cap_mb = float(getattr(settings, "curation_mem_cap_mb", 1024.0) or 1024.0)
        self._timeout_s = float(getattr(settings, "curation_timeout_s", 120.0) or 120.0)

    def _command(self, model_path: str, seed: int) -> list[str]:
        if self._bin:
            return [self._bin, model_path, str(seed)]
        return ["cargo", "run", "--release", "-p", "bloom-simulator",
                "--bin", "spin_json", "--", model_path, str(seed)]

    async def run(self, model: dict, seed: int) -> dict:
        tmp = Path(tempfile.mkdtemp(prefix="bloom-spin-"))
        try:
            model_path = str(tmp / "model.json")
            Path(model_path).write_text(json.dumps(model))
            proc = await asyncio.create_subprocess_exec(
                *self._command(model_path, seed),
                cwd=str(_REPO_ROOT),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            result: dict | None = None
            done = asyncio.Event()

            async def _drain() -> None:
                nonlocal result
                assert proc.stdout is not None
                async for raw in proc.stdout:
                    line = raw.decode().strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if "grid" in obj:
                        result = obj
                done.set()

            async def _watchdog() -> None:
                await watch_proc_tree(proc, done, label="spin",
                                      mem_cap_mb=self._mem_cap_mb,
                                      timeout_s=self._timeout_s, poll_s=0.1)

            assert proc.stderr is not None
            _, stderr_bytes, _ = await asyncio.gather(_drain(), proc.stderr.read(), _watchdog())
            await proc.wait()
            if result is None:
                raise RuntimeError(
                    f"spin produced no result (exit {proc.returncode}): {stderr_bytes.decode()[:300]}")
            return result
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class FakeSpinRunner:
    def __init__(self, *, result: dict):
        self._result = result

    async def run(self, model: dict, seed: int) -> dict:
        return self._result


def build_spin_runner(settings) -> SpinRunner:
    return SubprocessSpinRunner(settings)
```

> Verify `_REPO_ROOT` resolves to the repo root on first run (mirror the `parents[4]`
> reasoning in `app/simulator/runner.py`). `watch_proc_tree` is the same guard the curation
> runner uses — import path `app.subprocess_guard`.

- [ ] **Step 4: Run it — expect GREEN**

Run: `cd studio/backend && uv run pytest tests/test_reels_spin.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/reels_spin.py studio/backend/tests/test_reels_spin.py
git commit -m "feat(reels): demo model, config derivation, and spin runner"
```

---

## Task 4: Backend — `scene_add_module` + `scene_spin` socket handlers

**Files:**
- Modify: `studio/backend/app/scene/sockets.py`
- Modify: `studio/backend/app/main.py:150`
- Test: `studio/backend/tests/test_reels_sockets.py` (new)

**Interfaces:**
- Consumes: `GameSceneHub.set_modules`, `GameSceneHub.ensure_root` (Task 2 + existing), `SlotModelStore.get` (existing), `reels_spin.*` (Task 3).
- Produces (wire): client emits `scene_add_module {gameId, type?}` → server ensures a root, derives config, sets the `modules` declaration (broadcasts a snapshot). Client emits `scene_spin {gameId, seed?}` → server evaluates one round → emits `scene_spin_outcome {gameId, outcome: {grid: string[][]}}` to the room.
- Produces (signature): `register_scene_handlers(sio, hub, broker, model_store, spin_runner)`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_reels_sockets.py`:

```python
import pytest
from app.scene.reels_spin import DEMO_SLOT_MODEL, FakeSpinRunner
from app.scene.sockets import register_scene_handlers


class FakeSio:
    def __init__(self):
        self.handlers = {}
        self.emitted = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    def event(self, fn):
        self.handlers[fn.__name__] = fn
        return fn

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room or to))

    async def enter_room(self, sid, room):
        pass


class FakeHub:
    def __init__(self):
        self.modules = None

    async def ensure_root(self, game_id, canvas):
        return {"root_id": "root", "canvas": canvas}

    async def set_modules(self, game_id, modules):
        self.modules = modules
        return {"version": 1, "nodes": {}, "edges": [], "modules": modules}


class FakeModelStore:
    def __init__(self, model):
        self._model = model

    async def get(self, game_id):
        from types import SimpleNamespace
        return None if self._model is None else SimpleNamespace(model=self._model)


@pytest.mark.asyncio
async def test_add_module_with_no_realized_model_derives_from_the_demo_model():
    # No per-game SlotModel yet -> the handler falls back to DEMO_SLOT_MODEL
    # (3 reels x 3 rows, symbols 0,1,2,9) and derives the declaration from it.
    sio, hub = FakeSio(), FakeHub()
    register_scene_handlers(sio, hub, None, FakeModelStore(None),
                            FakeSpinRunner(result={"grid": [[0]], "basePayout": 0, "totalPayout": 0}))
    await sio.handlers["scene_add_module"]("sid", {"gameId": "g1"})
    assert hub.modules == [{"id": "reels", "type": "reels",
                            "config": {"cols": 3, "rows": 3,
                                       "symbols": ["0", "1", "2", "9"], "parentId": "root"}}]


@pytest.mark.asyncio
async def test_spin_maps_kernel_grid_to_string_outcome():
    sio, hub = FakeSio(), FakeHub()
    runner = FakeSpinRunner(result={"grid": [[0, 1, 2], [9, 0, 1], [2, 2, 2]],
                                    "basePayout": 0, "totalPayout": 0})
    register_scene_handlers(sio, hub, None, FakeModelStore(DEMO_SLOT_MODEL), runner)
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1", "seed": 42})
    event, data, room = sio.emitted[-1]
    assert event == "scene_spin_outcome"
    assert room == "g1"
    assert data["outcome"]["grid"] == [["0", "1", "2"], ["9", "0", "1"], ["2", "2", "2"]]
```

- [ ] **Step 2: Run it — expect RED**

Run: `cd studio/backend && uv run pytest tests/test_reels_sockets.py -q`
Expected: FAIL (`register_scene_handlers` takes 3 args; no `scene_add_module`).

- [ ] **Step 3: Implement the handlers**

In `studio/backend/app/scene/sockets.py`, change the signature and append two handlers. Full new file body:

```python
import secrets
from app.scene.document import OpError
from app.scene.reels_spin import DEMO_SLOT_MODEL, derive_reels_config, map_grid

# Default canvas used when a game has no Root yet (idempotent: ensure_root keeps
# an existing Root's canvas).
_DEFAULT_CANVAS = (1080, 1920)


def register_scene_handlers(sio, hub, broker, model_store, spin_runner):
    @sio.on("join_scene")
    async def join_scene(sid, data):
        await hub.attach(data["gameId"], sid)

    @sio.on("leave_scene")
    async def leave_scene(sid, data):
        await sio.leave_room(sid, data["gameId"])

    @sio.on("scene_apply_op")
    async def scene_apply_op(sid, data):
        game_id = data.get("gameId")
        op = data.get("op") or {}
        if op.get("kind") != "setProp":
            await sio.emit("scene_op_rejected",
                           {"gameId": game_id, "code": "forbidden_kind", "op": op}, to=sid)
            return
        if any(k not in op for k in ("id", "path", "value")):
            await sio.emit("scene_op_rejected",
                           {"gameId": game_id, "code": "bad_op", "op": op}, to=sid)
            return
        try:
            await hub.apply_op(game_id, op)
        except OpError as e:
            await sio.emit("scene_op_rejected",
                           {"gameId": game_id, "code": e.code, "op": op}, to=sid)

    @sio.on("scene_capture_result")
    async def scene_capture_result(sid, data):
        png = data.get("png")
        if broker is not None and png:
            broker.resolve_capture(data.get("captureId"), png)

    async def _model_for(game_id: str) -> dict:
        doc = await model_store.get(game_id)
        model = doc.model if doc is not None else None
        return model if model else DEMO_SLOT_MODEL

    @sio.on("scene_add_module")
    async def scene_add_module(sid, data):
        game_id = data.get("gameId")
        mtype = data.get("type", "reels")
        await hub.ensure_root(game_id, _DEFAULT_CANVAS)
        config = derive_reels_config(await _model_for(game_id))
        await hub.set_modules(game_id, [{"id": "reels", "type": mtype, "config": config}])

    @sio.on("scene_spin")
    async def scene_spin(sid, data):
        game_id = data.get("gameId")
        seed = data.get("seed")
        if seed is None:
            seed = secrets.randbelow(2 ** 63)
        result = await spin_runner.run(await _model_for(game_id), int(seed))
        grid = map_grid(result["grid"])
        await sio.emit("scene_spin_outcome",
                       {"gameId": game_id, "outcome": {"grid": grid}}, room=game_id)
```

In `studio/backend/app/main.py`, update the wiring. Change line 150 from:

```python
    register_scene_handlers(sio, scene_hub, capture_broker)
```

to:

```python
    spin_runner = build_spin_runner(settings)
    register_scene_handlers(sio, scene_hub, capture_broker, sim_store, spin_runner)
```

and add the import near the other scene imports (top of `main.py`):

```python
from app.scene.reels_spin import build_spin_runner
```

(`sim_store = SlotModelStore(...)` already exists at `main.py:102`.)

- [ ] **Step 4: Run it — expect GREEN**

Run: `cd studio/backend && uv run pytest tests/test_reels_sockets.py -q`
Expected: PASS.

- [ ] **Step 5: Confirm app boots (wiring is valid)**

Run: `cd studio/backend && uv run python -c "import app.main"`
Expected: no ImportError / no exception.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/sockets.py studio/backend/app/main.py studio/backend/tests/test_reels_sockets.py
git commit -m "feat(reels): scene_add_module + scene_spin socket handlers"
```

---

## Task 5: Runtime — declaration-driven `ModuleManager` + engine refactor

**Files:**
- Modify: `runtime/client/src/model/document.ts`
- Modify: `runtime/client/src/protocol/protocolHost.ts`
- Create: `runtime/client/src/modules/moduleManager.ts`
- Modify: `runtime/client/src/orchestration/orchestrator.ts`
- Modify: `runtime/client/src/engine.ts`
- Modify: `runtime/client/src/main.ts`
- Modify: `runtime/client/src/engine.modules.spec.ts`
- Test: `runtime/client/src/modules/moduleManager.spec.ts` (new)

**Interfaces:**
- Produces: `interface IModuleDecl { id: string; type: string; config?: Record<string, JsonValue>; }` and `IGameDocument.modules?: IModuleDecl[]`.
- Produces: `ProtocolHost` deps gain `onModules?: (decls: IModuleDecl[]) => void`, invoked during `init` with `document.modules ?? []`.
- Produces: `class ModuleManager` with `sync(decls: IModuleDecl[]): void` and `byType(type: string): IGameModule | undefined`.
- Produces: `Orchestrator` constructor takes `{ bus; reels: () => IReelsControl | null }`; `spin` no-ops if the resolver returns null.
- Produces: `createEngine` returns `{ host, model, modules: { registry, manager, orchestrator, bus }, viewport? }`.

- [ ] **Step 1: Write the failing ModuleManager test**

Create `runtime/client/src/modules/moduleManager.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MockRenderer } from '../render/mockRenderer';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from '../render/reconciler';
import { createBus } from '../orchestration/bus';
import { createModuleHost } from './host';
import { ModuleRegistry } from './registry';
import { ModuleManager } from './moduleManager';
import { ReelsModule } from './reels/reelsModule';

function setup() {
  const model = new GraphModel();
  model.apply({ kind: 'addNode', id: 'root', type: 'Root', props: {} });
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const host = createModuleHost({ model, reconciler, renderer, bus: createBus() });
  const registry = new ModuleRegistry();
  registry.register('reels', (args) => new ReelsModule(args));
  return { model, registry, host };
}

describe('ModuleManager', () => {
  it('instantiates + projects a declared reels module', () => {
    const { model, registry, host } = setup();
    const manager = new ModuleManager({ registry, host });
    manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root', cols: 3, rows: 3 } }]);
    expect(manager.byType('reels')).toBeTruthy();
    expect(model.getNode('reels:reel:0')).toBeTruthy();
    expect(model.getNode('reels:cell:0:0')).toBeTruthy();
  });

  it('ignores unknown module types', () => {
    const { registry, host } = setup();
    const manager = new ModuleManager({ registry, host });
    manager.sync([{ id: 'x', type: 'nope' }]);
    expect(manager.byType('nope')).toBeUndefined();
  });

  it('re-syncing disposes the old set before rebuilding', () => {
    const { registry, host } = setup();
    const manager = new ModuleManager({ registry, host });
    manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root' } }]);
    const first = manager.byType('reels');
    manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root' } }]);
    expect(manager.byType('reels')).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run it — expect RED**

Run: `cd runtime/client && npx vitest run src/modules/moduleManager.spec.ts`
Expected: FAIL (no `moduleManager` module).

- [ ] **Step 3: Add the document type**

In `runtime/client/src/model/document.ts`, after `IEdge` add:

```typescript
export interface IModuleDecl {
  id: string;
  type: string;
  config?: Record<string, JsonValue>;
}
```

and extend `IGameDocument`:

```typescript
export interface IGameDocument {
  version: number;
  nodes: Record<string, INode>;
  edges: IEdge[];
  modules?: IModuleDecl[];
}
```

- [ ] **Step 4: Implement ModuleManager**

Create `runtime/client/src/modules/moduleManager.ts`:

```typescript
import type { IGameModule, IModuleHost } from './module';
import type { ModuleRegistry } from './registry';
import type { IModuleDecl } from '../model/document';

/** Owns the live module instances declared on the scene document. On sync it
 *  disposes the previous set and rebuilds from the declarations, projecting +
 *  mounting each — the structure plane is a deterministic function of the
 *  declaration (cells are derived client-side, never round-tripped upstream). */
export class ModuleManager {
  private modules = new Map<string, IGameModule>();

  constructor(private readonly deps: { registry: ModuleRegistry; host: IModuleHost }) {}

  sync(decls: IModuleDecl[]): void {
    for (const m of this.modules.values()) m.dispose();
    this.modules.clear();
    for (const d of decls) {
      if (!this.deps.registry.has(d.type)) continue;
      const m = this.deps.registry.create(d.type, { id: d.id, host: this.deps.host, config: d.config });
      this.modules.set(d.id, m);
      m.project();
      m.mount();
    }
  }

  byType(type: string): IGameModule | undefined {
    for (const m of this.modules.values()) if (m.type === type) return m;
    return undefined;
  }
}
```

- [ ] **Step 5: Run the ModuleManager test — expect GREEN**

Run: `cd runtime/client && npx vitest run src/modules/moduleManager.spec.ts`
Expected: PASS.

- [ ] **Step 6: Rework the Orchestrator to resolve reels lazily**

Replace `runtime/client/src/orchestration/orchestrator.ts` body:

```typescript
import type { IEventBus } from './bus';
import type { IOutcome } from '../modules/module';

/** The slice of a module the orchestrator drives (modules talk via the bus otherwise). */
export interface IReelsControl {
  project(): void;
  startSpinning(): void;
  stopSpinning(outcome: IOutcome): void;
}

/** Owns round sequencing in one inspectable place (spec §5). The reels control
 *  is resolved lazily because modules are instantiated on `init`, after the
 *  engine (and orchestrator) are built. */
export class Orchestrator {
  private off: () => void;

  constructor(private readonly deps: { bus: IEventBus; reels: () => IReelsControl | null }) {
    this.off = deps.bus.on<{ grid: string[][] }>('reels:settled', (payload) => {
      deps.bus.emit('round:complete', payload);
    });
  }

  spin(outcome: IOutcome): void {
    const reels = this.deps.reels();
    if (!reels) return;
    reels.project(); // idempotent — ensures structure exists
    reels.startSpinning();
    reels.stopSpinning(outcome);
  }

  dispose(): void {
    this.off();
  }
}
```

- [ ] **Step 7: Add `onModules` to ProtocolHost**

In `runtime/client/src/protocol/protocolHost.ts`, extend deps and the `init` branch. Add to `IProtocolDeps`:

```typescript
  onModules?: (decls: import('../model/document').IModuleDecl[]) => void;
```

and in `handle`, replace the `init` branch:

```typescript
      if (msg.kind === 'init') {
        const document = msg.document ?? emptyDocument();
        const changes = this.deps.model.load(document);
        await this.deps.reconciler.applyChanges(changes);
        this.deps.onModules?.(document.modules ?? []);
      } else if (msg.kind === 'op') {
```

- [ ] **Step 8: Rewire the engine**

Replace `runtime/client/src/engine.ts`:

```typescript
import { GraphModel } from './model/graphModel';
import { Reconciler } from './render/reconciler';
import type { IRenderer } from './render/renderer';
import { ProtocolHost } from './protocol/protocolHost';
import type { OutboundMessage } from './protocol/messages';
import { createBus, type IEventBus } from './orchestration/bus';
import { createModuleHost } from './modules/host';
import { ModuleRegistry } from './modules/registry';
import { ModuleManager } from './modules/moduleManager';
import { Orchestrator, type IReelsControl } from './orchestration/orchestrator';
import { ReelsModule } from './modules/reels/reelsModule';
import { ViewportController, type IHostSurface } from './render/viewportController';

export interface IEngineModules {
  registry: ModuleRegistry;
  manager: ModuleManager;
  orchestrator: Orchestrator;
  bus: IEventBus;
}

export function createEngine(deps: { renderer: IRenderer; post: (m: OutboundMessage) => void; surface?: IHostSurface }): {
  host: ProtocolHost;
  model: GraphModel;
  modules: IEngineModules;
  viewport?: ViewportController;
} {
  const model = new GraphModel();
  const bus = createBus();
  const viewport = deps.surface ? new ViewportController({ surface: deps.surface, renderer: deps.renderer, bus }) : undefined;
  const reconciler = new Reconciler(deps.renderer, model, viewport);
  const moduleHost = createModuleHost({ model, reconciler, renderer: deps.renderer, bus });

  const registry = new ModuleRegistry();
  registry.register('reels', (args) => new ReelsModule(args));
  const manager = new ModuleManager({ registry, host: moduleHost });

  const orchestrator = new Orchestrator({
    bus,
    reels: () => (manager.byType('reels') as unknown as IReelsControl) ?? null,
  });
  const host = new ProtocolHost({
    model,
    reconciler,
    post: deps.post,
    onSpin: (o) => orchestrator.spin(o),
    onModules: (decls) => manager.sync(decls),
  });

  return { host, model, modules: { registry, manager, orchestrator, bus }, viewport };
}
```

- [ ] **Step 9: Update `main.ts` (standalone seed + `__engineModules` via the manager)**

In `runtime/client/src/main.ts`, after `const { host, model, modules, viewport } = createEngine(...)`, add a standalone seed and route the debug API through the manager. Replace the `__engineModules` block (lines ~31-42) with:

```typescript
import { ReelsModule } from './modules/reels/reelsModule';
// ...existing imports unchanged...

// Standalone (no studio parent) keeps a default reels module so the runtime is
// usable on its own; embedded studio mode instead instantiates from the
// document's `modules` declaration on init.
if (!expectedOrigin) {
  modules.manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root' } }]);
}

const reels = () => modules.manager.byType('reels') as ReelsModule | undefined;

const settledEvents: Array<{ grid: string[][] }> = [];
modules.bus.on<{ grid: string[][] }>('reels:settled', (e) => settledEvents.push(e));
(window as unknown as { __engineModules: unknown }).__engineModules = {
  spin: (outcome: { grid: string[][] }) => modules.orchestrator.spin(outcome),
  setConfig: (partial: Record<string, unknown>) => {
    const r = reels();
    if (r) {
      r.setConfig(partial as Record<string, never>);
      r.project();
    }
  },
  project: () => reels()?.project(),
  state: () => reels()?.debugState() ?? { phase: 'idle', grid: [] },
  settled: () => settledEvents,
};
```

(Keep the `import { ReelsModule }` at the top with the other imports; shown inline here for context.)

- [ ] **Step 10: Update `engine.modules.spec.ts` for the new shape**

Replace `runtime/client/src/engine.modules.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';

const DOC_WITH_REELS = {
  version: 1 as const,
  nodes: { root: { id: 'root', type: 'Root' as const, props: {} } },
  edges: [],
  modules: [{ id: 'reels', type: 'reels', config: { parentId: 'root' } }],
};

describe('createEngine modules wiring', () => {
  it('instantiates a declared reels module on init', async () => {
    const { host, modules } = createEngine({ renderer: new MockRenderer(), post: () => {} });
    await host.handle({ v: 1, kind: 'init', id: 'i', document: DOC_WITH_REELS });
    expect(modules.manager.byType('reels')?.type).toBe('reels');
    expect(modules.orchestrator).toBeTruthy();
  });

  it('a spin message drives the declared reels module to settle to the outcome grid', async () => {
    const renderer = new MockRenderer();
    const { host, modules } = createEngine({ renderer, post: () => {} });
    await host.handle({ v: 1, kind: 'init', id: 'i', document: DOC_WITH_REELS });
    await host.handle({ v: 1, kind: 'spin', id: 's', outcome: { grid: [['B'], ['C'], ['A'], ['B'], ['C']] } });
    for (let i = 0; i < 300; i++) renderer.tickCbs.forEach((cb) => cb(16));
    const reels = modules.manager.byType('reels')!;
    expect((reels as unknown as { debugState(): { phase: string } }).debugState().phase).toBe('idle');
    expect((reels as unknown as { debugState(): { grid: string[][] } }).debugState().grid[0]).toEqual(['B']);
  });
});
```

- [ ] **Step 11: Run the affected runtime unit tests — expect GREEN**

Run: `cd runtime/client && npx vitest run src/modules/moduleManager.spec.ts src/engine.modules.spec.ts src/orchestration/orchestrator.spec.ts src/protocol/protocolHost.spin.spec.ts`
Expected: PASS. (If `orchestrator.spec.ts` constructs `Orchestrator` with the old `reels` object, update it to pass `{ bus, reels: () => fakeControl }`.)

- [ ] **Step 12: Commit**

```bash
git add runtime/client/src/model/document.ts runtime/client/src/protocol/protocolHost.ts runtime/client/src/modules/moduleManager.ts runtime/client/src/modules/moduleManager.spec.ts runtime/client/src/orchestration/orchestrator.ts runtime/client/src/orchestration/orchestrator.spec.ts runtime/client/src/engine.ts runtime/client/src/main.ts runtime/client/src/engine.modules.spec.ts
git commit -m "feat(reels): declaration-driven ModuleManager + engine wiring"
```

---

## Task 6: Runtime — symbol colors, rectangle props, land colors on settle

**Files:**
- Create: `runtime/client/src/modules/reels/symbolColor.ts`
- Modify: `runtime/client/src/modules/reels/reelsModule.ts`
- Test: `runtime/client/src/modules/reels/symbolColor.spec.ts` (new)
- Modify: `runtime/client/src/modules/reels/reelsModule.project.spec.ts`
- Modify: `runtime/client/src/modules/reels/reelsModule.behavior.spec.ts`

**Interfaces:**
- Produces: `colorForSymbol(symbol: string): string` — pure, deterministic, returns a `#rrggbb` from a fixed palette.
- Produces: each reel cell node now carries props `fill: string`, `size: { width, height }`, `label: string` (in addition to `position`, `symbol`).
- Produces: on settle, `finishSettle` emits `setProp` `fill`/`label` ops for each visible cell so the landed grid shows the outcome symbols' colors/labels.

- [ ] **Step 1: Write the failing colorForSymbol test**

Create `runtime/client/src/modules/reels/symbolColor.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { colorForSymbol } from './symbolColor';

describe('colorForSymbol', () => {
  it('is deterministic', () => {
    expect(colorForSymbol('0')).toBe(colorForSymbol('0'));
  });
  it('returns a hex color', () => {
    expect(colorForSymbol('9')).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('distinguishes distinct symbols', () => {
    expect(colorForSymbol('0')).not.toBe(colorForSymbol('1'));
  });
});
```

- [ ] **Step 2: Run it — expect RED**

Run: `cd runtime/client && npx vitest run src/modules/reels/symbolColor.spec.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement colorForSymbol**

Create `runtime/client/src/modules/reels/symbolColor.ts`:

```typescript
// A fixed, high-contrast palette indexed by a stable string hash. Pure and
// deterministic so the same symbol always renders the same color (placeholder
// art: real symbol textures are a later slice).
const PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4',
];

export function colorForSymbol(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
```

- [ ] **Step 4: Run it — expect GREEN**

Run: `cd runtime/client && npx vitest run src/modules/reels/symbolColor.spec.ts`
Expected: PASS. (Symbols `'0'` and `'1'` map to different palette slots.)

- [ ] **Step 5: Write the failing projection + settle assertions**

In `runtime/client/src/modules/reels/reelsModule.project.spec.ts`, add a test asserting cell props (adapt to the file's existing `buildDesired` import/usage):

```typescript
import { colorForSymbol } from './symbolColor';

it('each cell carries fill, size and label for rectangle rendering', () => {
  const scene = buildDesired('reels', { cols: 1, rows: 1, symbols: ['7'], cellSize: 100, spacing: 0, buffer: 0, parentId: 'root' });
  const cell = scene.nodes.find((n) => n.id === 'reels:cell:0:0')!;
  expect(cell.props.fill).toBe(colorForSymbol('7'));
  expect(cell.props.size).toEqual({ width: 100, height: 100 });
  expect(cell.props.label).toBe('7');
});
```

In `runtime/client/src/modules/reels/reelsModule.behavior.spec.ts`, add a test that settling emits fill/label ops for the landed outcome. Use the file's existing fake host (it records `emit` ops); assert after the settle loop:

```typescript
it('lands the outcome symbols colors+labels via setProp on settle', () => {
  // ...drive a spin+settle to idle exactly as the existing settle test does...
  // outcome grid = [['9']] (1 col, 1 row)
  const fillOps = host.emitted.flat().filter((o: any) => o.kind === 'setProp' && o.path === 'fill');
  const labelOps = host.emitted.flat().filter((o: any) => o.kind === 'setProp' && o.path === 'label');
  expect(fillOps).toContainEqual({ kind: 'setProp', id: 'reels:cell:0:0', path: 'fill', value: colorForSymbol('9') });
  expect(labelOps).toContainEqual({ kind: 'setProp', id: 'reels:cell:0:0', path: 'label', value: '9' });
});
```

> Match the existing behavior spec's host/spin/settle setup (it already advances the
> tick to `idle`); only the assertions above are new. Import `colorForSymbol`.

- [ ] **Step 6: Run them — expect RED**

Run: `cd runtime/client && npx vitest run src/modules/reels/reelsModule.project.spec.ts src/modules/reels/reelsModule.behavior.spec.ts`
Expected: FAIL (no `fill`/`size`/`label` props; no settle ops).

- [ ] **Step 7: Implement in reelsModule.ts**

Add the import at the top of `runtime/client/src/modules/reels/reelsModule.ts`:

```typescript
import type { Op } from '../../model/ops';
import { colorForSymbol } from './symbolColor';
```

In `buildDesired`, set the cell props (replace the inner cell `nodes.push`):

```typescript
      for (let r = 0; r < cfg.rows + cfg.buffer; r++) {
        const sym = cfg.symbols[r % cfg.symbols.length];
        nodes.push({
          id: cellId(moduleId, c, r),
          type: 'Sprite',
          props: {
            position: { x: 0, y: r * span },
            symbol: sym,
            fill: colorForSymbol(sym),
            size: { width: cfg.cellSize, height: cfg.cellSize },
            label: sym,
          },
          parent: containerId(moduleId, c),
        });
      }
```

In `finishSettle`, after building `grid` and resetting positions, emit the landed colors/labels. Insert before `this.settledGrid = grid;`:

```typescript
    const ops: Op[] = [];
    for (let c = 0; c < cfg.cols; c++) {
      for (let r = 0; r < cfg.rows; r++) {
        const sym = grid[c]?.[r];
        if (sym === undefined) continue;
        ops.push({ kind: 'setProp', id: cellId(this.id, c, r), path: 'fill', value: colorForSymbol(sym) });
        ops.push({ kind: 'setProp', id: cellId(this.id, c, r), path: 'label', value: sym });
      }
    }
    if (ops.length) this.host.emit(ops);
```

- [ ] **Step 8: Run them — expect GREEN**

Run: `cd runtime/client && npx vitest run src/modules/reels/`
Expected: PASS (all reels specs, including the updated project + behavior).

- [ ] **Step 9: Commit**

```bash
git add runtime/client/src/modules/reels/
git commit -m "feat(reels): color-coded labeled cells + land outcome colors on settle"
```

---

## Task 7: Runtime renderer — draw `fill`/`size` rectangles + `label` text

**Files:**
- Modify: `runtime/client/src/render/pixiRenderer.ts`
- Test: `runtime/client/src/render/pixiRenderer.rect.spec.ts` (new)

**Interfaces:**
- Consumes: cell props `fill: string`, `size: { width, height }`, `label: string` (Task 6).
- Produces: `applyPixiProp(sprite, 'fill', '#rrggbb')` sets `texture = Texture.WHITE` and `tint`; `applyPixiProp(sprite, 'size', {width,height})` sizes it. `PixiRenderer.setProp(id, 'label', value)` creates/updates a centered child `Text`; `destroyObject` cleans the label up.

- [ ] **Step 1: Write the failing renderer test**

Create `runtime/client/src/render/pixiRenderer.rect.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Sprite, Texture } from 'pixi.js';
import { applyPixiProp } from './pixiRenderer';

describe('rectangle props', () => {
  it('fill assigns the WHITE texture and tints it', () => {
    const s = new Sprite();
    applyPixiProp(s, 'fill', '#3cb44b');
    expect(s.texture).toBe(Texture.WHITE);
    // Pixi v8 normalizes tint to a numeric color; just assert it changed off-white.
    expect(s.tint).not.toBe(0xffffff);
  });

  it('size sets the sprite dimensions', () => {
    const s = new Sprite(Texture.WHITE);
    applyPixiProp(s, 'size', { width: 80, height: 120 });
    expect(Math.round(s.width)).toBe(80);
    expect(Math.round(s.height)).toBe(120);
  });
});
```

- [ ] **Step 2: Run it — expect RED**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.rect.spec.ts`
Expected: FAIL (`fill`/`size` fall through to the default no-op; tint unchanged).

- [ ] **Step 3: Implement fill/size in `applyPixiProp`**

In `runtime/client/src/render/pixiRenderer.ts`, add cases inside `applyPixiProp`'s `switch` (before `default`). `Sprite` and `Texture` are already imported:

```typescript
    case 'fill': {
      if (obj instanceof Sprite) {
        obj.texture = Texture.WHITE;
        obj.tint = (value as string) ?? 0xffffff;
      }
      return;
    }
    case 'size': {
      if (obj instanceof Sprite) {
        const s = (value ?? {}) as { width?: number; height?: number };
        obj.setSize(s.width ?? 0, s.height ?? 0);
      }
      return;
    }
```

- [ ] **Step 4: Implement the `label` child in `PixiRenderer.setProp`**

Add `Text` to the pixi import at the top of the file:

```typescript
import { Application, Assets, BlurFilter, Container, Sprite, Text, Texture, type Filter, type Ticker } from 'pixi.js';
```

Add a labels map field to the class (next to `objects`):

```typescript
  private labels = new Map<string, Text>();
```

Replace `setProp`:

```typescript
  setProp(id: string, path: string, value: JsonValue): void {
    if (path === 'label') {
      this.applyLabel(id, value);
      return;
    }
    const obj = this.objects.get(id);
    if (obj) applyPixiProp(obj, path, value);
  }

  private applyLabel(id: string, value: JsonValue): void {
    const obj = this.objects.get(id);
    if (!(obj instanceof Sprite)) return;
    const str = value == null ? '' : String(value);
    let text = this.labels.get(id);
    if (!text) {
      text = new Text({ text: str, style: { fill: '#0b0b0c', fontSize: 28, fontWeight: 'bold' } });
      text.anchor.set(0.5); // centered on the sprite's origin (cells are anchor-0.5)
      obj.addChild(text);
      this.labels.set(id, text);
    } else {
      text.text = str;
    }
  }
```

And clean up in `destroyObject` — add before `this.objects.delete(id);`:

```typescript
    this.labels.delete(id);
```

- [ ] **Step 5: Run it — expect GREEN**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.rect.spec.ts src/render/pixiRenderer.handle.spec.ts`
Expected: PASS (both — the handle spec must still pass).

- [ ] **Step 6: Commit**

```bash
git add runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.rect.spec.ts
git commit -m "feat(reels): render fill/size rectangles + label text in the engine"
```

---

## Task 8: Studio frontend — bridge.spin, socket wiring, Game-pane buttons

**Files:**
- Modify: `studio/frontend/src/scene/types.ts`
- Modify: `studio/frontend/src/scene/reducers.ts`
- Modify: `studio/frontend/src/plugins/game/protocolBridge.ts`
- Modify: `studio/frontend/src/plugins/game/protocolBridge.spec.ts`
- Modify: `studio/frontend/src/plugins/game/socketClient.ts`
- Modify: `studio/frontend/src/plugins/game/GamePreviewPane.tsx`
- Modify: `studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx`

**Interfaces:**
- Consumes: backend `scene_spin_outcome {gameId, outcome:{grid}}` (Task 4); emits `scene_add_module` / `scene_spin` (Task 4).
- Produces: `ProtocolBridge.spin(outcome: { grid: string[][] })` sends `{ v:1, kind:'spin', id, outcome }` to the engine (queued before ready, like other messages).
- Produces: `emitSceneAddModule(gameId)`, `emitSceneSpin(gameId, seed?)`; socket handler for `scene_spin_outcome` → `getBridge()?.spin(outcome)` (+ dev hook `window.__gameLastSpinOutcome`).
- Produces: `ISceneDocument.modules?: IModuleDecl[]`; `loadDocument` preserves it.

- [ ] **Step 1: Write the failing bridge test**

In `studio/frontend/src/plugins/game/protocolBridge.spec.ts`, add:

```typescript
it('queues a spin before ready, then posts it on ready', () => {
  const { bridge, post } = setup();
  bridge.spin({ grid: [['0', '1']] });
  expect(post).not.toHaveBeenCalled();
  bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ v: 1, kind: 'spin', outcome: { grid: [['0', '1']] } }),
    ENGINE,
  );
});
```

- [ ] **Step 2: Run it — expect RED**

Run: `cd studio/frontend && npx vitest run src/plugins/game/protocolBridge.spec.ts`
Expected: FAIL (`bridge.spin` is not a function).

- [ ] **Step 3: Implement `spin` on the bridge**

In `studio/frontend/src/plugins/game/protocolBridge.ts`, add `spin` to the `InboundMessage` union:

```typescript
type InboundMessage =
  | { v: 1; kind: 'init'; id: string; document?: ISceneDocument }
  | { v: 1; kind: 'op'; id: string; op: ISceneOp }
  | { v: 1; kind: 'batch'; id: string; ops: ISceneOp[] }
  | { v: 1; kind: 'spin'; id: string; outcome: { grid: string[][] } }
  | { v: 1; kind: 'capture'; id: string };
```

and add the method (next to `capture`):

```typescript
  /** Drive a spin round: the engine settles the reels onto `outcome.grid`. */
  spin(outcome: { grid: string[][] }): void {
    this.send({ v: 1, kind: 'spin', id: this.nextId(), outcome });
  }
```

- [ ] **Step 4: Run it — expect GREEN**

Run: `cd studio/frontend && npx vitest run src/plugins/game/protocolBridge.spec.ts`
Expected: PASS.

- [ ] **Step 5: Scene-doc `modules` passthrough**

In `studio/frontend/src/scene/types.ts`, add after `IEdge`:

```typescript
export interface IModuleDecl {
  id: string;
  type: string;
  config?: Record<string, JsonValue>;
}
```

and extend `ISceneDocument`:

```typescript
export interface ISceneDocument {
  version: number;
  nodes: Record<string, INode>;
  edges: IEdge[];
  modules?: IModuleDecl[];
}
```

In `studio/frontend/src/scene/reducers.ts`, make `loadDocument` preserve `modules`:

```typescript
export function loadDocument(doc: ISceneDocument): ISceneDocument {
  return {
    version: doc.version,
    nodes: Object.fromEntries(Object.entries(doc.nodes).map(([id, n]) => [id, { ...n, props: { ...n.props } }])),
    edges: doc.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } })),
    modules: doc.modules ? doc.modules.map((m) => ({ ...m })) : undefined,
  };
}
```

- [ ] **Step 6: Wire the socket client (handle outcome, emit add/spin)**

In `studio/frontend/src/plugins/game/socketClient.ts`, inside `createGameSocket` after the `scene_op` handler, add:

```typescript
    sock.on('scene_spin_outcome', (p) => {
      const payload = p as { gameId: string; outcome: { grid: string[][] } };
      if (!isActive(payload.gameId)) return;
      if (!import.meta.env.PROD) {
        (window as unknown as { __gameLastSpinOutcome?: unknown }).__gameLastSpinOutcome = payload.outcome;
      }
      getBridge()?.spin(payload.outcome);
    });
```

and add two emitters at the bottom of the file (next to `emitSceneApplyOp`):

```typescript
export function emitSceneAddModule(gameId: string, type = 'reels'): void {
  sock?.emit('scene_add_module', { gameId, type });
}

export function emitSceneSpin(gameId: string, seed?: number): void {
  sock?.emit('scene_spin', seed === undefined ? { gameId } : { gameId, seed });
}
```

- [ ] **Step 7: Write the failing pane test (buttons present + wired)**

In `studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx`, add a test (mirror the file's existing render/setup helpers; mock `./socketClient` so the emitters are spies):

```typescript
it('renders Add Reels + Spin controls when a game is open', () => {
  // ...render the pane with an active game id set, per the existing spec's setup...
  expect(screen.getByTestId('game-add-reels')).toBeInTheDocument();
  expect(screen.getByTestId('game-spin')).toBeInTheDocument();
});
```

- [ ] **Step 8: Run it — expect RED**

Run: `cd studio/frontend && npx vitest run src/plugins/game/GamePreviewPane.spec.tsx`
Expected: FAIL (no such testids).

- [ ] **Step 9: Add the buttons to the pane**

In `studio/frontend/src/plugins/game/GamePreviewPane.tsx`, import the emitters and render a small toolbar above the iframe. Update the import line and the returned JSX (the `activeGameId` branch):

```tsx
import { emitSceneAddModule, emitSceneSpin } from './socketClient';
```

```tsx
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <button
          type="button"
          data-testid="game-add-reels"
          onClick={() => emitSceneAddModule(activeGameId)}
          className="rounded bg-surface-2 px-2 py-1 text-text-1 hover:bg-surface-3"
        >
          Add Reels
        </button>
        <button
          type="button"
          data-testid="game-spin"
          onClick={() => emitSceneSpin(activeGameId)}
          className="rounded bg-surface-2 px-2 py-1 text-text-1 hover:bg-surface-3"
        >
          Spin
        </button>
      </div>
      <iframe ref={frameRef} data-testid="game-engine-frame" title="Game scene preview" src={src} className="h-full w-full flex-1 border-0" />
    </div>
  );
```

> Use only token classes that already exist in `studio/frontend/src/styles.css` /
> `docs/design-language.md`. If `bg-surface-2`/`surface-3`/`border-hairline` are not the exact
> token names, substitute the nearest existing tokens — the design-language guard test will
> reject raw colors. Run `nx test` to confirm the guard passes.

- [ ] **Step 10: Run the pane + scene unit tests — expect GREEN**

Run: `cd studio/frontend && npx vitest run src/plugins/game/ src/scene/`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add studio/frontend/src/scene/types.ts studio/frontend/src/scene/reducers.ts studio/frontend/src/plugins/game/
git commit -m "feat(reels): studio bridge.spin, socket wiring, and Game-pane controls"
```

---

## Task 9: Authoritative e2e — add reels, render grid, spin to server outcome

**Files:**
- Create: `studio/frontend/e2e/reels.spec.ts`

**Interfaces:**
- Consumes: the full live-ish stack (replay backend `8000+offset`, studio `4200+offset`, engine `4300+offset`); the dev hooks `window.__gameActiveId`, `window.__gameLastSpinOutcome`, and the cross-origin frame globals `__engineModel` / `__engineModules`.

This is the behavioral contract (per `AGENTS.md`): assert the **observable end-state** — the rendered grid reconciles to the server's outcome — never merely that a spin was dispatched.

- [ ] **Step 1: Write the e2e spec**

Create `studio/frontend/e2e/reels.spec.ts`:

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack on the
// worktree's offset ports: engine, backend (replay), studio. Drives the real
// socket path: Add Reels -> declaration -> projected grid; Spin -> server round
// -> rendered settle. The engine iframe is cross-origin, so engine globals are
// read via Playwright's contentFrame(), not the top window.

async function openGamePane(page: Page): Promise<string> {
  await page.addInitScript(() => {
    (window as any).__engineMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && (d.kind === 'ready' || d.kind === 'error')) {
        (window as any).__engineMsgs.push({ origin: e.origin, kind: d.kind });
      }
    });
  });
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Reels E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);
  expect(gameId).toBeTruthy();
  return gameId as string;
}

async function engineFrame(page: Page) {
  const handle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await handle!.contentFrame();
  expect(frame).toBeTruthy();
  return frame!;
}

test('Add Reels projects a color-coded grid; Spin lands on the server outcome', async ({ page }) => {
  await openGamePane(page);
  const frame = await engineFrame(page);

  // 1. Add Reels -> the declaration projects cells into the engine model.
  await page.getByTestId('game-add-reels').click();
  await expect
    .poll(() => frame.evaluate(() => (window as any).__engineModel?.toDocument().nodes['reels:cell:0:0'] != null), { timeout: 20000 })
    .toBe(true);

  // The grid is color-coded + labeled: cell carries a hex fill and a label.
  const cell = await frame.evaluate(() => (window as any).__engineModel.toDocument().nodes['reels:cell:0:0'].props);
  expect(String(cell.fill)).toMatch(/^#[0-9a-f]{6}$/i);
  expect(cell.label).toBeDefined();

  // 2. Spin -> the backend evaluates a round and broadcasts an outcome.
  await page.getByTestId('game-spin').click();
  await expect.poll(() => page.evaluate(() => (window as any).__gameLastSpinOutcome ?? null), { timeout: 20000 }).not.toBeNull();
  const outcome = await page.evaluate(() => (window as any).__gameLastSpinOutcome as { grid: string[][] });

  // 3. End-state: the engine settles to idle and the RENDERED grid equals the
  //    server's outcome (assert reconciliation, not dispatch).
  await expect.poll(() => frame.evaluate(() => (window as any).__engineModules.state().phase), { timeout: 10000 }).toBe('idle');
  const rendered = await frame.evaluate(() => (window as any).__engineModules.state().grid);
  expect(rendered).toEqual(outcome.grid);

  // 4. And the landed cells took the outcome's colors (structure plane updated).
  const landedFill = await frame.evaluate(() => (window as any).__engineModel.toDocument().nodes['reels:cell:0:0'].props.fill);
  expect(String(landedFill)).toMatch(/^#[0-9a-f]{6}$/i);

  // No engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});
```

- [ ] **Step 2: Bring up the stack on the worktree offset and run**

In separate terminals from the worktree root (offset 1):

```bash
just backend-serve-replay     # backend on :8001 (replay)
nx serve client               # engine on :4301
nx serve frontend             # studio on :4201
```

Then run the spec (set the offset so Playwright targets the right ports — see the `worktree-independent-ports` rule):

```bash
BLOOM_PORT_OFFSET=1 just e2e -- reels.spec.ts
```

Expected: the spec PASSES — the grid appears color-coded and the rendered grid equals the server outcome. The first Spin may take longer while `cargo` builds `spin_json` once; the 20s poll covers a warm binary, so pre-build it with `cargo build --release -p bloom-simulator --bin spin_json` before the run, or configure `spin_bin`.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/reels.spec.ts
git commit -m "test(reels): e2e add-reels grid + server-driven spin outcome"
```

---

## Final verification (whole-branch gates)

- [ ] **Rust:** `cargo test -p bloom-simulator` and `cargo fmt --check` and `cargo clippy -p bloom-simulator` — all clean. (Memory: CI runs `cargo fmt --check`; run it locally.)
- [ ] **Backend:** `cd studio/backend && uv run pytest -q` — green.
- [ ] **Frontend gates (all four — vitest green ≠ types valid):**
  - `cd runtime/client && npx vitest run` and `cd studio/frontend && npx vitest run`
  - `nx typecheck` (both projects)
  - `node_modules/.bin/prettier --check .` (pinned prettier, not `npx`)
  - `nx build client && nx build frontend`
- [ ] **Standalone regression:** the pre-existing `runtime/client/e2e/reels.e2e.spec.ts` still passes (the `main.ts` standalone seed preserves it): `BLOOM_PORT_OFFSET=1 nx e2e client -- reels.e2e.spec.ts` (engine must be serving on :4301).
- [ ] **Authoritative e2e:** `studio/frontend/e2e/reels.spec.ts` green (Task 9).
- [ ] Open a PR: `git push -u origin feat/reels-in-game && gh pr create`.

---

## Spec coverage check

- Declarative module on the scene doc → Task 2 (persist), Task 5 (runtime reads + projects), Task 8 (studio passthrough + Add Reels).
- Render as color-coded labeled rectangles → Task 6 (props + colors), Task 7 (Pixi rectangle + label).
- Server-driven outcome via the trusted kernel → Task 1 (`spin_json`), Task 3 (runner + demo model + mapping), Task 4 (handlers).
- Spin button in the studio Game pane → Task 8.
- Existing #103 settle animation reused → Task 5/6 (Orchestrator + finishSettle).
- Demo-model fallback → Task 3/4.
- TDD + authoritative e2e + standalone non-regression → every task + Task 9 + Final verification.
- Deferred (no task, by design): in-game Preact overlay; persisting last grid; re-deriving config on model change; scene-graph listing of derived cells; real symbol textures.
