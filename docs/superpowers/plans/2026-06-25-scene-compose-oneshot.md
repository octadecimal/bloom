# Scene-Compose One-Shot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single chat prompt (e.g. "make a pirate theme game with a background and a logo centered at the top") generates the named art via ComfyUI and places each piece, positioned, into the live Pixi scene — every step a visible tool call.

**Architecture:** Add one durable mid-level tool, `add_sprite`, that encapsulates the Sprite+Texture+edges+position recipe as one atomic batch (hiding the Pixi graph plumbing). Extend the existing synthetic `design-router` agent with a visual-compose branch and the visual tools (`generate_asset`, `add_sprite`, `list_assets`) so the same agent that already infers GDD-edit/symbol/question intent now also infers "generate + place visual elements" and chains the calls. No new subsystems, no skill-handoff machinery.

**Tech Stack:** Python 3 + FastAPI + LangGraph/LangChain (backend agent + tools), MongoDB (Motor), Socket.IO (live ops), TypeScript + Pixi.js (runtime engine), Playwright (browser e2e), pytest/pytest-asyncio (backend unit + non-browser e2e).

## Global Constraints

- **Branch:** `feat/scene-compose`. Worktree `..\bloom.wt\scene-compose`, `BLOOM_PORT_OFFSET=1` (backend 8001 / studio 4201 / engine 4301). Run `just bootstrap` inside the worktree once before testing.
- **TDD is mandatory:** failing test first, watch it fail, minimal code to pass, refactor. Commit per task.
- **TypeScript interfaces use an `I` prefix** (`IPlugin`, `IPaneDef`). No raw colors outside `styles.css`.
- **Conventional Commits** for every commit (`feat`, `test`, `docs`, …), imperative mood.
- **Asset reference is by stable `slot` handle, never the runtime asset id** — runtime asset ids differ every run, so a cassette/replay flow cannot encode them. `add_sprite` resolves the asset via `asset_store.get_by_slot(game_id, slot)` (mirrors `realize_symbol`), and node ids derive from the slot (`spr.<slot>`, `tex.<slot>`) so re-runs and replay are deterministic.
- **Scene mutations go through `scene_hub.apply_batch`** (one atomic, validated op set; the hub broadcasts each op as a `scene_op`). Never persist directly.
- **Backend tests** run from `studio/backend` via `uv run pytest …`; they need `mongod` running (`just mongo-up` from the worktree). **Browser e2e is never in CI** — run locally with a replay backend.
- **No approval gates** — `generate_asset` and scene ops are non-destructive; the flow runs autonomously in one turn.

**Spec:** `docs/superpowers/specs/2026-06-25-scene-compose-oneshot-design.md`.

---

### Task 1: Pure op-builder `build_sprite_ops`

The fiddly, branch-heavy part (id derivation, position defaults, fit math, edge wiring) isolated as a pure, synchronous, I/O-free function so it is exhaustively unit-testable without Mongo or async. Lives in a new `app/scene/compose.py` — the home for the per-type op-builder pattern (`build_text_ops`, `build_spine_ops` are future siblings here).

**Files:**
- Create: `studio/backend/app/scene/compose.py`
- Test: `studio/backend/tests/test_scene_compose.py`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `DEFAULT_CANVAS: tuple[int, int]` and
  `build_sprite_ops(*, handle: str, src: str, role: str = "", parent_id: str = "root", ensure_root: bool = False, canvas: tuple[int, int] = DEFAULT_CANVAS, tex_size: tuple[int, int] = (512, 512), x: float | None = None, y: float | None = None, anchor_x: float = 0.5, anchor_y: float = 0.5, fit: str = "none", z_index: int = 0) -> list[dict]` — returns an ordered op list: `[addNode root?, addNode Sprite, addNode Texture, connect data, connect child]`. Node ids are `spr.<handle>` / `tex.<handle>`; edge ids `e.data.<handle>` / `e.child.<handle>`.

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_scene_compose.py`:

```python
from app.scene.compose import build_sprite_ops, DEFAULT_CANVAS


def _kinds(ops):
    return [o["kind"] for o in ops]


def test_basic_placement_emits_sprite_texture_and_two_edges():
    ops = build_sprite_ops(handle="logo", src="/media/g/a/logo.png")
    assert _kinds(ops) == ["addNode", "addNode", "connect", "connect"]
    sprite, texture, data_edge, child_edge = ops
    assert sprite["id"] == "spr.logo" and sprite["type"] == "Sprite"
    assert texture["id"] == "tex.logo" and texture["type"] == "Texture"
    assert texture["props"]["src"] == "/media/g/a/logo.png"
    # data edge: Texture.data -> Sprite.texture
    assert data_edge["type"] == "data"
    assert data_edge["from"] == {"node": "tex.logo", "port": "data"}
    assert data_edge["to"] == {"node": "spr.logo", "port": "texture"}
    # child edge: parent.children -> Sprite.parent
    assert child_edge["type"] == "child"
    assert child_edge["from"] == {"node": "root", "port": "children"}
    assert child_edge["to"] == {"node": "spr.logo", "port": "parent"}


