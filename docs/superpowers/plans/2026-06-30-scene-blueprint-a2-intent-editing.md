# Scene Blueprint — A2 (Editable GDD Intent Surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only `GddViewerPane` into an editor for the five Scene-Blueprint _intent_ fields (2 prose textareas + 3 enum selects), and make saving an intent field reflow the live scene — the editable GDD becomes HITL Surface 2 from the design spec.

**Architecture:** The save goes through the existing `PUT /games/{id}/gdd/{aspect}`, now routed through the `GddHub` so it emits `gdd_doc_updated` to every connected viewer. When a save changes an _intent_ field on a non-empty scene, the endpoint runs the **same** `rebuild_scene` bind→place→reconcile spine A1 shipped — extracted into a reusable `rebuild_scene_core(ctx)` so the agent tool and the REST path share one code path. The deterministic bind moves each element into its new planned region, so the reflow is critic-independent (the critic only nudges further). This plan also lands the three A3 follow-ups PR #129 deferred, two of which (orientation-flip Root resize; handle→role unification) are directly exercised by an editable orientation enum.

**Tech Stack:** Backend — Python 3 / FastAPI / Pydantic / dataclasses, LangGraph tool seams, MongoDB, pytest (backend replay e2e under `PROVIDER_MODE=replay`). Frontend — React + TypeScript + Hookstate + Dockview, Vitest. Engine — Pixi (`runtime/client`), Vitest. Browser e2e — Playwright (local, authoritative).

## Global Constraints

- **GDD holds NO geometry/coordinates.** The editor exposes only prose + the three enums. The five editable intent fields are exactly: `theme.art_direction` (prose), `ui-ux.layout` (prose), `ui-ux.orientation` (enum `portrait`|`landscape`), `ui-ux.focal_emphasis` (enum `reels`|`logo`|`balanced`), `ui-ux.framing_density` (enum `clean`|`moderate`|`ornate`). This set is identical to the design-router's rebuild-trigger condition (`gdd/router.py:42-44`).
- **TypeScript interfaces use an `I` prefix** (repo coding standard) — e.g. `IGddDoc`, `IIntentField`.
- **Studio UI MUST follow `docs/design-language.md`** — 4 surfaces, 2 hairlines, 3 text tiers, 1 accent. Use existing token classes already in `GddViewerPane.tsx` (`bg-surface`, `text-text-1/2/3`, `border-hairline`, `text-accent-text`, `hover:bg-raised-hover`). **No raw colors** (a guard test blocks hex/rgb outside `styles.css`).
- **TDD is mandatory:** failing test first, watch it fail, minimal code to pass, refactor. Commit per task.
- **Semantic commits** (Conventional Commits): `<type>(<scope>): <description>`, imperative mood.
- **Reuse, don't fork.** One rebuild spine (`rebuild_scene_core`). The REST save reuses the existing PUT + `gdd_doc_updated` websocket; **no new persistence** (region overrides are A3).
- **The rebuild is synchronous inside the PUT** for A2 (deterministic + fast under replay; mirrors the agent path that already blocks its run on `rebuild_scene`). Moving it to a background task / approval gate is A3's job. Document this; do not build async/approval here.
- **Canvas:** landscape `(1280, 720)`, portrait `(720, 1280)` (from `app.scene.layout.template.canvas_for`).
- **Run backend unit tests:** `uv --directory studio/backend run pytest <path> -v`.
- **Run backend e2e (replay):** `uv --directory studio/backend run pytest tests/e2e/<file> -v` (these spin real in-process Mongo + replay critics, no server subprocess — see `tests/e2e/test_scene_blueprint_compose.py`).
- **Run frontend unit tests:** `cd studio/frontend && npx nx test frontend -- <file>` (vitest). **Before any frontend push run all four gates** (`prettier --check .` via `node_modules/.bin/prettier`, `nx typecheck`, `nx test`, `nx build`) — vitest green ≠ types valid.
- **Run engine (runtime/client) unit tests:** `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts`.
- **Browser e2e is local-only, never CI.** Start a replay backend first (`just backend-serve-replay`); in a worktree export its `BLOOM_PORT_OFFSET` ports — NEVER the defaults (:8000/:4200/:4300). Run via `just e2e` or target the file with the playwright config.

---

### Task 1: Carry-forward cleanup — dead field, handle→role unification, coverage tests

PR #129 deferred three cheap items to A3. This task lands two of them (the third, orientation-flip Root resize, is Task 2): delete the inert `BuildElement.scale` field (no consumer in A1) and unify the asymmetric handle→role resolution in `_apply_plan`/`_plan_context` behind two small helpers, plus the cheap coverage tests PR #129 asked for (focal=logo, flourish-shrink, invalid-enum fallback, width-limited region).

**Files:**

- Modify: `studio/backend/app/scene/compose_loop.py:46-66` (`BuildElement` — drop `scale`), `:95-122` (`_apply_plan` / `_plan_context` — share helpers)
- Test: `studio/backend/tests/test_layout_bind.py` (extend — append focal=logo + flourish-shrink), `studio/backend/tests/test_layout_intent.py` (extend — append invalid-enum fallback), `studio/backend/tests/test_layout_plan.py` (extend — append width-limited region), `studio/backend/tests/test_compose_loop.py` (extend — append handle/role unification test)

**Interfaces:**

- Consumes: existing `ScenePlan.for_role`.
- Produces: module-level `_handle_of(e: BuildElement) -> str` (`e.slot or e.role`) and `_role_of(e: BuildElement) -> str` (`e.role or e.slot`) in `compose_loop.py`, used by both `_apply_plan` and `_plan_context`. `BuildElement` no longer has a `scale` field.

- [ ] **Step 1: Confirm `BuildElement.scale` has no consumer**

Run: `cd studio/backend && grep -rn "\.scale" app/ | grep -iv "params.scale\|_scale_for_fit\|scale_to_region\|\"scale\"\|'scale'\|scaleX\|scale\.x\|scale=\|scale:"`
Expected: no line reads `BuildElement`'s `.scale` attribute (matches are the unrelated `EditParams.scale`, the sprite-op `scale` dict, and `_scale_for_fit`/`scale_to_region`). This confirms the field is dead. If a real consumer appears, STOP and keep the field.

- [ ] **Step 2: Write the failing coverage + unification tests**

Append to `studio/backend/tests/test_layout_bind.py`:

```python
def test_focal_logo_enlarges_logo_region():
    base = bind(GddIntent(focal_emphasis="balanced")).for_role(LOGO)
    logo = bind(GddIntent(focal_emphasis="logo")).for_role(LOGO)
    assert logo.region_w > base.region_w and logo.region_h > base.region_h


def test_focal_reels_shrinks_flourishes():
    base = bind(GddIntent(focal_emphasis="balanced", framing_density="ornate"))
    reels = bind(GddIntent(focal_emphasis="reels", framing_density="ornate"))
    assert reels.for_role(FLOURISH_LEFT).region_w < base.for_role(FLOURISH_LEFT).region_w
```

Append to `studio/backend/tests/test_layout_intent.py`:

```python
@pytest.mark.asyncio
async def test_read_intent_falls_back_on_invalid_enum():
    store = _FakeStore({"ui-ux": {"orientation": "sideways",
                                  "focal_emphasis": "", "framing_density": "BOGUS"}})
    intent = await read_intent(store, "g1")
    assert intent.orientation == "landscape"
    assert intent.focal_emphasis == "balanced"
    assert intent.framing_density == "moderate"
```

Append to `studio/backend/tests/test_layout_plan.py`:

```python
def test_scale_to_region_is_width_limited_for_wide_box():
    # a 512x512 texture into a 400x900 box -> limited by width: 400/512
    assert scale_to_region((512, 512), (400, 900)) == 400 / 512
```

Append to `studio/backend/tests/test_compose_loop.py` (reuses the `_RecordingDeps` fake already in that file from A1):

```python
@pytest.mark.asyncio
async def test_plan_context_and_apply_agree_on_handle_role_resolution():
    """The handle the critic is keyed by (slot-or-role) and the role used to fetch
    its planned region must stay consistent between place and critique."""
    plan = bind(GddIntent())
    deps = _RecordingDeps()
    # slot and role differ: handle should be the slot, region resolved via role.
    el = BuildElement(description="x", slot="reel_frame", role="reels")
    await run_compose([el], "pirate", deps, plan=plan)
    placed = deps.placed[0]
    pr = plan.for_role("reels")
    assert (placed.x, placed.y) == (pr.x, pr.y)          # _apply_plan resolved via role
    assert "reel_frame" in deps.requests[0].plan          # _plan_context keyed by slot
    assert deps.requests[0].plan["reel_frame"]["w"] == pr.region_w
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_layout_bind.py tests/test_layout_intent.py tests/test_layout_plan.py tests/test_compose_loop.py -k "focal_logo or flourishes or invalid_enum or width_limited or handle_role" -v`
Expected: the new coverage tests PASS already (they assert existing A1 behaviour) EXCEPT they confirm intent; the unification test PASSES too if behaviour already agrees. Run them to establish a green baseline before refactoring. (If any FAIL, that is a real A1 bug — fix it in Step 4.)

> Note: these are characterization tests guarding behaviour through the refactor. They should be green on current `main`; their job is to stay green after Step 4's edits.

- [ ] **Step 4: Drop the dead field and unify the helpers**

In `studio/backend/app/scene/compose_loop.py`, delete the `scale` line from `BuildElement` (currently line 63):

```python
    fit: str = "none"
    z_index: int = 0
    region_w: int | None = None
    region_h: int | None = None
```

Replace `_apply_plan` and `_plan_context` (lines 95-122) with shared-helper versions:

```python
def _handle_of(element: BuildElement) -> str:
    """The stable scene handle for an element: its slot, else its role."""
    return element.slot or element.role


def _role_of(element: BuildElement) -> str:
    """The canonical-layout role for an element: its role, else its slot."""
    return element.role or element.slot


def _apply_plan(element: BuildElement, plan: "ScenePlan | None") -> BuildElement:
    """Overwrite an element's geometry from its planned role region. The plan owns
    geometry; the agent only chose content + role. No-op when no plan or no role."""
    if plan is None:
        return element
    pr = plan.for_role(_role_of(element))
    if pr is None:
        return element
    return element.model_copy(update={
        "x": pr.x, "y": pr.y, "anchor_x": pr.anchor_x, "anchor_y": pr.anchor_y,
        "z_index": pr.z, "fit": pr.fit,
        "region_w": pr.region_w, "region_h": pr.region_h,
    })


def _plan_context(plan: "ScenePlan | None", window: list[str],
                  elements: list[BuildElement]) -> dict:
    """Map in-window handles to their intended region for the critic."""
    if plan is None:
        return {}
    role_by_handle = {_handle_of(e): _role_of(e) for e in elements}
    out: dict = {}
    for handle in window:
        pr = plan.for_role(role_by_handle.get(handle, handle))
        if pr is not None:
            out[handle] = {"role": pr.role, "x": pr.x, "y": pr.y,
                           "w": pr.region_w, "h": pr.region_h, "z": pr.z}
    return out
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_layout_bind.py tests/test_layout_intent.py tests/test_layout_plan.py tests/test_compose_loop.py -v`
Expected: PASS — all coverage + unification tests green, no regression. (If the `scale` deletion broke a test, a real consumer exists — restore the field and revisit Step 1.)

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/compose_loop.py studio/backend/tests/test_layout_bind.py studio/backend/tests/test_layout_intent.py studio/backend/tests/test_layout_plan.py studio/backend/tests/test_compose_loop.py
git commit -m "refactor(scene): drop dead BuildElement.scale, unify handle/role resolution"
```

---

### Task 2: `ensure_root` resizes an existing Root on orientation flip

The third PR #129 follow-up, promoted into A2 because an editable `orientation` enum makes it reachable: today `GameSceneHub.ensure_root` early-returns an existing Root's stored canvas **without resizing it** (`scene/hub.py:30-37`), so a `rebuild_scene` after a portrait/landscape flip lays the new-orientation plan into the OLD canvas. Fix: when the requested canvas differs from the existing Root's, emit a `setProp`-style update that resizes the Root and broadcast it, then return the NEW canvas. The plan's per-role regions are absolute pixels against this canvas, so once the Root is the right size, `rebuild_scene` re-places every element into the correct orientation (children reflow via the existing place path — no separate child walk needed).

**Files:**

- Modify: `studio/backend/app/scene/hub.py:16-45` (`ensure_root`)
- Test: `studio/backend/tests/test_scene.py` (extend — append resize tests; reuse the existing hub/store fakes in that file)

**Interfaces:**

- Consumes: existing `GameSceneStore.apply_op`, `empty_document`.
- Produces: `ensure_root(game_id, canvas)` returns `{"root_id", "canvas"}` where `canvas` is the **requested** canvas when it differs from the stored one (after resizing), and broadcasts a `setProp` op (`{"kind": "setProp", "id": <root_id>, "props": {"width": cw, "height": ch}}`) so connected clients resize their stage. Idempotent: same-size requests still create nothing and broadcast nothing.

- [ ] **Step 1: Read the existing setProp op shape**

Run: `cd studio/backend && grep -rn "setProp" app/scene/ | head` and open `app/scene/store.py` to confirm `apply_op` accepts a `setProp` op that merges into a node's `props`. Use that exact op kind/shape in the resize (do NOT invent a new op kind). If the store uses a different update kind (e.g. `updateNode`), use that one consistently.

- [ ] **Step 2: Write the failing test**

Append to `studio/backend/tests/test_scene.py` (mirror the existing hub-test setup in that file — a `GameSceneStore(mongo_db)` + a fake/no-op sio with an async `emit`):

```python
@pytest.mark.asyncio
async def test_ensure_root_resizes_existing_root_on_orientation_flip(scene_hub_and_store):
    hub, store = scene_hub_and_store
    gid = "g-flip"
    await hub.ensure_root(gid, (1280, 720))           # landscape first
    info = await hub.ensure_root(gid, (720, 1280))     # flip to portrait
    assert info["canvas"] == (720, 1280)               # returns the NEW canvas
    doc = await store.get_document(gid)
    root = next(n for n in doc["nodes"].values() if n["type"] == "Root")
    assert (int(root["props"]["width"]), int(root["props"]["height"])) == (720, 1280)


