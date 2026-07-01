# Scene Blueprint — A3 (Approval Gate + Region Nudge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two remaining HITL surfaces from the Scene Blueprint spec — a human **approval gate** on the agent's `rebuild_scene` (Surface 3) and a **region-override** store + editor form that lets a human nudge a role's geometry which then survives every rebuild (Surface 4) — plus the two carry-forward fixes A2 deferred (anchor as a reflow channel; clearing an intent field).

**Architecture:** Region overrides become the final layer of the pure `bind()` (after focal/density transforms and the A4 refiner seam), read from a new per-game Mongo store inside `_plan_for_game`, so **every** rebuild path (agent chat, REST intent-save, REST nudge-save) picks them up and a nudge survives future rebuilds. The approval gate wraps only the **`rebuild_scene` agent tool** (where LangGraph `interrupt()` works) — it computes a cheap planned-change summary, gates via the existing `interrupt()` mechanism (same one `delete_asset` uses), and calls the ungated `rebuild_scene_core` spine only on approve; REST paths call `rebuild_scene_core` directly and stay synchronous. The region editor is a new read-plan/write-override Dockview plugin modelled on `scene-graph`.

**Tech Stack:** Backend — Python 3 / FastAPI / Pydantic / dataclasses, LangGraph tool seams (`interrupt()`), MongoDB (Motor), pytest (backend replay e2e under `PROVIDER_MODE=replay`). Frontend — React + TypeScript + Hookstate + Dockview, Vitest. Engine — Pixi (`runtime/client`), Vitest. Browser e2e — Playwright (local, authoritative).

## Global Constraints

- **GDD holds NO geometry/coordinates, ever.** Geometry lives in code (`scene/layout/`) + the new **region-override store**. The override store is reproducibility input #2 from the spec (`docs/superpowers/specs/2026-06-30-scene-blueprint-design.md` §Reproducibility). The GDD/IntentEditor stays prose + the three enums only.
- **One rebuild spine.** `rebuild_scene_core` (`agent_tools.py:641`) is the single bind→ensure_root→place→reconcile path. The approval gate and every REST bridge reuse it; do **not** fork a second compose path.
- **Overrides are the FINAL bind layer**, applied AFTER the `LayoutRefiner` (per spec §"The bind step" step 6). `bind()` stays a pure function — the store read happens in the caller (`_plan_for_game` / the REST services), never inside `bind`.
- **Override model:** absolute, per-field-optional, per canonical role: `{x?, y?, region_w?, region_h?, anchor_x?, anchor_y?}`. Only set fields override; unset fields fall through to the plan. Every applied field is clamped to the canvas. Orientation-flip staleness is accepted + documented (a human re-nudges after a flip), mirroring how the spec already documents intent/geometry coupling (§Risks).
- **Approval gate = agent path only, gate-before-apply, Approve/Deny.** `interrupt()` only works inside the LangGraph run; the REST intent-save (S2) and nudge-save (S4) are already explicit human Saves and stay synchronous auto-apply. The gate offers a binary Approve/Deny reusing the existing `ApprovalCard` — "nudge" is the separate Surface-4 form, not a third button.
- **TypeScript interfaces use an `I` prefix** (repo coding standard) — e.g. `IRegionOverride`, `IOverrideView`.
- **Studio UI MUST follow `docs/design-language.md`** — 4 surfaces, 2 hairlines, 3 text tiers, 1 accent. Reuse the token classes already in `GddViewerPane.tsx` (`bg-surface`, `text-text-1/2/3`, `border-hairline`, `bg-raised`, `bg-primary`, `text-primary-foreground`, `hover:bg-primary-hover`). **No raw colors** (a guard test blocks hex/rgb outside `styles.css`).
- **TDD is mandatory:** failing test first, watch it fail, minimal code to pass, refactor. Commit per task.
- **Semantic commits** (Conventional Commits): `<type>(<scope>): <description>`, imperative mood.
- **Canvas:** landscape `(1280, 720)`, portrait `(720, 1280)` (`app.scene.layout.template.canvas_for`).
- **Run backend unit tests:** `uv --directory studio/backend run pytest <path> -v`.
- **Run backend e2e (replay):** `uv --directory studio/backend run pytest tests/e2e/<file> -v` (real in-process Mongo + replay critics; no server subprocess — see `tests/e2e/test_scene_blueprint_compose.py`).
- **Run frontend unit tests:** `cd studio/frontend && npx nx test frontend -- <file>` (vitest). **Before any frontend push run all four gates** (`node_modules/.bin/prettier --check .`, `nx typecheck frontend`, `nx test frontend`, `nx build frontend`) — vitest green ≠ types valid.
- **Run engine (runtime/client) unit tests:** `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts`.
- **Browser e2e is local-only, never CI.** Start a replay backend first (`just backend-serve-replay`). This work happens in the worktree `C:\code\bloom.wt\scene-blueprint-a3` with **`BLOOM_PORT_OFFSET=1`** → backend **8001** / frontend **4201** / runtime **4301** — export the offset ports and NEVER the defaults (:8000/:4200/:4300), which another live session owns.

---

### Task 1: `bind()` gains an absolute region-override layer (pure)

The keystone. Extend the pure `bind()` so a per-game override map replaces set fields on each `PlannedRole` as the **final** layer (after focal/density transforms and the refiner). Absolute values, per-field-optional, clamped to canvas. No store, no I/O — overrides are passed in.

**Files:**

- Modify: `studio/backend/app/scene/layout/bind.py` (`bind` signature + a new `_apply_overrides`)
- Test: `studio/backend/tests/test_layout_bind.py` (extend — append override tests)

**Interfaces:**

- Consumes: `ScenePlan`, `PlannedRole`, `canonical_role` (from `app.scene.layout.plan`).
- Produces: `bind(intent: GddIntent, overrides: dict[str, "RegionOverride | dict"] | None = None, refiner: LayoutRefiner | None = None) -> ScenePlan`. `overrides` is keyed by role (any alias; canonicalized internally); each value is a `RegionOverride` (Task 2) **or** a plain dict with any of `x, y, region_w, region_h, anchor_x, anchor_y`. `_apply_overrides(plan, overrides) -> ScenePlan` replaces only the provided fields on the matching role, clamped to `[0, canvas]` (sizes to `[1, canvas]`, anchors to `[0, 1]`); unknown/absent roles are skipped.

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_layout_bind.py`:

```python
def test_override_replaces_only_set_fields():
    base = bind(GddIntent()).for_role("reels")
    plan = bind(GddIntent(), overrides={"reels": {"x": 100.0, "region_w": 200}})
    r = plan.for_role("reels")
    assert (r.x, r.region_w) == (100.0, 200)
    # untouched fields fall through to the plan
    assert (r.y, r.region_h, r.anchor_x) == (base.y, base.region_h, base.anchor_x)


def test_override_accepts_role_aliases():
    plan = bind(GddIntent(), overrides={"reel_frame": {"y": 42.0}})
    assert plan.for_role("reels").y == 42.0


def test_override_is_clamped_to_canvas():
    # landscape canvas is 1280x720; out-of-range values clamp
    plan = bind(GddIntent(), overrides={"reels": {"x": 9999.0, "y": -50.0,
                                                  "region_w": 99999, "anchor_x": 5.0}})
    r = plan.for_role("reels")
    assert r.x == 1280.0 and r.y == 0.0
    assert r.region_w == 1280 and r.anchor_x == 1.0


def test_override_for_absent_role_is_ignored():
    # 'clean' density drops flourishes; an override for one is a no-op, not a crash
    plan = bind(GddIntent(framing_density="clean"),
                overrides={"flourish_left": {"x": 10.0}})
    assert plan.for_role("flourish_left") is None


def test_bind_without_overrides_is_unchanged():
    assert bind(GddIntent()).for_role("reels") == bind(GddIntent(), overrides=None).for_role("reels")
    assert bind(GddIntent()).for_role("reels") == bind(GddIntent(), overrides={}).for_role("reels")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_layout_bind.py -k override -v`
Expected: FAIL — `bind()` has no `overrides` parameter (`TypeError: bind() got an unexpected keyword argument 'overrides'`).

- [ ] **Step 3: Implement the override layer**

In `studio/backend/app/scene/layout/bind.py`, add the import and helper, and thread `overrides` through `bind`. Update the imports at the top:

```python
from dataclasses import dataclass, field, replace

from app.scene.layout.template import (
    TEMPLATE_VERSION, RoleRegion, canvas_for, template_for,
    REELS, LOGO, FLOURISH_LEFT, FLOURISH_RIGHT,
)
from app.scene.layout.plan import ScenePlan, PlannedRole, resolve_region, canonical_role
```

Add the helper above `bind`:

```python
def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _apply_overrides(plan: ScenePlan, overrides: dict | None) -> ScenePlan:
    """Replace set fields on each role's PlannedRole from a per-game override map.
    Absolute values, per-field-optional, clamped to the canvas. The FINAL bind
    layer (spec §bind step 6): applied after the refiner so a human nudge always
    wins, yet only for the fields it sets."""
    if not overrides:
        return plan
    cw, ch = plan.canvas
    roles = dict(plan.roles)
    for role, ov in overrides.items():
        key = canonical_role(role)
        pr = roles.get(key) if key else None
        if pr is None:
            continue  # unknown / dropped role -> no-op
        fields = ov.as_set_fields() if hasattr(ov, "as_set_fields") else {
            k: v for k, v in dict(ov).items() if v is not None}
        upd: dict = {}
        if "x" in fields:
            upd["x"] = _clamp(float(fields["x"]), 0.0, cw)
        if "y" in fields:
            upd["y"] = _clamp(float(fields["y"]), 0.0, ch)
        if "region_w" in fields:
            upd["region_w"] = int(_clamp(float(fields["region_w"]), 1.0, cw))
        if "region_h" in fields:
            upd["region_h"] = int(_clamp(float(fields["region_h"]), 1.0, ch))
        if "anchor_x" in fields:
            upd["anchor_x"] = _clamp(float(fields["anchor_x"]), 0.0, 1.0)
        if "anchor_y" in fields:
            upd["anchor_y"] = _clamp(float(fields["anchor_y"]), 0.0, 1.0)
        roles[key] = replace(pr, **upd)
    return replace(plan, roles=roles)
