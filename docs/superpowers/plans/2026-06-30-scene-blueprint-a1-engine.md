# Scene Blueprint — A1 (Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scene composition plan-driven — GDD art-direction/layout *intent* is bound onto a code-side canonical layout template to produce a concrete per-game `ScenePlan` that supplies every element's geometry, and the vision critic reconciles each element to its planned region instead of re-composing from remembered principles.

**Architecture:** Three new pure modules under `studio/backend/app/scene/layout/` (`template.py`, `plan.py`, `bind.py`, `intent.py`) turn GDD intent + orientation into a typed `ScenePlan`. The existing `compose_scene` / `run_compose` loop stops trusting agent coordinates: it overwrites each placed element's geometry from the plan (position/anchor/scale-to-region/z) and passes each element's intended region into the critic. A new `rebuild_scene` agent verb re-runs the whole bind→place→reconcile flow from persisted GDD intent, and the design-router calls it after intent edits (HITL Surface 1, chat-driven).

**Tech Stack:** Python 3 / FastAPI / Pydantic / dataclasses, LangChain + LangGraph (existing critic + tool seams), MongoDB (GDD + scene stores), pytest. Backend replay e2e (`PROVIDER_MODE=replay`) for the integration path.

## Global Constraints

- **GDD holds NO geometry/coordinates.** The only new structured geometry inputs are three enums in the `ui-ux` aspect: `orientation` (`portrait`|`landscape`), `focal_emphasis` (`reels`|`logo`|`balanced`), `framing_density` (`clean`|`moderate`|`ornate`). Everything else stays prose.
- **TypeScript interfaces use an `I` prefix** (repo coding standard) — not relevant to this backend-only A1, noted for completeness.
- **TDD is mandatory:** failing test first, watch it fail, minimal code to pass, refactor. Commit per task.
- **Semantic commits** (Conventional Commits): `<type>(<scope>): <description>`, imperative mood.
- **Critic is a direct structured+image LLM call behind the `SceneCritic` seam** (`app/scene/critic.py`) with its own cassette format under `tests/fixtures/replay/critic/`. Do not route it through the tool-calling chat model.
- **Reproducibility inputs:** GDD intent + region overrides (not built until A3) + asset seeds + `TEMPLATE_VERSION`. A1 pins `TEMPLATE_VERSION` into the plan so reproduction is deterministic.
- **Canvas:** landscape `(1280, 720)` (current `DEFAULT_CANVAS`), portrait `(720, 1280)`.
- **Run backend unit tests with:** `uv --directory studio/backend run pytest <path> -v` (machine-local toolchain).

---

### Task 1: GDD intent enums (`ui-ux` aspect)

Add the three geometry-driving enums to the `ui-ux` aspect so the design-router can set them and `read_intent` (Task 5) can read them. The GDD schema is permissive and auto-propagates to the catalog, router prompt, REST, and frontend — only the schema dict changes.

**Files:**
- Modify: `studio/backend/app/gdd/schemas.py:87-93` (the `"ui-ux"` field list)
- Test: `studio/backend/tests/test_gdd_schema_intent.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `ASPECT_SCHEMAS["ui-ux"]` now contains `Field("orientation", ...)`, `Field("focal_emphasis", ...)`, `Field("framing_density", ...)`; `field_catalog()["ui-ux"]` lists them with their enums.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_schema_intent.py
from app.gdd.schemas import ASPECT_SCHEMAS, field_catalog


def _keys(aspect):
    return {f.key for f in ASPECT_SCHEMAS[aspect]}


def test_ui_ux_has_blueprint_enums():
    assert {"orientation", "focal_emphasis", "framing_density"} <= _keys("ui-ux")


def test_blueprint_enums_have_expected_values():
    by_key = {f.key: f for f in ASPECT_SCHEMAS["ui-ux"]}
    assert by_key["orientation"].enum == ("portrait", "landscape")
    assert by_key["focal_emphasis"].enum == ("reels", "logo", "balanced")
    assert by_key["framing_density"].enum == ("clean", "moderate", "ornate")
    assert all(by_key[k].type == "enum" for k in
               ("orientation", "focal_emphasis", "framing_density"))


def test_catalog_exposes_blueprint_enums():
    ui = {f["key"]: f for f in field_catalog()["ui-ux"]}
    assert ui["orientation"]["enum"] == ["portrait", "landscape"]
    assert ui["framing_density"]["enum"] == ["clean", "moderate", "ornate"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schema_intent.py -v`
Expected: FAIL — `KeyError`/assertion: the three keys are not in `ui-ux`.

- [ ] **Step 3: Add the three enum fields**

In `studio/backend/app/gdd/schemas.py`, extend the `"ui-ux"` list (currently ending at the `autoplay` field, line ~92) so it reads:

```python
    "ui-ux": [
        Field("layout", "Layout", "text", "narrative"),
        Field("orientation", "Orientation", "enum", "param",
              enum=("portrait", "landscape")),
        Field("focal_emphasis", "Focal emphasis", "enum", "param",
              enum=("reels", "logo", "balanced")),
        Field("framing_density", "Framing density", "enum", "param",
              enum=("clean", "moderate", "ornate")),
        Field("key_screens", "Key screens", "list", "param"),
        Field("controls", "Controls", "text", "narrative"),
        Field("quick_spin", "Quick spin", "text", "param"),
        Field("autoplay", "Autoplay", "text", "param"),
    ],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_gdd_schema_intent.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/schemas.py studio/backend/tests/test_gdd_schema_intent.py
git commit -m "feat(gdd): add orientation/focal_emphasis/framing_density intent enums"
```

---

### Task 2: Canonical layout template module

The reusable slot anatomy as normalized 0–1 regions, two orientation variants, versioned. Pure data + pure functions.

**Files:**
- Create: `studio/backend/app/scene/layout/__init__.py`
- Create: `studio/backend/app/scene/layout/template.py`
- Test: `studio/backend/tests/test_layout_template.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `TEMPLATE_VERSION: int`
  - `RoleRegion` frozen dataclass: `role:str, cx:float, cy:float, w:float, h:float, anchor_x:float=0.5, anchor_y:float=0.5, z:int=0, fit:str="region"`
  - `canvas_for(orientation: str) -> tuple[int,int]`
  - `template_for(orientation: str) -> dict[str, RoleRegion]`
  - role constants: `BACKGROUND, REELS, LOGO, SPIN, FLOURISH_LEFT, FLOURISH_RIGHT` (string values `"background"`, `"reels"`, `"logo"`, `"spin"`, `"flourish_left"`, `"flourish_right"`)

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_layout_template.py
from app.scene.layout.template import (
    TEMPLATE_VERSION, RoleRegion, canvas_for, template_for,
    BACKGROUND, REELS, LOGO, SPIN, FLOURISH_LEFT, FLOURISH_RIGHT,
)


def test_template_version_is_pinned_int():
    assert isinstance(TEMPLATE_VERSION, int) and TEMPLATE_VERSION >= 1


def test_canvas_orientation():
    assert canvas_for("landscape") == (1280, 720)
    assert canvas_for("portrait") == (720, 1280)
    assert canvas_for("anything-else") == (1280, 720)  # default landscape


def test_landscape_template_has_all_roles():
    t = template_for("landscape")
    assert set(t) == {BACKGROUND, REELS, LOGO, SPIN, FLOURISH_LEFT, FLOURISH_RIGHT}


def test_background_is_full_bleed_cover_at_back():
    bg = template_for("landscape")[BACKGROUND]
    assert (bg.cx, bg.cy, bg.w, bg.h) == (0.5, 0.5, 1.0, 1.0)
    assert bg.fit == "cover" and bg.z == 0


def test_reels_are_centered_and_focal_above_logo_below_spin():
    t = template_for("landscape")
    assert t[REELS].cx == 0.5                 # horizontally centered
    assert t[LOGO].cy < t[REELS].cy < t[SPIN].cy   # logo top, reels mid, spin bottom
    assert t[REELS].z < t[SPIN].z             # spin draws above reels


def test_regions_stay_within_unit_square():
    for orient in ("landscape", "portrait"):
        for r in template_for(orient).values():
            assert 0.0 <= r.cx <= 1.0 and 0.0 <= r.cy <= 1.0
            assert 0.0 < r.w <= 1.0 and 0.0 < r.h <= 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_layout_template.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.layout.template`.