@pytest.mark.asyncio
async def test_ensure_root_same_size_is_noop(scene_hub_and_store):
    hub, store = scene_hub_and_store
    gid = "g-same"
    await hub.ensure_root(gid, (1280, 720))
    info = await hub.ensure_root(gid, (1280, 720))      # identical
    assert info["canvas"] == (1280, 720)
    doc = await store.get_document(gid)
    roots = [n for n in doc["nodes"].values() if n["type"] == "Root"]
    assert len(roots) == 1                              # still exactly one Root
```

If `test_scene.py` has no shared `scene_hub_and_store` fixture, add one at the top of the file:

```python
import pytest
import pytest_asyncio
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


class _FakeSio:
    async def emit(self, *a, **k):
        pass

    async def enter_room(self, *a, **k):
        pass


@pytest_asyncio.fixture
async def scene_hub_and_store(mongo_db):
    store = GameSceneStore(mongo_db)
    yield GameSceneHub(_FakeSio(), store), store
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_scene.py -k "orientation_flip or same_size" -v`
Expected: FAIL — `test_ensure_root_resizes_existing_root_on_orientation_flip` returns the old `(1280, 720)` canvas and leaves the Root at the old size.

- [ ] **Step 4: Resize the existing Root when the canvas differs**

In `studio/backend/app/scene/hub.py`, replace the existing-Root branch of `ensure_root` (lines 30-45) so a size mismatch resizes + broadcasts:

```python
        cw, ch = int(canvas[0]), int(canvas[1])
        async with self._lock(game_id):
            doc = await self._store.get_document(game_id) or empty_document()
            nodes = doc.get("nodes", {})
            for nid, n in nodes.items():
                if n.get("type") == "Root":
                    props = n.get("props") or {}
                    ow = int(props.get("width", cw))
                    oh = int(props.get("height", ch))
                    if (ow, oh) == (cw, ch):
                        return {"root_id": nid, "canvas": (ow, oh)}
                    resize = {"kind": "setProp", "id": nid,
                              "props": {"width": cw, "height": ch}}
                    await self._store.apply_op(game_id, resize)
                    broadcast_op = resize
                    break
            else:
                op = {"kind": "addNode", "id": "root", "type": "Root",
                      "props": {"width": cw, "height": ch}}
                await self._store.apply_op(game_id, op)
                broadcast_op = op
                nid = "root"
        await self._sio.emit(
            "scene_op", {"gameId": game_id, "op": broadcast_op}, room=game_id
        )
        return {"root_id": nid, "canvas": (cw, ch)}
```

(Use the actual op kind confirmed in Step 1 if it is not `setProp`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_scene.py -v`
Expected: PASS — resize + no-op tests green and the existing scene tests still pass.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/hub.py studio/backend/tests/test_scene.py
git commit -m "fix(scene): resize an existing Root on orientation flip in ensure_root"
```

---

### Task 3: Extract `rebuild_scene_core` so agent + REST share one spine

The `rebuild_scene` agent tool (`agent_tools.py:586-615`) holds the bind→ensure_root→place→reconcile logic inline. Extract that body into a module-level `rebuild_scene_core(ctx, theme="")` coroutine so the REST intent-save path (Task 4) reuses the **same** spine. Pure refactor — the tool delegates; behaviour is unchanged.

**Files:**

- Modify: `studio/backend/app/agent_tools.py:586-615` (`build_rebuild_scene_tool`)
- Test: `studio/backend/tests/test_agent_tools.py` (extend — append a direct `rebuild_scene_core` test; if the file does not exist, create it)

**Interfaces:**

- Consumes: `ToolContext`, `_plan_for_game`, `_SceneComposeDeps`, `run_compose`, `BuildElement`, `format_compose_summary` (all already in `agent_tools.py`).
- Produces: `async def rebuild_scene_core(ctx: ToolContext, theme: str = "") -> str` returning one of: `"Rebuild unavailable: no critic wired."`, `"Nothing to rebuild: the scene is empty."`, or `"Rebuilt scene from current design intent. " + format_compose_summary(result)`. `room_id` is NOT used by the spine, so a REST caller may pass `room_id=""`.

- [ ] **Step 1: Write the failing test**

Create/append `studio/backend/tests/test_agent_tools.py`:

```python
import pytest

from app.agent_tools import rebuild_scene_core, ToolContext


@pytest.mark.asyncio
async def test_rebuild_scene_core_reports_no_critic():
    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None)
    assert "no critic" in (await rebuild_scene_core(ctx)).lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_agent_tools.py -k rebuild_scene_core -v`
Expected: FAIL — `ImportError: cannot import name 'rebuild_scene_core'`.

- [ ] **Step 3: Extract the core; tool delegates**

In `studio/backend/app/agent_tools.py`, add a module-level coroutine above `build_rebuild_scene_tool` and shrink the tool to call it:

```python
async def rebuild_scene_core(ctx: ToolContext, theme: str = "") -> str:
    """Re-run bind -> place -> reconcile for every role already in the scene,
    using the CURRENT persisted GDD intent. Shared by the agent tool and the
    REST intent-save path (room_id is unused, so a REST caller may pass "")."""
    if ctx.scene_critic is None or ctx.asset_critic is None:
        return "Rebuild unavailable: no critic wired."
    plan = await _plan_for_game(ctx)
    if ctx.scene_hub is not None:
        await ctx.scene_hub.ensure_root(ctx.game_id, plan.canvas)
    deps = _SceneComposeDeps(ctx)
    handles = await deps.placed_handles()
    if not handles:
        return "Nothing to rebuild: the scene is empty."
    elements = [BuildElement(slot=h, role=h) for h in handles]
    result = await run_compose(elements, theme, deps, plan=plan)
    return "Rebuilt scene from current design intent. " + format_compose_summary(result)