def test_position_defaults_to_canvas_center_when_omitted():
    ops = build_sprite_ops(handle="bg", src="s", canvas=(1280, 720))
    pos = ops[0]["props"]["position"]
    assert pos == {"x": 640.0, "y": 360.0}


def test_explicit_top_center_position():
    ops = build_sprite_ops(handle="logo", src="s", canvas=(1280, 720),
                           y=0, anchor_y=0.0)
    sprite = ops[0]
    assert sprite["props"]["position"] == {"x": 640.0, "y": 0}
    assert sprite["props"]["anchor"] == {"x": 0.5, "y": 0.0}


def test_fit_cover_scales_to_cover_canvas():
    ops = build_sprite_ops(handle="bg", src="s", canvas=(1280, 720),
                           tex_size=(640, 720), fit="cover")
    # max(1280/640, 720/720) = 2.0
    assert ops[0]["props"]["scale"] == {"x": 2.0, "y": 2.0}


def test_fit_contain_scales_to_fit_inside_canvas():
    ops = build_sprite_ops(handle="bg", src="s", canvas=(1280, 720),
                           tex_size=(640, 720), fit="contain")
    # min(1280/640, 720/720) = 1.0
    assert ops[0]["props"]["scale"] == {"x": 1.0, "y": 1.0}


def test_fit_none_is_unit_scale():
    ops = build_sprite_ops(handle="x", src="s", tex_size=(640, 720), fit="none")
    assert ops[0]["props"]["scale"] == {"x": 1.0, "y": 1.0}


def test_ensure_root_prepends_a_root_node_with_canvas_dims():
    ops = build_sprite_ops(handle="bg", src="s", ensure_root=True, canvas=(800, 600))
    assert ops[0] == {"kind": "addNode", "id": "root", "type": "Root",
                      "props": {"width": 800, "height": 600}}
    assert _kinds(ops) == ["addNode", "addNode", "addNode", "connect", "connect"]


def test_role_prop_present_only_when_set():
    with_role = build_sprite_ops(handle="bg", src="s", role="background")
    assert with_role[0]["props"]["role"] == "background"
    without = build_sprite_ops(handle="bg", src="s")
    assert "role" not in without[0]["props"]


def test_custom_parent_and_default_canvas_constant():
    assert DEFAULT_CANVAS == (1280, 720)
    ops = build_sprite_ops(handle="x", src="s", parent_id="reels")
    child_edge = ops[-1]
    assert child_edge["from"] == {"node": "reels", "port": "children"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `studio/backend`): `uv run pytest tests/test_scene_compose.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.scene.compose'`.

- [ ] **Step 3: Write the minimal implementation**

Create `studio/backend/app/scene/compose.py`:

```python
"""Pure op-builders that compose higher-level scene constructs from primitives.

Each builder returns an ordered list of scene ops (the same add/connect shapes
GraphModel validates) for ONE node type, hiding the Sprite+Texture+edges
bookkeeping from callers. ``build_sprite_ops`` is the first; ``build_text_ops`` /
``build_spine_ops`` are future siblings that follow the same pattern.
"""

DEFAULT_CANVAS: tuple[int, int] = (1280, 720)


def _scale_for_fit(fit: str, canvas: tuple[int, int], tex: tuple[int, int]) -> float:
    cw, ch = canvas
    tw, th = tex
    if not tw or not th:
        return 1.0
    if fit == "cover":
        return max(cw / tw, ch / th)
    if fit == "contain":
        return min(cw / tw, ch / th)
    return 1.0


def build_sprite_ops(
    *,
    handle: str,
    src: str,
    role: str = "",
    parent_id: str = "root",
    ensure_root: bool = False,
    canvas: tuple[int, int] = DEFAULT_CANVAS,
    tex_size: tuple[int, int] = (512, 512),
    x: float | None = None,
    y: float | None = None,
    anchor_x: float = 0.5,
    anchor_y: float = 0.5,
    fit: str = "none",
    z_index: int = 0,
) -> list[dict]:
    """Ops to place an image asset as a Sprite bound to a Texture.

    ``handle`` is a stable, unique token (a slot or asset id) used to derive node
    and edge ids so re-runs and replay are deterministic. ``ensure_root`` prepends
    a Root (id 'root', canvas dims) when the scene has none yet. Position defaults
    to the canvas centre; omit ``x`` to centre horizontally.
    """
    cw, ch = canvas
    px = cw / 2 if x is None else x
    py = ch / 2 if y is None else y
    scale = _scale_for_fit(fit, canvas, tex_size)

    sprite_id = f"spr.{handle}"
    texture_id = f"tex.{handle}"
    sprite_props: dict = {
        "position": {"x": px, "y": py},
        "anchor": {"x": anchor_x, "y": anchor_y},
        "scale": {"x": scale, "y": scale},
        "zIndex": z_index,
    }
    if role:
        sprite_props["role"] = role

    ops: list[dict] = []
    if ensure_root:
        ops.append({"kind": "addNode", "id": "root", "type": "Root",
                    "props": {"width": cw, "height": ch}})
    ops.append({"kind": "addNode", "id": sprite_id, "type": "Sprite", "props": sprite_props})
    ops.append({"kind": "addNode", "id": texture_id, "type": "Texture", "props": {"src": src}})
    ops.append({"kind": "connect", "edgeId": f"e.data.{handle}", "type": "data",
                "from": {"node": texture_id, "port": "data"},
                "to": {"node": sprite_id, "port": "texture"}})
    ops.append({"kind": "connect", "edgeId": f"e.child.{handle}", "type": "child",
                "from": {"node": parent_id, "port": "children"},
                "to": {"node": sprite_id, "port": "parent"}})
    return ops
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_scene_compose.py -v`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/compose.py studio/backend/tests/test_scene_compose.py
git commit -m "feat(scene): pure build_sprite_ops op-builder for asset placement"
```

---

### Task 2: `add_sprite` agent tool + registration

The async tool wrapper: resolve the asset by stable `slot` (or `asset_id`), read the scene to find the Root (canvas dims) or plan to create one, then build the batch via `build_sprite_ops` and apply it atomically. Registered in `ToolFactory._BUILDERS` so the router can bind it by name.

**Files:**
- Modify: `studio/backend/app/agent_tools.py` (add import of `empty_document` + `build_sprite_ops`/`DEFAULT_CANVAS`; add `build_add_sprite_tool`; register in `ToolFactory._BUILDERS`)
- Test: `studio/backend/tests/test_add_sprite_tool.py`

**Interfaces:**
- Consumes: `build_sprite_ops`, `DEFAULT_CANVAS` (Task 1); `_selected_media_ref`, `_orphan_suffix`, `ToolContext`, `ToolFactory` (existing in `agent_tools.py`); `asset_store.get_by_slot` / `asset_store.get_asset`; `scene_store.get_document`; `scene_hub.apply_batch`.
- Produces: `build_add_sprite_tool(ctx: ToolContext) -> BaseTool` (tool name `add_sprite`), and `"add_sprite"` in `ToolFactory._BUILDERS` / `known_tool_names()`.

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_add_sprite_tool.py`:

```python
import pytest
from datetime import datetime, timezone

from app.agent_tools import ToolContext, ToolFactory, build_add_sprite_tool
from app.assets.models import Asset, Generation
from app.scene.document import unreachable_nodes
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


def _asset(slot="background", width=1280, height=720, ref="/media/g/a/bg.png"):
    return Asset(
        id="a1", game_id="g1", name=slot.title(), prompt="p",
        width=width, height=height, workflow="schnell-opaque", slot=slot,
        generations=[Generation(id="gen1", seed=1, image_ref=ref,
                                 created_at=datetime.now(timezone.utc))],
        selected_generation_id="gen1",
    )


class _AssetStore:
    def __init__(self, asset):
        self._asset = asset
    async def get_by_slot(self, game_id, slot):
        return self._asset if (self._asset and self._asset.slot == slot) else None
    async def get_asset(self, asset_id):
        return self._asset if (self._asset and self._asset.id == asset_id) else None


class _RecordingHub:
    def __init__(self):
        self.batches = []
    async def apply_batch(self, game_id, ops):
        self.batches.append(ops)
        return {"version": 1, "nodes": {}, "edges": []}


class _EmptySceneStore:
    async def get_document(self, game_id):
        return None


class _RootSceneStore:
    async def get_document(self, game_id):
        return {"version": 1,
                "nodes": {"root": {"id": "root", "type": "Root",
                                   "props": {"width": 800, "height": 600}}},
                "edges": []}


@pytest.mark.asyncio
async def test_add_sprite_resolves_by_slot_and_applies_one_batch():
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=_RootSceneStore(), scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke(
        {"slot": "background", "role": "background", "fit": "cover", "z_index": 0})
    assert len(hub.batches) == 1
    ops = hub.batches[0]
    ids = [o.get("id") or o.get("edgeId") for o in ops]
    assert "spr.background" in ids and "tex.background" in ids
    # canvas came from the existing Root (800x600), not the default
    sprite = next(o for o in ops if o.get("id") == "spr.background")
    assert sprite["props"]["position"] == {"x": 400.0, "y": 300.0}
    assert "Placed" in out


@pytest.mark.asyncio
async def test_add_sprite_creates_root_when_scene_empty():
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=_EmptySceneStore(), scene_hub=hub)
    await build_add_sprite_tool(ctx).ainvoke({"slot": "background"})
    ops = hub.batches[0]
    assert ops[0] == {"kind": "addNode", "id": "root", "type": "Root",
                      "props": {"width": 1280, "height": 720}}


@pytest.mark.asyncio
async def test_add_sprite_unknown_slot_returns_friendly_error_no_batch():
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(None), None,
                      scene_store=_EmptySceneStore(), scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke({"slot": "ghost"})
    assert "ghost" in out and "generate" in out.lower()
    assert hub.batches == []


@pytest.mark.asyncio
async def test_add_sprite_no_image_yet_returns_error_no_batch():
    asset = _asset()
    asset.selected_generation_id = None  # generated record but no selected image
    hub = _RecordingHub()
    ctx = ToolContext("r1", "g1", _AssetStore(asset), None,
                      scene_store=_EmptySceneStore(), scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke({"slot": "background"})
    assert "no image yet" in out.lower()
    assert hub.batches == []


@pytest.mark.asyncio
async def test_add_sprite_requires_slot_or_asset_id():
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=_EmptySceneStore(), scene_hub=_RecordingHub())
    out = await build_add_sprite_tool(ctx).ainvoke({})
    assert "slot" in out.lower() and "asset_id" in out.lower()


@pytest.mark.asyncio
async def test_add_sprite_against_real_store_renders_a_parented_bound_sprite(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)

    class _SilentSio:
        async def emit(self, *a, **k): ...
        async def enter_room(self, *a, **k): ...

    hub = GameSceneHub(_SilentSio(), store)
    ctx = ToolContext("r1", "g1", _AssetStore(_asset()), None,
                      scene_store=store, scene_hub=hub)
    out = await build_add_sprite_tool(ctx).ainvoke(
        {"slot": "background", "role": "background", "fit": "cover"})
    assert "not parented" not in out.lower()  # sprite reaches the auto-created root

    doc = await store.get_document("g1")
    assert unreachable_nodes(doc) == []  # nothing orphaned
    # the sprite is bound to its texture via a data edge
    data_edges = [e for e in doc["edges"] if e["type"] == "data"
                  and e["to"]["node"] == "spr.background"]
    assert data_edges and data_edges[0]["from"]["node"] == "tex.background"
    await mongo_db["game_scenes"].delete_many({})


def test_factory_registers_add_sprite():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "add_sprite" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["add_sprite"], ctx)[0].name == "add_sprite"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_add_sprite_tool.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_add_sprite_tool'`.