```

Replace `bind` so overrides apply last:

```python
def bind(intent: GddIntent, overrides: dict | None = None,
         refiner: LayoutRefiner | None = None) -> ScenePlan:
    canvas = canvas_for(intent.orientation)
    regions = template_for(intent.orientation)
    regions = _apply_focal(regions, intent.focal_emphasis)
    regions = _apply_density(regions, intent.framing_density)

    roles = {
        role: resolve_region(region, canvas,
                             prompt_snippet=intent.role_snippets.get(role, ""))
        for role, region in regions.items()
    }
    plan = ScenePlan(
        canvas=canvas,
        orientation=intent.orientation or "landscape",
        template_version=TEMPLATE_VERSION,
        roles=roles,
    )
    plan = (refiner or NoopRefiner()).refine(plan, intent)
    return _apply_overrides(plan, overrides)  # FINAL layer, after the refiner
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_layout_bind.py -v`
Expected: PASS — the override tests plus every pre-existing bind test stay green.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/layout/bind.py studio/backend/tests/test_layout_bind.py
git commit -m "feat(scene): apply per-game region overrides as the final bind layer"
```

---

### Task 2: `RegionOverride` model + `RegionOverrideStore` (persistence)

The per-game store the spec calls reproducibility input #2. A tiny Mongo-backed store holding `game_id -> {canonical_role -> {set fields}}`, mirroring `GameSceneStore`'s shape (one collection, `_id = game_id`).

**Files:**

- Create: `studio/backend/app/scene/layout/overrides.py`
- Test: `studio/backend/tests/test_region_overrides.py` (create)

**Interfaces:**

- Consumes: a Motor db handle (`mongo_db` fixture in tests; `mongo[settings.mongo_db]` in `main.py`).
- Produces:
  - `@dataclass(frozen=True) RegionOverride` with optional `x, y, region_w, region_h, anchor_x, anchor_y` and `as_set_fields() -> dict` (only non-`None` fields).
  - `RegionOverrideStore(db)` with `async get(game_id) -> dict[str, RegionOverride]`, `async set_role(game_id, role, override: RegionOverride) -> None` (merges the set fields onto any existing override for that role), `async clear_role(game_id, role) -> None`. **Callers pass already-canonical role keys** (canonicalization happens at the REST/service boundary, Task 5).

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_region_overrides.py`:

```python
import pytest

from app.scene.layout.overrides import RegionOverride, RegionOverrideStore


def test_as_set_fields_drops_none():
    assert RegionOverride(x=10.0, region_w=200).as_set_fields() == {"x": 10.0, "region_w": 200}
    assert RegionOverride().as_set_fields() == {}


@pytest.mark.asyncio
async def test_set_get_roundtrip(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=100.0, region_w=300))
    got = await store.get("g1")
    assert got["reels"].x == 100.0 and got["reels"].region_w == 300
    assert got["reels"].y is None


@pytest.mark.asyncio
async def test_set_role_merges_fields(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=100.0))
    await store.set_role("g1", "reels", RegionOverride(y=50.0))
    got = (await store.get("g1"))["reels"]
    assert (got.x, got.y) == (100.0, 50.0)  # x survives the second write


@pytest.mark.asyncio
async def test_clear_role_removes_only_that_role(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=1.0))
    await store.set_role("g1", "logo", RegionOverride(y=2.0))
    await store.clear_role("g1", "reels")
    got = await store.get("g1")
    assert "reels" not in got and got["logo"].y == 2.0


@pytest.mark.asyncio
async def test_get_missing_game_is_empty(mongo_db):
    assert await RegionOverrideStore(mongo_db).get("nope") == {}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_region_overrides.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.layout.overrides`.

- [ ] **Step 3: Create the model + store**

```python
# studio/backend/app/scene/layout/overrides.py
"""Per-game region overrides — the human-editable geometry layer (HITL Surface 4).

Reproducibility input #2 (spec §Reproducibility): a small per-game store of
`role -> {set fields}` that `bind()` applies as its final layer. Absolute,
per-field-optional; only the fields a human set are stored. Role keys are
already-canonical (the REST/service boundary canonicalizes before calling here).
"""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class RegionOverride:
    x: float | None = None
    y: float | None = None
    region_w: int | None = None
    region_h: int | None = None
    anchor_x: float | None = None
    anchor_y: float | None = None

    def as_set_fields(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


class RegionOverrideStore:
    """Mongo-backed `game_id -> {role -> {set fields}}`. One collection, _id=game_id,
    mirroring GameSceneStore's single-document-per-game shape."""

    def __init__(self, db):
        self._c = db["region_overrides"]

    async def get(self, game_id: str) -> dict[str, RegionOverride]:
        raw = await self._c.find_one({"_id": game_id})
        if not raw:
            return {}
        return {role: RegionOverride(**fields)
                for role, fields in raw.get("overrides", {}).items()}

    async def set_role(self, game_id: str, role: str, override: RegionOverride) -> None:
        raw = await self._c.find_one({"_id": game_id})
        overrides = dict(raw.get("overrides", {})) if raw else {}
        merged = {**overrides.get(role, {}), **override.as_set_fields()}
        overrides[role] = merged
        await self._c.replace_one(
            {"_id": game_id}, {"_id": game_id, "overrides": overrides}, upsert=True)

    async def clear_role(self, game_id: str, role: str) -> None:
        raw = await self._c.find_one({"_id": game_id})
        if not raw:
            return
        overrides = dict(raw.get("overrides", {}))
        if role in overrides:
            del overrides[role]
            await self._c.replace_one(
                {"_id": game_id}, {"_id": game_id, "overrides": overrides}, upsert=True)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_region_overrides.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/layout/overrides.py studio/backend/tests/test_region_overrides.py
git commit -m "feat(scene): per-game RegionOverrideStore (reproducibility input #2)"
```

---

### Task 3: Wire the override store into every rebuild via `_plan_for_game`

Make `_plan_for_game` read overrides and pass them to `bind()`, so all three rebuild paths honour them. Add the `region_override_store` field to `ToolContext` and thread the singleton through `RoomHub` (agent path) + `main.py`.

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (`ToolContext` dataclass `:24-41`; `_plan_for_game` `:595-601`)
- Modify: `studio/backend/app/room_hub.py` (`__init__` `:14-55` add param + `self._region_override_store`; `ToolContext(...)` `:294-301` pass it)
- Modify: `studio/backend/app/main.py` (construct `RegionOverrideStore`, pass to `RoomHub`, set `app.state.region_override_store`)
- Test: `studio/backend/tests/test_plan_for_game.py` (create)

**Interfaces:**

- Consumes: `RegionOverrideStore` (Task 2), `bind(..., overrides=...)` (Task 1).
- Produces: `ToolContext.region_override_store: object = None`. `_plan_for_game(ctx)` now binds `bind(intent, overrides=<store.get or {}>)`. `RoomHub.__init__` gains keyword `region_override_store=None`; `main.py` sets `fastapi_app.state.region_override_store`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_plan_for_game.py`:

```python
import pytest

from app.agent_tools import ToolContext, _plan_for_game
from app.scene.layout.overrides import RegionOverride, RegionOverrideStore


@pytest.mark.asyncio
async def test_plan_for_game_applies_stored_overrides(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=123.0))
    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      gdd_store=None, region_override_store=store)
    plan = await _plan_for_game(ctx)
    assert plan.for_role("reels").x == 123.0


@pytest.mark.asyncio
async def test_plan_for_game_without_store_is_plain_bind(mongo_db):
    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      gdd_store=None)  # no override store
    plan = await _plan_for_game(ctx)
    assert plan.for_role("reels") is not None  # falls back to template defaults
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_plan_for_game.py -v`
Expected: FAIL — `ToolContext.__init__() got an unexpected keyword argument 'region_override_store'`.

- [ ] **Step 3: Add the field + read overrides**

In `studio/backend/app/agent_tools.py`, add the field to `ToolContext` (after `asset_critic`, `:41`):

```python
    scene_critic: object = None
    capture_broker: object = None
    asset_critic: object = None
    region_override_store: object = None
```

Replace `_plan_for_game` (`:595-601`):

```python
async def _plan_for_game(ctx: ToolContext) -> ScenePlan:
    """Bind a ScenePlan from the game's persisted GDD intent + any per-game region
    overrides. Falls back to the default landscape template when no GDD store is
    present; overrides are the final bind layer so a human nudge survives rebuild."""
    from app.scene.layout.bind import GddIntent
    intent = GddIntent()
    if ctx.gdd_store is not None:
        intent = await read_intent(ctx.gdd_store, ctx.game_id)
    overrides: dict = {}
    if ctx.region_override_store is not None:
        overrides = await ctx.region_override_store.get(ctx.game_id)
    return bind(intent, overrides=overrides)
```

In `studio/backend/app/room_hub.py`, add the constructor param (in the `__init__` signature block near the other `*_store` kwargs, `:14-43`) and the assignment (next to `self._scene_store = scene_store`, `:48`):

```python
        region_override_store=None,
```

```python
        self._region_override_store = region_override_store
```

Then pass it into the `ToolContext(...)` build (`:294-301`), appended to the kwargs:

```python
                         scene_critic=self._scene_critic,
                         capture_broker=self._capture_broker,
                         asset_critic=self._asset_critic,
                         region_override_store=self._region_override_store)
```

In `studio/backend/app/main.py`, construct the store next to `scene_store` (`:96-97`):

```python
    region_override_store = RegionOverrideStore(mongo[settings.mongo_db])
```

Add the import near the other scene imports at the top of `main.py`:

```python
    from app.scene.layout.overrides import RegionOverrideStore
```

(If `main.py` uses module-top imports rather than in-function imports, add `from app.scene.layout.overrides import RegionOverrideStore` alongside the existing `from app.scene...` imports instead.)

Pass it to `RoomHub(...)` (append inside the call, `:123-133`):

```python
        scene_critic=scene_critic, capture_broker=capture_broker,
        asset_critic=asset_critic,
        region_override_store=region_override_store,
```

And expose it on app state (next to `fastapi_app.state.scene_store`, `:144`):

```python
    fastapi_app.state.region_override_store = region_override_store
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_plan_for_game.py tests/e2e/test_scene_blueprint_compose.py -v`
Expected: PASS — overrides flow through `_plan_for_game`, and the A1 blueprint e2e (which drives the rebuild path) is undisturbed.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/room_hub.py studio/backend/app/main.py studio/backend/tests/test_plan_for_game.py
git commit -m "feat(scene): thread region-override store into _plan_for_game rebuilds"
```

---

### Task 4: Anchor as a reflow channel (carry-forward fix a)

The reflow `setProp` path in `_place_in_scene` (`agent_tools.py:174-192`) intentionally omits `anchor` (A2 assumed all roles stay at 0.5). A region override CAN set `anchor_x`/`anchor_y`, so the reflow must now emit anchor setProps or an anchor nudge would persist in the plan yet never reach the sprite.

**Files:**

- Modify: `studio/backend/app/agent_tools.py:174-192` (reflow `ops` list in `_place_in_scene`)
- Test: `studio/backend/tests/test_reflow_anchor.py` (create)

**Interfaces:**

- Consumes: the existing `build_sprite_ops` output `sp` (it already carries `anchor`).
- Produces: the reflow `setProp` op list now includes `anchor.x` / `anchor.y` when the sprite already exists. No signature change.

- [ ] **Step 1: Confirm `sp` carries an anchor**

Run: `cd studio/backend && grep -n "anchor" app/scene/compose.py | head`
Expected: `build_sprite_ops` writes an `anchor` into the sprite props (an `{"x": .., "y": ..}` dict). Note the exact key path it uses (`sp["anchor"]["x"]`). If the key differs (e.g. `anchorX`), use that exact shape in Step 3.

- [ ] **Step 2: Write the failing test**

Create `studio/backend/tests/test_reflow_anchor.py`. This drives `_place_in_scene` through a fake hub that records the ops, with a pre-existing sprite so the reflow branch runs:

```python
import pytest

from app.agent_tools import _place_in_scene, ToolContext


class _RecordingHub:
    def __init__(self):
        self.batches = []

    async def ensure_root(self, game_id, canvas):
        return {"root_id": "root", "canvas": canvas}

    async def apply_batch(self, game_id, ops):
        self.batches.append(ops)
        return {"nodes": {}}


class _StoreWithSprite:
    async def get_document(self, game_id):
        # a Root plus an already-placed reels sprite -> forces the reflow branch
        return {"nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.reels": {"id": "spr.reels", "type": "Sprite", "props": {}},
        }}


