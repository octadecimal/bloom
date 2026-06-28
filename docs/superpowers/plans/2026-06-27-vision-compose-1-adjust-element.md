# Vision-in-the-loop scene composition — Plan 1: `adjust_element` transform actuator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `adjust_element` agent tool that moves / resizes / reorders an already-placed scene sprite by reference — the cheap, deterministic transform actuator the compose-loop critic will lean on (~80% of its edits), without regenerating art.

**Architecture:** A new `build_adjust_element_tool` in `agent_tools.py` resolves a placed element the same way `regenerate_element` does (`_resolve_placed_elements`), then writes `position.x/.y`, `scale.x/.y`, and `zIndex` via the existing `scene_hub.apply_batch` `setProp` ops. It is registered in `ToolFactory._BUILDERS` and bound into the `design-router` skill, whose branch-5 prose learns to route pure layout changes to it instead of `regenerate_element`.

**Tech Stack:** Python 3 / FastAPI backend, LangChain `StructuredTool`, MongoDB (motor), pytest + pytest-asyncio. This is the first of four plans (see Roadmap); it is backend-only and ships independently.

## Roadmap (this plan is #1 of 4)

The approved spec (`docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`) decomposes into four sequential, independently-shippable plans. Author each at its sub-project boundary (commit + `/clear` + fresh resume between them):

1. **`adjust_element` transform actuator (THIS PLAN)** — the cheap layout lever. Backend, no frontend, no LLM. Independently useful: the agent can now "move the logo up / make the captain smaller / bring the chest to the front."
2. **`SceneCritic` seam** — a swappable critic (live `claude-sonnet-4-6` vision call + replay impl), structured-output schema `{done, edits:[{target_handle, action, params, why}]}`, mirroring `build_chat_model` in `providers.py`. Backend, replay-cassette tested. **Note:** the critic is a _direct structured+image LLM call_, NOT a bound tool — it cannot ride the existing `ReplayToolCallingChatModel` (which only replays recorded tool calls). It needs its own seam.
3. **Real-frame capture handshake** — extend the runtime-client postMessage protocol (`messages.ts`) with a `capture` request + a render-settled `captured` reply carrying a PNG (the existing `ack` fires after `reconciler.applyChanges()`, _before_ the Pixi frame is painted — a `requestAnimationFrame`/ticker wait + `renderer.extract` is net-new). Relay studio→backend over the socket. Frontend + Playwright.
4. **Compose-loop orchestrator** — ties 1–3 together with the bounds (look-behind N=3, max-passes=3, regen budget K=5, transform-first), streams each critique/edit into the chat feed, and routes design-router branch 4 ("build a scene") into it. Backend integration + replay e2e + Playwright.

---

## Global Constraints

Copied from the spec and repo standards (`AGENTS.md`, `docs/coding-standards.md`). Every task implicitly includes these.

- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, then refactor.
- **Semantic (Conventional Commits) format** for every commit — `feat(scope): …`, imperative mood, ~50-char subject.
- **Backend unit tests:** `cd studio/backend && uv run pytest -m "not e2e"` — requires a `mongod` on `:27017` (a shared singleton; tests use DB `bloom_studio_test`).
- **Worktree port/data isolation:** this worktree is `C:\code\bloom.wt\vision-compose` with `BLOOM_PORT_OFFSET=1`. Backend unit tests don't bind a port, but if you run the live/replay stack use the offset ports (backend `:8001`), never the defaults.
- **Reuse existing seams, don't duplicate:** resolution goes through `_resolve_placed_elements`; mutation goes through `scene_hub.apply_batch` `setProp` ops; the orphan warning through `_orphan_suffix`. Do not hand-roll node lookups or write to Mongo directly.
- **Do not change** `regenerate_element`, `generate_and_place`, `read_scene`, or `_place_in_scene` behavior — `adjust_element` is purely additive.

---

## File Structure

- `studio/backend/app/agent_tools.py` — **modify.** Add `build_adjust_element_tool(ctx)` next to `build_regenerate_element_tool` (after it, ~line 308); add `"adjust_element": build_adjust_element_tool` to the `_BUILDERS` dict (~line 976).
- `studio/backend/app/gdd/router.py` — **modify.** Add `"adjust_element"` to the `tools=sorted({…})` set in `build_design_router_spec()`; add one branch-5 sentence to `_BODY_TEMPLATE` routing pure layout changes to it.
- `studio/backend/tests/test_adjust_element_tool.py` — **create.** Unit tests (happy path, error paths, registry).
- `studio/backend/tests/test_design_router.py` — **modify.** Add an assertion that the router binds + mentions `adjust_element`.

---

### Task 1: `adjust_element` tool — happy path (move / scale / reorder)

**Files:**