- [ ] **Step 3: Create the package + template**

```python
# studio/backend/app/scene/layout/__init__.py
"""GDD-intent → canonical template → ScenePlan (the Scene Blueprint bind)."""
```

```python
# studio/backend/app/scene/layout/template.py
"""Canonical slot-anatomy layout template — normalized 0–1 regions, versioned.

Pure data + pure functions: no I/O, no Mongo. Regions are expressed as an
anchor-center (cx, cy) plus a region box (w, h) as fractions of the canvas, so
the same template serves any canvas size. `fit="cover"` means fill the canvas
(background); `fit="region"` means scale the asset to fit inside its (w, h) box.

Bumping TEMPLATE_VERSION changes layout for NEW binds only; existing games pin
the version they were built with (see plan.ScenePlan.template_version).
"""
from dataclasses import dataclass

TEMPLATE_VERSION = 1

BACKGROUND = "background"
REELS = "reels"
LOGO = "logo"
SPIN = "spin"
FLOURISH_LEFT = "flourish_left"
FLOURISH_RIGHT = "flourish_right"


@dataclass(frozen=True)
class RoleRegion:
    role: str
    cx: float
    cy: float
    w: float
    h: float
    anchor_x: float = 0.5
    anchor_y: float = 0.5
    z: int = 0
    fit: str = "region"  # "cover" | "region"


_LANDSCAPE = (
    RoleRegion(BACKGROUND, 0.5, 0.5, 1.0, 1.0, z=0, fit="cover"),
    RoleRegion(LOGO, 0.5, 0.13, 0.52, 0.20, z=40),
    RoleRegion(REELS, 0.5, 0.55, 0.62, 0.60, z=20),
    RoleRegion(SPIN, 0.5, 0.90, 0.13, 0.13, z=50),
    RoleRegion(FLOURISH_LEFT, 0.085, 0.55, 0.17, 0.72, z=30),
    RoleRegion(FLOURISH_RIGHT, 0.915, 0.55, 0.17, 0.72, z=30),
)

_PORTRAIT = (
    RoleRegion(BACKGROUND, 0.5, 0.5, 1.0, 1.0, z=0, fit="cover"),
    RoleRegion(LOGO, 0.5, 0.11, 0.80, 0.14, z=40),
    RoleRegion(REELS, 0.5, 0.50, 0.90, 0.52, z=20),
    RoleRegion(SPIN, 0.5, 0.88, 0.20, 0.11, z=50),
    RoleRegion(FLOURISH_LEFT, 0.12, 0.50, 0.20, 0.60, z=30),
    RoleRegion(FLOURISH_RIGHT, 0.88, 0.50, 0.20, 0.60, z=30),
)

_TEMPLATES = {
    "landscape": {r.role: r for r in _LANDSCAPE},
    "portrait": {r.role: r for r in _PORTRAIT},
}

_CANVAS = {"landscape": (1280, 720), "portrait": (720, 1280)}


def canvas_for(orientation: str) -> tuple[int, int]:
    return _CANVAS.get(orientation, _CANVAS["landscape"])


def template_for(orientation: str) -> dict[str, RoleRegion]:
    return dict(_TEMPLATES.get(orientation, _TEMPLATES["landscape"]))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_layout_template.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/layout/__init__.py studio/backend/app/scene/layout/template.py studio/backend/tests/test_layout_template.py
git commit -m "feat(scene): add canonical layout template (normalized regions, versioned)"
```

---

### Task 3: Plan types + region resolution

Resolve normalized regions to a concrete per-game plan in pixels, plus the role-alias map (so agent roles like `reel_frame` map to canonical `reels`) and the scale-to-region helper used at placement time.

**Files:**
- Create: `studio/backend/app/scene/layout/plan.py`
- Test: `studio/backend/tests/test_layout_plan.py` (create)

**Interfaces:**
- Consumes: `template.RoleRegion`.
- Produces:
  - `PlannedRole` frozen dataclass: `role:str, x:float, y:float, anchor_x:float, anchor_y:float, z:int, fit:str, region_w:int, region_h:int, prompt_snippet:str=""`
  - `ScenePlan` frozen dataclass: `canvas:tuple[int,int], orientation:str, template_version:int, roles:dict[str,PlannedRole]` with method `for_role(role:str) -> PlannedRole | None`
  - `canonical_role(role: str) -> str | None`
  - `resolve_region(region: RoleRegion, canvas: tuple[int,int], prompt_snippet: str="") -> PlannedRole`
  - `scale_to_region(tex_size: tuple[int,int], region_px: tuple[int,int]) -> float`

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_layout_plan.py
from app.scene.layout.template import template_for, REELS, BACKGROUND
from app.scene.layout.plan import (
    PlannedRole, ScenePlan, canonical_role, resolve_region, scale_to_region,
)


def test_canonical_role_aliases():
    assert canonical_role("reels") == "reels"
    assert canonical_role("reel_frame") == "reels"
    assert canonical_role("grid") == "reels"
    assert canonical_role("BackGround") == "background"
    assert canonical_role("title") == "logo"
    assert canonical_role("spin_button") == "spin"
    assert canonical_role("totally-unknown") is None


def test_resolve_region_places_anchor_center_in_pixels():
    reels = template_for("landscape")[REELS]            # cx=0.5, cy=0.55, w=0.62, h=0.60
    pr = resolve_region(reels, (1280, 720))
    assert (pr.x, pr.y) == (640.0, 396.0)               # 0.5*1280, 0.55*720
    assert (pr.region_w, pr.region_h) == (794, 432)     # round(0.62*1280), round(0.60*720)
    assert pr.z == 20 and pr.fit == "region"


def test_background_resolves_to_cover():
    bg = template_for("landscape")[BACKGROUND]
    pr = resolve_region(bg, (1280, 720))
    assert pr.fit == "cover"


def test_scale_to_region_contains_texture_in_box():
    # a 512x512 texture into a 794x432 box -> limited by height: 432/512
    assert scale_to_region((512, 512), (794, 432)) == 432 / 512
    assert scale_to_region((0, 0), (794, 432)) == 1.0   # guard against div-by-zero


def test_scene_plan_for_role_uses_alias():
    pr = PlannedRole("reels", 640, 396, 0.5, 0.5, 20, "region", 794, 432)
    plan = ScenePlan(canvas=(1280, 720), orientation="landscape",
                     template_version=1, roles={"reels": pr})
    assert plan.for_role("reel_frame") is pr
    assert plan.for_role("nope") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_layout_plan.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.layout.plan`.

- [ ] **Step 3: Create the plan module**

```python
# studio/backend/app/scene/layout/plan.py
"""Concrete per-game plan: normalized template regions resolved to pixels.

`ScenePlan` is DERIVED (reproducible from GDD intent + template_version) and is
the single source of geometry the placer and critic both read. Role aliases let
the agent name an element loosely ("reel_frame", "title") and still hit the
canonical region.
"""
from dataclasses import dataclass