@pytest.mark.asyncio
async def test_reflow_emits_anchor_setprops():
    hub = _RecordingHub()
    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      scene_store=_StoreWithSprite(), scene_hub=hub)
    await _place_in_scene(
        ctx, handle="reels", src="/media/x.png", role="reels", parent="root",
        x=100.0, y=200.0, anchor_x=0.1, anchor_y=0.9, fit="region", z_index=20,
        tex_size=(512, 512), region_w=400, region_h=300,
    )
    ops = hub.batches[0]
    paths = {(o["path"], o["value"]) for o in ops if o["kind"] == "setProp"}
    assert ("anchor.x", 0.1) in paths
    assert ("anchor.y", 0.9) in paths
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_reflow_anchor.py -v`
Expected: FAIL — the reflow op list has no `anchor.x` / `anchor.y` entries.

- [ ] **Step 4: Emit anchor in the reflow op list**

In `studio/backend/app/agent_tools.py`, update the reflow `ops` list (`:178-192`). Replace the "anchor intentionally omitted" comment and add the two anchor setProps:

```python
            sp = sprite_addnode["props"]
            # Reflow updates position/scale/zIndex/anchor/role. anchor IS emitted
            # now (A3): a region override can set anchor_x/anchor_y, so the reflow
            # must carry it through or an anchor nudge would never reach the sprite.
            ops = [
                {"kind": "setProp", "id": sprite_id, "path": "position.x",
                 "value": sp["position"]["x"]},
                {"kind": "setProp", "id": sprite_id, "path": "position.y",
                 "value": sp["position"]["y"]},
                {"kind": "setProp", "id": sprite_id, "path": "scale.x",
                 "value": sp["scale"]["x"]},
                {"kind": "setProp", "id": sprite_id, "path": "scale.y",
                 "value": sp["scale"]["y"]},
                {"kind": "setProp", "id": sprite_id, "path": "anchor.x",
                 "value": sp["anchor"]["x"]},
                {"kind": "setProp", "id": sprite_id, "path": "anchor.y",
                 "value": sp["anchor"]["y"]},
                {"kind": "setProp", "id": sprite_id, "path": "zIndex",
                 "value": sp["zIndex"]},
            ]
            if role:
                ops.append({"kind": "setProp", "id": sprite_id, "path": "role",
                            "value": role})
```

(If Step 1 found `build_sprite_ops` does not always include an `anchor` key, guard the two anchor ops with `if "anchor" in sp:` — but for a region-fit sprite it is always present.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_reflow_anchor.py tests/e2e/test_gdd_rest.py -v`
Expected: PASS — anchor setProps emit, and the A2 intent-reflow e2e (which exercises the same reflow branch) still passes (anchors stay 0.5 there, so positions/scales are unchanged).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_reflow_anchor.py
git commit -m "fix(scene): emit anchor setProps on reflow so anchor nudges take effect"
```

---

### Task 5: `override_rebuild` service — set/clear + reflow + editor view

The REST-side bridge (mirrors `scene/intent_rebuild.py`): canonicalize the role, persist the override, reflow through `rebuild_scene_core`, and provide the editor's read model (plan defaults + stored overrides). Kept out of `rest.py` so it is unit-testable with fakes.

**Files:**

- Create: `studio/backend/app/scene/override_rebuild.py`
- Test: `studio/backend/tests/test_override_rebuild.py` (create)

**Interfaces:**

- Consumes: `app.agent_tools.{ToolContext, rebuild_scene_core}`, `app.scene.layout.overrides.RegionOverride`, `app.scene.layout.bind.{GddIntent, bind}`, `app.scene.layout.intent.read_intent`, `app.scene.layout.plan.canonical_role`; an `app_state` exposing the same singletons `intent_rebuild` reads **plus** `region_override_store`.
- Produces:
  - `async set_override_and_rebuild(app_state, game_id, role, override: RegionOverride) -> str | None` — canonicalize role (return `None` if unknown), persist, reflow; `None` when the reflow is a no-op or the role is unknown.
  - `async clear_override_and_rebuild(app_state, game_id, role) -> str | None`.
  - `async override_view(app_state, game_id) -> dict` — `{"canvas": [w, h], "plan": {role: {x, y, region_w, region_h, anchor_x, anchor_y}}, "overrides": {role: {set fields}}}`. `plan` is bind WITHOUT overrides (the defaults the form shows as placeholders).

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_override_rebuild.py`:

```python
import pytest
from types import SimpleNamespace

from app.scene.layout.overrides import RegionOverride, RegionOverrideStore
from app.scene.override_rebuild import (
    set_override_and_rebuild, clear_override_and_rebuild, override_view,
)


@pytest.mark.asyncio
async def test_set_override_unknown_role_returns_none(mongo_db):
    state = SimpleNamespace(region_override_store=RegionOverrideStore(mongo_db))
    assert await set_override_and_rebuild(state, "g1", "nonsense", RegionOverride(x=1.0)) is None


@pytest.mark.asyncio
async def test_set_override_persists_even_when_rebuild_is_noop(mongo_db):
    # no critics/scene wired -> rebuild is a no-op (None), but the override must persist
    store = RegionOverrideStore(mongo_db)
    state = SimpleNamespace(region_override_store=store)
    result = await set_override_and_rebuild(state, "g1", "reel_frame", RegionOverride(x=77.0))
    assert result is None
    assert (await store.get("g1"))["reels"].x == 77.0  # canonicalized + stored


@pytest.mark.asyncio
async def test_clear_override_removes_it(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=5.0))
    state = SimpleNamespace(region_override_store=store)
    await clear_override_and_rebuild(state, "g1", "reels")
    assert "reels" not in await store.get("g1")


@pytest.mark.asyncio
async def test_override_view_shows_plan_defaults_and_overrides(mongo_db):
    store = RegionOverrideStore(mongo_db)
    await store.set_role("g1", "reels", RegionOverride(x=99.0))
    state = SimpleNamespace(region_override_store=store, gdd_store=None)
    view = await override_view(state, "g1")
    assert view["canvas"] == [1280, 720]
    assert "reels" in view["plan"] and "region_w" in view["plan"]["reels"]
    assert view["overrides"]["reels"] == {"x": 99.0}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_override_rebuild.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.override_rebuild`.

- [ ] **Step 3: Create the service**