- [ ] **Step 3: Write the minimal implementation**

In `studio/backend/app/agent_tools.py`, update the scene-document import (currently `from app.scene.document import OpError, unreachable_nodes`) to also import `empty_document`, and add the compose import near the other `app.` imports at the top:

```python
from app.scene.document import OpError, unreachable_nodes, empty_document
from app.scene.compose import build_sprite_ops, DEFAULT_CANVAS
```

Add the tool builder (place it right after `build_list_assets_tool`, alongside the other asset/scene tools):

```python
def build_add_sprite_tool(ctx: ToolContext) -> BaseTool:
    async def add_sprite(
        slot: str = "",
        asset_id: str = "",
        role: str = "",
        parent: str = "root",
        x: float | None = None,
        y: float | None = None,
        anchor_x: float = 0.5,
        anchor_y: float = 0.5,
        fit: str = "none",
        z_index: int = 0,
    ) -> str:
        # 1. resolve the asset by stable slot handle (preferred) or explicit id
        if slot:
            asset = await ctx.asset_store.get_by_slot(ctx.game_id, slot)
        elif asset_id:
            asset = await ctx.asset_store.get_asset(asset_id)
        else:
            return "Pass slot or asset_id to choose which asset to place."
        if asset is None:
            ref = slot or asset_id
            return f"No asset for '{ref}'; generate it first."
        src = _selected_media_ref(asset)
        if not src:
            return f"Asset '{asset.name}' has no image yet; generate it before placing it."

        handle = slot or asset.id

        # 2. read the scene: find the Root (its dims are the canvas) or plan one
        doc = await ctx.scene_store.get_document(ctx.game_id) or empty_document()
        nodes = doc.get("nodes", {})
        root_id = next((nid for nid, n in nodes.items() if n.get("type") == "Root"), None)
        ensure_root = parent == "root" and root_id is None
        parent_id = (root_id or "root") if parent == "root" else parent
        root_props = (nodes.get(root_id) or {}).get("props", {}) if root_id else {}
        canvas = (int(root_props.get("width", DEFAULT_CANVAS[0])),
                  int(root_props.get("height", DEFAULT_CANVAS[1])))

        # 3. build + apply the placement as one atomic batch
        ops = build_sprite_ops(
            handle=handle, src=src, role=role, parent_id=parent_id,
            ensure_root=ensure_root, canvas=canvas,
            tex_size=(int(getattr(asset, "width", 0)), int(getattr(asset, "height", 0))),
            x=x, y=y, anchor_x=anchor_x, anchor_y=anchor_y, fit=fit, z_index=z_index,
        )
        try:
            doc = await ctx.scene_hub.apply_batch(ctx.game_id, ops)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Placed '{role or handle}' as sprite 'spr.{handle}'." + _orphan_suffix(doc)

    return StructuredTool.from_function(
        coroutine=add_sprite, name="add_sprite",
        description=(
            "Place an already-generated image asset into the live scene as a Sprite, "
            "creating its Texture and wiring both edges in ONE atomic step — do NOT add "
            "Texture nodes or edges yourself. Identify the asset by the same `slot` you "
            "passed to generate_asset (preferred), or by `asset_id`. Positioning is in "
            "the Root's pixel space: omit x to centre horizontally; for the top edge pass "
            "y=0 and anchor_y=0; for a full-bleed background pass fit='cover' and "
            "z_index=0. Pass a short role like 'background' or 'logo'. If the scene has no "
            "Root yet, one is created automatically."
        ),
    )
```