from app.scene.layout.template import RoleRegion

_ALIASES = {
    "background": "background", "bg": "background", "backdrop": "background",
    "reels": "reels", "reel": "reels", "reel_frame": "reels",
    "reelframe": "reels", "grid": "reels", "reel_grid": "reels",
    "logo": "logo", "title": "logo", "wordmark": "logo", "banner": "logo",
    "spin": "spin", "spin_button": "spin", "spinbtn": "spin", "play": "spin",
    "flourish_left": "flourish_left", "flourish-left": "flourish_left",
    "left_flourish": "flourish_left", "ornament_left": "flourish_left",
    "flourish_right": "flourish_right", "flourish-right": "flourish_right",
    "right_flourish": "flourish_right", "ornament_right": "flourish_right",
}


def canonical_role(role: str) -> str | None:
    if not role:
        return None
    return _ALIASES.get(role.strip().lower().replace(" ", "_"))


@dataclass(frozen=True)
class PlannedRole:
    role: str
    x: float
    y: float
    anchor_x: float
    anchor_y: float
    z: int
    fit: str
    region_w: int
    region_h: int
    prompt_snippet: str = ""


@dataclass(frozen=True)
class ScenePlan:
    canvas: tuple[int, int]
    orientation: str
    template_version: int
    roles: dict[str, PlannedRole]

    def for_role(self, role: str) -> PlannedRole | None:
        key = canonical_role(role)
        return self.roles.get(key) if key else None


def resolve_region(region: RoleRegion, canvas: tuple[int, int],
                   prompt_snippet: str = "") -> PlannedRole:
    cw, ch = canvas
    return PlannedRole(
        role=region.role,
        x=region.cx * cw,
        y=region.cy * ch,
        anchor_x=region.anchor_x,
        anchor_y=region.anchor_y,
        z=region.z,
        fit=region.fit,
        region_w=round(region.w * cw),
        region_h=round(region.h * ch),
        prompt_snippet=prompt_snippet,
    )


def scale_to_region(tex_size: tuple[int, int], region_px: tuple[int, int]) -> float:
    tw, th = tex_size
    rw, rh = region_px
    if not tw or not th:
        return 1.0
    return min(rw / tw, rh / th)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_layout_plan.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/layout/plan.py studio/backend/tests/test_layout_plan.py
git commit -m "feat(scene): add ScenePlan types, role aliases, region resolution"
```

---

### Task 4: The bind step (intent → ScenePlan) + refiner seam

The keystone. `bind` selects the orientation template, applies the three enum transforms deterministically, resolves to pixels, attaches per-role prompt snippets, and runs an optional `LayoutRefiner` (no-op default in A1). `GddIntent` is the plain input struct (Task 5 fills it from the GDD store).

**Files:**
- Create: `studio/backend/app/scene/layout/bind.py`
- Test: `studio/backend/tests/test_layout_bind.py` (create)

**Interfaces:**
- Consumes: `template.{template_for,canvas_for,TEMPLATE_VERSION,REELS,LOGO,...}`, `plan.{ScenePlan,PlannedRole,resolve_region}`.
- Produces:
  - `GddIntent` frozen dataclass: `orientation:str="landscape", focal_emphasis:str="balanced", framing_density:str="moderate", art_direction:str="", tone:str="", setting:str="", layout:str="", role_snippets:dict[str,str]=field(default_factory=dict)`
  - `LayoutRefiner` Protocol: `def refine(self, plan: ScenePlan, intent: GddIntent) -> ScenePlan`
  - `NoopRefiner` (default): returns the plan unchanged.
  - `bind(intent: GddIntent, refiner: LayoutRefiner | None = None) -> ScenePlan`

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_layout_bind.py
from app.scene.layout.template import TEMPLATE_VERSION, REELS, LOGO, FLOURISH_LEFT, FLOURISH_RIGHT
from app.scene.layout.bind import GddIntent, NoopRefiner, bind


def test_bind_landscape_default_has_canonical_roles_and_version():
    plan = bind(GddIntent(orientation="landscape"))
    assert plan.canvas == (1280, 720)
    assert plan.template_version == TEMPLATE_VERSION
    assert {REELS, LOGO} <= set(plan.roles)


def test_bind_portrait_selects_portrait_canvas():
    plan = bind(GddIntent(orientation="portrait"))
    assert plan.canvas == (720, 1280)


def test_focal_emphasis_reels_enlarges_reels_region():
    base = bind(GddIntent(focal_emphasis="balanced")).for_role(REELS)
    reels = bind(GddIntent(focal_emphasis="reels")).for_role(REELS)
    assert reels.region_w > base.region_w and reels.region_h > base.region_h


def test_framing_density_clean_drops_flourishes():
    clean = bind(GddIntent(framing_density="clean"))
    ornate = bind(GddIntent(framing_density="ornate"))
    assert FLOURISH_LEFT not in clean.roles and FLOURISH_RIGHT not in clean.roles
    assert FLOURISH_LEFT in ornate.roles and FLOURISH_RIGHT in ornate.roles


def test_role_snippet_attached_from_intent():
    plan = bind(GddIntent(role_snippets={"reels": "ornate gold reel frame"}))
    assert "ornate gold reel frame" in plan.for_role(REELS).prompt_snippet


def test_noop_refiner_leaves_plan_unchanged():
    intent = GddIntent()
    assert bind(intent, NoopRefiner()).roles.keys() == bind(intent).roles.keys()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_layout_bind.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.layout.bind`.

- [ ] **Step 3: Create the bind module**

```python
# studio/backend/app/scene/layout/bind.py
"""The bind step — GDD intent + canonical template -> a concrete ScenePlan.

Deterministic core (enum transforms + pixel resolution) with an optional
`LayoutRefiner` seam. A1 ships the no-op refiner; A4 drops in an LLM refiner
that nudges regions within clamped bounds — without changing any caller.
"""
from dataclasses import dataclass, field, replace
from typing import Protocol

from app.scene.layout.template import (
    TEMPLATE_VERSION, RoleRegion, canvas_for, template_for,
    REELS, LOGO, FLOURISH_LEFT, FLOURISH_RIGHT,
)
from app.scene.layout.plan import ScenePlan, resolve_region


@dataclass(frozen=True)
class GddIntent:
    orientation: str = "landscape"
    focal_emphasis: str = "balanced"
    framing_density: str = "moderate"
    art_direction: str = ""
    tone: str = ""
    setting: str = ""
    layout: str = ""
    role_snippets: dict[str, str] = field(default_factory=dict)


class LayoutRefiner(Protocol):
    def refine(self, plan: ScenePlan, intent: GddIntent) -> ScenePlan: ...


class NoopRefiner:
    def refine(self, plan: ScenePlan, intent: GddIntent) -> ScenePlan:
        return plan


def _apply_focal(regions: dict[str, RoleRegion], focal: str) -> dict[str, RoleRegion]:
    out = dict(regions)
    if focal == "reels" and REELS in out:
        r = out[REELS]
        out[REELS] = replace(r, w=min(1.0, r.w * 1.18), h=min(1.0, r.h * 1.12))
        for fl in (FLOURISH_LEFT, FLOURISH_RIGHT):
            if fl in out:
                out[fl] = replace(out[fl], w=out[fl].w * 0.85)
    elif focal == "logo" and LOGO in out:
        l = out[LOGO]
        out[LOGO] = replace(l, w=min(1.0, l.w * 1.25), h=min(1.0, l.h * 1.2))
    return out


def _apply_density(regions: dict[str, RoleRegion], density: str) -> dict[str, RoleRegion]:
    out = dict(regions)
    if density == "clean":
        out.pop(FLOURISH_LEFT, None)
        out.pop(FLOURISH_RIGHT, None)
    return out


def bind(intent: GddIntent, refiner: LayoutRefiner | None = None) -> ScenePlan:
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
    return (refiner or NoopRefiner()).refine(plan, intent)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_layout_bind.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/layout/bind.py studio/backend/tests/test_layout_bind.py
git commit -m "feat(scene): add deterministic bind step + LayoutRefiner seam"
```