```python
# studio/backend/app/scene/override_rebuild.py
"""Bridge REST region-override edits to the scene rebuild spine (HITL Surface 4).

A human nudging a role's region persists a per-game override, then the scene
reflows through the SAME rebuild_scene_core spine the intent-save path uses — so
the nudge shows live and survives future rebuilds. Geometry lives here + in the
override store, never in the GDD.
"""
import logging

from app.agent_tools import ToolContext, rebuild_scene_core
from app.scene.layout.bind import GddIntent, bind
from app.scene.layout.intent import read_intent
from app.scene.layout.overrides import RegionOverride
from app.scene.layout.plan import canonical_role

log = logging.getLogger(__name__)


def _ctx(app_state, game_id: str) -> ToolContext:
    return ToolContext(
        room_id="",
        game_id=game_id,
        asset_store=getattr(app_state, "asset_store", None),
        asset_hub=getattr(app_state, "asset_hub", None),
        gdd_store=getattr(app_state, "gdd_store", None),
        scene_store=getattr(app_state, "scene_store", None),
        scene_hub=getattr(app_state, "scene_hub", None),
        scene_critic=getattr(app_state, "scene_critic", None),
        asset_critic=getattr(app_state, "asset_critic", None),
        region_override_store=getattr(app_state, "region_override_store", None),
    )


async def _rebuild(app_state, game_id: str) -> str | None:
    """Best-effort reflow: the override is already persisted, so a live-mode
    critic/LLM/store error must not fail the nudge's PUT."""
    try:
        summary = await rebuild_scene_core(_ctx(app_state, game_id))
    except Exception:  # noqa: BLE001 — reflow is best-effort; the override stays authoritative
        log.warning("scene reflow after region nudge failed for game %s", game_id, exc_info=True)
        return None
    if summary.startswith("Rebuild unavailable") or summary.startswith("Nothing to rebuild"):
        return None
    return summary


async def set_override_and_rebuild(app_state, game_id: str, role: str,
                                   override: RegionOverride) -> str | None:
    key = canonical_role(role)
    if key is None:
        return None
    store = getattr(app_state, "region_override_store", None)
    if store is not None:
        await store.set_role(game_id, key, override)
    return await _rebuild(app_state, game_id)


async def clear_override_and_rebuild(app_state, game_id: str, role: str) -> str | None:
    key = canonical_role(role)
    if key is None:
        return None
    store = getattr(app_state, "region_override_store", None)
    if store is not None:
        await store.clear_role(game_id, key)
    return await _rebuild(app_state, game_id)


async def override_view(app_state, game_id: str) -> dict:
    """The editor read model: plan defaults (NO overrides) as placeholders + the
    stored overrides for the form's current values."""
    gdd_store = getattr(app_state, "gdd_store", None)
    intent = await read_intent(gdd_store, game_id) if gdd_store is not None else GddIntent()
    base = bind(intent)  # no overrides -> the defaults the human nudges away from
    plan = {role: {"x": pr.x, "y": pr.y, "region_w": pr.region_w,
                   "region_h": pr.region_h, "anchor_x": pr.anchor_x,
                   "anchor_y": pr.anchor_y}
            for role, pr in base.roles.items()}
    store = getattr(app_state, "region_override_store", None)
    ovr = await store.get(game_id) if store is not None else {}
    overrides = {role: o.as_set_fields() for role, o in ovr.items()}
    return {"canvas": list(base.canvas), "plan": plan, "overrides": overrides}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_override_rebuild.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/override_rebuild.py studio/backend/tests/test_override_rebuild.py
git commit -m "feat(scene): override-rebuild service bridging REST nudge to rebuild spine"
```

---

### Task 6: REST override routes + backend e2e (persist → reflow → survive rebuild)

Expose the override service over REST and prove the reproducibility contract end-to-end on a real replay scene: a nudge persists, reflows the role into its overridden region, and **survives a later rebuild**.

**Files:**

- Modify: `studio/backend/app/rest.py` (add `RegionOverrideBody` + three routes; import the service)
- Test: `studio/backend/tests/e2e/test_scene_overrides_rest.py` (create — extend the `_BlueprintRestHarness` pattern with an override store)

**Interfaces:**

- Consumes: `request.app.state.{region_override_store, ...}`, `app.scene.override_rebuild.{set_override_and_rebuild, clear_override_and_rebuild, override_view}`.
- Produces:
  - `GET /games/{game_id}/scene/overrides` → the `override_view` dict.
  - `PUT /games/{game_id}/scene/overrides/{role}` body `{x?, y?, region_w?, region_h?, anchor_x?, anchor_y?}` → `{"rebuilt": bool}`.
  - `DELETE /games/{game_id}/scene/overrides/{role}` → `{"rebuilt": bool}`.

- [ ] **Step 1: Add the routes**

In `studio/backend/app/rest.py`, add the import (next to the intent-rebuild import, `:8`):

```python
from app.scene.override_rebuild import (
    set_override_and_rebuild, clear_override_and_rebuild, override_view,
)
from app.scene.layout.overrides import RegionOverride
```

Add the body model near the other `BaseModel`s (after `SetGddFieldsBody`, `:27-28`):

```python
class RegionOverrideBody(BaseModel):
    x: float | None = None
    y: float | None = None
    region_w: int | None = None
    region_h: int | None = None
    anchor_x: float | None = None
    anchor_y: float | None = None
```

Add the three routes after `set_gdd_fields_rest` (`:129`):

```python
@router.get("/games/{game_id}/scene/overrides")
async def get_scene_overrides(game_id: str, request: Request) -> dict:
    return await override_view(request.app.state, game_id)


@router.put("/games/{game_id}/scene/overrides/{role}")
async def put_scene_override(
    game_id: str, role: str, body: RegionOverrideBody, request: Request
) -> dict:
    override = RegionOverride(**body.model_dump())
    summary = await set_override_and_rebuild(request.app.state, game_id, role, override)
    return {"rebuilt": summary is not None}


@router.delete("/games/{game_id}/scene/overrides/{role}")
async def delete_scene_override(game_id: str, role: str, request: Request) -> dict:
    summary = await clear_override_and_rebuild(request.app.state, game_id, role)
    return {"rebuilt": summary is not None}
```

- [ ] **Step 2: Write the failing e2e**

Create `studio/backend/tests/e2e/test_scene_overrides_rest.py`. Reuse the `blueprint_rest_harness` fixture from `tests/e2e/test_gdd_rest.py` (import it so pytest collects the fixture), and add an override store to its `state`, plus thin `put_override`/`del_override`/`overrides` helpers that replicate the route bodies in-process (the same way the harness's `put_gdd` replicates `set_gdd_fields_rest`):

```python
import pytest

# Reuse the A2 in-process harness (real stores + replay critics + seeded scene).
from tests.e2e.test_gdd_rest import blueprint_rest_harness  # noqa: F401
from app.scene.layout.overrides import RegionOverride, RegionOverrideStore
from app.scene.override_rebuild import (
    set_override_and_rebuild, clear_override_and_rebuild,
)


async def _put_override(h, role, **fields):
    return await set_override_and_rebuild(h._state, h.game_id, role, RegionOverride(**fields))


@pytest.fixture
def with_override_store(blueprint_rest_harness):
    """Attach a real RegionOverrideStore to the harness's app.state namespace."""
    h = blueprint_rest_harness
    h._state.region_override_store = RegionOverrideStore(h._state.scene_store._scenes.database)
    return h


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_nudge_persists_and_reflows_reels(with_override_store):
    h = with_override_store
    await _put_override(h, "reels", x=140.0)
    pos = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert pos["x"] == 140.0  # the sprite reflowed to the overridden x


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_override_survives_a_later_intent_rebuild(with_override_store):
    """The reproducibility contract: an override applied now is still honoured
    after an unrelated intent rebuild runs (bind re-applies it as the final layer)."""
    h = with_override_store
    await _put_override(h, "reels", x=140.0)
    # a later, unrelated rebuild (e.g. an intent edit) must NOT lose the nudge
    await h.put_gdd(h.game_id, "ui-ux", {"framing_density": "ornate"})
    pos = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert pos["x"] == 140.0  # override still wins


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_clear_override_restores_plan(with_override_store):
    h = with_override_store
    plan_x = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]["x"]
    await _put_override(h, "reels", x=140.0)
    await clear_override_and_rebuild(h._state, h.game_id, "reels")
    pos = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert pos["x"] == plan_x  # back to the plan default
```

> Note: `h._state` is the `SimpleNamespace` the A2 harness already exposes; `intent_rebuild.rebuild_after_intent` reads `region_override_store` via `getattr`, so once it's attached, the intent rebuild in the second test re-applies the override. If `GameSceneStore` does not expose `._scenes.database`, get the db from the harness another way — the fixture in `test_gdd_rest.py` builds every store from the `mongo_db` fixture, so alternatively add `region_override_store` **inside** that fixture's `state` (preferred if editing the fixture is acceptable). Confirm the db handle in Step 3.

- [ ] **Step 3: Run the e2e to verify it fails, then passes**

Run: `uv --directory studio/backend run pytest tests/e2e/test_scene_overrides_rest.py -v`
Expected: initially FAIL if the harness wiring/db-handle is off — fix the db-handle acquisition (see the Step 2 note; the cleanest fix is to add `region_override_store=RegionOverrideStore(mongo_db)` directly into the `state` built by the `blueprint_rest_harness` fixture in `test_gdd_rest.py` and drop the `with_override_store` indirection). Once wired: PASS — nudge reflows, survives a later rebuild, and clear restores the plan default.

- [ ] **Step 4: Commit**

```bash
git add studio/backend/app/rest.py studio/backend/tests/e2e/test_scene_overrides_rest.py studio/backend/tests/e2e/test_gdd_rest.py
git commit -m "feat(scene): REST region-override routes + reproducibility e2e"
```

---

### Task 7: Approval gate on the `rebuild_scene` agent tool (Surface 3)

Wrap the agent tool (not the core spine) in a gate-before-apply `interrupt()`: compute a cheap planned-change summary, ask the human, and call `rebuild_scene_core` only on approve. REST callers use `rebuild_scene_core` directly and stay ungated. The pure summary helper is unit-tested; the gate is tested by monkeypatching the module-level `interrupt` (the same seam `delete_asset` uses).

**Files:**

- Create: `studio/backend/app/scene/rebuild_summary.py` (pure summary helper)
- Modify: `studio/backend/app/agent_tools.py` (`build_rebuild_scene_tool` `:659-676`; add a `_current_role_positions` helper; ensure `canonical_role` is imported)
- Test: `studio/backend/tests/test_rebuild_summary.py` (create), `studio/backend/tests/test_rebuild_gate.py` (create)

**Interfaces:**

- Consumes: `ScenePlan` (Task 1's bind output), `canonical_role`, the module-level `interrupt` already imported in `agent_tools.py` (used by `delete_asset`).
- Produces:
  - `summarize_rebuild(plan: ScenePlan, current: dict[str, tuple[float, float]]) -> str` — one clause per role: `"reels: (600,400) -> (640,396) 794x432"` when moved, else `"reels: (640,396) 794x432"`.
  - `_current_role_positions(ctx) -> dict[str, tuple[float, float]]` in `agent_tools.py` — canonical role → current sprite `(x, y)` from the scene doc (empty when no scene).
  - `build_rebuild_scene_tool` now: no placed sprites → delegate to `rebuild_scene_core` (unchanged empty-case message); otherwise `interrupt({"tool": "rebuild_scene", "args": {"theme": theme}, "label": <summary>})` and return `"Rebuild cancelled by the user."` unless the decision is `"approve"`.

- [ ] **Step 1: Write the failing summary test**

Create `studio/backend/tests/test_rebuild_summary.py`:

```python
from app.scene.layout.bind import GddIntent, bind
from app.scene.rebuild_summary import summarize_rebuild


def test_summary_marks_moved_roles_and_lists_targets():
    plan = bind(GddIntent())
    reels = plan.for_role("reels")
    # reels currently far from its planned spot -> shows an arrow; logo omitted from current
    summary = summarize_rebuild(plan, {"reels": (10.0, 10.0)})
    assert "reels:" in summary
    assert "->" in summary                       # moved
    assert f"{reels.region_w}x{reels.region_h}" in summary


def test_summary_no_arrow_when_already_in_place():
    plan = bind(GddIntent())
    reels = plan.for_role("reels")
    summary = summarize_rebuild(plan, {"reels": (reels.x, reels.y)})
    assert "->" not in summary
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_rebuild_summary.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.rebuild_summary`.

- [ ] **Step 3: Create the pure summary helper**

```python
# studio/backend/app/scene/rebuild_summary.py
"""A short human summary of what a rebuild will do, for the approval gate label.

Pure: takes the freshly-bound plan + the currently-placed role positions and
renders one clause per role. Marks a role that will move with an arrow so the
human can approve against a concrete change, not a blind 'rebuild?'.
"""
from app.scene.layout.plan import ScenePlan


def summarize_rebuild(plan: ScenePlan, current: dict[str, tuple[float, float]]) -> str:
    clauses: list[str] = []
    for role, pr in sorted(plan.roles.items()):
        target = f"({pr.x:g},{pr.y:g}) {pr.region_w}x{pr.region_h}"
        cur = current.get(role)
        if cur and (round(cur[0]) != round(pr.x) or round(cur[1]) != round(pr.y)):
            clauses.append(f"{role}: ({cur[0]:g},{cur[1]:g}) -> {target}")
        else:
            clauses.append(f"{role}: {target}")
    return "; ".join(clauses)
```

- [ ] **Step 4: Run the summary test — PASS**

Run: `uv --directory studio/backend run pytest tests/test_rebuild_summary.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing gate test**

Create `studio/backend/tests/test_rebuild_gate.py`. It monkeypatches the module-level `interrupt` to avoid needing a live LangGraph run, and stubs `rebuild_scene_core` to observe whether it ran:

```python
import pytest

import app.agent_tools as at
from app.agent_tools import ToolContext


class _DocStore:
    async def get_document(self, game_id):
        return {"nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.reels": {"id": "spr.reels", "type": "Sprite",
                          "props": {"role": "reels", "position": {"x": 10, "y": 10}}},
        }}


def _ctx():
    return ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                       gdd_store=None, scene_store=_DocStore())