Register it in `ToolFactory._BUILDERS` (add the line under `"list_assets"`):

```python
        "list_assets": build_list_assets_tool,
        "add_sprite": build_add_sprite_tool,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_add_sprite_tool.py -v`
Expected: PASS (7 tests). Then run the existing tool suites to confirm no regression:
`uv run pytest tests/test_scene_tools.py tests/test_realize_symbol.py tests/test_agent_tools.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_add_sprite_tool.py
git commit -m "feat(scene): add_sprite tool placing a generated asset in one atomic batch"
```

---

### Task 3: Router visual-compose branch

Give the existing `design-router` the visual tools and a branch that turns a "make/place visual elements" message into a `generate_asset` → `add_sprite` chain per element, while leaving the existing GDD/symbol/question branches intact.

**Files:**
- Modify: `studio/backend/app/gdd/router.py` (`build_design_router_spec` tools set + `_BODY_TEMPLATE`)
- Test: `studio/backend/tests/test_design_router.py` (extend)

**Interfaces:**
- Consumes: `add_sprite` registered in `ToolFactory._BUILDERS` (Task 2); existing `generate_asset` / `list_assets` builders.
- Produces: `build_design_router_spec().tools` now includes `generate_asset`, `add_sprite`, `list_assets`; `.body` documents the visual branch (mentions `add_sprite`, `fit`, `background`, `logo`).

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_design_router.py`:

```python
def test_router_binds_visual_compose_tools():
    spec = build_design_router_spec()
    for name in ("generate_asset", "add_sprite", "list_assets"):
        assert name in spec.tools


def test_router_body_documents_visual_compose_branch():
    body = build_design_router_spec().body
    assert "add_sprite" in body
    assert "fit" in body
    assert "background" in body and "logo" in body
    # existing branches still present
    assert "set_gdd_fields" in body and "realize_symbol" in body
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/test_design_router.py -v`
Expected: FAIL — `add_sprite`/`generate_asset` not in `spec.tools`.

- [ ] **Step 3: Write the minimal implementation**

In `studio/backend/app/gdd/router.py`, widen the tool set in `build_design_router_spec`:

```python
        tools=sorted(
            GDD_TOOL_NAMES
            | {"realize_symbol", "generate_asset", "add_sprite", "list_assets"}
        ),
```

In `_BODY_TEMPLATE`, insert a new branch 4 between branch 3 (ambiguous) and the current branch 4 (not-a-design-edit), and renumber the chit-chat branch to 5. Replace the block that currently reads:

```
4. Not a design edit (a greeting, a question, chit-chat): reply normally in
   plain text and call NO tool.