---

### Task 5: Intent reader (GDD → GddIntent)

Read the persisted GDD docs into a `GddIntent`, distilling per-role prompt snippets from the art direction. Async, store-backed; tested with a tiny fake store.

**Files:**
- Create: `studio/backend/app/scene/layout/intent.py`
- Test: `studio/backend/tests/test_layout_intent.py` (create)

**Interfaces:**
- Consumes: `bind.GddIntent`; a `gdd_store` with `async get_doc(game_id, aspect) -> doc|None` where `doc.data` is a dict (matches `app.gdd.store.GddStore.get_doc`).
- Produces:
  - `async read_intent(gdd_store, game_id: str) -> GddIntent`
  - `prompt_for_role(role: str, intent: GddIntent) -> str` — composes the generation prompt: art direction + tone/setting + the role's snippet.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_layout_intent.py
import pytest

from app.scene.layout.bind import GddIntent
from app.scene.layout.intent import read_intent, prompt_for_role


class _Doc:
    def __init__(self, data):
        self.data = data


class _FakeStore:
    def __init__(self, docs):
        self._docs = docs  # aspect -> data dict

    async def get_doc(self, game_id, aspect):
        d = self._docs.get(aspect)
        return _Doc(d) if d is not None else None


@pytest.mark.asyncio
async def test_read_intent_pulls_enums_and_prose():
    store = _FakeStore({
        "theme": {"art_direction": "weathered gold & deep teal", "tone": "luxe",
                  "setting": "sunken pirate vault"},
        "ui-ux": {"orientation": "portrait", "focal_emphasis": "reels",
                  "framing_density": "ornate", "layout": "reels are the hero"},
    })
    intent = await read_intent(store, "g1")
    assert intent.orientation == "portrait"
    assert intent.focal_emphasis == "reels"
    assert intent.framing_density == "ornate"
    assert "weathered gold" in intent.art_direction
    assert intent.tone == "luxe" and intent.setting == "sunken pirate vault"


@pytest.mark.asyncio
async def test_read_intent_defaults_when_docs_missing():
    intent = await read_intent(_FakeStore({}), "g1")
    assert intent.orientation == "landscape"
    assert intent.focal_emphasis == "balanced"
    assert intent.framing_density == "moderate"


def test_prompt_for_role_composes_art_direction_and_snippet():
    intent = GddIntent(art_direction="weathered gold & deep teal",
                       tone="luxe", role_snippets={"logo": "ornate crest wordmark"})
    p = prompt_for_role("logo", intent)
    assert "weathered gold" in p and "ornate crest wordmark" in p and "luxe" in p
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_layout_intent.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.layout.intent`.

- [ ] **Step 3: Create the intent reader**

```python
# studio/backend/app/scene/layout/intent.py
"""Read persisted GDD docs into a GddIntent for the bind step.

The GDD holds intent as rich prose + three enums (Task 1). This module is the
single place that knows which aspect/field each piece of intent lives in, so the
bind stays decoupled from GDD storage.
"""
from app.scene.layout.bind import GddIntent

_VALID = {
    "orientation": ("portrait", "landscape"),
    "focal_emphasis": ("reels", "logo", "balanced"),
    "framing_density": ("clean", "moderate", "ornate"),
}
_DEFAULTS = {"orientation": "landscape", "focal_emphasis": "balanced",
             "framing_density": "moderate"}


def _enum(data: dict, key: str) -> str:
    val = str(data.get(key) or "").strip().lower()
    return val if val in _VALID[key] else _DEFAULTS[key]


async def read_intent(gdd_store, game_id: str) -> GddIntent:
    theme_doc = await gdd_store.get_doc(game_id, "theme")
    ui_doc = await gdd_store.get_doc(game_id, "ui-ux")
    theme = getattr(theme_doc, "data", {}) or {}
    ui = getattr(ui_doc, "data", {}) or {}
    return GddIntent(
        orientation=_enum(ui, "orientation"),
        focal_emphasis=_enum(ui, "focal_emphasis"),
        framing_density=_enum(ui, "framing_density"),
        art_direction=str(theme.get("art_direction") or ""),
        tone=str(theme.get("tone") or ""),
        setting=str(theme.get("setting") or ""),
        layout=str(ui.get("layout") or ""),
        role_snippets={},
    )


def prompt_for_role(role: str, intent: GddIntent) -> str:
    parts = [
        intent.role_snippets.get(role, ""),
        intent.art_direction,
        f"{intent.tone} tone" if intent.tone else "",
        intent.setting,
    ]
    return ", ".join(p for p in parts if p)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/test_layout_intent.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/layout/intent.py studio/backend/tests/test_layout_intent.py
git commit -m "feat(scene): read GDD intent into GddIntent for the bind"
```

---

### Task 6: Thread an explicit region/scale through the placement path

The plan sizes each non-background element to its region box. The current placement math (`_scale_for_fit`) only knows `cover`/`contain`/`none` against the *whole canvas*. Add a `fit="region"` mode plus a `region` box so a sprite can be scaled to fit inside its planned box. Thread it through `build_sprite_ops` → `_place_in_scene` → `generate_and_place` → `BuildElement` (the loop sets these; the agent never does).

**Files:**
- Modify: `studio/backend/app/scene/compose.py:12-21` (`_scale_for_fit`), `:24-51` (`build_sprite_ops` signature + scale line)
- Modify: `studio/backend/app/agent_tools.py:102-138` (`_place_in_scene`), `:190-241` (`generate_and_place`)
- Modify: `studio/backend/app/scene/compose_loop.py:45-61` (`BuildElement`)
- Test: `studio/backend/tests/test_build_sprite_region.py` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `build_sprite_ops(..., region: tuple[int,int] | None = None)` honoring `fit="region"`; `BuildElement` gains `scale: float | None = None`, `region_w: int | None = None`, `region_h: int | None = None`; `generate_and_place` and `_place_in_scene` accept and forward `region_w`/`region_h`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_build_sprite_region.py
from app.scene.compose import build_sprite_ops


def _sprite_scale(ops):
    spr = next(o for o in ops if o["type"] == "Sprite")
    return spr["props"]["scale"]["x"]


def test_region_fit_scales_texture_into_box():
    ops = build_sprite_ops(
        handle="reels", src="/m/x.png", canvas=(1280, 720),
        tex_size=(512, 512), fit="region", region=(794, 432),
    )
    assert _sprite_scale(ops) == 432 / 512   # height-limited contain into the box


def test_region_fit_without_region_falls_back_to_native():
    ops = build_sprite_ops(
        handle="x", src="/m/x.png", canvas=(1280, 720),
        tex_size=(512, 512), fit="region", region=None,
    )
    assert _sprite_scale(ops) == 1.0


def test_cover_still_fills_canvas():
    ops = build_sprite_ops(
        handle="bg", src="/m/b.png", canvas=(1280, 720),
        tex_size=(640, 360), fit="cover",
    )
    assert _sprite_scale(ops) == 2.0   # max(1280/640, 720/360)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_build_sprite_region.py -v`