- Create: `studio/backend/tests/test_adjust_element_tool.py`
- Modify: `studio/backend/app/agent_tools.py` (add `build_adjust_element_tool` after `build_regenerate_element_tool` ~line 308; register in `_BUILDERS` ~line 976)

**Interfaces:**

- Consumes (existing, already in `agent_tools.py`):
  - `ToolContext(room_id, game_id, asset_store, asset_hub, *, scene_store, scene_hub)` — dataclass.
  - `_resolve_placed_elements(document: dict, assets: list, ref: str) -> list[PlacedElement]` — substring match on handle/role/asset-name (line 658).
  - `_placed_summary(document: dict, assets: list) -> str` (line 672).
  - `_orphan_suffix(doc: dict) -> str` (line 479).
  - `PlacedElement.sprite_id` is the scene node id (e.g. `"spr.background"`); `.handle`, `.role` are strings (line 600).
  - `scene_hub.apply_batch(game_id, ops) -> dict` raising `OpError(code, …)` (imported as `from app.scene.document import OpError` at top of file).
  - `scene_store.get_document(game_id) -> dict`; `asset_store.list_assets(game_id) -> list`.
  - `setProp` op shape: `{"kind": "setProp", "id": <node_id>, "path": <dotted path>, "value": <json>}`.
- Produces (relied on by later tasks/plans): a registered tool named `adjust_element` with signature `adjust_element(ref: str, x: float|None=None, y: float|None=None, scale: float|None=None, z: int|None=None) -> str`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_adjust_element_tool.py`:

```python
import pytest

from app.agent_tools import ToolContext, build_adjust_element_tool
from app.scene.store import GameSceneStore
from app.scene.hub import GameSceneHub


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


class _NoAssets:
    async def list_assets(self, game_id):
        return []


