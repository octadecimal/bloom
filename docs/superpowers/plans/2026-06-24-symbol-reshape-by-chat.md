# Reshape a Symbol by Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "make the high symbol a dragon" in a game-room chat regenerate that symbol's art and re-paint the rendered game live, with the identity wiring established during initial authoring.

**Architecture:** A stable `slot` string joins a GDD symbol row, its Asset, and its scene Sprite/Texture. The conversational design-router edits the GDD (the design) and then calls one deterministic tool, `realize_symbol(slot)` (the realization: regenerate the asset + atomically rewrite the bound Texture's `src`). A per-game lock makes scene writes race-free (fixes #69).

**Tech Stack:** Python 3 / FastAPI / Motor (async MongoDB) / LangGraph + LangChain tools (backend); TypeScript / Pixi.js / Vite (runtime client engine); pytest + Playwright (tests); `just` task runner.

## Global Constraints

- TypeScript interfaces use an `I` prefix (`IPlugin`, `IPaneDef`).
- TDD mandatory: failing test → minimal code → pass → commit. Browser e2e is the authoritative behavioral contract (run locally, never in CI). Backend unit + non-browser e2e are CI-affordable.
- Backend tests run under `PROVIDER_MODE=replay`; live providers only to record cassettes. Replay run cassette is the hand-curated union `studio/backend/tests/fixtures/replay/run/default.json` (`{tool_calls, final}`), filtered per skill by bound tool names. Append to it; never `just record-fixtures` for curated tool sequences.
- Never hardcode `localhost` in browser-facing URLs (LAN rule); host-derive from `window.location`.
- Conventional Commits for every commit. Work happens in worktree `C:\code\bloom.wt\symbol-reshape` (`feat/symbol-reshape`, `BLOOM_PORT_OFFSET=2`).
- Scene node/edge schema: nodes `Root|Container|Sprite|Texture`; edges `child` (from parent `children` → to child `parent`) and `data` (from Texture `data` → to Sprite `texture`). A `setProp` on a Texture's `src` re-binds the sprite in the engine reconciler.

---

### Task 1: Per-game lock in GameSceneHub (fix #69)

Serialize every scene write per game so concurrent `scene_*` ops can't clobber via the store's read-modify-write.

**Files:**

- Modify: `studio/backend/app/scene/hub.py`
- Test: `studio/backend/tests/test_scene_hub_concurrency.py` (create)

**Interfaces:**

- Consumes: `GameSceneStore.apply_op(game_id, op) -> dict`, `.apply_batch(game_id, ops) -> dict`.
- Produces: `GameSceneHub.apply_op` / `.apply_batch` unchanged signatures, now serialized per `game_id`.

- [ ] **Step 1: Write the failing test**

A fake store reproduces the RMW race: read the in-memory doc, `await asyncio.sleep(0)` to yield, then write back. Without a lock, N concurrent `apply_op` lose updates; with the hub lock they don't.

```python
# studio/backend/tests/test_scene_hub_concurrency.py
import asyncio
import pytest
from app.scene.hub import GameSceneHub


class _FakeStore:
    """Reproduces apply_op's read-modify-write with a yield point in the middle."""
    def __init__(self):
        self.docs = {}

    async def get_or_create(self, game_id):
        return self.docs.setdefault(game_id, {"version": 1, "nodes": {}, "edges": []})

    async def apply_op(self, game_id, op):
        doc = await self.get_or_create(game_id)
        nodes = dict(doc["nodes"])          # read
        await asyncio.sleep(0)              # yield — lets a racing op interleave
        nodes[op["id"]] = {"id": op["id"], "type": op["type"], "props": {}}
        self.docs[game_id] = {"version": doc["version"] + 1, "nodes": nodes, "edges": doc["edges"]}
        return self.docs[game_id]

    async def apply_batch(self, game_id, ops):
        for op in ops:
            await self.apply_op(game_id, op)
        return self.docs[game_id]


class _FakeSio:
    async def emit(self, *a, **k):
        return None


@pytest.mark.asyncio
async def test_concurrent_apply_op_does_not_lose_updates():
    hub = GameSceneHub(_FakeSio(), _FakeStore())
    ops = [{"kind": "addNode", "id": f"n{i}", "type": "Container"} for i in range(20)]
    await asyncio.gather(*(hub.apply_op("g1", op) for op in ops))
    doc = await hub._store.get_or_create("g1")
    assert len(doc["nodes"]) == 20
    assert doc["version"] == 21  # 1 seed + 20 applied
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_scene_hub_concurrency.py -v`
Expected: FAIL — fewer than 20 nodes / version < 21 (lost updates), because `GameSceneHub` has no lock yet.

- [ ] **Step 3: Add a per-game asyncio.Lock around apply_op / apply_batch**

```python
# studio/backend/app/scene/hub.py
import asyncio

from app.scene.store import GameSceneStore


class GameSceneHub:
    def __init__(self, sio, store: GameSceneStore):
        self._sio = sio
        self._store = store
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, game_id: str) -> asyncio.Lock:
        return self._locks.setdefault(game_id, asyncio.Lock())

    async def attach(self, game_id: str, sid: str) -> None:
        await self._sio.enter_room(sid, game_id)
        doc = await self._store.get_or_create(game_id)
        await self._sio.emit("scene_snapshot", {"gameId": game_id, "document": doc}, to=sid)

    async def apply_op(self, game_id: str, op: dict) -> dict:
        async with self._lock(game_id):
            doc = await self._store.apply_op(game_id, op)
        await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc

    async def apply_batch(self, game_id: str, ops: list[dict]) -> dict:
        async with self._lock(game_id):
            doc = await self._store.apply_batch(game_id, ops)
        for op in ops:
            await self._sio.emit("scene_op", {"gameId": game_id, "op": op}, room=game_id)
        return doc
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_scene_hub_concurrency.py -v`
Expected: PASS (20 nodes, version 21).

- [ ] **Step 5: Run the existing scene suite to confirm no regression**

Run: `cd studio/backend && uv run pytest tests/test_scene.py tests/e2e/test_scene.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/hub.py studio/backend/tests/test_scene_hub_concurrency.py
git commit -m "fix(scene): serialize per-game scene writes to close the apply_op race (#69)"
```

---

### Task 2: `engine-serve` recipe + nx serve target

Make the runtime client engine launchable without a manual `npx vite`.

**Files:**

- Modify: `justfile`
- Modify: `runtime/client/project.json`

**Interfaces:**

- Produces: `just engine-serve` runs Vite on `4300 + BLOOM_PORT_OFFSET`, host `0.0.0.0`.

- [ ] **Step 1: Add the nx serve target**

```json
// runtime/client/project.json — add inside "targets"
"serve": {
  "executor": "nx:run-commands",
  "options": {
    "cwd": "runtime/client",
    "command": "npx vite"
  }
}
```

- [ ] **Step 2: Add the justfile recipe**

The engine port derives from `BLOOM_PORT_OFFSET` inside `runtime/client/vite.config.mts` already, so the recipe just invokes Vite from the project dir.

```make
# justfile — add near serve-frontend
engine-serve:
    cd runtime/client && npx vite --host 0.0.0.0
```

- [ ] **Step 3: Verify it serves**

Run: `just engine-serve` (in a spare terminal), then in another:
`curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4302/`
Expected: `200` (offset 2 → 4302). Stop the server (Ctrl-C) after.

- [ ] **Step 4: Commit**

```bash
git add justfile runtime/client/project.json
git commit -m "build(engine): add engine-serve recipe + nx serve target for the runtime client"
```

---

### Task 3: GDD `symbols-reels` gains a `slot` column

Each symbol row carries a stable slot id so the symbol is addressable across planes.

**Files:**

- Modify: `studio/backend/app/gdd/schemas.py:58-61` (the `symbols` field's `columns`)
- Test: `studio/backend/tests/test_gdd_schemas.py` (create or extend)

**Interfaces:**

- Produces: the `symbols` table column set is `("slot","name","kind","art_desc")`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_schemas.py
from app.gdd.schemas import schema_for


def test_symbols_table_has_slot_column():
    symbols = next(f for f in schema_for("symbols-reels") if f.key == "symbols")
    cols = [c.key for c in symbols.columns]
    assert cols == ["slot", "name", "kind", "art_desc"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_gdd_schemas.py -v`
Expected: FAIL — `slot` not present.

- [ ] **Step 3: Add the column**

```python
# studio/backend/app/gdd/schemas.py — symbols-reels "symbols" field
        Field("symbols", "Symbols", "table", "param", required=True,
              columns=_t(("slot", "Slot"), ("name", "Name"), ("kind", "Kind"),
                         ("art_desc", "Art description"))),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_gdd_schemas.py tests/test_gdd_render.py -v`
Expected: PASS (render is column-driven, so the new column flows through automatically).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/schemas.py studio/backend/tests/test_gdd_schemas.py
git commit -m "feat(gdd): add a stable slot column to the symbols table"
```

---

### Task 4: `Asset.slot` + lookup by (game_id, slot)

Tag assets with their slot and resolve an asset by slot.

**Files:**

- Modify: `studio/backend/app/assets/models.py:22-35` (add field)
- Modify: `studio/backend/app/assets/store.py` (`_AUTHORING_FIELDS`, `create_asset`, new `get_by_slot`)
- Test: `studio/backend/tests/test_asset_store_slot.py` (create)

**Interfaces:**

- Consumes: `AssetStore(db)`.
- Produces: `Asset.slot: Optional[str]`; `AssetStore.create_asset(..., slot=None)`; `AssetStore.get_by_slot(game_id, slot) -> Optional[Asset]`.

- [ ] **Step 1: Write the failing test**

The test uses the same Mongo test DB pattern the backend already uses. Use `mongomock_motor` if present, else a real test DB; mirror `tests/conftest.py`'s db fixture if one exists. Here we construct the store against an `AsyncMongoMockClient`-style `db` fixture named `mongo_db` (add to conftest if absent, mirroring existing store tests).

```python
# studio/backend/tests/test_asset_store_slot.py
import pytest
from app.assets.store import AssetStore


@pytest.mark.asyncio
async def test_create_with_slot_and_lookup(mongo_db):
    store = AssetStore(mongo_db)
    created = await store.create_asset(
        "g1", "High Symbol", "a raven", 512, 512, "schnell-transparent", slot="high1"
    )
    assert created.slot == "high1"
    found = await store.get_by_slot("g1", "high1")
    assert found is not None and found.id == created.id
    assert await store.get_by_slot("g1", "nope") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_asset_store_slot.py -v`
Expected: FAIL — `create_asset` has no `slot`, `get_by_slot` undefined.

- [ ] **Step 3: Add the field and store methods**

```python
# studio/backend/app/assets/models.py — in class Asset, after category
    slot: Optional[str] = None
```

```python
# studio/backend/app/assets/store.py
_AUTHORING_FIELDS = {"name", "category", "prompt", "width", "height", "workflow", "seed", "slot"}

    async def create_asset(self, game_id, name, prompt, width, height, workflow,
                           seed=None, category=None, slot=None) -> Asset:
        asset = Asset(
            id=uuid4().hex, game_id=game_id, name=name, category=category, slot=slot,
            prompt=prompt, width=width, height=height, workflow=workflow, seed=seed,
        )
        await self._assets.insert_one(_to_doc(asset))
        return asset

    async def get_by_slot(self, game_id, slot) -> Optional[Asset]:
        doc = await self._assets.find_one({"game_id": game_id, "slot": slot})
        return _from_doc(doc) if doc else None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_asset_store_slot.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/assets/models.py studio/backend/app/assets/store.py studio/backend/tests/test_asset_store_slot.py
git commit -m "feat(assets): add Asset.slot and get_by_slot lookup"
```

---

### Task 5: `generate_asset` tool accepts an optional `slot`

So initial authoring can tag a generated symbol asset with its slot.

**Files:**

- Modify: `studio/backend/app/agent_tools.py:23-47` (`build_generate_asset_tool`)
- Test: `studio/backend/tests/test_agent_tools.py` (extend)

**Interfaces:**

- Consumes: `ToolContext.asset_store.create_asset(..., slot=)`, `ToolContext.asset_hub.generate_and_wait`.
- Produces: `generate_asset(description, style="", size="512x512", transparent=True, slot="")` — passes `slot` (when non-empty) to `create_asset`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_agent_tools.py — add
import pytest
from app.agent_tools import ToolContext, build_generate_asset_tool


class _RecordingAssetStore:
    def __init__(self):
        self.created = None
    async def create_asset(self, game_id, name, prompt, width, height, workflow, slot=None):
        from app.assets.models import Asset
        self.created = {"slot": slot, "name": name}
        return Asset(id="a1", game_id=game_id, name=name, prompt=prompt,
                     width=width, height=height, workflow=workflow, slot=slot)


class _NoopAssetHub:
    async def generate_and_wait(self, game_id, asset_id):
        return None


@pytest.mark.asyncio
async def test_generate_asset_passes_slot():
    store = _RecordingAssetStore()
    ctx = ToolContext("r1", "g1", store, _NoopAssetHub())
    tool = build_generate_asset_tool(ctx)
    await tool.ainvoke({"description": "a raven", "transparent": True, "slot": "high1"})
    assert store.created["slot"] == "high1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_agent_tools.py::test_generate_asset_passes_slot -v`
Expected: FAIL — `generate_asset` has no `slot` param / `create_asset` called without slot.

- [ ] **Step 3: Thread slot through the tool**

```python
# studio/backend/app/agent_tools.py — build_generate_asset_tool
    async def generate_asset(
        description: str,
        style: str = "",
        size: str = "512x512",
        transparent: bool = True,
        slot: str = "",
    ) -> str:
        prompt = description if not style else f"{description}, {style} style"
        width, height = (int(x) for x in size.lower().split("x", 1))
        workflow = "schnell-transparent" if transparent else "schnell-opaque"
        asset = await ctx.asset_store.create_asset(
            ctx.game_id, description[:40] or "asset", prompt, width, height, workflow,
            slot=slot or None,
        )
        await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
        tag = f" (slot {slot})" if slot else ""
        return f"Generated '{asset.name}' (asset {asset.id}){tag} and added it to the Asset Board."
```

Also extend the tool description: append `"Pass slot='<id>' to tie a symbol's art to its design slot."`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_agent_tools.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(assets): let generate_asset tag a generated asset with its slot"
```

---

### Task 6: `list_assets` surfaces the slot

So the scene agent can match a slot to an asset's media URL.

**Files:**

- Modify: `studio/backend/app/agent_tools.py:60-78` (`build_list_assets_tool`)
- Test: `studio/backend/tests/test_agent_tools.py` (extend)

**Interfaces:**

- Produces: each `list_assets` line includes `[slot=<slot>]` when set.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_agent_tools.py — add
from app.agent_tools import build_list_assets_tool


class _ListStore:
    async def list_assets(self, game_id):
        from app.assets.models import Asset, Generation
        from datetime import datetime, timezone
        a = Asset(id="a1", game_id=game_id, name="High", prompt="raven",
                  width=512, height=512, workflow="schnell-transparent", slot="high1",
                  selected_generation_id="gen1",
                  generations=[Generation(id="gen1", seed=1, image_ref="/media/g/a1/gen1.png",
                                          created_at=datetime.now(timezone.utc))])
        return [a]


@pytest.mark.asyncio
async def test_list_assets_includes_slot():
    ctx = ToolContext("r1", "g1", _ListStore(), None)
    out = await build_list_assets_tool(ctx).ainvoke({})
    assert "slot=high1" in out
    assert "/media/g/a1/gen1.png" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_agent_tools.py::test_list_assets_includes_slot -v`
Expected: FAIL — slot not in output.

- [ ] **Step 3: Add the slot to each line**

```python
# studio/backend/app/agent_tools.py — build_list_assets_tool, inside the loop
        for a in assets:
            slot = getattr(a, "slot", None)
            head = f"- {a.id}: {a.name}"
            if slot:
                head += f" [slot={slot}]"
            elif getattr(a, "category", None):
                head += f" ({a.category})"
            ref = _selected_media_ref(a)
            lines.append(f"{head} — {ref}" if ref else f"{head} — (no image yet)")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_agent_tools.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(assets): surface the slot in list_assets output"
```

---

### Task 7: The `realize_symbol` tool (deterministic realize step)

Given a slot: regenerate its asset and atomically rewrite the bound Texture's `src`.

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (new builder + register in `ToolFactory._BUILDERS`)
- Test: `studio/backend/tests/test_realize_symbol.py` (create)

**Interfaces:**

- Consumes: `ToolContext` with `asset_store` (`get_by_slot`, `get_asset`, `update_asset`, `select_generation`), `asset_hub.generate_and_wait`, `gdd_store.get_doc`, `scene_store.get_document`, `scene_hub.apply_op`.
- Produces: tool `realize_symbol(slot)` registered under name `"realize_symbol"`. Helper `_find_symbol_sprite(document, slot) -> tuple[str, str] | None` returning `(sprite_id, texture_node_id)`.

- [ ] **Step 1: Write the failing test (pure resolution + op emission)**

```python
# studio/backend/tests/test_realize_symbol.py
import pytest
from datetime import datetime, timezone
from app.agent_tools import ToolContext, build_realize_symbol_tool, _find_symbol_sprite
from app.assets.models import Asset, Generation


def _doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.high1": {"id": "spr.high1", "type": "Sprite", "props": {"slot": "high1"}},
            "tex.high1": {"id": "tex.high1", "type": "Texture", "props": {"src": "/media/g/a1/old.png"}},
        },
        "edges": [
            {"id": "c1", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.high1", "port": "parent"}},
            {"id": "d1", "type": "data", "from": {"node": "tex.high1", "port": "data"},
             "to": {"node": "spr.high1", "port": "texture"}},
        ],
    }


def test_find_symbol_sprite_resolves_sprite_and_texture():
    assert _find_symbol_sprite(_doc(), "high1") == ("spr.high1", "tex.high1")
    assert _find_symbol_sprite(_doc(), "missing") is None


class _Gdd:
    async def get_doc(self, game_id, aspect):
        class D:  # minimal stand-in
            data = {"symbols": [{"slot": "high1", "name": "Dragon", "art_desc": "a fierce dragon"}]}
        return D()


class _AssetStore:
    def __init__(self):
        self.updated = None
        self.selected = None
    async def get_by_slot(self, game_id, slot):
        return Asset(id="a1", game_id=game_id, name="High", prompt="raven",
                     width=512, height=512, workflow="schnell-transparent", slot=slot)
    async def update_asset(self, asset_id, **fields):
        self.updated = fields
        return None
    async def get_asset(self, asset_id):
        return Asset(id="a1", game_id="g1", name="High", prompt="a fierce dragon",
                     width=512, height=512, workflow="schnell-transparent", slot="high1",
                     generations=[Generation(id="genNEW", seed=2, image_ref="/media/g/a1/new.png",
                                             created_at=datetime.now(timezone.utc))])
    async def select_generation(self, asset_id, gen_id):
        self.selected = gen_id
        return None


class _AssetHub:
    async def generate_and_wait(self, game_id, asset_id):
        return None


class _SceneStore:
    async def get_document(self, game_id):
        return _doc()


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append(op)
        return None


@pytest.mark.asyncio
async def test_realize_symbol_regenerates_and_rebinds():
    astore, ahub, shub = _AssetStore(), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", astore, ahub, gdd_store=_Gdd(),
                      scene_store=_SceneStore(), scene_hub=shub)
    out = await build_realize_symbol_tool(ctx).ainvoke({"slot": "high1"})
    # regenerated with the new art_desc, then selected the newest generation
    assert astore.updated == {"prompt": "a fierce dragon"}
    assert astore.selected == "genNEW"
    # rewrote the bound texture's src atomically (one setProp op)
    assert shub.ops == [{
        "kind": "setProp", "id": "tex.high1", "path": "src", "value": "/media/g/a1/new.png",
    }]
    assert "high1" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_realize_symbol.py -v`
Expected: FAIL — `build_realize_symbol_tool` / `_find_symbol_sprite` undefined.

- [ ] **Step 3: Implement the helper and tool**

```python
# studio/backend/app/agent_tools.py — add near the scene tools

def _find_symbol_sprite(document: dict, slot: str) -> tuple[str, str] | None:
    """Resolve (sprite_id, texture_node_id) for a slot, or None.

    The symbol Sprite carries props.slot==slot; its bound Texture is the source
    of the `data` edge into that sprite's `texture` port.
    """
    nodes = document.get("nodes", {})
    sprite_id = next(
        (nid for nid, n in nodes.items()
         if n.get("type") == "Sprite" and (n.get("props") or {}).get("slot") == slot),
        None,
    )
    if sprite_id is None:
        return None
    for e in document.get("edges", []):
        if e.get("type") == "data" and e["to"]["node"] == sprite_id and e["to"]["port"] == "texture":
            return sprite_id, e["from"]["node"]
    return None


def build_realize_symbol_tool(ctx: ToolContext) -> BaseTool:
    async def realize_symbol(slot: str) -> str:
        # 1. read the (already-updated) symbol art description from the GDD
        gdd = await ctx.gdd_store.get_doc(ctx.game_id, "symbols-reels")
        rows = (gdd.data.get("symbols") if gdd else None) or []
        row = next((r for r in rows if r.get("slot") == slot), None)
        if row is None:
            return f"No symbol with slot '{slot}' in the GDD; nothing to realize."
        art_desc = row.get("art_desc") or row.get("name") or slot

        # 2. resolve the slot's asset, update its prompt, regenerate, select newest gen
        asset = await ctx.asset_store.get_by_slot(ctx.game_id, slot)
        if asset is None:
            return f"No asset tagged slot '{slot}'; generate it first."
        await ctx.asset_store.update_asset(asset.id, prompt=art_desc)
        await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
        refreshed = await ctx.asset_store.get_asset(asset.id)
        if not refreshed.generations:
            return f"Regeneration for slot '{slot}' produced no image."
        newest = refreshed.generations[-1]
        await ctx.asset_store.select_generation(asset.id, newest.id)

        # 3. rewrite the bound Texture's src — one atomic scene write
        document = await ctx.scene_store.get_document(ctx.game_id)
        found = _find_symbol_sprite(document or {}, slot) if document else None
        if found is None:
            return (f"Regenerated slot '{slot}', but no scene Sprite is labeled with it; "
                    f"the rendered game was not updated.")
        _, texture_id = found
        await ctx.scene_hub.apply_op(
            ctx.game_id,
            {"kind": "setProp", "id": texture_id, "path": "src", "value": newest.image_ref},
        )
        return f"Reshaped symbol '{slot}': regenerated its art and re-rendered the game."

    return StructuredTool.from_function(
        coroutine=realize_symbol, name="realize_symbol",
        description=(
            "Realize a symbol design change on the rendered game. Given a symbol slot "
            "id (e.g. 'high1'), regenerate that symbol's art from its current GDD "
            "art_desc and rebind it in the scene so the game re-renders. Call AFTER "
            "editing the symbol's GDD row with set_gdd_fields."
        ),
    )
```

Register it in `ToolFactory._BUILDERS`:

```python
# studio/backend/app/agent_tools.py — ToolFactory._BUILDERS, add one entry
        "realize_symbol": build_realize_symbol_tool,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_realize_symbol.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_realize_symbol.py
git commit -m "feat(scene): add realize_symbol — regenerate a symbol's art and rebind the scene texture"
```

---

### Task 8: Design-router gains `realize_symbol`

Bind the tool to the game-room conversational turn and teach the router to call it after a symbol edit.

**Files:**

- Modify: `studio/backend/app/gdd/router.py`
- Test: `studio/backend/tests/test_design_router.py` (create or extend)

**Interfaces:**

- Consumes: `build_design_router_spec() -> SkillSpec`.
- Produces: the router spec's `tools` include `realize_symbol`; body prose instructs calling it after a symbol change.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_design_router.py
from app.gdd.router import build_design_router_spec


def test_router_binds_realize_symbol_and_explains_it():
    spec = build_design_router_spec()
    assert "realize_symbol" in spec.tools
    assert "realize_symbol" in spec.body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_design_router.py -v`
Expected: FAIL — `realize_symbol` not in tools/body.

- [ ] **Step 3: Add the tool to the spec and a routing clause**

```python
# studio/backend/app/gdd/router.py
def build_design_router_spec() -> SkillSpec:
    return SkillSpec(
        name=DESIGN_ROUTER_NAME,
        description="Route a freeform design-room message to the GDD.",
        args=[],
        tools=sorted(GDD_TOOL_NAMES | {"realize_symbol"}),
        body=_BODY_TEMPLATE.format(catalog=_render_catalog(field_catalog())),
    )
```

Add this clause to `_BODY_TEMPLATE` (insert as item 2, renumbering the rest):

```
2. A change to a SYMBOL's identity or art (e.g. "make the high symbol a dragon",
   "the wild should be a rune stone"): first call `set_gdd_fields` on
   "symbols-reels" to update that symbol row's name/art_desc (keep its `slot`
   unchanged), THEN call `realize_symbol` with that row's `slot` so the rendered
   game re-paints the new art. Confirm in one sentence, e.g. "Reshaped the high
   symbol → dragon."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_design_router.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_design_router.py
git commit -m "feat(gdd): bind realize_symbol to the design-router for chat-driven symbol reshapes"
```

---

### Task 9: Authoring-skill prose threads the slot

Teach `/design-game` and `/design-scene` to establish the slot contract.

**Files:**

- Modify: `skills/design-game.md`
- Modify: `skills/design-scene.md`
- Test: `studio/backend/tests/test_skills_slot_guidance.py` (create) — a light guard that the prose mentions the contract (skills are prose; the behavioral proof is the e2e in Tasks 11–12).

**Interfaces:**

- Produces: `design-game` instructs giving each symbol a stable `slot`; `design-scene` instructs labeling each symbol Sprite with `props.slot` and binding a Texture per slot.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_skills_slot_guidance.py
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_design_game_mentions_slot():
    text = (ROOT / "skills" / "design-game.md").read_text(encoding="utf-8")
    assert "slot" in text.lower()


def test_design_scene_mentions_slot_labeling():
    text = (ROOT / "skills" / "design-scene.md").read_text(encoding="utf-8")
    lower = text.lower()
    assert "slot" in lower and "props" in lower
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_skills_slot_guidance.py -v`
Expected: FAIL — no slot guidance yet.

- [ ] **Step 3: Edit the skills**

In `skills/design-game.md`, in the symbols-reels guidance, add: _"Give every symbol a stable `slot` id (`high1`, `high2`, `low1`, `wild`, `scatter`) in its row — this is the durable handle later chat edits use to reshape that symbol."_

In `skills/design-scene.md`, in the symbol-sprite step, add: _"For each symbol sprite, set `props.slot` to that symbol's GDD `slot`, and bind it (data edge) to a Texture whose `src` is that slot's asset media URL (match by `[slot=…]` in `list_assets`). Prefer one `scene_apply_batch` per reel/group."_

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_skills_slot_guidance.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/design-game.md skills/design-scene.md studio/backend/tests/test_skills_slot_guidance.py
git commit -m "docs(skills): thread the symbol slot contract through design-game and design-scene"
```

---

### Task 10: Engine test — a Texture `src` change re-binds the sprite

Lock in the reconciler behavior `realize_symbol` depends on (no engine code change).

**Files:**

- Test: `runtime/client/src/render/reconciler.spec.ts` (create or extend)

**Interfaces:**

- Consumes: `Reconciler`, `GraphModel`, a fake `IRenderer` recording `loadTexture`/`assignTexture`.

- [ ] **Step 1: Write the failing/again-passing test**

A fake renderer records calls; drive the model: add Sprite + Texture, connect data edge, then `setProp` the Texture's `src` and assert the reconciler re-loads + re-assigns the texture.

```ts
// runtime/client/src/render/reconciler.spec.ts
import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from './reconciler';
import type { IRenderer, ITextureHandle } from './renderer';

class FakeRenderer implements IRenderer {
  loaded: string[] = [];
  assigned: Array<[string, ITextureHandle | null]> = [];
  async mount() {}
  createObject() {}
  destroyObject() {}
  setParent() {}
  setProp() {}
  async loadTexture(src: string): Promise<ITextureHandle> {
    this.loaded.push(src);
    return { src } as unknown as ITextureHandle;
  }
  assignTexture(id: string, t: ITextureHandle | null) {
    this.assigned.push([id, t]);
  }
  textureSizeOf() {
    return null;
  }
}

describe('reconciler texture rebind', () => {
  it('reloads and reassigns a sprite when its Texture src changes', async () => {
    const model = new GraphModel();
    const r = new FakeRenderer();
    const rec = new Reconciler(r, model);
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'spr', type: 'Sprite', props: {} }));
    await rec.applyChanges(model.apply({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: '/old.png' } }));
    await rec.applyChanges(
      model.apply({ kind: 'connect', edgeId: 'd', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'spr', port: 'texture' } }),
    );
    r.loaded.length = 0;
    r.assigned.length = 0;
    await rec.applyChanges(model.apply({ kind: 'setProp', id: 'tex', path: 'src', value: '/new.png' }));
    expect(r.loaded).toContain('/new.png');
    expect(r.assigned.map(([id]) => id)).toContain('spr');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx nx test client` (or `cd runtime/client && npx vitest run src/render/reconciler.spec.ts`)
Expected: PASS (the behavior exists). If the fake `IRenderer` signature drifts from `renderer.ts`, align it. If it unexpectedly FAILS, that is a real regression to fix before proceeding.

- [ ] **Step 3: Commit**

```bash
git add runtime/client/src/render/reconciler.spec.ts
git commit -m "test(engine): lock in texture rebind on Texture src change"
```

---

### Task 11: Backend non-browser e2e — reshape through the agent loop (replay, CI)

Prove the conversational reshape end-to-end on the backend under replay.

**Files:**

- Modify: `studio/backend/tests/fixtures/replay/run/default.json` (append the design-router tool sequence)
- Test: `studio/backend/tests/e2e/test_symbol_reshape.py` (create) — mirror `tests/e2e/test_scene.py`'s boot + `run_skill` harness.

**Interfaces:**

- Consumes: the replay backend, a socket.io client, the design-router turn.

- [ ] **Step 1: Curate the cassette**

Append to `studio/backend/tests/fixtures/replay/run/default.json`'s `tool_calls` a deterministic design-router sequence for "make the high symbol a dragon": one `set_gdd_fields` (symbols-reels → the high1 row name/art_desc = dragon) followed by one `realize_symbol` (`{"slot": "high1"}`). These are invisible to other skills (filtered by bound tool names). Keep the existing union intact.

- [ ] **Step 2: Write the failing e2e**

Seed (via the stores) a game whose `symbols-reels` has a `high1` row, an Asset tagged `slot=high1` with one generation, and a scene with a Sprite `props.slot=high1` bound to a Texture. Send the plain-chat message through the room (design-router path) and assert: the GDD high1 row updated, the asset gained a new generation, and the scene Texture's `src` changed (read back via a fresh `join_scene` snapshot), plus a `scene_op` was observed.

```python
# studio/backend/tests/e2e/test_symbol_reshape.py (skeleton — fill boot/seed from tests/e2e/test_scene.py)
import pytest