```

with:

```
4. A request to CREATE or PLACE visual art, or to build/compose the scene
   (e.g. "make a pirate game with a background and a logo at the top", "add a
   treasure chest bottom-right"): treat it as a short build list. For EACH visual
   element the user names:
     a. call `generate_asset` with a vivid, concrete description and a stable
        `slot` handle you choose (e.g. slot="background", slot="logo"); set
        transparent=false for a full-bleed background, true for logos and props;
        pass size like "1280x720" for a background or "768x512" for a logo.
     b. call `add_sprite` with that SAME `slot` plus a short `role` and the
        placement: a background uses fit="cover" and z_index=0; for "centered at
        the top" pass y=0 and anchor_y=0 and omit x (x defaults to centred).
   Call `list_assets` first and reuse a fitting asset instead of regenerating it.
   You do NOT add Texture nodes or edges by hand — add_sprite does that. You MAY
   generate and place several elements in this one turn.
5. Not a design or scene request (a greeting, a question, chit-chat): reply
   normally in plain text and call NO tool.
```

Then replace the final paragraph:

```
Call `read_gdd_doc` first if unsure of an aspect's exact field keys. Never invent
keys that are not in the catalog. Make at most one design edit per message unless
the user clearly asked for several.
```

with:

```
Call `read_gdd_doc` first if unsure of an aspect's exact field keys. Never invent
keys that are not in the catalog. For GDD edits (branches 1-3) make at most one
edit per message unless the user clearly asked for several; a scene-composition
request (branch 4) may create and place every element the user named.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/test_design_router.py tests/test_gdd_router.py -v`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_design_router.py
git commit -m "feat(gdd): route visual-compose prompts to generate_asset + add_sprite"
```

---

### Task 4: Backend non-browser e2e + replay cassette

Prove the whole chain offline and deterministically: a plain-chat pirate prompt routes through the design-router, whose replayed tool calls run the **real** `generate_asset` (→ replay ComfyUI) and **real** `add_sprite` (→ real scene mutation), leaving two parented, texture-bound sprites in the persisted scene. The cassette is a committed JSON artifact (the LLM's decisions); the pipeline under it runs for real.

**Files:**
- Create: `studio/backend/tests/fixtures/replay/run/compose-pirate-scene.json`
- Create: `studio/backend/tests/e2e/test_scene_compose.py`

**Interfaces:**
- Consumes: `add_sprite` + router branch (Tasks 2–3); the `live_server` fixture (`tests/e2e/conftest.py`); run-cassette keying by normalized prompt (`app/replay/cassette.py::load_run_cassettes`).
- Produces: an e2e proof keyed on the prompt `"make a pirate theme game with a background and a logo centered at the top"`.

- [ ] **Step 1: Author the cassette**

Create `studio/backend/tests/fixtures/replay/run/compose-pirate-scene.json`:

```json
{
  "prompt": "make a pirate theme game with a background and a logo centered at the top",
  "tool_calls": [
    {
      "name": "generate_asset",
      "args": {
        "description": "a pirate ship on the high seas at sunset, full scene background",
        "slot": "background",
        "size": "1280x720",
        "transparent": false
      }
    },
    {
      "name": "add_sprite",
      "args": { "slot": "background", "role": "background", "fit": "cover", "z_index": 0 }
    },
    {
      "name": "generate_asset",
      "args": {
        "description": "a pirate game logo with bold gold lettering and a skull",
        "slot": "logo",
        "size": "768x512",
        "transparent": true
      }
    },
    {
      "name": "add_sprite",
      "args": { "slot": "logo", "role": "logo", "y": 0, "anchor_y": 0 }
    }
  ],
  "final": ["Placed a pirate background and a logo at the top of the scene."]
}
```

- [ ] **Step 2: Write the failing test**

Create `studio/backend/tests/e2e/test_scene_compose.py`:

```python
"""Backend non-browser e2e: one plain-chat prompt builds a scene end-to-end.

Under PROVIDER_MODE=replay, "make a pirate theme game with a background and a logo
centered at the top" routes through the design-router. Its replayed tool calls run
the REAL generate_asset (-> replay ComfyUI) and REAL add_sprite (-> real scene
mutation), so the persisted scene ends with two parented, texture-bound sprites.

Cassette: run/compose-pirate-scene.json (prompt-keyed).
"""
import asyncio

import httpx
import pytest
import socketio

PROMPT = "make a pirate theme game with a background and a logo centered at the top"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "ComposeE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_one_prompt_generates_and_places_background_and_logo(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    scene_ops: list[dict] = []
    run_completions: list[dict] = []
    scene_snapshots: list[dict] = []
    client.on("scene_op", lambda d: scene_ops.append(d))
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)

    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 40
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received for compose prompt"
    assert run_completions[0]["status"] == "completed", f"compose run failed: {run_completions}"

    # Two assets, tagged by their stable slots, each with a generated image.
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    by_slot = {a.get("slot"): a for a in assets}
    assert "background" in by_slot and "logo" in by_slot, f"assets: {assets}"
    for slot in ("background", "logo"):
        gens = by_slot[slot].get("generations") or []
        assert gens, f"{slot} asset has no generation: {by_slot[slot]}"

    # The persisted scene has both sprites, parented and texture-bound.
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received"
    doc = scene_snapshots[-1]["document"]
    nodes, edges = doc["nodes"], doc["edges"]
    assert any(n["type"] == "Root" for n in nodes.values()), "no Root auto-created"
    for handle in ("background", "logo"):
        assert f"spr.{handle}" in nodes, f"missing sprite spr.{handle}: {list(nodes)}"
        assert f"tex.{handle}" in nodes, f"missing texture tex.{handle}"
        # texture bound to the sprite via a data edge
        assert any(e["type"] == "data" and e["from"]["node"] == f"tex.{handle}"
                   and e["to"]["node"] == f"spr.{handle}" for e in edges), \
            f"tex.{handle} not bound to spr.{handle}"
        # sprite parented (child edge into it)
        assert any(e["type"] == "child" and e["to"]["node"] == f"spr.{handle}"
                   for e in edges), f"spr.{handle} not parented"
        # texture src points at generated media
        assert nodes[f"tex.{handle}"]["props"].get("src", "").startswith("/media/")

    # The placement was broadcast live (addNode + connect ops seen).
    kinds = [o.get("op", {}).get("kind") for o in scene_ops]
    assert "addNode" in kinds and "connect" in kinds, f"ops seen: {kinds}"

    await client.disconnect()
```

- [ ] **Step 3: Run the test to verify it fails (before wiring is proven)**

First confirm it FAILS without the cassette by temporarily asserting the path — instead, run it directly; if the replay model cannot find the prompt key it falls back to `__default__` (no tool calls) and the scene stays empty, so the sprite assertions fail.

Run (from `studio/backend`, with `mongod` up): `uv run pytest tests/e2e/test_scene_compose.py -v`
Expected at this point: PASS once the cassette (Step 1) + Tasks 2–3 are in place. If it FAILS, debug with the systematic-debugging skill — most likely causes: cassette prompt text not matching `PROMPT` verbatim (normalization is whitespace+lowercase only), or the replay model not replaying 4 sequential tool calls.

> Note: this is the one task whose green depends on the replay model faithfully replaying a 4-call chain. The existing `reshape-symbol` cassette proves 2 sequential calls work; if the 4-call chain misbehaves, that is a real finding to surface, not to paper over.

- [ ] **Step 4: Run the broader e2e backend suite for regressions**

Run: `uv run pytest tests/e2e/test_gdd_routing.py tests/e2e/test_symbol_reshape.py -v`
Expected: PASS (the new router branch must not break existing routing).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tests/fixtures/replay/run/compose-pirate-scene.json studio/backend/tests/e2e/test_scene_compose.py
git commit -m "test(scene): backend e2e for one-prompt compose (generate + place)"
```

---

### Task 5: Frontend Playwright e2e (authoritative client contract)

The behavioral contract: a user types the pirate prompt into the chat composer and watches the agent's discrete tool calls in the feed, then the engine iframe renders both sprites with real (>64px) textures. Mirrors `symbol-reshape.spec.ts` (chat → scene render) and `game-scene.spec.ts` (engine `textureSizeOf`).

**Files:**
- Create: `studio/frontend/e2e/compose-scene.spec.ts`

**Interfaces:**
- Consumes: the same replay backend + `compose-pirate-scene.json` cassette (Task 4); studio testids `chat-composer`, `chat-send`, `chat-messages`, `menu-view`, `view-open-game/preview`, `game-engine-frame`; dev hooks `window.__gameActiveId`, `window.__engineMsgs`, engine-frame `window.__engineRenderer.textureSizeOf(id)`.
- Produces: an authoritative client e2e proving prompt → visible tool calls → rendered sprites.

- [ ] **Step 1: Write the failing spec**

Create `studio/frontend/e2e/compose-scene.spec.ts`:

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — authoritative behavioral contract for:
//   chat → design-router → generate_asset + add_sprite (×2) → engine iframe
//   renders a background sprite and a logo sprite with real textures.
//
// Stack required (replay backend): backend :8000+offset, engine, studio.
// Run: just backend-serve-replay  (then)  just e2e   — or target this file:
//   npx playwright test --config=studio/frontend/playwright.config.ts e2e/compose-scene.spec.ts
//
// Cassette (prompt-keyed, replay backend):
//   run/compose-pirate-scene.json
//     — prompt: "make a pirate theme game with a background and a logo centered at the top"
//     — generate_asset(slot=background) + add_sprite(slot=background, fit=cover)
//       generate_asset(slot=logo)       + add_sprite(slot=logo, y=0, anchor_y=0)
//
// Scene node ids (derived from the slots by add_sprite):
//   spr.background / tex.background, spr.logo / tex.logo, root (auto-created)

const PROMPT = 'make a pirate theme game with a background and a logo centered at the top';

async function openAppAtRoom(page: Page, username: string): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__engineMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && (d.kind === 'ack' || d.kind === 'ready' || d.kind === 'error')) {
        (window as any).__engineMsgs.push({ origin: e.origin, kind: d.kind });
      }
    });
  });
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Compose E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

// Drives one router run + an engine render; allow for first-run Vite compile.
test.setTimeout(300_000);

test('one chat prompt generates and places a background and logo, rendered live', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-room-pane')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gameId).toBeTruthy();

  // 1. Send the pirate prompt as plain prose via the Send button (router path).
  const composer = page.getByTestId('chat-composer');
  await composer.fill(PROMPT);
  await page.getByTestId('chat-send').click();

  // 2. The feed shows the discrete tool calls (generate_asset + add_sprite) and the final line.
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('generate_asset', { timeout: 60_000 });
  await expect(feed).toContainText('add_sprite', { timeout: 60_000 });
  await expect(feed).toContainText('Placed a pirate background and a logo', { timeout: 60_000 });

  // 3. Both assets exist with a generated image (backend wire).
  const slots = await page.evaluate(async (gid) => {
    const assets: any[] = await (await fetch(`/games/${gid}/assets`)).json();
    return assets.filter((a) => a.generations?.length).map((a) => a.slot);
  }, gameId);
  expect(slots).toContain('background');
  expect(slots).toContain('logo');

  // 4. Open the Game Scene pane and wait for the engine handshake.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 25_000 }).toBe(true);

  // 5. Both sprites render with real (>64px) textures inside the engine frame.
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  expect(frame).not.toBeNull();
  for (const id of ['spr.background', 'spr.logo']) {
    await expect
      .poll(async () => frame!.evaluate((sid) => (window as any).__engineRenderer?.textureSizeOf(sid)?.width ?? 0, id), { timeout: 25_000 })
      .toBeGreaterThan(64);
  }

  // 6. No engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});
```

- [ ] **Step 2: Start the replay stack, then run the spec**

In the worktree (offset 1), start the replay backend and the dev servers it needs, then run only this spec. From the worktree root:

```bash
just backend-serve-replay   # terminal 1 (backend :8001, replay)
just e2e -- e2e/compose-scene.spec.ts   # or: npx playwright test --config=studio/frontend/playwright.config.ts e2e/compose-scene.spec.ts
```

Expected first run: FAIL if the feed does not surface tool-call names as written. Inspect how `symbol-reshape.spec.ts` assertions match the feed; if the run-step rows render the tool name differently than the literal `generate_asset`/`add_sprite`, adjust the `toContainText` matchers to the actual rendered label (use the systematic-debugging skill and the Playwright trace). Re-run until green.

- [ ] **Step 3: Confirm no regression in the sibling scene specs**

Run: `just e2e -- e2e/symbol-reshape.spec.ts e2e/game-scene.spec.ts`
Expected: PASS (the new router branch and tool must not disturb existing scene rendering).

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/compose-scene.spec.ts
git commit -m "test(scene): authoritative e2e — one prompt renders background + logo"
```

---

### Task 6: Whole-branch verification + handoff notes

Run every affordable gate, record the result honestly, and note the live-verification follow-up.

**Files:** none (verification + a short doc note).

- [ ] **Step 1: Backend unit + non-browser e2e**

From `studio/backend` (with `mongod` up):
```bash
uv run pytest tests/test_scene_compose.py tests/test_add_sprite_tool.py tests/test_design_router.py -q
uv run pytest tests/e2e/test_scene_compose.py tests/e2e/test_gdd_routing.py tests/e2e/test_symbol_reshape.py -q
```
Expected: all PASS. Also run the linter the repo uses (`uv run ruff check app tests` if configured).

- [ ] **Step 2: Frontend gates (the four that CI runs)**

Per the repo's frontend CI gates, run all four — vitest passing does not imply types/build pass:
```bash
node_modules/.bin/prettier --check .
npx nx typecheck studio-frontend
npx nx test studio-frontend
npx nx build studio-frontend
```
Expected: all PASS. (Use the pinned `node_modules/.bin/prettier`, not `npx prettier`, to match CI's version.)

- [ ] **Step 3: Browser e2e (local, never CI)**

With `just backend-serve-replay` running: `just e2e -- e2e/compose-scene.spec.ts`
Expected: PASS. Record the actual outcome; do not claim success without the green run.

- [ ] **Step 4: Note the live-verification follow-up**

The committed cassette scripts the agent's *decisions*; the pipeline beneath runs for real, but the LLM has not been verified to actually emit this chain. Add a one-line follow-up to the spec's "Risks / open items" (or a tracking todo): _record/verify the compose chain against live providers via `just e2e-live` (and refresh the cassette with `just record-fixtures` if the natural phrasing drifts) — the same deferred live-recording step noted for tuner-chat._ This mirrors the established repo rhythm (hand-author for deterministic replay now; live-verify as a follow-up).

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill: push `feat/scene-compose` and open a PR (main is protected). After merge, clean up the worktree per the repo convention.

---

## Self-Review

**Spec coverage:**
- "One prompt generates named visual elements and places them, positioned, one turn" → Tasks 2–4 (tool + router branch + e2e proof). ✅
- "Every action a discrete, visible tool call" → router emits separate `generate_asset`/`add_sprite` steps; asserted in Task 5 feed checks. ✅
- "Placement seam generalizes to future node types" → `app/scene/compose.py` per-type op-builder pattern (Task 1), documented as the home for `build_text_ops`/`build_spine_ops`. ✅
- "Does not regress existing GDD/symbol/question routing" → Task 3 keeps branches 1–3/5; regression runs in Tasks 4 Step 4 and 5 Step 3. ✅
- "GDD-ready `role` tag" → `role` prop on the sprite (Tasks 1–2). ✅
- "`fit=cover` for backgrounds; canvas from Root dims; auto-create Root" → Tasks 1–2 with tests. ✅
- "No approval gates" → none added; flow is autonomous. ✅
- Non-goals (add_text/add_spine, GDD reconciliation, dedicated compose-scene skill, drag-in UI, asset-ref texture binding) → not implemented; `compose.py` + `slot`/`role` seams leave them clean. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The one genuinely uncertain point (replay of a 4-call chain) is called out explicitly in Task 4 with a debugging path, not hidden. ✅

**Type/name consistency:** `build_sprite_ops` signature, `DEFAULT_CANVAS`, node ids `spr.<handle>`/`tex.<handle>`, edge ids `e.data.<handle>`/`e.child.<handle>`, and tool name `add_sprite` are identical across Tasks 1–5. The cassette `slot` values (`background`, `logo`) match the e2e node-id assertions (`spr.background`, `spr.logo`). Asset resolution by `get_by_slot` matches the `Asset.slot` field and the `realize_symbol` precedent. ✅