async def _seed_sprite(hub, game_id, handle, role, *, pos=(640, 360), z=0):
    """Place a bare Sprite (no texture needed — adjust_element resolves off the
    Sprite node + handle) parented to an auto-created Root."""
    await hub.apply_batch(game_id, [
        {"kind": "addNode", "id": "root", "type": "Root", "props": {}},
        {"kind": "addNode", "id": f"spr.{handle}", "type": "Sprite", "props": {
            "position": {"x": pos[0], "y": pos[1]},
            "anchor": {"x": 0.5, "y": 0.5},
            "scale": {"x": 1, "y": 1},
            "zIndex": z,
            "role": role,
        }},
        {"kind": "connect", "edgeId": f"e.child.{handle}", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": f"spr.{handle}", "port": "parent"}},
    ])


@pytest.mark.asyncio
async def test_adjust_element_moves_scales_and_reorders_a_placed_sprite(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke(
        {"ref": "background", "x": 100, "y": 50, "scale": 0.4, "z": 5})

    assert "Adjusted" in out and "background" in out
    props = (await store.get_document("g1"))["nodes"]["spr.background"]["props"]
    assert props["position"] == {"x": 100, "y": 50}
    assert props["scale"] == {"x": 0.4, "y": 0.4}
    assert props["zIndex"] == 5
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_adjust_element_changes_only_the_named_fields(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "logo", "logo", pos=(640, 100), z=2)
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    await build_adjust_element_tool(ctx).ainvoke({"ref": "logo", "y": 30})

    props = (await store.get_document("g1"))["nodes"]["spr.logo"]["props"]
    assert props["position"] == {"x": 640, "y": 30}   # x untouched
    assert props["scale"] == {"x": 1, "y": 1}          # scale untouched
    assert props["zIndex"] == 2                          # z untouched
    await mongo_db["game_scenes"].delete_many({})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_adjust_element_tool.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_adjust_element_tool' from 'app.agent_tools'`.

- [ ] **Step 3: Write the minimal implementation**

In `studio/backend/app/agent_tools.py`, add this function immediately after `build_regenerate_element_tool` ends (after line 307, before `build_read_scene_tool`):

```python
def build_adjust_element_tool(ctx: ToolContext) -> BaseTool:
    async def adjust_element(
        ref: str,
        x: float | None = None,
        y: float | None = None,
        scale: float | None = None,
        z: int | None = None,
    ) -> str:
        document = await ctx.scene_store.get_document(ctx.game_id)
        if not document or not document.get("nodes"):
            return "The scene is empty; there's nothing placed to adjust."
        assets = await ctx.asset_store.list_assets(ctx.game_id)

        matches = _resolve_placed_elements(document, assets, ref)
        if not matches:
            return (f"No placed element matches '{ref}'. "
                    f"Placed: {_placed_summary(document, assets)}. "
                    f"Use one of those, or add it with generate_and_place.")
        if len(matches) > 1:
            opts = ", ".join(
                m.handle + (f" (role {m.role})" if m.role else "") for m in matches)
            return (f"'{ref}' matches several placed elements: {opts}. "
                    f"Call adjust_element again with ref set to the exact one.")

        el = matches[0]
        ops: list[dict] = []
        changed: list[str] = []
        if x is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "position.x", "value": x})
            changed.append(f"x={x:g}")
        if y is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "position.y", "value": y})
            changed.append(f"y={y:g}")
        if scale is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "scale.x", "value": scale})
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "scale.y", "value": scale})
            changed.append(f"scale={scale:g}")
        if z is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "zIndex", "value": int(z)})
            changed.append(f"z={int(z)}")
        if not ops:
            return "Pass at least one of x, y, scale, or z to adjust."

        try:
            doc = await ctx.scene_hub.apply_batch(ctx.game_id, ops)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return (f"Adjusted '{el.handle}': {', '.join(changed)}." + _orphan_suffix(doc))

    return StructuredTool.from_function(
        coroutine=adjust_element, name="adjust_element",
        description=(
            "MOVE, RESIZE, or REORDER an element ALREADY placed in the scene "
            "WITHOUT changing its art. Use this for pure layout fixes — 'move the "
            "logo up', 'make the captain smaller', 'bring the chest to the front'. "
            "`ref` is matched against each placed element's slot/role/asset name. "
            "Pass any of: x, y (Root pixel position of the element's anchor), scale "
            "(uniform multiplier, e.g. 0.4 to shrink), z (z-index; higher draws on "
            "top). Omit a field to leave it unchanged. Prefer this over "
            "regenerate_element for anything that's just mispositioned or mis-sized — "
            "regeneration makes a different image, this keeps the same art."
        ),
    )
```

Then register it in the `_BUILDERS` dict (~line 976), immediately after the `"regenerate_element"` entry:

```python
    "regenerate_element": build_regenerate_element_tool,
    "adjust_element": build_adjust_element_tool,
    "read_scene": build_read_scene_tool,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_adjust_element_tool.py -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_adjust_element_tool.py
git commit -m "feat(scene): add adjust_element transform actuator (move/scale/reorder)"
```

---

### Task 2: `adjust_element` error paths (no fields / no match / ambiguous match)

**Files:**

- Modify: `studio/backend/tests/test_adjust_element_tool.py` (add three tests)

**Interfaces:**

- Consumes: the `build_adjust_element_tool`, `_seed_sprite`, `_SilentSio`, `_NoAssets` from Task 1.
- Produces: nothing new — these tests lock the guard clauses already written in Task 1 (no-op when no fields; friendly no-match and multi-match messages).

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_adjust_element_tool.py`:

```python
@pytest.mark.asyncio
async def test_adjust_element_with_no_fields_is_a_no_op_with_guidance(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke({"ref": "background"})

    assert "at least one of x, y, scale, or z" in out
    props = (await store.get_document("g1"))["nodes"]["spr.background"]["props"]
    assert props["position"] == {"x": 640, "y": 360}   # unchanged
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_adjust_element_unknown_ref_lists_what_is_placed(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke({"ref": "nope", "x": 1})

    assert "No placed element matches 'nope'" in out
    assert "background" in out   # the placed summary
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_adjust_element_ambiguous_ref_returns_candidates(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    # two sprites whose handles both contain "logo" → "logo" matches both
    await _seed_sprite(hub, "g1", "logo_top", "logo")
    await hub.apply_batch("g1", [
        {"kind": "addNode", "id": "spr.logo_bottom", "type": "Sprite", "props": {
            "position": {"x": 640, "y": 700}, "anchor": {"x": 0.5, "y": 0.5},
            "scale": {"x": 1, "y": 1}, "zIndex": 0, "role": "logo"}},
        {"kind": "connect", "edgeId": "e.child.logo_bottom", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": "spr.logo_bottom", "port": "parent"}},
    ])
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)

    out = await build_adjust_element_tool(ctx).ainvoke({"ref": "logo", "y": 10})

    assert "matches several" in out
    assert "logo_top" in out and "logo_bottom" in out
    await mongo_db["game_scenes"].delete_many({})
```

- [ ] **Step 2: Run the tests to verify they pass (guards already exist)**

Run: `cd studio/backend && uv run pytest tests/test_adjust_element_tool.py -v`
Expected: PASS — Task 1's implementation already contains the no-field, no-match, and multi-match guards, so these tests should pass immediately. If any FAIL, the guard wording in Task 1 drifted from the asserted substrings; reconcile them (the test strings are authoritative).

- [ ] **Step 3: Commit**

```bash
git add studio/backend/tests/test_adjust_element_tool.py
git commit -m "test(scene): lock adjust_element no-op / no-match / ambiguous guards"
```

---

### Task 3: Register `adjust_element` in `ToolFactory` and bind it into the design-router

**Files:**

- Modify: `studio/backend/app/gdd/router.py` (add `"adjust_element"` to the tools set in `build_design_router_spec`; add a branch-5 sentence to `_BODY_TEMPLATE`)
- Modify: `studio/backend/tests/test_adjust_element_tool.py` (ToolFactory registry assertion)
- Modify: `studio/backend/tests/test_design_router.py` (router binds + mentions `adjust_element`)

**Interfaces:**

- Consumes: `from app.agent_tools import ToolFactory`; `ToolFactory().build(allowlist: list[str], ctx) -> list[BaseTool]` (line ~1018). `from app.gdd.router import build_design_router_spec`; the returned `SkillSpec` has `.tools` (set/list of names) and `.body` (str).
- Produces: `adjust_element` is in `build_design_router_spec().tools` and named in `.body`, so the live agent can call it.

- [ ] **Step 1: Write the failing registry + router tests**

Append to `studio/backend/tests/test_adjust_element_tool.py`:

```python
from app.agent_tools import ToolFactory


def test_tool_factory_builds_adjust_element():
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=None, scene_hub=None)
    tools = ToolFactory().build(["adjust_element"], ctx)
    assert [t.name for t in tools] == ["adjust_element"]
```

Append to `studio/backend/tests/test_design_router.py`:

```python
def test_router_binds_adjust_element_for_layout_edits():
    spec = build_design_router_spec()
    assert "adjust_element" in spec.tools
    body = spec.body.lower()
    assert "adjust_element" in body
    # branch 5 must distinguish a pure layout change from an art regenerate
    assert "move" in body or "reposition" in body or "resize" in body
```

(`test_design_router.py` already imports `build_design_router_spec` — reuse it.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_adjust_element_tool.py::test_tool_factory_builds_adjust_element tests/test_design_router.py::test_router_binds_adjust_element_for_layout_edits -v`
Expected: FAIL — the registry test fails (`adjust_element` not yet in `_BUILDERS`? it was added in Task 1 — if so this one PASSES; that's fine) and the router test FAILS (`"adjust_element"` not in `spec.tools`).

> Note: the `ToolFactory` registry test may already pass from Task 1's `_BUILDERS` edit. The router test is the one that must fail here. Both must pass after Step 3.

- [ ] **Step 3: Bind the tool into the router**

In `studio/backend/app/gdd/router.py`, find the `tools=sorted({…})` set inside `build_design_router_spec()` and add `"adjust_element"` to it (alphabetical position within the literal is irrelevant — `sorted()` orders it):

```python
        tools=sorted({
            # …existing names…
            "regenerate_element",
            "adjust_element",
            "read_scene",
            # …existing names…
        }),
```

Then, in the same file's `_BODY_TEMPLATE`, find branch 5 (the "fix / regenerate / replace an element already in the scene" branch) and add this sentence to its guidance:

```
For a PURE LAYOUT change to something already on screen — move it, resize it, or
change its draw order (e.g. "move the logo up", "make the captain smaller",
"bring the chest to the front") — call `adjust_element` with the element `ref`
and any of x, y, scale, z. Do NOT regenerate for a layout-only change:
regeneration makes a different image; `adjust_element` keeps the same art and
just repositions/resizes it.
```

- [ ] **Step 4: Run the full backend unit suite to verify green**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — the new `adjust_element` tests, the router test, and **all existing tests** (confirm `test_design_router.py` and `test_generate_and_place_tool.py` still pass — branch-5 prose changed but their assertions target other branches/keywords).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_adjust_element_tool.py studio/backend/tests/test_design_router.py
git commit -m "feat(router): route pure layout edits to adjust_element"
```

---

## Self-Review

- **Spec coverage (for this plan's slice):** The spec's §4 "Transform (liberal)" actuator names exactly this — `adjust_element(ref, x?, y?, scale?, z?)` as the recommended semantic wrapper over `scene_set_prop`, handle-resolved like `regenerate_element`. ✓ Covered by Tasks 1–3. The critic loop, capture, and orchestrator are explicitly deferred to Plans 2–4 (Roadmap) and out of scope here.
- **Placeholder scan:** No TBDs; every step has concrete code and an exact run command. ✓
- **Type consistency:** `build_adjust_element_tool` (Task 1) is the name registered in `_BUILDERS` (Task 1) and asserted by `ToolFactory().build(["adjust_element"], …)` (Task 3). The tool name string `"adjust_element"` is consistent across the builder, registry, router set, and all assertions. `el.sprite_id` is the documented `PlacedElement` attribute used as the `setProp` node id. ✓
- **Reuse check:** Resolution (`_resolve_placed_elements`/`_placed_summary`), mutation (`apply_batch`/`setProp`), and the orphan suffix all go through existing seams — no duplicated node-walking or direct Mongo writes. ✓