@pytest.mark.asyncio
async def test_chat_reshapes_high_symbol(replay_backend, sio_client, seed_slot_game):
    game = await seed_slot_game(slot="high1", src="/media/g/a1/old.png")
    await sio_client.emit("prompt", {"roomId": game.room_id, "text": "make the high symbol a dragon"})
    await sio_client.wait_for("run_completed")
    snap = await sio_client.join_scene(game.id)
    tex = next(n for n in snap["document"]["nodes"].values()
               if n["type"] == "Texture")
    assert tex["props"]["src"] != "/media/g/a1/old.png"  # rebound to the new generation
```

- [ ] **Step 3: Run to verify it fails, then passes**

Run: `just backend-serve-replay` (separate terminal), then `cd studio/backend && uv run pytest tests/e2e/test_symbol_reshape.py -v`
Expected: FAIL first (no reshape wiring if run before Tasks 7–8; here it should pass once those land). Fill the seed/boot helpers from `tests/e2e/test_scene.py` until green.

- [ ] **Step 4: Commit**

```bash
git add studio/backend/tests/e2e/test_symbol_reshape.py studio/backend/tests/fixtures/replay/run/default.json
git commit -m "test(e2e): reshape the high symbol through the agent loop under replay"
```

---

### Task 12: Browser e2e — the whole loop re-paints (Playwright, local, authoritative)

The behavioral contract: chat → the rendered game changes pixels.

**Files:**

- Test: `studio/frontend/e2e/symbol-reshape.spec.ts` (create) — mirror `studio/frontend/e2e/game-scene.spec.ts` for engine-iframe assertions.

**Interfaces:**

- Consumes: the replay backend on `:8000+offset`, the studio on `:4200+offset`, the engine on `:4300+offset`.

- [ ] **Step 1: Write the spec**

Seed (or author) a game with a `high1` symbol: GDD row, asset tagged `high1` with a known PNG under the test media root, and a scene Sprite `props.slot=high1` bound to its Texture. Open the Game Scene pane; capture the high-symbol sprite's texture identity (size/hash via the engine's `textureSizeOf` or a screenshot crop). Send "make the high symbol a dragon" through the composer (slash-free prose → design-router). Wait for `run_completed`. Assert the Texture's `src` changed to a new generation path AND the rendered pixels in the engine iframe changed (non-`EMPTY`, new dimensions or differing screenshot crop).

```ts
// studio/frontend/e2e/symbol-reshape.spec.ts (skeleton — reuse helpers from game-scene.spec.ts)
import { test, expect } from '@playwright/test';