Expected: FAIL — `build_sprite_ops() got an unexpected keyword argument 'region'`.

- [ ] **Step 3: Add the `region` fit mode + thread it**

In `studio/backend/app/scene/compose.py`, replace `_scale_for_fit` and add the `region` param to `build_sprite_ops`:

```python
def _scale_for_fit(fit: str, canvas: tuple[int, int], tex: tuple[int, int],
                   region: tuple[int, int] | None = None) -> float:
    cw, ch = canvas
    tw, th = tex
    if not tw or not th:
        return 1.0
    if fit == "cover":
        return max(cw / tw, ch / th)
    if fit == "contain":
        return min(cw / tw, ch / th)
    if fit == "region" and region:
        rw, rh = region
        return min(rw / tw, rh / th)
    return 1.0
```

In `build_sprite_ops`, add `region: tuple[int, int] | None = None` to the signature (e.g. right after `fit: str = "none",`) and change the scale line:

```python
    scale = _scale_for_fit(fit, canvas, tex_size, region)
```

In `studio/backend/app/agent_tools.py`, add `region_w`/`region_h` to `_place_in_scene` (signature + the `build_sprite_ops(...)` call):

```python
async def _place_in_scene(
    ctx: ToolContext, *, handle: str, src: str, role: str, parent: str,
    x: float | None, y: float | None, anchor_x: float, anchor_y: float,
    fit: str, z_index: int, tex_size: tuple[int, int], asset_id: str = "",
    region_w: int | None = None, region_h: int | None = None,
) -> str:
    ...
    region = (region_w, region_h) if region_w and region_h else None
    ops = build_sprite_ops(
        handle=handle, src=src, role=role, parent_id=parent_id,
        ensure_root=False, canvas=canvas, tex_size=tex_size,
        x=x, y=y, anchor_x=anchor_x, anchor_y=anchor_y, fit=fit, z_index=z_index,
        asset_id=asset_id, region=region,
    )
```

In `generate_and_place`, add the two params to the inner signature and forward them in BOTH `_place_in_scene(...)` calls (it only has one) — add `region_w: int | None = None, region_h: int | None = None` after `z_index: int = 0,` and pass `region_w=region_w, region_h=region_h` into `_place_in_scene`.

In `studio/backend/app/scene/compose_loop.py`, add to `BuildElement`:

```python
    z_index: int = 0
    scale: float | None = None
    region_w: int | None = None
    region_h: int | None = None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_build_sprite_region.py tests/test_compose.py -v`
Expected: PASS — the new region tests pass and the existing `test_compose.py` still passes (no regression in cover/contain/none).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/compose.py studio/backend/app/agent_tools.py studio/backend/app/scene/compose_loop.py studio/backend/tests/test_build_sprite_region.py
git commit -m "feat(scene): add region fit-mode and thread it through placement"
```

---

### Task 7: Critic reframe — reconcile to plan

Give the critic each element's intended region and replace the remembered "slot anatomy" prose with the concrete plan. Pure changes to the request shape + prompt builder.

**Files:**
- Modify: `studio/backend/app/scene/critic.py:53-72` (`CritiqueRequest`), `:102-133` (`CRITIC_SYSTEM_PROMPT`), `:141-172` (`build_critic_messages`)
- Test: `studio/backend/tests/test_scene_critic.py` (extend — append new tests)

**Interfaces:**
- Consumes: nothing new (plan is passed as a plain dict to keep the critic decoupled from `layout.plan` types and replay-serializable).
- Produces: `CritiqueRequest` gains `plan: dict = field(default_factory=dict)` where `plan` maps `handle -> {role, x, y, w, h, z}` (the intended region for each placed handle). `build_critic_messages` includes it; `CRITIC_SYSTEM_PROMPT` instructs reconcile-to-plan.

- [ ] **Step 1: Write the failing test**

```python
# append to studio/backend/tests/test_scene_critic.py
from app.scene.critic import CritiqueRequest, build_critic_messages, CRITIC_SYSTEM_PROMPT


def test_critique_request_carries_plan():
    req = CritiqueRequest(
        frame_png=b"", scene={"elements": []}, target_handle="reels",
        window=["reels"], plan={"reels": {"role": "reels", "x": 640, "y": 396,
                                          "w": 794, "h": 432, "z": 20}},
    )
    assert req.plan["reels"]["w"] == 794


def test_messages_include_plan_region_for_target():
    req = CritiqueRequest(
        frame_png=b"\x89PNG", scene={"elements": []}, target_handle="reels",
        window=["reels"], plan={"reels": {"role": "reels", "x": 640, "y": 396,
                                          "w": 794, "h": 432, "z": 20}},
    )
    msgs = build_critic_messages(req)
    text = msgs[1].content[0]["text"]
    assert "plan" in text.lower()
    assert "794" in text   # the intended region is shown to the critic


def test_system_prompt_is_reconcile_to_plan():
    assert "plan" in CRITIC_SYSTEM_PROMPT.lower()
    assert "reconcile" in CRITIC_SYSTEM_PROMPT.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_scene_critic.py -k "plan or reconcile" -v`
Expected: FAIL — `CritiqueRequest.__init__` has no `plan`; prompt lacks "reconcile".

- [ ] **Step 3: Add `plan` to the request, prompt, and message builder**

In `studio/backend/app/scene/critic.py`, add to `CritiqueRequest` (after `edit_history`):

```python
    edit_history: dict = field(default_factory=dict)
    plan: dict = field(default_factory=dict)