def build_rebuild_scene_tool(ctx: ToolContext) -> BaseTool:
    async def rebuild_scene(theme: str = "") -> str:
        """Re-run bind -> place -> reconcile for every role already in the scene,
        using the CURRENT persisted GDD intent. Use after the art direction or
        layout intent changes so the live scene reflows to the new plan."""
        return await rebuild_scene_core(ctx, theme)

    return StructuredTool.from_function(
        coroutine=rebuild_scene, name="rebuild_scene",
        description=(
            "Reflow the existing scene to the current design intent: re-bind the "
            "layout plan from the GDD (orientation / focal emphasis / framing "
            "density + art direction) and re-place every element into its planned "
            "region, keeping each element's art. Call this AFTER changing art "
            "direction or layout intent so the live game updates."
        ),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_agent_tools.py -k rebuild_scene_core tests/e2e/test_scene_blueprint_compose.py -v`
Expected: PASS — the new core test passes and the A1 blueprint e2e (which drives the rebuild path) is undisturbed.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "refactor(scene): extract rebuild_scene_core shared by agent and REST"
```

---

### Task 4: Intent-rebuild service (intent-field detection + ctx-from-app-state)

A small service module the REST PUT calls: decide whether a save touched an intent field, and if so build a `ToolContext` from the app's shared singletons and run `rebuild_scene_core`. Kept out of `rest.py` so it is unit-testable with fakes and keeps the route thin.

**Files:**

- Create: `studio/backend/app/scene/intent_rebuild.py`
- Test: `studio/backend/tests/test_intent_rebuild.py` (create)

**Interfaces:**

- Consumes: `app.agent_tools.{ToolContext, rebuild_scene_core}`; an `app_state` object exposing `.asset_store`, `.asset_hub`, `.scene_store`, `.scene_hub`, `.gdd_store`, `.scene_critic`, `.asset_critic` (these are set on `app.state` in `main.py`; missing attrs default to `None` via `getattr`).
- Produces:
  - `INTENT_FIELDS: dict[str, set[str]]` = `{"theme": {"art_direction"}, "ui-ux": {"layout", "orientation", "focal_emphasis", "framing_density"}}`
  - `is_intent_change(aspect: str, fields: dict) -> bool` — True iff any saved key is an intent field for that aspect.
  - `async def rebuild_after_intent(app_state, game_id: str) -> str | None` — returns the rebuild summary, or `None` when no critics are wired or the scene is empty (caller treats `None` as "nothing to do").

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_intent_rebuild.py
import pytest

from app.scene.intent_rebuild import INTENT_FIELDS, is_intent_change, rebuild_after_intent


def test_is_intent_change_detects_each_intent_field():
    assert is_intent_change("ui-ux", {"focal_emphasis": "reels"})
    assert is_intent_change("ui-ux", {"orientation": "portrait", "controls": "x"})
    assert is_intent_change("theme", {"art_direction": "gold"})


def test_is_intent_change_ignores_non_intent_fields():
    assert not is_intent_change("ui-ux", {"controls": "tap", "autoplay": "on"})
    assert not is_intent_change("theme", {"name": "X", "tone": "luxe"})
    assert not is_intent_change("math-model", {"rtp": "96%"})


class _State:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


@pytest.mark.asyncio
async def test_rebuild_after_intent_returns_none_without_critics():
    state = _State(asset_store=object(), asset_hub=object(), scene_store=object(),
                   scene_hub=object(), gdd_store=object())  # no critics
    assert await rebuild_after_intent(state, "g1") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_intent_rebuild.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.intent_rebuild`.

- [ ] **Step 3: Create the service**

```python
# studio/backend/app/scene/intent_rebuild.py
"""Bridge the REST GDD save to the scene rebuild spine (HITL Surface 2).

A save that touches an art-direction / layout-intent field should reflow the
live scene the same way the design-router's chat path does — by running the one
`rebuild_scene_core` spine. This module decides "was this an intent edit?" and,
if so, assembles a ToolContext from the app's shared singletons and runs it.
No new persistence; geometry still comes only from the bind.
"""
from app.agent_tools import ToolContext, rebuild_scene_core

INTENT_FIELDS: dict[str, set[str]] = {
    "theme": {"art_direction"},
    "ui-ux": {"layout", "orientation", "focal_emphasis", "framing_density"},
}


def is_intent_change(aspect: str, fields: dict) -> bool:
    keys = INTENT_FIELDS.get(aspect, set())
    return any(k in keys for k in fields)


async def rebuild_after_intent(app_state, game_id: str) -> str | None:
    """Run the rebuild spine for game_id using app_state's singletons. Returns the
    summary string, or None when the rebuild is a no-op (no critics / empty scene)."""
    ctx = ToolContext(
        room_id="",
        game_id=game_id,
        asset_store=getattr(app_state, "asset_store", None),
        asset_hub=getattr(app_state, "asset_hub", None),
        gdd_store=getattr(app_state, "gdd_store", None),
        scene_store=getattr(app_state, "scene_store", None),
        scene_hub=getattr(app_state, "scene_hub", None),
        scene_critic=getattr(app_state, "scene_critic", None),
        asset_critic=getattr(app_state, "asset_critic", None),
    )
    summary = await rebuild_scene_core(ctx)
    if summary.startswith("Rebuild unavailable") or summary.startswith("Nothing to rebuild"):
        return None
    return summary
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_intent_rebuild.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/intent_rebuild.py studio/backend/tests/test_intent_rebuild.py
git commit -m "feat(scene): intent-rebuild service bridging REST save to rebuild spine"
```

---

### Task 5: Wire the REST PUT — emit `gdd_doc_updated` + trigger rebuild

Close the two server-side gaps: the PUT currently calls `store.set_fields` directly (bypassing the hub, so no `gdd_doc_updated` is broadcast), and it never triggers a rebuild. Route it through `gdd_hub.set_fields` (broadcasts to every viewer) and, on an intent-field change, run `rebuild_after_intent`. Synchronous within the request (deterministic; mirrors the agent path). The response gains a `rebuilt` flag for observability/tests.

**Files:**

- Modify: `studio/backend/app/rest.py:117-124` (`set_gdd_fields_rest`)
- Test: `studio/backend/tests/e2e/test_gdd_rest.py` (extend — append the emit + rebuild integration tests)

**Interfaces:**

- Consumes: `request.app.state.gdd_hub` (set in `main.py`), `app.scene.intent_rebuild.{is_intent_change, rebuild_after_intent}`.
- Produces: `PUT /games/{game_id}/gdd/{aspect}` returns `{"doc": <wire>, "warnings": [...], "rebuilt": bool}`. The save goes through the hub (emits `gdd_doc_updated`). When `is_intent_change` and the scene is non-empty, the scene is reflowed before the response returns and `rebuilt` is `True`.

- [ ] **Step 1: Confirm `gdd_hub` is on app.state**

Run: `cd studio/backend && grep -n "gdd_hub" app/main.py`
Expected: `app.state.gdd_hub = ...` (a `GddHub`) exists. If only `gdd_store` is on state, add `app.state.gdd_hub = gdd_hub` in `main.py` next to the other `app.state.*` assignments (the `GddHub` is already constructed there for sockets). Make that addition part of this step if needed.

- [ ] **Step 2: Write the failing test**

Append to `studio/backend/tests/e2e/test_gdd_rest.py` (this suite already drives the FastAPI app with a real replay backend; follow its existing client/fixture style — the snippet below assumes an `async_client` httpx fixture and a `seed a scene` helper analogous to the A1 blueprint e2e; adapt names to the file's existing fixtures):

```python
import pytest
from app.scene.layout.bind import GddIntent, bind


@pytest.mark.asyncio
async def test_put_intent_field_emits_and_rebuilds(blueprint_rest_harness):
    """A PUT to an intent field on a non-empty scene reflows the scene and
    reports rebuilt=True; the reels region grows under focal_emphasis=reels."""
    h = blueprint_rest_harness                      # seeds bg+reels+logo via compose
    gid = h.game_id

    before = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    resp = await h.put_gdd(gid, "ui-ux", {"focal_emphasis": "reels"})
    assert resp["rebuilt"] is True

    plan = bind(GddIntent(focal_emphasis="reels"))
    after = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert after == {"x": plan.for_role("reels").x, "y": plan.for_role("reels").y}
    # reels scaled into its enlarged region
    assert (await h.scene_doc())["nodes"]["spr.reels"]["props"]["scale"]["x"] != before


@pytest.mark.asyncio
async def test_put_orientation_flip_resizes_root_and_reflows(blueprint_rest_harness):
    h = blueprint_rest_harness
    resp = await h.put_gdd(h.game_id, "ui-ux", {"orientation": "portrait"})
    assert resp["rebuilt"] is True
    doc = await h.scene_doc()
    root = next(n for n in doc["nodes"].values() if n["type"] == "Root")
    assert (int(root["props"]["width"]), int(root["props"]["height"])) == (720, 1280)
    plan = bind(GddIntent(orientation="portrait"))
    assert doc["nodes"]["spr.reels"]["props"]["position"] == {
        "x": plan.for_role("reels").x, "y": plan.for_role("reels").y}


@pytest.mark.asyncio
async def test_put_non_intent_field_does_not_rebuild(blueprint_rest_harness):
    h = blueprint_rest_harness
    resp = await h.put_gdd(h.game_id, "ui-ux", {"controls": "tap to spin"})
    assert resp["rebuilt"] is False


@pytest.mark.asyncio
async def test_put_intent_field_is_reproducible(blueprint_rest_harness):
    """Same intent save twice -> identical reels geometry (derivable scene)."""
    h = blueprint_rest_harness
    await h.put_gdd(h.game_id, "ui-ux", {"focal_emphasis": "reels"})
    first = (await h.scene_doc())["nodes"]["spr.reels"]["props"]
    await h.put_gdd(h.game_id, "ui-ux", {"focal_emphasis": "reels"})
    second = (await h.scene_doc())["nodes"]["spr.reels"]["props"]
    assert first["position"] == second["position"]
    assert first["scale"] == second["scale"]
```

Add the `blueprint_rest_harness` fixture to the file. Model it on `compose_harness` in `tests/e2e/test_scene_blueprint_compose.py` (real stores + `ReplaySceneCritic`/`ReplayAssetCritic` + `ReplayComfyProvider`), but assemble them onto a tiny `app.state`-like object so `rebuild_after_intent` can read them, expose `put_gdd(gid, aspect, fields)` calling the real `set_gdd_fields_rest` logic (or the FastAPI app via httpx), `scene_doc()` reading `scene_store.get_document(gid)`, and seed a background+reels+logo scene by invoking `build_compose_scene_tool` once (exactly as the A1 e2e does). Reuse the A1 critic cassettes already in `tests/fixtures/replay/`.

- [ ] **Step 3: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/e2e/test_gdd_rest.py -k "intent or orientation_flip" -v`
Expected: FAIL — the response has no `rebuilt` key / the scene does not reflow.

- [ ] **Step 4: Route through the hub + trigger the rebuild**

In `studio/backend/app/rest.py`, update the imports and the handler:

```python
from app.scene.intent_rebuild import is_intent_change, rebuild_after_intent
```

```python
@router.put("/games/{game_id}/gdd/{aspect}")
async def set_gdd_fields_rest(
    game_id: str, aspect: str, body: SetGddFieldsBody, request: Request
) -> dict:
    hub = request.app.state.gdd_hub
    await request.app.state.gdd_store.seed_taxonomy(game_id)  # idempotent
    doc, warnings = await hub.set_fields(game_id, aspect, body.fields)  # emits gdd_doc_updated
    rebuilt = False
    if is_intent_change(aspect, body.fields):
        rebuilt = (await rebuild_after_intent(request.app.state, game_id)) is not None
    return {"doc": gdd_wire(doc), "warnings": warnings, "rebuilt": rebuilt}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/e2e/test_gdd_rest.py -v`
Expected: PASS — intent saves reflow + report `rebuilt=True`, orientation flip resizes the Root, non-intent saves report `rebuilt=False`, geometry reproduces.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/rest.py studio/backend/tests/e2e/test_gdd_rest.py studio/backend/app/main.py
git commit -m "feat(gdd): PUT emits gdd_doc_updated and reflows scene on intent edits"
```

---

### Task 6: Frontend plumbing — expose `data`, add `setGddFields` + save action

The wire already carries each doc's structured `data` (`gdd_wire` dumps it), but the frontend `IGddDoc` drops it. Surface it, add a REST `setGddFields` client, and a `saveIntentFields` action that PUTs and optimistically reconciles from the response (the websocket `gdd_doc_updated` also lands, and `upsertDoc` is idempotent by aspect).

**Files:**

- Modify: `studio/frontend/src/plugins/gdd/state.ts:9-19` (`IGddDoc`)
- Modify: `studio/frontend/src/plugins/gdd/restClient.ts` (add `setGddFields`)
- Modify: `studio/frontend/src/plugins/gdd/actions.ts` (add `saveIntentFields`)
- Test: `studio/frontend/src/plugins/gdd/restClient.spec.ts` (create), `studio/frontend/src/plugins/gdd/actions.spec.ts` (create)

**Interfaces:**

- Consumes: `BACKEND_URL`, `gddSlice`, `upsertDoc`.
- Produces:
  - `IGddDoc` gains `data: Record<string, unknown>`.
  - `setGddFields(gameId: string, aspect: string, fields: Record<string, unknown>): Promise<{ doc: IGddDoc; warnings: string[]; rebuilt: boolean }>`
  - `saveIntentFields(gameId: string, aspect: string, fields: Record<string, unknown>): Promise<{ rebuilt: boolean; warnings: string[] }>` — PUTs, upserts the returned doc into state, returns `{ rebuilt, warnings }`.

- [ ] **Step 1: Write the failing tests**

```ts
// studio/frontend/src/plugins/gdd/restClient.spec.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setGddFields } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('setGddFields', () => {
  it('PUTs fields to the gdd aspect endpoint and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ doc: { aspect: 'ui-ux', data: { orientation: 'portrait' } }, warnings: [], rebuilt: true }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const res = await setGddFields('g1', 'ui-ux', { orientation: 'portrait' });
    expect(res.rebuilt).toBe(true);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/games\/g1\/gdd\/ui-ux$/);
    expect(init).toMatchObject({ method: 'PUT' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ fields: { orientation: 'portrait' } });
  });
});
```

```ts
// studio/frontend/src/plugins/gdd/actions.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GDD_PLUGIN_ID, gddSlice, makeInitialState, type IGddDoc } from './state';
import * as rest from './restClient';
import { saveIntentFields } from './actions';