test('chat reshapes the high symbol and the game re-paints', async ({ page }) => {
  const room = await seedSlotGame(page, { slot: 'high1' }); // helper per game-scene.spec.ts
  await openGameScene(page);
  const before = await readSpriteTextureSrc(page, 'high1');
  await sendChat(page, 'make the high symbol a dragon');
  await waitForRunCompleted(page);
  const after = await readSpriteTextureSrc(page, 'high1');
  expect(after).not.toEqual(before);
  await expectSpriteHasNonEmptyTexture(page, 'high1');
});
```

- [ ] **Step 2: Run locally (requires the live/replay stack + engine)**

Run: `just backend-serve-replay` + `just engine-serve` (separate terminals), then
`cd studio/frontend && BLOOM_PORT_OFFSET=2 npx playwright test e2e/symbol-reshape.spec.ts`
Expected: PASS — `src` changed and the sprite texture is non-empty/changed.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/symbol-reshape.spec.ts
git commit -m "test(e2e): browser proof the high-symbol reshape re-paints the rendered game"
```

---

## Self-Review

**Spec coverage:**

- §3 contract (slot across GDD/Asset/Scene) → Tasks 3, 4, plus the scene convention asserted in 9/11/12. ✓
- §4 authoring threads the contract → Tasks 5 (asset slot), 6 (list_assets), 9 (skill prose). ✓
- §5 reshape path + `realize_symbol` algorithm → Task 7; router wiring → Task 8. ✓
- §6 #69 per-game lock → Task 1; `engine-serve` recipe → Task 2. ✓
- §8 testing (unit / non-browser e2e / browser e2e) → Tasks 1,3,4,5,6,7,8,10 (unit) + 11 (non-browser e2e) + 12 (browser e2e). ✓

**Placeholder scan:** Tasks 11 and 12 carry e2e _skeletons_ with explicit instructions to fill boot/seed helpers from the named existing specs (`tests/e2e/test_scene.py`, `studio/frontend/e2e/game-scene.spec.ts`) — these are integration harnesses whose fixtures are repo-specific; the asserted behavior and exact assertions are concrete. All unit tasks (1,3–8,10) carry complete, runnable code.

**Type consistency:** `realize_symbol` resolution helper `_find_symbol_sprite(document, slot) -> (sprite_id, texture_id) | None` is defined and used in Task 7; `create_asset(..., slot=None)` / `get_by_slot` from Task 4 are consumed in Tasks 5 and 7; `slot` column from Task 3 is read in Task 7; router `tools` set from Task 8 binds the Task 7 tool name `"realize_symbol"`. Consistent.