```

Replace `CRITIC_SYSTEM_PROMPT` with a reconcile-to-plan version:

```python
CRITIC_SYSTEM_PROMPT = (
    "You are a slot-game composition critic. You are shown a RENDERED frame of a "
    "slot game scene being assembled element-by-element, structured context for "
    "every placed element, and a LAYOUT PLAN giving each element's INTENDED region "
    "(x, y, width, height, z) on the canvas. Your job is to RECONCILE the frame to "
    "the plan and return corrective edits as structured output.\n\n"
    "Reconcile each element to its planned region:\n"
    "- It should sit at its planned (x, y), fill close to its planned (w, h), and "
    "draw at its planned z. If it is off its mark, too large, too small, or behind/"
    "in front of the wrong neighbours, correct it with move / scale / reorder.\n"
    "- Elements must not spill outside their planned region or collide with another "
    "element's region.\n\n"
    "Discipline:\n"
    "- TRANSFORM-FIRST. Prefer move / scale / reorder. Reach for 'regenerate' only "
    "when no transform can reconcile the element because the asset is wrong FOR ITS "
    "ROLE (e.g. a dense rectangular blob). A 'regenerate' edit MUST justify in 'why' "
    "that no transform fixes it, and is refused once the budget is exhausted.\n"
    "- Edit ONLY elements inside the provided editable look-behind WINDOW. Never "
    "target a handle that is not in the window.\n"
    "- When every in-window element matches the plan, return done=true with an empty "
    "edit list. Do not invent busywork edits.\n"
    "- CONVERGE. You are shown 'edit_history' — your prior edits this build. Do NOT "
    "undo a move or oscillate; if an element was already adjusted a few times, leave "
    "it unless clearly still off-plan; prefer done=true.\n\n"
    "Return: {done, edits:[{target_handle, action, params, why}]} where action is "
    "one of move|scale|reorder|regenerate and params carries x, y (move), scale "
    "(scale), or z (reorder)."
)
```

In `build_critic_messages`, add `plan` to the context dict and the text:

```python
    context = {
        "theme": request.theme,
        "just_added": request.target_handle,
        "editable_window": request.window,
        "regen_budget_left": request.regen_budget_left,
        "edit_history": request.edit_history,
        "plan": request.plan,
        "scene": request.scene,
    }
    text = (
        "Critique the rendered slot scene shown in the image and return corrective "
        "edits that RECONCILE each element to its planned region.\n"
        f"Just-added element (judge it hardest): {request.target_handle}\n"
        f"Editable look-behind window (you may ONLY target these handles): "
        f"{request.window}\n"
        f"Regenerations left in budget: {request.regen_budget_left}\n"
        f"Theme/intent: {request.theme}\n\n"
        f"Layout plan + scene context (JSON):\n{json.dumps(context, indent=2)}"
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_scene_critic.py -v`
Expected: PASS — new plan/reconcile tests pass and the existing critic tests still pass (the extra `plan` key is additive; replay cassettes are unaffected).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/critic.py studio/backend/tests/test_scene_critic.py
git commit -m "feat(scene): critic reconciles each element to its planned region"
```

---

### Task 8: Compose loop places into plan regions + passes plan to critic

`run_compose` learns about the plan: before placing each element it overwrites the element's geometry from the plan (position/anchor/region/z), and it passes the per-handle intended regions into every `CritiqueRequest`. Pure loop change, tested with a fake `ComposeDeps`.

**Files:**
- Modify: `studio/backend/app/scene/compose_loop.py:91-160` (`run_compose` signature + body)
- Test: `studio/backend/tests/test_compose_loop.py` (extend — append new tests; reuse existing fakes if present, else the fake below)

**Interfaces:**
- Consumes: `app.scene.layout.plan.ScenePlan`.
- Produces: `run_compose(elements, theme, deps, bounds=ComposeBounds(), plan: ScenePlan | None = None) -> ComposeResult`. When `plan` is given: (a) each `BuildElement` is rewritten so its `x/y/anchor_x/anchor_y/z_index/fit/region_w/region_h` come from `plan.for_role(element.role or element.slot)`; (b) each `CritiqueRequest.plan` carries `{handle: {role,x,y,w,h,z}}` for handles in the window.

- [ ] **Step 1: Write the failing test**

```python
# append to studio/backend/tests/test_compose_loop.py
import pytest

from app.scene.asset_critic import AssetVerdict
from app.scene.critic import Critique, CritiqueRequest
from app.scene.compose_loop import BuildElement, ComposeBounds, run_compose
from app.scene.layout.bind import GddIntent, bind
from app.scene.layout.template import REELS


class _RecordingDeps:
    """Minimal ComposeDeps fake that records placed elements + critic requests."""

    def __init__(self):
        self.placed: list[BuildElement] = []
        self.requests: list[CritiqueRequest] = []

    async def place(self, element):
        self.placed.append(element)
        return "ok"

    async def placed_handles(self):
        return [e.slot or e.role for e in self.placed]

    async def scene_context(self):
        return {"elements": []}

    async def render_scene(self):
        return b"\x89PNG"

    async def critique_asset(self, target_handle, attempt=0):
        return AssetVerdict(ok=True, action="keep", reason="ok")

    async def critique(self, request):
        self.requests.append(request)
        return Critique(done=True, edits=[])

    async def adjust(self, handle, params):
        return "ok"

    async def regenerate(self, handle):
        return "ok"

    async def out_of_frame(self):
        return []


@pytest.mark.asyncio
async def test_loop_overwrites_geometry_from_plan():
    plan = bind(GddIntent(focal_emphasis="reels"))
    deps = _RecordingDeps()
    el = BuildElement(description="ornate reel frame", slot="reels", role="reels",
                      x=10, y=10, fit="none")   # agent-guessed coords, should be ignored
    await run_compose([el], "pirate", deps, plan=plan)
    placed = deps.placed[0]
    pr = plan.for_role("reels")
    assert (placed.x, placed.y) == (pr.x, pr.y)        # plan position, not (10,10)
    assert placed.fit == pr.fit
    assert (placed.region_w, placed.region_h) == (pr.region_w, pr.region_h)
    assert placed.z_index == pr.z


@pytest.mark.asyncio
async def test_loop_passes_plan_region_into_critique():
    plan = bind(GddIntent())
    deps = _RecordingDeps()
    el = BuildElement(description="x", slot="reels", role="reels")
    await run_compose([el], "pirate", deps, plan=plan)
    req = deps.requests[0]
    assert "reels" in req.plan
    assert req.plan["reels"]["w"] == plan.for_role("reels").region_w


@pytest.mark.asyncio
async def test_loop_without_plan_is_unchanged():
    deps = _RecordingDeps()
    el = BuildElement(description="x", slot="reels", role="reels", x=10, y=10)
    await run_compose([el], "pirate", deps)   # no plan -> agent coords preserved
    assert (deps.placed[0].x, deps.placed[0].y) == (10, 10)
    assert deps.requests[0].plan == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_compose_loop.py -k "plan" -v`
Expected: FAIL — `run_compose() got an unexpected keyword argument 'plan'`.

- [ ] **Step 3: Add the `plan` parameter and the rewrite/threading logic**

In `studio/backend/app/scene/compose_loop.py`, add the import near the top:

```python
from app.scene.layout.plan import ScenePlan
```

Add a pure helper above `run_compose`:

```python
def _apply_plan(element: BuildElement, plan: "ScenePlan | None") -> BuildElement:
    """Overwrite an element's geometry from its planned role region. The plan owns
    geometry; the agent only chose content + role. No-op when no plan or no role."""
    if plan is None:
        return element
    pr = plan.for_role(element.role or element.slot)
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
    role_by_handle = {(e.slot or e.role): (e.role or e.slot) for e in elements}
    out: dict = {}
    for handle in window:
        pr = plan.for_role(role_by_handle.get(handle, handle))
        if pr is not None:
            out[handle] = {"role": pr.role, "x": pr.x, "y": pr.y,
                           "w": pr.region_w, "h": pr.region_h, "z": pr.z}
    return out
```

Change the `run_compose` signature:

```python
async def run_compose(
    elements: list[BuildElement],
    theme: str,
    deps: ComposeDeps,
    bounds: ComposeBounds = ComposeBounds(),
    plan: ScenePlan | None = None,
) -> ComposeResult:
```

In the loop body, replace `await deps.place(element)` (line ~103) with:

```python
        await deps.place(_apply_plan(element, plan))
```

And in the `CritiqueRequest(...)` construction (line ~156), add the plan context:

```python
            critique = await deps.critique(CritiqueRequest(
                frame_png=frame, scene=scene, target_handle=target,
                window=window, theme=theme, regen_budget_left=regen_left,
                pass_index=pass_index, edit_history=window_history,
                plan=_plan_context(plan, window, elements),
            ))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_compose_loop.py -v`
Expected: PASS — new plan tests pass; existing compose-loop tests still pass (plan defaults to `None`, preserving old behaviour).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/compose_loop.py studio/backend/tests/test_compose_loop.py
git commit -m "feat(scene): compose loop places into plan regions and feeds critic the plan"
```

---

### Task 9: Wire `compose_scene` to bind; add `rebuild_scene`; router re-trigger

Make the agent path plan-driven end-to-end: `compose_scene` reads GDD intent, binds a plan, ensures the Root at the plan's canvas, and runs the loop with the plan. Add a `rebuild_scene` verb that re-runs the whole flow from persisted intent (HITL Surface 1), and have the design-router call it after intent edits.

**Files:**
- Modify: `studio/backend/app/agent_tools.py:533-562` (`build_compose_scene_tool`), and add `build_rebuild_scene_tool` nearby
- Modify: `studio/backend/app/scene/document.py` — none; reuse `empty_document` already imported
- Modify: `studio/backend/app/gdd/models.py` — add `"rebuild_scene"` to `GDD_TOOL_NAMES` only if the router needs it in its toolset (see Step 3)
- Modify: `studio/backend/app/gdd/router.py:53-108` (branch text) + `:118-123` (tool set)
- Register the new tool wherever `compose_scene` is registered (the `ToolFactory._BUILDERS` map — grep `build_compose_scene_tool`)
- Test: `studio/backend/tests/test_compose_scene_bind.py` (create)

**Interfaces:**
- Consumes: `layout.intent.read_intent`, `layout.bind.bind`, `layout.plan.ScenePlan`, existing `_SceneComposeDeps`, `run_compose`, `ctx.scene_hub.ensure_root`.
- Produces:
  - `compose_scene(elements, theme="")` now binds a plan from `ctx.gdd_store` and calls `run_compose(..., plan=plan)`.
  - new `rebuild_scene(theme="")` agent tool: reads intent, binds, and re-composes the canonical roles already present as GDD symbols/scene elements (A1: re-runs the loop over the current scene's placed roles).
  - helper `async def _plan_for_game(ctx) -> ScenePlan` shared by both.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_compose_scene_bind.py
import pytest

from app.scene.layout.plan import ScenePlan
from app.agent_tools import _plan_for_game, ToolContext


class _Doc:
    def __init__(self, data):
        self.data = data


class _FakeGdd:
    def __init__(self, docs):
        self._docs = docs

    async def get_doc(self, game_id, aspect):
        d = self._docs.get(aspect)
        return _Doc(d) if d is not None else None


@pytest.mark.asyncio
async def test_plan_for_game_binds_from_gdd_intent():
    ctx = ToolContext(room_id="r", game_id="g", asset_store=None, asset_hub=None,
                      gdd_store=_FakeGdd({"ui-ux": {"orientation": "portrait"}}))
    plan = await _plan_for_game(ctx)
    assert isinstance(plan, ScenePlan)
    assert plan.canvas == (720, 1280)        # portrait from GDD intent
    assert plan.orientation == "portrait"


@pytest.mark.asyncio
async def test_plan_for_game_defaults_without_gdd():
    ctx = ToolContext(room_id="r", game_id="g", asset_store=None, asset_hub=None,
                      gdd_store=_FakeGdd({}))
    plan = await _plan_for_game(ctx)
    assert plan.canvas == (1280, 720)        # default landscape
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_compose_scene_bind.py -v`
Expected: FAIL — `ImportError: cannot import name '_plan_for_game'`.

- [ ] **Step 3: Add `_plan_for_game`, bind in `compose_scene`, add `rebuild_scene`, wire router**

In `studio/backend/app/agent_tools.py`, add imports near the top (with the other `app.scene` imports):

```python
from app.scene.layout.bind import bind
from app.scene.layout.intent import read_intent
from app.scene.layout.plan import ScenePlan
```

Add the shared helper (above `build_compose_scene_tool`):

```python
async def _plan_for_game(ctx: ToolContext) -> ScenePlan:
    """Bind a ScenePlan from the game's persisted GDD intent. Falls back to the
    default landscape template when no GDD store / intent is present."""
    if ctx.gdd_store is None:
        from app.scene.layout.bind import GddIntent
        return bind(GddIntent())
    return bind(await read_intent(ctx.gdd_store, ctx.game_id))
```

Change `compose_scene` to bind and pass the plan + ensure the Root at the plan canvas:

```python
def build_compose_scene_tool(ctx: ToolContext) -> BaseTool:
    async def compose_scene(elements: list[dict], theme: str = "") -> str:
        if not elements:
            return "Pass at least one element to build."
        if ctx.scene_critic is None or ctx.asset_critic is None:
            return ("Compose loop unavailable: no critic wired. "
                    "Place elements individually with generate_and_place.")
        plan = await _plan_for_game(ctx)
        if ctx.scene_hub is not None:
            await ctx.scene_hub.ensure_root(ctx.game_id, plan.canvas)
        build = [BuildElement(**e) for e in elements]
        deps = _SceneComposeDeps(ctx)
        result = await run_compose(build, theme, deps, plan=plan)
        return format_compose_summary(result)
    # ... keep the existing StructuredTool.from_function(...) description block,
    #     but append this sentence to the description string:
    #     " Element positions come from the game's layout plan (you choose each "
    #     "element's role/slot — background, logo, reels, spin, flourish_left, "
    #     "flourish_right — not its x/y)."
```

Add the `rebuild_scene` tool (after `build_compose_scene_tool`):

```python
def build_rebuild_scene_tool(ctx: ToolContext) -> BaseTool:
    async def rebuild_scene(theme: str = "") -> str:
        """Re-run bind -> place -> reconcile for every role already in the scene,
        using the CURRENT persisted GDD intent. Use after the art direction or
        layout intent changes so the live scene reflows to the new plan."""
        if ctx.scene_critic is None or ctx.asset_critic is None:
            return "Rebuild unavailable: no critic wired."
        plan = await _plan_for_game(ctx)
        if ctx.scene_hub is not None:
            await ctx.scene_hub.ensure_root(ctx.game_id, plan.canvas)
        deps = _SceneComposeDeps(ctx)
        handles = await deps.placed_handles()
        if not handles:
            return "Nothing to rebuild: the scene is empty."
        # Re-place each existing role from the plan; reuse keeps the same art
        # (generate_and_place reuses a slot that already has a selected image).
        elements = [BuildElement(slot=h, role=h) for h in handles]
        result = await run_compose(elements, theme, deps, plan=plan)
        return "Rebuilt scene from current design intent. " + format_compose_summary(result)

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

Register `build_rebuild_scene_tool` in the same builder registry as `build_compose_scene_tool`. Grep first:

Run: `grep -rn "build_compose_scene_tool" studio/backend/app`
Add a sibling entry for `rebuild_scene` -> `build_rebuild_scene_tool` in the `_BUILDERS`/registry map you find, and add `"rebuild_scene"` to `GDD_TOOL_NAMES` (in `studio/backend/app/gdd/models.py`) so the design-router includes it.

In `studio/backend/app/gdd/router.py`, add `"rebuild_scene"` to the tool set in `build_design_router_spec` (the `sorted(GDD_TOOL_NAMES | {...})` set) and extend branch 1 and the symbol branch so an intent edit reflows the scene. Append this sentence to branch **1** (concrete design decision):

```
   If the field you just set is an ART-DIRECTION or LAYOUT-INTENT field
   (theme.art_direction, ui-ux.layout, ui-ux.orientation, ui-ux.focal_emphasis,
   ui-ux.framing_density) AND the scene already has placed elements, follow the
   `set_gdd_fields` call with a single `rebuild_scene` call so the live scene
   reflows to the new plan. Then confirm in one sentence.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_compose_scene_bind.py tests/test_agent_tools.py -v`
Expected: PASS — `_plan_for_game` binds from intent; existing agent-tool tests still pass (grep for the existing test module name; if it differs, run the suite under `tests/` that exercises `agent_tools`).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/gdd/router.py studio/backend/app/gdd/models.py studio/backend/tests/test_compose_scene_bind.py
git commit -m "feat(scene): bind plan in compose_scene, add rebuild_scene, router re-trigger"
```

---

### Task 10: Backend e2e — plan-driven build + reproducibility (replay)

Prove the integration path end-to-end against a replay backend: a build places elements into their planned regions, the critic reconciles, and a second identical bind produces an equivalent plan (reproducibility of geometry). This is the authoritative backend contract for A1.

**Files:**
- Create: `studio/backend/tests/e2e/test_scene_blueprint_compose.py`
- Create (if missing): `studio/backend/tests/fixtures/replay/critic/default.json` (a `done:true` cassette so the loop converges in one pass — only create if not already present)
- Test: the file above

**Interfaces:**
- Consumes: the real `run_compose`, `bind`, `_SceneComposeDeps` (or a thin real-store harness mirroring the existing `tests/e2e/test_compose_loop.py` setup).
- Produces: passing e2e asserting plan geometry + reproducibility.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/e2e/test_scene_blueprint_compose.py
"""Backend e2e (replay): plan-driven compose + geometry reproducibility.

Mirrors the harness in tests/e2e/test_compose_loop.py (real compositor + replay
critic, no browser). If that harness exposes shared fixtures, reuse them; the
asserts below are the A1 contract regardless of harness shape.
"""
import pytest

from app.scene.layout.bind import GddIntent, bind
from app.scene.layout.template import REELS, LOGO


def test_bind_is_reproducible_from_same_intent():
    intent = GddIntent(orientation="landscape", focal_emphasis="reels",
                       framing_density="ornate", art_direction="gold & teal")
    a = bind(intent)
    b = bind(intent)
    assert a.roles.keys() == b.roles.keys()
    for role in a.roles:
        assert a.for_role(role) == b.for_role(role)   # frozen dataclass equality
    assert a.template_version == b.template_version


def test_focal_reels_plan_makes_reels_largest_non_background():
    plan = bind(GddIntent(focal_emphasis="reels"))
    reels = plan.for_role(REELS)
    logo = plan.for_role(LOGO)
    reels_area = reels.region_w * reels.region_h
    logo_area = logo.region_w * logo.region_h
    assert reels_area > logo_area
```

Then add the full compose integration test following the existing
`tests/e2e/test_compose_loop.py` pattern (real stores + replay critic). Assert,
after a build of `[{"slot":"background",...,"transparent":false},{"slot":"reels",...},{"slot":"logo",...}]`:

```python
@pytest.mark.asyncio
async def test_plan_driven_build_places_reels_in_planned_region(compose_harness):
    # compose_harness: the same real-store + replay-critic fixture used by
    # tests/e2e/test_compose_loop.py, exposing ctx + a built scene document.
    ctx = compose_harness.ctx
    from app.agent_tools import build_compose_scene_tool
    tool = build_compose_scene_tool(ctx)
    await tool.ainvoke({"elements": [
        {"slot": "background", "role": "background", "description": "vault, no text",
         "transparent": False, "size": "1280x720"},
        {"slot": "reels", "role": "reels", "description": "ornate gold reel frame",
         "size": "512x512"},
        {"slot": "logo", "role": "logo", "description": "crest wordmark",
         "size": "768x512"},
    ], "theme": "premium pirate slot"})

    doc = await ctx.scene_store.get_document(ctx.game_id)
    reels = doc["nodes"]["spr.reels"]["props"]
    plan_reels = bind(GddIntent()).for_role("reels")
    assert reels["position"] == {"x": plan_reels.x, "y": plan_reels.y}
    assert reels["zIndex"] == plan_reels.z
    # scaled to its region, not left at native 512:
    assert reels["scale"]["x"] < 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/e2e/test_scene_blueprint_compose.py -v`
Expected: FAIL — the integration test fails (no `compose_harness` fixture yet) and/or the geometry asserts fail before wiring is complete. The two pure `bind` tests should already pass once Tasks 2–4 are in.

- [ ] **Step 3: Implement the harness + ensure a default critic cassette**

- Reuse the real-store + replay-critic setup from `studio/backend/tests/e2e/test_compose_loop.py`. If it exposes a fixture (e.g. `compose_harness` / a `ctx` builder), import and reuse it; otherwise lift its setup into a local `@pytest.fixture` named `compose_harness` exposing `.ctx` (with real `scene_store`, `scene_hub`, `asset_store`, `asset_hub`, a `ReplaySceneCritic`, and an `AssetCritic`).
- Ensure `studio/backend/tests/fixtures/replay/critic/default.json` exists with a single-pass converge cassette (only create if missing):

```json
[
  { "done": true, "edits": [] }
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/e2e/test_scene_blueprint_compose.py -v`
Expected: PASS — reproducibility + focal-area asserts pass; the plan-driven build places `spr.reels` at the planned position/z and scaled below native size.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tests/e2e/test_scene_blueprint_compose.py studio/backend/tests/fixtures/replay/critic/default.json
git commit -m "test(scene): backend e2e for plan-driven compose + reproducibility"
```

---

## Self-Review

**1. Spec coverage**

| Spec element | Task |
| --- | --- |
| L1 GDD intent: 3 enums + consume prose | Task 1 (enums), Task 5 (read + prose) |
| L2 canonical template in code, normalized regions, versioned | Task 2 |
| ScenePlan + region resolution | Task 3 |
| Bind step (enum transforms) + `LayoutRefiner` no-op seam | Task 4 |
| Generator prompts consume art direction | Task 5 (`prompt_for_role`) — consumed by `_SceneComposeDeps` via role snippets/intent; full per-asset prompt augmentation is sub-project C |
| Plan-driven placer (agent stops hand-placing) | Task 6 (region fit) + Task 8 (geometry overwrite) + Task 9 (compose_scene binds) |
| Critic reconciles to plan; remembered anatomy replaced | Task 7 + Task 8 (plan threaded) |
| `rebuild_scene` spine | Task 9 |
| HITL Surface 1 (chat re-trigger) | Task 9 (router branch) |
| Reproducibility (TEMPLATE_VERSION pinned, deterministic bind) | Task 3/4 (version in plan) + Task 10 (reproducibility e2e) |
| Testing: unit + backend replay e2e | Tasks 1–9 unit, Task 10 e2e |

Out of A1 scope (correctly deferred per spec): real-frame vision (B); asset-floor prompt/cfg/upscale/mandatory asset critic (C); HITL Surfaces 2–4 (A2/A3); LLM layout refiner (A4 — seam present, impl deferred).

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". One deliberate grep-and-adapt point in Task 9 Step 3 (the tool-registry map and the agent-tools test module name) and Task 10 (reuse the existing e2e harness) — both name the exact symbol to grep (`build_compose_scene_tool`) and the exact file to mirror (`tests/e2e/test_compose_loop.py`), because those local names can't be known without reading the registry at implement-time. Acceptable: they point at a concrete, named anchor, not vague intent.

**3. Type consistency:** `GddIntent` fields match across bind (Task 4), intent reader (Task 5), and `_plan_for_game` (Task 9). `PlannedRole` field names (`region_w`/`region_h`/`z`/`fit`) are used identically in Task 3, 6, 8. `ScenePlan.for_role` is the single lookup used in Tasks 8–10. `CritiqueRequest.plan` is a `dict` everywhere (Task 7 defines, Task 8 fills, Task 10 reads). `BuildElement` gains `scale`/`region_w`/`region_h` in Task 6 and is updated via `model_copy` in Task 8. `fit="region"` is introduced in Task 6 and produced by the template/bind in Tasks 2–4. Consistent.