const doc = (aspect: string, data: Record<string, unknown>): IGddDoc => ({
  id: aspect,
  gameId: 'g1',
  aspect,
  title: aspect,
  order: 6,
  body: '',
  status: 'drafted',
  data,
  createdAt: '',
  updatedAt: '',
});

beforeEach(() => rootStore.plugins.nested(GDD_PLUGIN_ID).set(makeInitialState() as never));
afterEach(() => vi.restoreAllMocks());

describe('saveIntentFields', () => {
  it('PUTs and upserts the returned doc into state', async () => {
    gddSlice().activeGameId.set('g1');
    gddSlice().docs.set([doc('ui-ux', { orientation: 'landscape' })]);
    vi.spyOn(rest, 'setGddFields').mockResolvedValue({
      doc: doc('ui-ux', { orientation: 'portrait' }),
      warnings: [],
      rebuilt: true,
    });

    const res = await saveIntentFields('g1', 'ui-ux', { orientation: 'portrait' });
    expect(res.rebuilt).toBe(true);
    const updated = gddSlice()
      .docs.get({ noproxy: true })
      .find((d) => d.aspect === 'ui-ux');
    expect(updated?.data.orientation).toBe('portrait');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/frontend && npx nx test frontend -- restClient actions`
Expected: FAIL — `setGddFields`/`saveIntentFields` are not exported.

- [ ] **Step 3: Implement the plumbing**

In `state.ts`, add `data` to `IGddDoc`:

```ts
export interface IGddDoc {
  id: string;
  gameId: string;
  aspect: string;
  title: string;
  order: number;
  body: string;
  status: GddStatus;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

In `restClient.ts`, add the PUT client:

```ts
export interface ISetGddFieldsResult {
  doc: IGddDoc;
  warnings: string[];
  rebuilt: boolean;
}

export async function setGddFields(gameId: string, aspect: string, fields: Record<string, unknown>): Promise<ISetGddFieldsResult> {
  return okJson<ISetGddFieldsResult>(
    await fetch(`${BACKEND_URL}/games/${gameId}/gdd/${aspect}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }),
    }),
  );
}
```

In `actions.ts`, add the save action (import `setGddFields` from `./restClient`, `upsertDoc` from `./reducers`):

```ts
export async function saveIntentFields(gameId: string, aspect: string, fields: Record<string, unknown>): Promise<{ rebuilt: boolean; warnings: string[] }> {
  const res = await setGddFields(gameId, aspect, fields);
  const s = gddSlice();
  s.docs.set(upsertDoc(s.docs.get({ noproxy: true }) as IGddDoc[], res.doc));
  return { rebuilt: res.rebuilt, warnings: res.warnings };
}
```

(Add the needed imports: `import { setGddFields } from './restClient';`, `import { upsertDoc } from './reducers';`, `import type { IGddDoc } from './state';`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx nx test frontend -- restClient actions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/gdd/state.ts studio/frontend/src/plugins/gdd/restClient.ts studio/frontend/src/plugins/gdd/actions.ts studio/frontend/src/plugins/gdd/restClient.spec.ts studio/frontend/src/plugins/gdd/actions.spec.ts
git commit -m "feat(gdd): expose doc.data, add setGddFields + saveIntentFields"
```