@pytest.mark.asyncio
async def test_gate_denied_does_not_rebuild(monkeypatch):
    monkeypatch.setattr(at, "interrupt", lambda payload: "deny")
    ran = {"core": False}

    async def _fake_core(ctx, theme=""):
        ran["core"] = True
        return "Rebuilt scene from current design intent. ok"

    monkeypatch.setattr(at, "rebuild_scene_core", _fake_core)
    tool = at.build_rebuild_scene_tool(_ctx())
    out = await tool.coroutine(theme="")
    assert "cancelled" in out.lower()
    assert ran["core"] is False


@pytest.mark.asyncio
async def test_gate_approved_runs_rebuild_with_summary_label(monkeypatch):
    seen = {}
    monkeypatch.setattr(at, "interrupt", lambda payload: seen.setdefault("p", payload) and "approve" or "approve")

    async def _fake_core(ctx, theme=""):
        return "Rebuilt scene from current design intent. ok"

    monkeypatch.setattr(at, "rebuild_scene_core", _fake_core)
    tool = at.build_rebuild_scene_tool(_ctx())
    out = await tool.coroutine(theme="")
    assert "Rebuilt scene" in out
    assert seen["p"]["tool"] == "rebuild_scene"
    assert "reels:" in seen["p"]["label"]  # summary carried in the interrupt label


@pytest.mark.asyncio
async def test_gate_skipped_on_empty_scene(monkeypatch):
    calls = {"interrupt": 0}
    monkeypatch.setattr(at, "interrupt", lambda payload: calls.__setitem__("interrupt", calls["interrupt"] + 1) or "deny")

    class _Empty:
        async def get_document(self, game_id):
            return {"nodes": {}}

    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      gdd_store=None, scene_store=_Empty(), scene_critic=None, asset_critic=None)
    tool = at.build_rebuild_scene_tool(ctx)
    out = await tool.coroutine(theme="")
    assert calls["interrupt"] == 0            # no gate when nothing is placed
    assert "Rebuild unavailable" in out or "Nothing to rebuild" in out
```

- [ ] **Step 6: Run it to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_rebuild_gate.py -v`
Expected: FAIL — the current tool never calls `interrupt` and always delegates to core.

- [ ] **Step 7: Add the gate + current-positions helper**

In `studio/backend/app/agent_tools.py`, confirm `canonical_role` is imported (it comes from `app.scene.layout.plan`). If the module imports `from app.scene.layout.plan import ScenePlan`, extend it to `from app.scene.layout.plan import ScenePlan, canonical_role`. Add the import for the summary helper near the other scene imports:

```python
from app.scene.rebuild_summary import summarize_rebuild
```

Add the helper above `build_rebuild_scene_tool`:

```python
async def _current_role_positions(ctx: "ToolContext") -> dict[str, tuple[float, float]]:
    """Canonical role -> current sprite (x, y) from the live scene doc. Empty when
    there is no scene. Used to render the approval gate's planned-change summary."""
    doc = await ctx.scene_store.get_document(ctx.game_id) if ctx.scene_store else None
    out: dict[str, tuple[float, float]] = {}
    if not doc:
        return out
    for nid, n in doc.get("nodes", {}).items():
        if n.get("type") != "Sprite":
            continue
        props = n.get("props") or {}
        role = canonical_role(props.get("role") or nid.removeprefix("spr."))
        pos = props.get("position") or {}
        if role:
            out[role] = (float(pos.get("x", 0)), float(pos.get("y", 0)))
    return out
```

Replace the `rebuild_scene` inner coroutine inside `build_rebuild_scene_tool` (`:660-664`):

```python
    async def rebuild_scene(theme: str = "") -> str:
        """Re-run bind -> place -> reconcile for every role already in the scene,
        using the CURRENT persisted GDD intent + region overrides. Asks the human
        to approve the planned reflow before applying it."""
        current = await _current_role_positions(ctx)
        if not current:
            # nothing placed -> no gate; let the core report the empty/no-critic case
            return await rebuild_scene_core(ctx, theme)
        plan = await _plan_for_game(ctx)
        label = ("Rebuild the scene to the current design intent?\n"
                 + summarize_rebuild(plan, current))
        decision = interrupt(
            {"tool": "rebuild_scene", "args": {"theme": theme}, "label": label})
        if decision != "approve":
            return "Rebuild cancelled by the user."
        return await rebuild_scene_core(ctx, theme)
```

(Leave the `StructuredTool.from_function(...)` description block below it unchanged.)

- [ ] **Step 8: Run the gate + full agent-tools tests**

Run: `uv --directory studio/backend run pytest tests/test_rebuild_gate.py tests/test_rebuild_summary.py tests/e2e/test_scene_blueprint_compose.py -v`
Expected: PASS — deny cancels without rebuilding, approve rebuilds with a summary label, empty scenes skip the gate, and the A1 e2e (which drives `rebuild_scene_core` directly, not the tool) is unaffected.

- [ ] **Step 9: Commit**

```bash
git add studio/backend/app/scene/rebuild_summary.py studio/backend/app/agent_tools.py studio/backend/tests/test_rebuild_summary.py studio/backend/tests/test_rebuild_gate.py
git commit -m "feat(scene): human approval gate on the rebuild_scene agent tool (Surface 3)"
```

---

### Task 8: Engine `positionOf` accessor for reflow assertions

The region-nudge browser e2e proves a reflow by observing a sprite's position change. The Pixi renderer exposes `scaleOf`/`anchorOf` but no position accessor. Add `positionOf(id)` mirroring `scaleOf` exactly (`pixiRenderer.ts:236-239`).

**Files:**

- Modify: `runtime/client/src/render/pixiRenderer.ts` (next to `scaleOf`, `:236-239`)
- Test: `runtime/client/src/render/pixiRenderer.spec.ts` (extend)

**Interfaces:**

- Consumes: the renderer's `this.objects` registry (same lookup `scaleOf` uses).
- Produces: `positionOf(id: string): { x: number; y: number } | null` — the display object's current position, or `null` for an unknown id.

- [ ] **Step 1: Write the failing test**

Append to `runtime/client/src/render/pixiRenderer.spec.ts`, mirroring the existing `scaleOf`/`anchorOf` test setup in that file (create the renderer the same way the sibling tests do, add a Sprite node, set its position via the same reconcile/`setProp` op path the neighbours use):

```ts
it('positionOf reports a sprite position and null for unknown ids', () => {
  const r = makeRenderer(); // use whatever factory the sibling scaleOf test uses
  r.apply({ kind: 'addNode', id: 's', type: 'Sprite', props: { position: { x: 12, y: 34 } } });
  expect(r.positionOf('s')).toEqual({ x: 12, y: 34 });
  expect(r.positionOf('ghost')).toBeNull();
});
```