---

### Task 7: Editable intent pane (HITL Surface 2)

Render an intent editor for the `theme` and `ui-ux` aspects: textareas for the prose intent fields and selects for the three enums, with a Save button that calls `saveIntentFields`. Other aspects keep the read-only markdown view. The editor pulls current values from `current.data`. Driven by a small static `INTENT_FIELDS` descriptor that mirrors the backend schema (the three enums are stable; documented as the mirror of `app/gdd/schemas.py`).

**Files:**

- Create: `studio/frontend/src/plugins/gdd/intentFields.ts`
- Modify: `studio/frontend/src/plugins/gdd/GddViewerPane.tsx`
- Test: `studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx` (extend)

**Interfaces:**

- Consumes: `gddHooks`, `saveIntentFields`, `current.data`.
- Produces:
  - `intentFields.ts`: `interface IIntentField { key: string; label: string; control: 'textarea' | 'select'; options?: string[] }` and `INTENT_FIELDS: Record<string, IIntentField[]>` for aspects `theme` and `ui-ux`.
  - Editor markup with testids: `gdd-intent-editor` (wrapper), `gdd-intent-<key>` (each control), `gdd-intent-save` (button), `gdd-intent-status` (post-save line, e.g. "Reflowed scene." / "Saved.").

- [ ] **Step 1: Write the failing component test**

Append to `studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx` (note the existing `doc()` helper there must be updated to include `data: {}` to satisfy the new `IGddDoc` — do that as part of this step):

```tsx
import { saveIntentFields } from './actions';
import { fireEvent } from '@testing-library/react';

vi.mock('./actions', () => ({
  openGameDocs: vi.fn(),
  initGdd: vi.fn(),
  saveIntentFields: vi.fn(async () => ({ rebuilt: true, warnings: [] })),
}));

const uiDoc = (data: Record<string, unknown>): IGddDoc => ({
  id: 'ui-ux',
  gameId: 'g1',
  aspect: 'ui-ux',
  title: 'UI / UX & Layout',
  order: 6,
  body: '',
  status: 'drafted',
  data,
  createdAt: '',
  updatedAt: '',
});

describe('GddViewerPane intent editor', () => {
  it('renders enum selects + prose textareas for ui-ux and saves on click', async () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([uiDoc({ orientation: 'landscape', focal_emphasis: 'balanced' })]);
      gddSlice().selectedAspect.set('ui-ux');
    });
    render(<GddViewerPane {...fakeProps} />);
    const select = screen.getByTestId('gdd-intent-orientation') as HTMLSelectElement;
    expect(select.value).toBe('landscape');
    expect(screen.getByTestId('gdd-intent-layout')).toBeTruthy(); // prose textarea

    act(() => fireEvent.change(select, { target: { value: 'portrait' } }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('gdd-intent-save'));
    });
    expect(saveIntentFields).toHaveBeenCalledWith('g1', 'ui-ux', expect.objectContaining({ orientation: 'portrait' }));
  });

  it('shows read-only markdown for non-intent aspects', () => {
    act(() => {
      gddSlice().activeGameId.set('g1');
      gddSlice().docs.set([{ ...uiDoc({}), aspect: 'math-model', title: 'Math Model' }]);
      gddSlice().selectedAspect.set('math-model');
    });
    render(<GddViewerPane {...fakeProps} />);
    expect(screen.queryByTestId('gdd-intent-editor')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx nx test frontend -- GddViewerPane`
Expected: FAIL — no `gdd-intent-*` testids; (and the pre-existing `doc()` helper fails typecheck until `data` is added).

- [ ] **Step 3: Add the descriptor + editor**

```ts
// studio/frontend/src/plugins/gdd/intentFields.ts
// Mirrors the intent fields in studio/backend/app/gdd/schemas.py (theme.art_direction,
// ui-ux.layout + the three Scene-Blueprint enums). The enums are stable; if the backend
// schema changes, update this descriptor.
export interface IIntentField {
  key: string;
  label: string;
  control: 'textarea' | 'select';
  options?: string[];
}

export const INTENT_FIELDS: Record<string, IIntentField[]> = {
  theme: [{ key: 'art_direction', label: 'Art direction', control: 'textarea' }],
  'ui-ux': [
    { key: 'layout', label: 'Layout', control: 'textarea' },
    { key: 'orientation', label: 'Orientation', control: 'select', options: ['portrait', 'landscape'] },
    { key: 'focal_emphasis', label: 'Focal emphasis', control: 'select', options: ['reels', 'logo', 'balanced'] },
    { key: 'framing_density', label: 'Framing density', control: 'select', options: ['clean', 'moderate', 'ornate'] },
  ],
};
```

In `GddViewerPane.tsx`, add an editor for aspects in `INTENT_FIELDS`. Use a local `useState` seeded from `current.data`, re-seeding when the selected aspect changes (keyed remount). Keep the existing markdown view below for context; render the editor only for intent aspects:

```tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { gddHooks } from './state';
import { saveIntentFields } from './actions';
import { INTENT_FIELDS } from './intentFields';
import { Markdown } from '@/components/ui/Markdown';

// ...STATUS_LABEL unchanged...

function IntentEditor({ gameId, aspect, data }: { gameId: string; aspect: string; data: Record<string, unknown> }) {
  const fields = INTENT_FIELDS[aspect];
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, String(data[f.key] ?? '')])));
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSave() {
    setSaving(true);
    setStatus('');
    try {
      const patch = Object.fromEntries(fields.map((f) => [f.key, values[f.key]]).filter(([, v]) => v !== ''));
      const res = await saveIntentFields(gameId, aspect, patch);
      setStatus(res.rebuilt ? 'Reflowed scene.' : 'Saved.');
    } catch {
      setStatus('Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="gdd-intent-editor" className="mb-4 flex flex-col gap-3 border-b border-hairline pb-4">
      {fields.map((f) => (
        <label key={f.key} className="flex flex-col gap-1 text-sm text-text-2">
          <span>{f.label}</span>
          {f.control === 'select' ? (
            <select
              data-testid={`gdd-intent-${f.key}`}
              value={values[f.key] || ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="rounded border border-hairline bg-raised px-2 py-1 text-text-1"
            >
              <option value="">—</option>
              {f.options!.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <textarea
              data-testid={`gdd-intent-${f.key}`}
              value={values[f.key] || ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              rows={3}
              className="rounded border border-hairline bg-raised px-2 py-1 text-text-1"
            />
          )}
        </label>
      ))}
      <div className="flex items-center gap-3">
        <button
          data-testid="gdd-intent-save"
          onClick={onSave}
          disabled={saving}
          className="rounded bg-accent px-3 py-1 text-sm text-accent-text hover:bg-raised-hover disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status && (
          <span data-testid="gdd-intent-status" className="text-sm text-text-3">
            {status}
          </span>
        )}
      </div>
    </div>
  );
}
```

Inside the existing pane, in the content column, render the editor when the selected aspect is editable:

```tsx
<div className="flex-1 overflow-auto p-3">
  {current && INTENT_FIELDS[current.aspect] && <IntentEditor key={current.aspect} gameId={activeGameId} aspect={current.aspect} data={current.data || {}} />}
  <Markdown source={current?.body || ''} />
</div>
```

(If `bg-accent`/`text-accent-text` are not existing token classes, use the accent classes already present in the repo's buttons — confirm against `studio/frontend/src/styles.css`; do not introduce raw colors.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx nx test frontend -- GddViewerPane`
Expected: PASS — editor renders for intent aspects, saves the changed value, and is absent for non-intent aspects.

- [ ] **Step 5: Run all four frontend gates**

Run: `cd studio/frontend && node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
Expected: all green. Fix any prettier/type issues before committing.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/gdd/intentFields.ts studio/frontend/src/plugins/gdd/GddViewerPane.tsx studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx
git commit -m "feat(gdd): editable intent pane (Surface 2) — prose + enum editing"
```

---

### Task 8: Engine `scaleOf` accessor for reflow assertions

The browser e2e proves a reflow by observing a sprite's scale change after a focal-emphasis edit. The Pixi renderer test hook exposes `textureSizeOf`/`anchorOf`/`onStage` but no scale. Add `scaleOf(id)` mirroring `anchorOf`.

**Files:**

- Modify: `runtime/client/src/render/pixiRenderer.ts:223-240` (alongside `textureSizeOf`/`anchorOf`/`onStage`)
- Test: `runtime/client/src/render/pixiRenderer.spec.ts` (extend)

**Interfaces:**

- Consumes: the renderer's existing object registry (same lookup `anchorOf` uses).
- Produces: `scaleOf(id: string): { x: number; y: number } | null` — the display object's current scale, or `null` for an unknown id.

- [ ] **Step 1: Write the failing test**

Append to `runtime/client/src/render/pixiRenderer.spec.ts` (mirror the `anchorOf` test setup already in the file — create a renderer, add a Sprite node, set its scale via a `setProp`/reconcile op as the existing tests do):

```ts
it('scaleOf reports a sprite scale and null for unknown ids', () => {
  const r = makeRenderer(); // use whatever factory the sibling tests use
  r.apply({ kind: 'addNode', id: 's', type: 'Sprite', props: { scale: { x: 0.5, y: 0.5 } } });
  expect(r.scaleOf('s')).toEqual({ x: 0.5, y: 0.5 });
  expect(r.scaleOf('ghost')).toBeNull();
});
```

(Match the exact op/reconcile API the neighbouring `anchorOf`/`onStage` tests use — read them first and copy their style precisely.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts -t scaleOf`
Expected: FAIL — `r.scaleOf is not a function`.

- [ ] **Step 3: Add the accessor**

In `runtime/client/src/render/pixiRenderer.ts`, next to `anchorOf` (read the exact registry lookup it uses and mirror it):

```ts
  scaleOf(id: string): { x: number; y: number } | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    return { x: obj.scale.x, y: obj.scale.y };
  }
```

(Use the same object-map field name `anchorOf` uses — e.g. `this.objects`; adjust if the field differs.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts`
Expected: PASS — `scaleOf` test green, no regression.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.spec.ts
git commit -m "feat(engine): add scaleOf renderer accessor for reflow assertions"
```

---

### Task 9: Browser e2e — edit intent → save → scene reflows (authoritative)

The authoritative A2 contract: seed a scene, open the GDD viewer, change `focal_emphasis` to `logo`, save, and watch the live engine reflow the logo (its planned region grows, so its fit-scale increases). This rides the synchronous PUT→rebuild path end-to-end through the real UI, backend, websocket, and engine. Seed reuses the existing pirate-compose cassette (background + logo); the rebuild after the edit needs critic verdicts for that re-place pass.

**Files:**

- Create: `studio/frontend/e2e/scene-blueprint-intent-edit.spec.ts`
- Create/extend: critic + asset cassettes under `studio/backend/tests/fixtures/replay/` covering the rebuild's re-place pass over `background` + `logo` (hand-authored "keep"/"done" verdicts, per the tuner-chat precedent — see `docs` memory on cassette authoring; record live with `just record-fixtures` if hand-authoring proves brittle)

**Interfaces:**

- Consumes: the running replay stack (worktree-offset ports), the seed cassette `run/compose-pirate-scene.json`, the engine `scaleOf` hook (Task 8), the editable pane testids (Task 7).
- Produces: a green Playwright spec asserting the logo sprite's scale increased after the intent save.

- [ ] **Step 1: Write the e2e spec (expected RED until the stack + cassettes are ready)**

```ts
// studio/frontend/e2e/scene-blueprint-intent-edit.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — HITL Surface 2 contract (Scene Blueprint A2):
//   seed a background+logo scene -> open GDD viewer -> set focal_emphasis=logo -> Save
//   -> PUT triggers rebuild_scene server-side -> the logo reflows into its enlarged
//      planned region (its fit-scale increases) in the live engine.
// Stack (replay): backend :8000+offset, engine, studio. Run: just backend-serve-replay; just e2e
// Cassettes: run/compose-pirate-scene.json (seed) + critic/asset verdicts for the rebuild re-place.

const SEED_PROMPT = 'make a pirate theme game with a background and a logo centered at the top';

async function openAppAtRoom(page: Page, username: string): Promise<string> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Blueprint A2 ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();
  return (await page.evaluate(() => (window as any).__gameActiveId as string))!;
}

async function logoScale(page: Page): Promise<number> {
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  return frame!.evaluate(() => (window as any).__engineRenderer?.scaleOf('spr.logo')?.x ?? 0);
}