(Match the EXACT op/reconcile API the neighbouring `scaleOf`/`anchorOf` tests use — read them first and copy their style precisely; `makeRenderer`/`apply` are placeholders for whatever those tests call.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts -t positionOf`
Expected: FAIL — `r.positionOf is not a function`.

- [ ] **Step 3: Add the accessor**

In `runtime/client/src/render/pixiRenderer.ts`, next to `scaleOf` (`:236-239`):

```ts
  positionOf(id: string): { x: number; y: number } | null {
    const obj = this.objects.get(id);
    return obj ? { x: obj.position.x, y: obj.position.y } : null;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd runtime/client && npx vitest run src/render/pixiRenderer.spec.ts`
Expected: PASS — `positionOf` test green, no regression.

- [ ] **Step 5: Commit**

```bash
git add runtime/client/src/render/pixiRenderer.ts runtime/client/src/render/pixiRenderer.spec.ts
git commit -m "feat(engine): add positionOf renderer accessor for reflow assertions"
```

---

### Task 9: IntentEditor can clear a prose field (carry-forward fix b)

`IntentEditor.onSave` (`GddViewerPane.tsx:25`) filters out empty strings, so a human can never clear a prose intent field back to empty. Only drop a key that was **already** empty (never touched); send an explicit empty string when the human cleared a previously-set field.

**Files:**

- Modify: `studio/frontend/src/plugins/gdd/GddViewerPane.tsx:15-33` (`IntentEditor`)
- Test: `studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx` (extend)

**Interfaces:**

- Consumes: `saveIntentFields` (unchanged), the component's initial `data`.
- Produces: `onSave` sends every field whose value **differs from its initial value** (so a cleared field sends `""`), and additionally any non-empty field. A field that started empty and is still empty is omitted (no-op). No signature change.

- [ ] **Step 1: Write the failing component test**

Append to `studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx` (reuse the file's existing `uiDoc`/`fakeProps`/`gddSlice` helpers and the `saveIntentFields` mock already set up there):

```tsx
it('clears a previously-set prose field (sends empty string)', async () => {
  act(() => {
    gddSlice().activeGameId.set('g1');
    gddSlice().docs.set([uiDoc({ layout: 'reels centered', orientation: 'landscape' })]);
    gddSlice().selectedAspect.set('ui-ux');
  });
  render(<GddViewerPane {...fakeProps} />);
  const layout = screen.getByTestId('gdd-intent-layout') as HTMLTextAreaElement;
  act(() => fireEvent.change(layout, { target: { value: '' } })); // clear it
  await act(async () => {
    fireEvent.click(screen.getByTestId('gdd-intent-save'));
  });
  expect(saveIntentFields).toHaveBeenCalledWith('g1', 'ui-ux', expect.objectContaining({ layout: '' }));
});

it('omits a field that started empty and stayed empty', async () => {
  act(() => {
    gddSlice().activeGameId.set('g1');
    gddSlice().docs.set([uiDoc({ orientation: 'landscape' })]); // no layout set
    gddSlice().selectedAspect.set('ui-ux');
  });
  render(<GddViewerPane {...fakeProps} />);
  await act(async () => {
    fireEvent.click(screen.getByTestId('gdd-intent-save'));
  });
  const [, , patch] = (saveIntentFields as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  expect('layout' in (patch as Record<string, unknown>)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx nx test frontend -- GddViewerPane`
Expected: FAIL — the first test fails because the empty `layout` is filtered out of the patch.

- [ ] **Step 3: Fix the patch construction**

In `studio/frontend/src/plugins/gdd/GddViewerPane.tsx`, capture the initial values and change the filter (`:17` and `:25`). Keep the initial map for comparison:

```tsx
function IntentEditor({ gameId, aspect, data }: { gameId: string; aspect: string; data: Record<string, unknown> }) {
  const fields = INTENT_FIELDS[aspect];
  const initial = Object.fromEntries(fields.map((f) => [f.key, String(data[f.key] ?? '')]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSave() {
    setSaving(true);
    setStatus('');
    try {
      // Send a field if it is non-empty OR it changed from its initial value
      // (so clearing a previously-set field sends '' and actually clears it).
      const patch = Object.fromEntries(fields.map((f) => [f.key, values[f.key]]).filter(([k, v]) => v !== '' || v !== initial[k as string]));
      const res = await saveIntentFields(gameId, aspect, patch);
      setStatus(res.rebuilt ? 'Reflowed scene.' : 'Saved.');
    } catch {
      setStatus('Save failed.');
    } finally {
      setSaving(false);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx nx test frontend -- GddViewerPane`
Expected: PASS — cleared fields send `''`; never-set fields are omitted; the A2 intent-editor tests stay green.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/gdd/GddViewerPane.tsx studio/frontend/src/plugins/gdd/GddViewerPane.spec.tsx
git commit -m "fix(gdd): let the intent editor clear a previously-set prose field"
```

---

### Task 10: Region-override editor plugin (HITL Surface 4 UI)

A new Dockview plugin — modelled on the read-only `scene-graph` plugin — that loads `override_view`, renders a numeric editor per role (x, y, region_w, region_h, anchor_x, anchor_y) with plan defaults as placeholders, PUTs a role's override on Save, and DELETEs it on Reset.

**Files:**

- Create: `studio/frontend/src/plugins/region-overrides/restClient.ts`
- Create: `studio/frontend/src/plugins/region-overrides/RegionOverridePane.tsx`
- Create: `studio/frontend/src/plugins/region-overrides/index.ts`
- Modify: `studio/frontend/src/plugins/index.ts` (register the plugin)
- Test: `studio/frontend/src/plugins/region-overrides/restClient.spec.ts` (create), `studio/frontend/src/plugins/region-overrides/RegionOverridePane.spec.tsx` (create)

**Interfaces:**

- Consumes: `BACKEND_URL` (re-export from the gdd/assets config), the active game id (read from the **game plugin's** state — see Step 1), the engine reflow lands over the existing scene websocket (no new socket).
- Produces:
  - `restClient.ts`: `getOverrides(gameId): Promise<IOverrideView>`, `putOverride(gameId, role, fields): Promise<{ rebuilt: boolean }>`, `deleteOverride(gameId, role): Promise<{ rebuilt: boolean }>`, and `interface IOverrideView { canvas: [number, number]; plan: Record<string, IRegionFields>; overrides: Record<string, Partial<IRegionFields>> }`, `interface IRegionFields { x: number; y: number; region_w: number; region_h: number; anchor_x: number; anchor_y: number }`.
  - A `region-overrides/preview` pane titled "Layout Regions", testids `region-editor`, `region-<role>-<field>` (number inputs), `region-<role>-save`, `region-<role>-reset`, `region-status`.

- [ ] **Step 1: Read the sibling plugin for the active-game pattern**

Run: read `studio/frontend/src/plugins/scene-graph/index.ts`, `scene-graph/state.ts`, and `game/state.ts`. Confirm how a pane learns the **active game id** (the scene-graph pane subscribes to the game plugin's synced state). Copy that exact selector/hook for `RegionOverridePane` — do NOT invent a new active-game source. Note the `IPlugin` shape from `game/index.ts`: `{ id, title, persist, initialState, panes:[{id,title,component}], commands:[...], init }`.

- [ ] **Step 2: Write the failing restClient test**

Create `studio/frontend/src/plugins/region-overrides/restClient.spec.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { putOverride, getOverrides } from './restClient';

afterEach(() => vi.restoreAllMocks());

describe('region-overrides restClient', () => {
  it('PUTs a role override and returns the parsed body', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ rebuilt: true }) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const res = await putOverride('g1', 'reels', { x: 100 });
    expect(res.rebuilt).toBe(true);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/games\/g1\/scene\/overrides\/reels$/);
    expect(init).toMatchObject({ method: 'PUT' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ x: 100 });
  });

  it('GETs the override view', async () => {
    const view = { canvas: [1280, 720], plan: { reels: { x: 640, y: 396, region_w: 794, region_h: 432, anchor_x: 0.5, anchor_y: 0.5 } }, overrides: {} };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => view })) as unknown as typeof fetch);
    expect((await getOverrides('g1')).plan.reels.region_w).toBe(794);
  });
});
```

- [ ] **Step 3: Implement the restClient**

```ts
// studio/frontend/src/plugins/region-overrides/restClient.ts
import { BACKEND_URL } from '../gdd/config';

export interface IRegionFields {
  x: number;
  y: number;
  region_w: number;
  region_h: number;
  anchor_x: number;
  anchor_y: number;
}

export interface IOverrideView {
  canvas: [number, number];
  plan: Record<string, IRegionFields>;
  overrides: Record<string, Partial<IRegionFields>>;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getOverrides(gameId: string): Promise<IOverrideView> {
  return okJson<IOverrideView>(await fetch(`${BACKEND_URL}/games/${gameId}/scene/overrides`));
}

export async function putOverride(gameId: string, role: string, fields: Partial<IRegionFields>): Promise<{ rebuilt: boolean }> {
  return okJson<{ rebuilt: boolean }>(
    await fetch(`${BACKEND_URL}/games/${gameId}/scene/overrides/${role}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  );
}

export async function deleteOverride(gameId: string, role: string): Promise<{ rebuilt: boolean }> {
  return okJson<{ rebuilt: boolean }>(await fetch(`${BACKEND_URL}/games/${gameId}/scene/overrides/${role}`, { method: 'DELETE' }));
}
```

- [ ] **Step 4: Run the restClient test — PASS**

Run: `cd studio/frontend && npx nx test frontend -- region-overrides/restClient`
Expected: PASS.

- [ ] **Step 5: Write the failing pane test**

Create `studio/frontend/src/plugins/region-overrides/RegionOverridePane.spec.tsx`. Mock `restClient`, render, edit `region-reels-x`, click `region-reels-save`, assert `putOverride` was called with the changed field. Follow the active-game setup from Step 1 (the snippet below assumes the pane reads the active game the same way `scene-graph` does — adapt the state seeding to match):

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import * as rest from './restClient';
import { RegionOverridePane } from './RegionOverridePane';
// import + seed the active-game state exactly as scene-graph's spec does (Step 1)

const view = {
  canvas: [1280, 720] as [number, number],
  plan: { reels: { x: 640, y: 396, region_w: 794, region_h: 432, anchor_x: 0.5, anchor_y: 0.5 } },
  overrides: {},
};

beforeEach(() => {
  vi.spyOn(rest, 'getOverrides').mockResolvedValue(view);
  vi.spyOn(rest, 'putOverride').mockResolvedValue({ rebuilt: true });
});
afterEach(() => vi.restoreAllMocks());

describe('RegionOverridePane', () => {
  it('edits a role region and PUTs the override on save', async () => {
    // ...seed active game id = 'g1' the scene-graph way...
    await act(async () => {
      render(<RegionOverridePane {...({} as never)} />);
    });
    const x = (await screen.findByTestId('region-reels-x')) as HTMLInputElement;
    act(() => fireEvent.change(x, { target: { value: '700' } }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('region-reels-save'));
    });
    expect(rest.putOverride).toHaveBeenCalledWith('g1', 'reels', expect.objectContaining({ x: 700 }));
  });
});
```

- [ ] **Step 6: Implement the pane**

Create `studio/frontend/src/plugins/region-overrides/RegionOverridePane.tsx`. Read the active game id the scene-graph way (Step 1); load `getOverrides` on mount + when the game changes; per role render six number inputs (placeholder = plan default, value = override-or-blank), a Save (PUTs only the fields the human typed) and a Reset (DELETEs). Use design-language token classes only — no raw colors.

```tsx
import { useEffect, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { getOverrides, putOverride, deleteOverride, type IOverrideView, type IRegionFields } from './restClient';
// import the active-game hook exactly as scene-graph does (Step 1)

const FIELDS: (keyof IRegionFields)[] = ['x', 'y', 'region_w', 'region_h', 'anchor_x', 'anchor_y'];

function RoleRow({ gameId, role, plan, override, onDone }: { gameId: string; role: string; plan: IRegionFields; override: Partial<IRegionFields>; onDone: (msg: string) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(FIELDS.map((f) => [f, override[f] != null ? String(override[f]) : ''])));

  async function save() {
    const fields: Partial<IRegionFields> = {};
    for (const f of FIELDS) {
      if (vals[f] !== '') fields[f] = Number(vals[f]);
    }
    const { rebuilt } = await putOverride(gameId, role, fields);
    onDone(rebuilt ? `Reflowed ${role}.` : `Saved ${role}.`);
  }

  async function reset() {
    await deleteOverride(gameId, role);
    setVals(Object.fromEntries(FIELDS.map((f) => [f, ''])));
    onDone(`Reset ${role} to plan.`);
  }

  return (
    <div className="flex flex-col gap-2 border-b border-hairline py-3" data-testid={`region-role-${role}`}>
      <span className="text-sm text-text-1">{role}</span>
      <div className="flex flex-wrap gap-2">
        {FIELDS.map((f) => (
          <label key={f} className="flex flex-col text-xs text-text-3">
            {f}
            <input
              type="number"
              data-testid={`region-${role}-${f}`}
              value={vals[f]}
              placeholder={String(plan[f])}
              onChange={(e) => setVals((v) => ({ ...v, [f]: e.target.value }))}
              className="w-20 rounded border border-hairline bg-raised px-2 py-1 text-text-1"
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button data-testid={`region-${role}-save`} onClick={save} className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover">
          Save
        </button>
        <button data-testid={`region-${role}-reset`} onClick={reset} className="rounded border border-hairline px-3 py-1 text-sm text-text-2 hover:bg-raised">
          Reset
        </button>
      </div>
    </div>
  );
}

export function RegionOverridePane(_props: IDockviewPanelProps) {
  const gameId = /* active game id, scene-graph way (Step 1) */ '' as string;
  const [view, setView] = useState<IOverrideView | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (gameId) getOverrides(gameId).then(setView).catch(() => setStatus('Load failed.'));
  }, [gameId]);

  if (!gameId) return <div className="p-3 text-sm text-text-3">Open a game to edit its layout regions.</div>;
  if (!view) return <div className="p-3 text-sm text-text-3">Loading regions…</div>;

  return (
    <div data-testid="region-editor" className="flex flex-col overflow-auto bg-surface p-3">
      {Object.entries(view.plan).map(([role, plan]) => (
        <RoleRow key={role} gameId={gameId} role={role} plan={plan} override={view.overrides[role] ?? {}} onDone={setStatus} />
      ))}
      {status && (
        <span data-testid="region-status" className="mt-2 text-sm text-text-3">
          {status}
        </span>
      )}
    </div>
  );
}
```

Create `studio/frontend/src/plugins/region-overrides/index.ts` (mirror `game/index.ts`; if the pane needs no plugin-level state, use an empty state object like `scene-graph` does — copy its exact `IPlugin` construction):

```ts
import type { IPlugin } from '../../host/types';
import { RegionOverridePane } from './RegionOverridePane';

export const REGION_OVERRIDES_PLUGIN_ID = 'region-overrides';

export const regionOverrides: IPlugin = {
  id: REGION_OVERRIDES_PLUGIN_ID,
  title: 'Layout Regions',
  persist: false,
  initialState: {},
  panes: [{ id: 'region-overrides/preview', title: 'Layout Regions', component: RegionOverridePane as never }],
  commands: [{ id: 'region-overrides/open', title: 'Open Layout Regions', run: (host) => host.openPane('region-overrides/preview') }],
  init: () => {},
};
```

(If `IPlugin` requires a typed state generic, mirror `scene-graph`'s exact signature from Step 1 — it is the closest stateless-pane precedent.)

Register it in `studio/frontend/src/plugins/index.ts`:

```ts
import { regionOverrides } from './region-overrides';
// ...append to the PLUGINS array:
export const PLUGINS: IPlugin[] = [sceneStorePlugin, demoCounter, demoScratch, llmChat, assets, gdd, game, simulator, tuner, sceneGraph, propertyInspector, regionOverrides];
```

- [ ] **Step 7: Run the pane test — PASS**

Run: `cd studio/frontend && npx nx test frontend -- region-overrides`
Expected: PASS — editing `region-reels-x` and clicking save calls `putOverride('g1','reels',{x:700})`.

- [ ] **Step 8: Run all four frontend gates**

Run: `cd studio/frontend && node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
Expected: all green. Fix prettier/type issues before committing.

- [ ] **Step 9: Commit**

```bash
git add studio/frontend/src/plugins/region-overrides studio/frontend/src/plugins/index.ts
git commit -m "feat(studio): region-override editor plugin (Scene Blueprint A3 Surface 4)"
```

---

### Task 11: Browser e2e — approval gate (Surface 3, authoritative)

The authoritative Surface-3 contract: a chat-driven intent edit makes the agent call `rebuild_scene`, which now pauses on an `ApprovalCard`; **Approve** reflows the scene, **Deny** leaves it unchanged. Rides the real UI → LangGraph interrupt → socket → engine.

**Files:**

- Create: `studio/frontend/e2e/scene-blueprint-approval-gate.spec.ts`
- Create/extend: cassettes under `studio/backend/tests/fixtures/replay/` so the design-router run (a) edits an intent field then (b) calls `rebuild_scene` (which triggers the interrupt), and the re-place pass has critic/asset verdicts.

**Interfaces:**

- Consumes: the running replay stack (offset ports 8001/4201/4301), the `ApprovalCard` (`approval-card`, buttons "Approve"/"Deny"), the engine `positionOf`/`scaleOf` hooks, the GDD viewer testids.
- Produces: a green Playwright spec proving approve→reflow and deny→no-change.

- [ ] **Step 1: Write the e2e spec (expected RED until stack + cassettes ready)**

```ts
// studio/frontend/e2e/scene-blueprint-approval-gate.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — HITL Surface 3 (Scene Blueprint A3): a chat intent edit makes the
// agent call rebuild_scene -> an ApprovalCard appears -> Approve reflows / Deny leaves
// the scene unchanged. Stack (replay): backend :8001, engine :4301, studio :4201.
// Run: export the worktree offset ports; just backend-serve-replay; just e2e.

const SEED_PROMPT = 'make a pirate theme game with a background and a logo centered at the top';
const EDIT_PROMPT = 'make the framing ornate';

async function openAppAtRoom(page: Page, username: string): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Blueprint A3 gate ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

async function logoPos(page: Page): Promise<number> {
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  return frame!.evaluate(() => (window as any).__engineRenderer?.positionOf('spr.logo')?.y ?? -1);
}

test.setTimeout(300_000);

test('rebuild_scene pauses on an approval card; approve reflows', async ({ page }) => {
  await openAppAtRoom(page, 'ada');
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // 1. Seed a scene (background + logo) via the compose cassette.
  await page.getByTestId('chat-composer').fill(SEED_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText(/background and a logo/i, { timeout: 60_000 });

  // 2. Open the Game Scene pane; wait for the logo to render.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => logoPos(page), { timeout: 25_000 }).toBeGreaterThanOrEqual(0);
  const before = await logoPos(page);

  // 3. Ask the agent to change intent -> it calls rebuild_scene -> approval card appears.
  await page.getByTestId('chat-composer').fill(EDIT_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 60_000 });

  // 4. Approve -> the scene reflows (the logo moves to its planned region).
  await page.getByTestId('approval-card').getByRole('button', { name: /approve/i }).click();
  await expect.poll(() => logoPos(page), { timeout: 30_000 }).not.toBe(before);
});
```

- [ ] **Step 2: Author the cassettes; bring up the stack**

In the worktree, export the offset ports and `just backend-serve-replay`. Run the spec once; when the design-router run hits an unmatched prompt key, hand-author the matching cassette(s) under `studio/backend/tests/fixtures/replay/` (per the tuner-chat precedent — see the `llm-chat-status` / cassette-authoring memory): the router turn must call `set_gdd_fields` (framing_density=ornate) then `rebuild_scene`; the re-place pass needs asset verdicts `action="keep"` and scene critiques `done=true` with empty edits (the reflow comes from the deterministic bind, so the critic only says "done"). Re-run until matched. If hand-authoring is too brittle, record live (`just record-fixtures`) and trim to this run.

- [ ] **Step 3: Run the e2e to verify it passes**

Run (worktree, offset ports exported): `just e2e` (or target the file via the playwright config).
Expected: PASS — the approval card appears and approving moves the logo.

- [ ] **Step 4: Add the Deny assertion**

Add a second `test(...)` to the same file: seed, edit, wait for `approval-card`, click **Deny**, and assert `logoPos` is unchanged after a short settle (`await expect.poll(...).toBe(before)` with a bounded timeout, or assert the chat shows "Rebuild cancelled"). Reuse the same cassettes (the deny path never runs the re-place pass, so no extra critic cassettes are needed).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/scene-blueprint-approval-gate.spec.ts studio/backend/tests/fixtures/replay/
git commit -m "test(e2e): approval gate pauses + approve/deny (Scene Blueprint A3 Surface 3)"
```

---

### Task 12: Browser e2e — region nudge (Surface 4, authoritative)

The authoritative Surface-4 contract: open the Layout Regions editor, change reels `x`, Save, and watch the live engine reflow reels to the new x; then prove it **survives a rebuild** (a subsequent intent edit does not lose the nudge).

**Files:**

- Create: `studio/frontend/e2e/scene-blueprint-region-nudge.spec.ts`
- Reuse: the seed compose cassette + the approval-gate cassettes from Task 11 for the survive-rebuild step.

**Interfaces:**

- Consumes: the replay stack (offset ports), the `region-editor` pane testids (Task 10), the engine `positionOf` hook (Task 8), the `ApprovalCard` (for the survive-rebuild step's approve).
- Produces: a green Playwright spec proving the nudge reflows the sprite and survives a later approved rebuild.

- [ ] **Step 1: Write the e2e spec (expected RED until stack ready)**

```ts
// studio/frontend/e2e/scene-blueprint-region-nudge.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Browser e2e — HITL Surface 4 (Scene Blueprint A3): edit reels x in the Layout
// Regions editor -> Save -> the live engine reflows reels -> the nudge survives a
// later approved rebuild. Stack (replay): backend :8001, engine :4301, studio :4201.

const SEED_PROMPT = 'make a pirate theme game with a background and reels in the middle';

async function reelsX(page: Page): Promise<number> {
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  return frame!.evaluate(() => (window as any).__engineRenderer?.positionOf('spr.reels')?.x ?? -1);
}

test.setTimeout(300_000);

test('nudging reels x in the region editor reflows the live scene and survives rebuild', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Blueprint A3 nudge ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });

  // 1. Seed a scene with reels.
  await page.getByTestId('chat-composer').fill(SEED_PROMPT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-messages')).toContainText(/reels/i, { timeout: 60_000 });

  // 2. Open the Game Scene + Layout Regions panes.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => reelsX(page), { timeout: 25_000 }).toBeGreaterThanOrEqual(0);
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-region-overrides/preview').click();
  await expect(page.getByTestId('region-editor')).toBeVisible({ timeout: 15_000 });

  // 3. Nudge reels x to 200 and Save.
  await page.getByTestId('region-reels-x').fill('200');
  await page.getByTestId('region-reels-save').click();
  await expect(page.getByTestId('region-status')).toContainText(/reflow/i, { timeout: 60_000 });
  await expect.poll(() => reelsX(page), { timeout: 30_000 }).toBe(200);

  // 4. Survive a rebuild: a chat intent edit -> approve -> reels stays at 200.
  await page.getByTestId('chat-composer').fill('make the framing ornate');
  await page.getByTestId('chat-send').click();
  await page.getByTestId('approval-card').getByRole('button', { name: /approve/i }).click();
  await expect.poll(() => reelsX(page), { timeout: 30_000 }).toBe(200);
});
```

- [ ] **Step 2: Bring up the stack + confirm the view command testid**

Confirm the view-menu opens the new pane via `view-open-region-overrides/preview` (the command id from Task 10). If the view menu derives its testid differently, read `menu-view`'s rendering and use the actual testid. Reuse the seed + ornate cassettes from Task 11 for the survive-rebuild step; the nudge itself needs only the seed + a re-place pass cassette (asset `keep` / scene `done`) — author as in Task 11 Step 2 if the run reports an unmatched key.

- [ ] **Step 3: Run the e2e to verify it passes**

Run (worktree, offset ports exported): `just e2e` (or target the file).
Expected: PASS — reels moves to x=200 on save and is still 200 after the approved rebuild.

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/scene-blueprint-region-nudge.spec.ts studio/backend/tests/fixtures/replay/
git commit -m "test(e2e): region nudge reflows + survives rebuild (Scene Blueprint A3 Surface 4)"
```

---

### Task 13: Full suites + whole-branch review

Run every suite and a whole-branch review confirming the A3 contract.

**Files:** none (verification + review only).

- [ ] **Step 1: Full backend suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: all unit + replay e2e green (A2 baseline + the new Task 1–7 unit tests + the override REST e2e).

- [ ] **Step 2: Full frontend gates**

Run: `cd studio/frontend && node_modules/.bin/prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
Expected: all green.

- [ ] **Step 3: Engine unit tests**

Run: `cd runtime/client && npx vitest run`
Expected: all green (incl. `positionOf`).

- [ ] **Step 4: Browser e2e (worktree offset ports)**

Run (offset ports exported, replay backend up): `just e2e`
Expected: the two new A3 specs pass and the existing suite (incl. the A2 intent-edit spec) stays green.

- [ ] **Step 5: Whole-branch review**

Use superpowers:requesting-code-review for the full branch diff against `main`. Confirm: one rebuild spine (no forked compose); GDD/IntentEditor carry NO geometry (overrides live only in the store + `bind`); overrides apply as the final bind layer and survive rebuild; the approval gate is agent-path-only + gate-before-apply + Approve/Deny reusing `ApprovalCard`; REST paths stay ungated/synchronous; anchor is now a real reflow channel; the intent editor can clear a field; design-language tokens only (no raw colors); the two browser e2es are the authoritative Surface-3/Surface-4 proofs.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-06-30-scene-blueprint-design.md`, phase A3 = "approval checkpoint via `interrupt()` (Surface 3) · region-override store + drag UI (Surface 4); Playwright: pause/approve; nudge → persist → survive rebuild"):

- Approval checkpoint via `interrupt()` (Surface 3) → Task 7 (gate on the agent tool) + Task 11 (authoritative pause/approve/deny e2e). ✅ (Interaction confirmed during brainstorming: gate-before-apply, agent-path only, Approve/Deny — REST Saves stay synchronous because `interrupt()` only works in the LangGraph run.)
- Region-override store applied after bind (Surface 4 persistence, reproducibility input #2) → Tasks 1 (bind layer) + 2 (store) + 3 (wired into every rebuild). ✅
- Region **editor** (form, per brainstorming decision — literal drag deferred) → Task 10; REST + service → Tasks 5–6. ✅ (Deviation from the spec's "drag UI" wording is intentional and user-approved: nudge intent preserved, gesture deferred.)
- Playwright: nudge → persist → survive rebuild → Task 12 (+ backend reproducibility e2e in Task 6). ✅
- Carry-forward A2 follow-ups: anchor as a reflow channel → Task 4; clear an intent field → Task 9. ✅ (The third deferred item — a concurrent per-game rebuild lock — is explicitly out of scope; `GameSceneHub` already serializes ops under a per-game `asyncio.Lock`, so rebuilds do not corrupt the doc.)

**Placeholder scan:** every backend step ships complete code. Frontend Task 10 and the two e2e tasks contain the one legitimately discovery-driven placeholder each: the exact active-game selector (Task 10 Step 1 points at `scene-graph` as the concrete precedent to copy) and the replay cassette keys (Tasks 11–12 give the run→read-unmatched-key→author-"keep"/"done"→re-run recipe from the tuner-chat precedent, not a literal blob). The engine test factory names (`makeRenderer`/`apply`) are flagged to be copied verbatim from the sibling `scaleOf`/`anchorOf` tests.

**Type consistency:** `RegionOverride`/`RegionOverrideStore` (Task 2) are consumed by Tasks 1, 3, 5, 6; `bind(intent, overrides=..., refiner=...)` (Task 1) is called by `_plan_for_game` (Task 3) and `override_view` (Task 5); `ToolContext.region_override_store` (Task 3) is read by `_plan_for_game` (Task 3) and set by `intent_rebuild`/`override_rebuild` (Task 5) + `room_hub` (Task 3); `summarize_rebuild(plan, current)` (Task 7) consumes Task 1's plan; `positionOf` (Task 8) is called by Tasks 11–12; the REST shapes (`{rebuilt}`, `override_view`) in Task 6 match the frontend `restClient` types in Task 10; `canonical_role` is the single canonicalization seam used by the store boundary (Task 5), `bind` overrides (Task 1), and the gate's current-positions helper (Task 7).

**Open assumptions to verify during execution (flagged, not blocking):**

- Task 3 assumes `RoomHub.__init__` accepts new keyword args and builds the agent `ToolContext` at `room_hub.py:294`; `ToolFactory.build(allowlist, ctx)` uses that ctx, so `ToolFactory` needs no change.
- Task 4 assumes `build_sprite_ops` writes `sp["anchor"]["x"|"y"]`; Step 1 confirms the exact key.
- Task 6's db-handle acquisition for the override store in the e2e (either `scene_store._scenes.database` or, preferred, adding it into the `blueprint_rest_harness` fixture's `state`); Step 3 resolves it.
- Task 10 assumes the active-game id is exposed the way `scene-graph` reads it; Step 1 confirms and copies that selector.