test.setTimeout(300_000);

test('editing focal_emphasis in the GDD pane reflows the live scene', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // 1. Seed a scene (background + logo) via the compose cassette.
  await page.getByTestId('chat-composer').fill(SEED_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText('Placed a pirate background and a logo', { timeout: 60_000 });

  // 2. Open the Game Scene pane; wait for the logo to render with a real texture.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => logoScale(page), { timeout: 25_000 }).toBeGreaterThan(0);
  const before = await logoScale(page);

  // 3. Open the GDD viewer, select ui-ux, set focal_emphasis = logo, Save.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-gdd/viewer').click();
  await page.getByTestId('gdd-aspect-ui-ux').click();
  await page.getByTestId('gdd-intent-focal_emphasis').selectOption('logo');
  await page.getByTestId('gdd-intent-save').click();
  await expect(page.getByTestId('gdd-intent-status')).toContainText(/reflow/i, { timeout: 60_000 });

  // 4. The logo reflowed into its enlarged planned region -> larger fit-scale.
  await expect.poll(() => logoScale(page), { timeout: 30_000 }).toBeGreaterThan(before);
});
```

- [ ] **Step 2: Author the rebuild cassettes; bring up the stack**

In a worktree, export the worktree's `BLOOM_PORT_OFFSET` ports, then `just backend-serve-replay`. Run the spec once to discover which critic/asset prompts the rebuild's re-place pass emits (the run will fail on a missing cassette and log the unmatched prompt key). Hand-author the matching verdicts under `studio/backend/tests/fixtures/replay/` — asset verdicts `action="keep"`, scene critiques `done=true` with empty edits (the reflow comes from the deterministic bind at place time, so the critic only needs to say "done"). Re-run until cassettes match. If hand-authoring is too brittle, record live: temporarily run against live providers and `just record-fixtures`, then trim to the rebuild pass.

- [ ] **Step 3: Run the e2e to verify it passes**

Run (from the worktree, offset ports exported): `just e2e` (or target the file via the playwright config: `npx playwright test --config=studio/frontend/playwright.config.ts e2e/scene-blueprint-intent-edit.spec.ts`).
Expected: PASS — the logo scale after the save is strictly greater than before.

- [ ] **Step 4: Guard against regressions in the existing GDD viewer e2e**

Run: `npx playwright test --config=studio/frontend/playwright.config.ts e2e/gdd.spec.ts`
Expected: PASS — the read-only seeding flow still works (the editor is additive; `gdd-aspect-*` testids are unchanged).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/scene-blueprint-intent-edit.spec.ts studio/backend/tests/fixtures/replay/
git commit -m "test(e2e): intent edit reflows the live scene (Scene Blueprint A2 Surface 2)"
```

---

### Task 10: Router-prompt note + whole-branch review

Surface 2 now reflows the scene WITHOUT the agent. The design-router already calls `rebuild_scene` for chat-driven intent edits (Surface 1) — that stays. Add a one-line note so the two paths are documented as sharing the spine, then run the full suites.

**Files:**

- Modify: `studio/backend/app/gdd/router.py:40-45` (a clarifying comment/sentence — no behaviour change)
- No test (doc/comment only); covered by existing router tests staying green.

- [ ] **Step 1: Confirm the existing router tests still pass**

Run: `uv --directory studio/backend run pytest tests/e2e/test_gdd_routing.py tests/e2e/test_gdd_structure_routing.py -v`
Expected: PASS (baseline before the comment edit).

- [ ] **Step 2: Add the note**

In `studio/backend/app/gdd/router.py`, after the branch-1 `rebuild_scene` instruction (~line 45), the prose already covers chat-driven rebuild. Add a short comment above `_BODY_TEMPLATE` (Python comment, not prompt text) documenting that direct GDD edits (REST PUT) trigger the same `rebuild_scene_core` spine via `app.scene.intent_rebuild`, so chat and direct-edit reflow identically. Keep it to 2 lines; do not change the prompt body.

- [ ] **Step 3: Full backend suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: full unit + replay e2e green (the A1 baseline was 542 unit + the blueprint e2e; this branch adds the Task 1/2/3/4/5 tests).

- [ ] **Step 4: Full frontend gates**

Run: `cd studio/frontend && node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/router.py
git commit -m "docs(gdd): note REST intent edits share the rebuild_scene spine"
```

- [ ] **Step 6: Whole-branch review**

Use superpowers:requesting-code-review for the full branch diff against `main`. Confirm: one rebuild spine (no forked compose), no geometry in the GDD/editor, design-language tokens only (no raw colors), the three A3 follow-ups landed (dead `scale` gone, `ensure_root` resizes, handle/role unified), and the browser e2e is the authoritative reflow proof.

---

## Self-Review

**Spec coverage (against `docs/superpowers/specs/2026-06-30-scene-blueprint-design.md`, phase A2 = "editable GDD pane (Surface 2) → rebuild trigger; Playwright: edit → save → reflow"):**

- Editable GDD pane for intent fields (textareas for prose, selects for the three enums) → Task 7. ✅
- Save → existing `PUT /games/{id}/gdd/{aspect}` (`set_fields`) → emits `gdd_doc_updated` → Task 5 (routed through `GddHub`). ✅
- Save triggers `rebuild_scene` → Task 5 via the extracted `rebuild_scene_core` (Task 3) + intent-rebuild service (Task 4). ✅
- Reuses REST + websocket; no new persistence → Tasks 4/5 (no new stores; region overrides remain A3). ✅
- Playwright edit → save → reflow → Task 9 (authoritative), with deterministic geometry proof in the backend e2e (Task 5). ✅
- Carry-forward A3 follow-ups from PR #129: dead `BuildElement.scale` removed + handle→role unified + coverage tests (Task 1); `ensure_root` orientation-flip resize (Task 2). ✅

**Placeholder scan:** every code step shows complete code; cassette authoring (Task 9 Step 2) is inherently discovery-driven and is given an explicit recipe (run → read unmatched key → author "keep"/"done" → re-run, or record live) rather than a literal blob, matching the tuner-chat precedent. Steps that say "mirror the sibling test" point at the exact neighbouring symbol to copy (`anchorOf`, `compose_harness`, `_RecordingDeps`).

**Type consistency:** `rebuild_scene_core(ctx, theme="")` (Task 3) is consumed unchanged by Task 4; `setGddFields`/`saveIntentFields`/`ISetGddFieldsResult` (Task 6) are consumed by Task 7; `IGddDoc.data` (Task 6) is read by Task 7's editor; `scaleOf` (Task 8) is called by Task 9; `is_intent_change`/`rebuild_after_intent` (Task 4) are called by Task 5; `INTENT_FIELDS` keys (`theme`, `ui-ux`) match the backend `INTENT_FIELDS` in Task 4.

**Open assumptions to verify during execution (flagged, not blocking):**

- Task 5 assumes `app.state.gdd_hub` exists; Step 1 verifies and adds it if missing.
- Task 2 assumes the scene store's resize op kind is `setProp`; Step 1 verifies against `scene/store.py`.
- Task 5's `blueprint_rest_harness` and the scene-doc shape (`props.position`, `props.scale.x`) mirror the A1 e2e (`test_scene_blueprint_compose.py`), which asserts exactly those keys.
