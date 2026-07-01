# Scene Blueprint B — Real-frame vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After A's geometry loop converges on the Pillow proxy, capture the real Pixi engine frame and run one additive art/effects grade that can regenerate weak assets and report a premium verdict.

**Architecture:** A new `SceneArtCritic` seam (replay + live, its own cassettes) mirrors the existing `SceneCritic`/`AssetCritic` seams. `run_compose` gains a final art stage that runs once after the per-element geometry loop: it captures the real frame via the already-wired `SceneCaptureBroker`, grades it, and regenerates flagged assets within the shared per-build budget — skipping cleanly (a note) when no browser client is attached. Geometry reconcile and the Pillow proxy are untouched.

**Tech Stack:** Python (FastAPI, pydantic, LangChain/`langchain_openai`), Socket.IO, pytest/pytest-asyncio (backend); Playwright + Pixi runtime client (browser e2e). Backend run via `uv --directory studio/backend run pytest`.

## Global Constraints

- **A is untouched.** Geometry reconcile-to-plan and the Pillow proxy (`render_scene()` → `composite_scene`) are NOT modified. B is additive.
- **The art critic's ONLY actuator is `regenerate`.** No `move`/`scale`/`reorder`, no effect-property (glow/blend/filter/particle) tuning.
- **No sub-project C changes.** `regenerate` reuses the existing generate path; no negative prompts / cfg / steps / upscale / asset-floor changes.
- **Art regenerations draw from the SAME per-build `regen_left`** used by the geometry loop — one hard ceiling per build.
- **Headless (no client) → art skipped, geometry output byte-for-byte unchanged**; a note (`"art grade skipped: no live client"`) is recorded.
- **No new persisted state.** The art grade is non-deterministic only when live; in replay it is cassette-driven. It is not a reproducibility input.
- **Mirror the existing critic seams structurally:** `Replay*`/`Live*` impls + `build_scene_art_critic(settings)` selector + a pure message builder + a cassette dir `tests/fixtures/replay/scene_art/`.
- **Browser e2e never runs in CI.** Run locally against the replay backend at THIS worktree's `BLOOM_PORT_OFFSET=1` → backend **8001** / frontend **4201** / runtime **4301**. Always export the offset before Playwright (else it attaches to the default-port stack another session may hold).
- **TDD RED-GREEN-REFACTOR, semantic commits, frequent commits.** TypeScript interfaces use the `I` prefix (repo standard) — only relevant if B3 adds any TS interface.

## File Structure

**Create:**
- `studio/backend/app/scene/art_critic.py` — the `SceneArtCritic` seam (types, protocol, replay + live, pure builder, selector).
- `studio/backend/tests/fixtures/replay/scene_art/default.json` — benign premium cassette (replay fallback).
- `studio/backend/tests/fixtures/replay/scene_art/pirate-regen.json` — theme-keyed cassette that flags a regenerate then passes (for the injected-frame backend e2e).
- `studio/backend/tests/test_art_critic.py` — unit: replay selection, loader, pure builder, selector.
- `studio/backend/tests/test_compose_art_stage.py` — unit: `run_compose` art stage behind a fake `ComposeDeps`.
- `studio/backend/tests/e2e/test_scene_art.py` — backend e2e: skip-when-no-client + grade-when-answered.
- `studio/frontend/e2e/scene-art.spec.ts` — browser e2e: real capture → grade → verdict in chat.

**Modify:**
- `studio/backend/app/replay/cassette.py` — add `load_scene_art_cassettes`.
- `studio/backend/app/config.py` — add `art_capture_timeout`.
- `studio/backend/app/scene/compose_loop.py` — `ComposeDeps` (+2 methods), `ComposeBounds.art_passes`, `ComposeResult.art_passes_run`, the art stage in `run_compose`.
- `studio/backend/app/agent_tools.py` — `ToolContext.scene_art_critic`; `_SceneComposeDeps.capture_real_frame` + `art_grade`; `import asyncio`.
- `studio/backend/app/main.py` — build + pass + `state` for `scene_art_critic`.
- `studio/backend/app/room_hub.py` — `__init__` param + field + thread into `ToolContext`.

**Wiring note (preempt reviewer confusion):** The REST rebuild sites that build a `ToolContext` directly (`intent_rebuild`, `override_rebuild`) intentionally leave `scene_art_critic` as its `None` default — those paths are headless (no browser client), so the art stage correctly skips there. Only the chat path (`RoomHub`, where a client is attached) threads the critic.

---

## Task 1: `SceneArtCritic` seam — types, replay impl, cassette loader

**Files:**
- Create: `studio/backend/app/scene/art_critic.py`
- Modify: `studio/backend/app/replay/cassette.py` (add `load_scene_art_cassettes`)
- Create: `studio/backend/tests/fixtures/replay/scene_art/default.json`
- Test: `studio/backend/tests/test_art_critic.py`

**Interfaces:**
- Produces:
  - `class ArtRegen(BaseModel)` — `target_handle: str`, `why: str = ""`
  - `class SceneArtVerdict(BaseModel)` — `premium: bool = False`, `summary: str = ""`, `regenerate: list[ArtRegen] = []`, `notes: list[str] = []`
  - `@dataclass(frozen=True) class SceneArtRequest` — `frame_png: bytes`, `scene: dict`, `plan: dict = {}`, `theme: str = ""`, `regen_budget_left: int = 0`, `pass_index: int = 0`
  - `class SceneArtCritic(Protocol)` — `async def grade(self, request: SceneArtRequest) -> SceneArtVerdict`
  - `class ReplaySceneArtCritic` — constructed with `cassettes: dict[str, list[dict]]`
  - `load_scene_art_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]`

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_art_critic.py`:

```python
import asyncio
import json
from pathlib import Path

from app.replay.cassette import load_scene_art_cassettes, normalize_prompt
from app.scene.art_critic import (
    ReplaySceneArtCritic,
    SceneArtRequest,
    SceneArtVerdict,
)


def test_loader_keys_by_theme_and_default(tmp_path: Path):
    base = tmp_path / "scene_art"
    base.mkdir()
    (base / "default.json").write_text(json.dumps({"passes": [{"premium": True}]}))
    (base / "pirate.json").write_text(json.dumps(
        {"theme": "Pirate Slot", "passes": [{"premium": False, "summary": "flat"}]}))
    out = load_scene_art_cassettes(tmp_path)
    assert out["__default__"] == [{"premium": True}]
    assert out[normalize_prompt("Pirate Slot")] == [{"premium": False, "summary": "flat"}]


def test_replay_returns_keyed_pass_then_benign_default():
    critic = ReplaySceneArtCritic({
        "pirate slot": [
            {"premium": False, "summary": "logo washed out",
             "regenerate": [{"target_handle": "logo", "why": "lost to glow"}]},
            {"premium": True, "summary": "reads premium"},
        ],
    })
    req0 = SceneArtRequest(frame_png=b"x", scene={}, theme="pirate slot", pass_index=0)
    v0 = asyncio.run(critic.grade(req0))
    assert v0.premium is False
    assert v0.regenerate[0].target_handle == "logo"

    # pass_index past the recorded passes -> benign premium (loop can end)
    req9 = SceneArtRequest(frame_png=b"x", scene={}, theme="pirate slot", pass_index=9)
    assert asyncio.run(critic.grade(req9)).premium is True

    # unknown theme, no default -> benign premium (never raises; additive stage)
    req_unknown = SceneArtRequest(frame_png=b"x", scene={}, theme="unknown")
    assert asyncio.run(critic.grade(req_unknown)).premium is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_art_critic.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.art_critic` / `ImportError: load_scene_art_cassettes`.

- [ ] **Step 3: Add the cassette loader**

In `studio/backend/app/replay/cassette.py`, add after `load_critic_cassettes` (mirrors it, keyed by `theme` instead of `target`):

```python
def load_scene_art_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]:
    """Load scene art/effects-critic cassettes keyed by normalized theme.

    Each ``scene_art/*.json`` is ``{passes: [<SceneArtVerdict-shaped dict>, ...]}``
    with an optional ``theme``. ``default.json`` becomes ``"__default__"`` (the
    fallback). Files with a ``theme`` are also keyed by ``normalize_prompt(theme)``.
    Mirrors ``load_critic_cassettes`` — the art critic is a direct structured+image
    call with its OWN per-pass cassette format, keyed by build theme.
    """
    out: dict[str, list[dict]] = {}
    base = Path(fixtures_dir) / "scene_art"
    if not base.is_dir():
        return out
    for path in sorted(base.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        passes = list(data.get("passes", []))
        if path.name == "default.json":
            out["__default__"] = passes
        if "theme" in data:
            out[normalize_prompt(data["theme"])] = passes
    return out
```

- [ ] **Step 4: Create `art_critic.py` (types + protocol + replay impl)**

Create `studio/backend/app/scene/art_critic.py`:

```python
"""Scene art/effects critic — swappable seam (sub-project B, real-frame vision).

Grades the REAL captured Pixi engine frame (effects, blends, responsive scaling)
AFTER A's geometry loop converges on the Pillow proxy. Additive: geometry reconcile
is untouched. Its ONLY actuator is ``regenerate`` — it never moves/scales/reorders
and never tunes effect properties. Like the two existing critics it is a DIRECT
structured+image LLM call (not a bound tool) with its own cassette format
(``tests/fixtures/replay/scene_art/``). See
``docs/superpowers/specs/2026-07-01-scene-vision-b-real-frame-design.md``.
"""

import base64
import json
from dataclasses import dataclass, field
from typing import Protocol

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR,
    load_scene_art_cassettes,
    normalize_prompt,
)


class ArtRegen(BaseModel):
    target_handle: str
    why: str = ""


class SceneArtVerdict(BaseModel):
    premium: bool = False
    summary: str = ""
    regenerate: list[ArtRegen] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class SceneArtRequest:
    """Everything the art critic needs to grade the finished scene's real frame.

    ``frame_png`` is the REAL captured engine frame. ``scene`` is the structured
    read_scene context; ``plan`` maps each role to its intended region. ``theme``
    keys the replay cassette; ``pass_index`` is the art re-grade number.
    """

    frame_png: bytes
    scene: dict
    plan: dict = field(default_factory=dict)
    theme: str = ""
    regen_budget_left: int = 0
    pass_index: int = 0


class SceneArtCritic(Protocol):
    async def grade(self, request: SceneArtRequest) -> SceneArtVerdict: ...


class ReplaySceneArtCritic:
    """Deterministic, offline art critic. Returns recorded per-pass verdicts from
    ``tests/fixtures/replay/scene_art/`` keyed by normalized theme. Never raises:
    the art stage is additive/optional, so a missing cassette yields a benign
    ``premium=True`` pass rather than failing the build."""

    def __init__(self, cassettes: dict[str, list[dict]]):
        self._cassettes = cassettes

    async def grade(self, request: SceneArtRequest) -> SceneArtVerdict:
        passes = self._cassettes.get(normalize_prompt(request.theme))
        if passes is None:
            passes = self._cassettes.get("__default__")
        if passes is None or request.pass_index >= len(passes):
            return SceneArtVerdict(premium=True)
        return SceneArtVerdict(**passes[request.pass_index])
```

- [ ] **Step 5: Create the default cassette fixture**

Create `studio/backend/tests/fixtures/replay/scene_art/default.json`:

```json
{
  "passes": [{ "premium": true, "summary": "Scene reads as a premium slot." }]
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_art_critic.py -v`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/scene/art_critic.py studio/backend/app/replay/cassette.py studio/backend/tests/fixtures/replay/scene_art/default.json studio/backend/tests/test_art_critic.py
git commit -m "feat(scene): SceneArtCritic seam + replay impl + cassette loader"
```

---

## Task 2: Pure message builder, live impl, and selector

**Files:**
- Modify: `studio/backend/app/scene/art_critic.py`
- Modify: `studio/backend/app/config.py` (add `art_capture_timeout`)
- Test: `studio/backend/tests/test_art_critic.py` (add cases)

**Interfaces:**
- Consumes: `SceneArtRequest`, `SceneArtVerdict` (Task 1).
- Produces:
  - `build_art_messages(request: SceneArtRequest) -> list[BaseMessage]`
  - `class LiveSceneArtCritic` — `__init__(api_key: str, base_url: str, model: str)`
  - `build_scene_art_critic(settings: Settings) -> SceneArtCritic`
  - `Settings.art_capture_timeout: float = 3.0`

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_art_critic.py`:

```python
from app.config import Settings
from app.scene.art_critic import (
    ART_SYSTEM_PROMPT,
    LiveSceneArtCritic,
    build_art_messages,
    build_scene_art_critic,
)


def test_build_art_messages_carries_frame_and_context():
    req = SceneArtRequest(
        frame_png=b"\x89PNGxyz", scene={"elements": [{"handle": "logo"}]},
        plan={"logo": {"role": "logo", "x": 540, "y": 200}}, theme="pirate slot")
    msgs = build_art_messages(req)
    assert msgs[0].content == ART_SYSTEM_PROMPT
    parts = msgs[1].content
    assert parts[0]["type"] == "text" and "pirate slot" in parts[0]["text"]
    assert parts[1]["type"] == "image_url"
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_selector_picks_replay_in_replay_mode():
    s = Settings(provider_mode="replay")
    assert type(build_scene_art_critic(s)).__name__ == "ReplaySceneArtCritic"


def test_selector_picks_live_otherwise():
    s = Settings(provider_mode="live", openrouter_api_key="k")
    assert isinstance(build_scene_art_critic(s), LiveSceneArtCritic)


def test_art_capture_timeout_default():
    assert Settings().art_capture_timeout == 3.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_art_critic.py -v -k "messages or selector or timeout"`
Expected: FAIL — `ImportError` for `build_art_messages` / `ART_SYSTEM_PROMPT` / `build_scene_art_critic`, and `art_capture_timeout` AttributeError.

- [ ] **Step 3: Add the timeout setting**

In `studio/backend/app/config.py`, add after `critic_model` (line ~21):

```python
    # Short timeout for the real-frame capture used by the art/effects grade
    # (sub-project B). A live browser client answers in well under a second; the
    # short bound lets a HEADLESS rebuild (no client) fail fast and skip the art
    # stage instead of blocking on the broker's 10s default.
    art_capture_timeout: float = 3.0
```

- [ ] **Step 4: Add builder, live impl, and selector to `art_critic.py`**

Append to `studio/backend/app/scene/art_critic.py`:

```python
ART_SYSTEM_PROMPT = (
    "You are a premium slot-game ART DIRECTOR grading a RENDERED frame of a "
    "finished slot scene — the real engine frame with lighting, blends, glows, "
    "and responsive scaling, NOT a flat layout mock. Geometry (position/size) has "
    "already been reconciled to a plan; do NOT re-judge placement. Judge whether "
    "the scene READS AS A SHIPPED, PREMIUM slot:\n"
    "- Overall composition, balance, and focal clarity.\n"
    "- Lighting, depth, contrast, and colour cohesion against the theme.\n"
    "- Framing and negative-space discipline; nothing important cropped or crowded.\n"
    "- Readability of the key elements (logo, reels, spin) at the rendered scale.\n"
    "- Effect integrity: an element must not be washed out, occluded, or lost to a "
    "blend/glow/another element.\n\n"
    "Your ONLY corrective action is REGENERATE: flag an element whose ART cannot be "
    "salvaged as-rendered and must be remade (you do NOT move, scale, reorder, or "
    "tune effects). Flag sparingly and only when no re-render of the SAME art could "
    "fix it. Prefer premium=true unless the scene is clearly not shippable.\n\n"
    "Return {premium, summary, regenerate:[{target_handle, why}], notes:[...]} where "
    "summary is a one-line verdict and notes are specific observations."
)


def _data_url(frame_png: bytes) -> str:
    b64 = base64.b64encode(frame_png).decode("ascii")
    return f"data:image/png;base64,{b64}"


def build_art_messages(request: SceneArtRequest) -> list[BaseMessage]:
    """Pure builder: render a SceneArtRequest into the LLM message list (system
    prompt + a multimodal human turn carrying scene/plan context and the real
    frame PNG as a base64 data URL). Kept pure so it is unit-testable offline."""
    context = {"theme": request.theme, "plan": request.plan, "scene": request.scene}
    text = (
        "Grade the RENDERED slot scene shown in the image on premium art quality.\n"
        f"Theme/intent: {request.theme}\n"
        f"Regenerations left in budget: {request.regen_budget_left}\n\n"
        f"Layout plan + scene context (JSON):\n{json.dumps(context, indent=2)}"
    )
    return [
        SystemMessage(ART_SYSTEM_PROMPT),
        HumanMessage(content=[
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": _data_url(request.frame_png)}},
        ]),
    ]


class LiveSceneArtCritic:
    """Live art critic: a DIRECT structured+image completion via OpenRouter, mirrors
    ``LiveSceneCritic``. NOT a bound tool."""

    def __init__(self, api_key: str, base_url: str, model: str):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    async def grade(self, request: SceneArtRequest) -> SceneArtVerdict:
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=self._model, api_key=self._api_key, base_url=self._base_url)
        structured = llm.with_structured_output(SceneArtVerdict)
        return await structured.ainvoke(build_art_messages(request))


def build_scene_art_critic(settings: Settings) -> SceneArtCritic:
    """Select the art-critic impl by provider mode — mirrors ``build_scene_critic``."""
    if settings.provider_mode == "replay":
        return ReplaySceneArtCritic(load_scene_art_cassettes(DEFAULT_FIXTURES_DIR))
    return LiveSceneArtCritic(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        model=settings.critic_model,
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_art_critic.py -v`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/art_critic.py studio/backend/app/config.py studio/backend/tests/test_art_critic.py
git commit -m "feat(scene): art critic message builder, live impl, selector + art_capture_timeout"
```

---

## Task 3: Wire `scene_art_critic` through `ToolContext`, `RoomHub`, and `main.py`

**Files:**
- Modify: `studio/backend/app/agent_tools.py:24-43` (`ToolContext`)
- Modify: `studio/backend/app/room_hub.py` (`__init__` param + field + `ToolContext` build)
- Modify: `studio/backend/app/main.py` (build + pass + `state`)
- Test: `studio/backend/tests/test_art_wiring.py` (new)

**Interfaces:**
- Consumes: `build_scene_art_critic` (Task 2).
- Produces: `ToolContext.scene_art_critic: object = None`; `RoomHub(..., scene_art_critic=None)`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_art_wiring.py`:

```python
from app.agent_tools import ToolContext


def test_toolcontext_has_scene_art_critic_field():
    ctx = ToolContext("r", "g", None, None)
    assert ctx.scene_art_critic is None
    ctx2 = ToolContext("r", "g", None, None, scene_art_critic="sentinel")
    assert ctx2.scene_art_critic == "sentinel"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_art_wiring.py -v`
Expected: FAIL — `TypeError: ... unexpected keyword argument 'scene_art_critic'`.

- [ ] **Step 3: Add the `ToolContext` field**

In `studio/backend/app/agent_tools.py`, in the `ToolContext` dataclass add after `asset_critic: object = None` (line ~42):

```python
    # Sub-project B: grades the REAL captured engine frame after geometry
    # converges (additive art/effects judgment). None on headless paths -> the
    # art stage skips.
    scene_art_critic: object = None
```

- [ ] **Step 4: Thread it through `RoomHub`**

In `studio/backend/app/room_hub.py`:

Add the constructor param (after `asset_critic=None`, line ~35):
```python
        scene_art_critic=None,
```
Store it (after `self._asset_critic = asset_critic`, line ~56):
```python
        self._scene_art_critic = scene_art_critic
```
Pass it into the `ToolContext(...)` build (in the `scene_critic=...` block, ~line 301):
```python
                         scene_art_critic=self._scene_art_critic,
```

- [ ] **Step 5: Build and pass it in `main.py`**

In `studio/backend/app/main.py`:

Add the import (with the other critic imports, ~line 26):
```python
from app.scene.art_critic import build_scene_art_critic
```
Build it (after `asset_critic = build_asset_critic(settings)`, ~line 124):
```python
    scene_art_critic = build_scene_art_critic(settings)
```
Pass it into `RoomHub(...)` (in the `scene_critic=..., asset_critic=...` block, ~line 133):
```python
        scene_art_critic=scene_art_critic,
```
Expose on app state (after `fastapi_app.state.asset_critic = asset_critic`, ~line 153):
```python
    fastapi_app.state.scene_art_critic = scene_art_critic
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_art_wiring.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/room_hub.py studio/backend/app/main.py studio/backend/tests/test_art_wiring.py
git commit -m "feat(scene): wire scene_art_critic through ToolContext, RoomHub, main"
```

---

## Task 4: `run_compose` final art stage (pure orchestration)

**Files:**
- Modify: `studio/backend/app/scene/compose_loop.py`
- Test: `studio/backend/tests/test_compose_art_stage.py` (new)

**Interfaces:**
- Consumes: `SceneArtRequest`, `SceneArtVerdict`, `ArtRegen` (Task 1); existing `_plan_context`, `run_compose`, `ComposeBounds`, `ComposeResult`, `ComposeDeps`.
- Produces:
  - `ComposeDeps.capture_real_frame(self) -> bytes | None`
  - `ComposeDeps.art_grade(self, request: SceneArtRequest) -> SceneArtVerdict`
  - `ComposeBounds.art_passes: int = 2`
  - `ComposeResult.art_passes_run: int = 0`
  - Art stage appended to `run_compose` (runs once after the element loop).

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_compose_art_stage.py`:

```python
import asyncio

from app.scene.art_critic import ArtRegen, SceneArtRequest, SceneArtVerdict
from app.scene.asset_critic import AssetVerdict
from app.scene.compose_loop import (
    BuildElement, ComposeBounds, CritiqueRequest, EditParams, run_compose,
)
from app.scene.critic import Critique


class FakeDeps:
    """Minimal ComposeDeps: geometry converges immediately so tests focus on the
    art stage. ``frames`` is the queue capture_real_frame returns (None = no
    client). ``art`` is the list of verdicts art_grade returns per pass."""

    def __init__(self, frames, art_verdicts):
        self._frames = list(frames)
        self._art = list(art_verdicts)
        self.regenerated: list[str] = []
        self._art_calls = 0

    async def place(self, element): return element.slot or element.role
    async def placed_handles(self): return ["background", "logo"]
    async def scene_context(self): return {"elements": []}
    async def render_scene(self): return b"pillow"
    async def critique_asset(self, target_handle, attempt=0): return AssetVerdict()
    async def critique(self, request): return Critique(done=True, edits=[])
    async def adjust(self, handle, params): return handle
    async def regenerate(self, handle): self.regenerated.append(handle); return handle
    async def out_of_frame(self): return []
    async def capture_real_frame(self):
        return self._frames.pop(0) if self._frames else None
    async def art_grade(self, request: SceneArtRequest) -> SceneArtVerdict:
        v = self._art[min(self._art_calls, len(self._art) - 1)]
        self._art_calls += 1
        return v


def _elements():
    return [BuildElement(slot="background", role="background"),
            BuildElement(slot="logo", role="logo")]


def test_art_skipped_when_no_client():
    deps = FakeDeps(frames=[None], art_verdicts=[SceneArtVerdict(premium=True)])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert result.art_passes_run == 0
    assert any("art grade skipped: no live client" in n for n in result.notes)
    assert deps.regenerated == []


def test_art_premium_short_circuits():
    deps = FakeDeps(frames=[b"real"],
                    art_verdicts=[SceneArtVerdict(premium=True, summary="great")])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert result.art_passes_run == 1
    assert any("art: great" in n for n in result.notes)
    assert deps.regenerated == []


def test_art_regenerates_then_regrades():
    deps = FakeDeps(
        frames=[b"real1", b"real2"],
        art_verdicts=[
            SceneArtVerdict(premium=False, summary="logo washed out",
                            regenerate=[ArtRegen(target_handle="logo", why="glow")]),
            SceneArtVerdict(premium=True, summary="fixed"),
        ])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert deps.regenerated == ["logo"]
    assert result.art_passes_run == 2
    assert result.regens_spent == 1


def test_art_regen_rejects_unknown_handle():
    deps = FakeDeps(
        frames=[b"real1", b"real2"],
        art_verdicts=[
            SceneArtVerdict(premium=False,
                            regenerate=[ArtRegen(target_handle="ghost", why="x")]),
            SceneArtVerdict(premium=True),
        ])
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps))
    assert deps.regenerated == []
    assert result.rejected >= 1


def test_art_shares_regen_budget():
    # budget of 0 -> art cannot regenerate even when flagged
    deps = FakeDeps(
        frames=[b"real1"],
        art_verdicts=[SceneArtVerdict(
            premium=False, regenerate=[ArtRegen(target_handle="logo", why="x")])])
    bounds = ComposeBounds(regen_budget=0)
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps, bounds=bounds))
    assert deps.regenerated == []
    assert any("budget exhausted" in n for n in result.notes)


def test_art_passes_bounded():
    # never returns premium -> stage stops at bounds.art_passes
    v = SceneArtVerdict(premium=False,
                        regenerate=[ArtRegen(target_handle="logo", why="x")])
    deps = FakeDeps(frames=[b"a", b"b", b"c", b"d"], art_verdicts=[v])
    bounds = ComposeBounds(art_passes=2, regen_budget=5)
    result = asyncio.run(run_compose(_elements(), "pirate slot", deps, bounds=bounds))
    assert result.art_passes_run == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_compose_art_stage.py -v`
Expected: FAIL — `ImportError` for `ArtRegen`/`SceneArtRequest`, and `ComposeResult` has no `art_passes_run` / `ComposeBounds` has no `art_passes`.

- [ ] **Step 3: Add the import, bounds, result counter**

In `studio/backend/app/scene/compose_loop.py`:

Add the import (after the existing `from app.scene.critic import ...`, line ~20):
```python
from app.scene.art_critic import SceneArtRequest, SceneArtVerdict
```
Add to `ComposeBounds` (after `max_edits_per_element`, line ~34):
```python
    art_passes: int = 2         # art/effects grades after geometry converges (1 grade + 1 re-grade)
```
Add to `ComposeResult` (after `corrections_applied`, line ~75):
```python
    art_passes_run: int = 0
```
Add the two methods to the `ComposeDeps` Protocol (after `out_of_frame`, line ~91):
```python
    async def capture_real_frame(self) -> bytes | None: ...
    async def art_grade(self, request: SceneArtRequest) -> SceneArtVerdict: ...
```

- [ ] **Step 4: Append the art stage to `run_compose`**

In `studio/backend/app/scene/compose_loop.py`, replace the final `return result` (line ~245) with the art stage followed by the return:

```python
    # ── Final art/effects grade (sub-project B) ──────────────────────────────
    # After geometry converges on the Pillow proxy, grade the REAL captured
    # engine frame (effects, blends, responsive scaling). Additive: geometry is
    # untouched. Skips cleanly (a note) when no client is attached. Art
    # regenerations draw from the SAME regen_left as the geometry loop.
    all_handles = await deps.placed_handles()
    if all_handles:
        frame = await deps.capture_real_frame()
        if frame is None:
            result.notes.append("art grade skipped: no live client")
        else:
            for art_pass in range(bounds.art_passes):
                scene = await deps.scene_context()
                verdict = await deps.art_grade(SceneArtRequest(
                    frame_png=frame, scene=scene,
                    plan=_plan_context(plan, all_handles, elements),
                    theme=theme, regen_budget_left=regen_left, pass_index=art_pass,
                ))
                result.art_passes_run += 1
                if verdict.summary:
                    result.notes.append(f"art: {verdict.summary}")
                for note in verdict.notes:
                    result.notes.append(f"art: {note}")
                if verdict.premium or not verdict.regenerate:
                    break
                regenerated_any = False
                for regen in verdict.regenerate:
                    if regen_left <= 0:
                        result.notes.append(
                            f"art refused regenerate {regen.target_handle} "
                            f"(budget exhausted)")
                        break
                    if regen.target_handle not in all_handles:
                        result.rejected += 1
                        result.notes.append(
                            f"art rejected regenerate {regen.target_handle} "
                            f"(not in scene)")
                        continue
                    regen_left -= 1
                    result.regens_spent += 1
                    await deps.regenerate(regen.target_handle)
                    result.notes.append(
                        f"art regenerated {regen.target_handle}: {regen.why}")
                    regenerated_any = True
                if not regenerated_any:
                    break
                frame = await deps.capture_real_frame()
                if frame is None:
                    result.notes.append("art re-grade skipped: no live client")
                    break

    return result
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_compose_art_stage.py -v`
Expected: PASS (all six tests).

- [ ] **Step 6: Run the existing compose_loop unit suite (no regression)**

Run: `uv --directory studio/backend run pytest tests/test_compose_loop.py -v`
Expected: PASS — the existing fake `ComposeDeps` in that file lacks the two new methods; if any test constructs `run_compose` with it and reaches the art stage it will error. **If it fails**, add `capture_real_frame`/`art_grade` returning `None`/`SceneArtVerdict(premium=True)` to that file's fake deps (the art stage then skips). Keep the change minimal.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/scene/compose_loop.py studio/backend/tests/test_compose_art_stage.py studio/backend/tests/test_compose_loop.py
git commit -m "feat(scene): final art/effects grade stage in run_compose"
```

---

## Task 5: `_SceneComposeDeps` — real capture + grade seams

**Files:**
- Modify: `studio/backend/app/agent_tools.py` (`import asyncio`; add `capture_real_frame` + `art_grade` to `_SceneComposeDeps`)
- Test: `studio/backend/tests/test_compose_deps_capture.py` (new)

**Interfaces:**
- Consumes: `ToolContext.scene_art_critic`, `ToolContext.capture_broker`, `Settings.art_capture_timeout`.
- Produces: `_SceneComposeDeps.capture_real_frame(self) -> bytes | None`; `_SceneComposeDeps.art_grade(self, request) -> SceneArtVerdict`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_compose_deps_capture.py`:

```python
import asyncio

from app.agent_tools import ToolContext, _SceneComposeDeps


class _Broker:
    def __init__(self, result=None, exc=None):
        self._result = result
        self._exc = exc
        self.calls = 0

    async def request_capture(self, game_id, *, timeout=10.0):
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        return self._result


def _deps(**ctx_kwargs):
    ctx = ToolContext("r", "g", None, None, scene_store=object(), **ctx_kwargs)
    return _SceneComposeDeps(ctx)


def test_capture_none_when_no_broker():
    deps = _deps(capture_broker=None, scene_art_critic=object())
    assert asyncio.run(deps.capture_real_frame()) is None


def test_capture_none_when_no_art_critic():
    deps = _deps(capture_broker=_Broker(result=b"png"), scene_art_critic=None)
    assert asyncio.run(deps.capture_real_frame()) is None


def test_capture_returns_bytes_when_answered():
    deps = _deps(capture_broker=_Broker(result=b"realpng"), scene_art_critic=object())
    assert asyncio.run(deps.capture_real_frame()) == b"realpng"


def test_capture_none_on_timeout():
    deps = _deps(capture_broker=_Broker(exc=asyncio.TimeoutError()),
                 scene_art_critic=object())
    assert asyncio.run(deps.capture_real_frame()) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_compose_deps_capture.py -v`
Expected: FAIL — `_SceneComposeDeps` has no `capture_real_frame`.

- [ ] **Step 3: Add `import asyncio`**

In `studio/backend/app/agent_tools.py`, add at the top with the stdlib imports (line ~1):
```python
import asyncio
```

- [ ] **Step 4: Add the two methods to `_SceneComposeDeps`**

In `studio/backend/app/agent_tools.py`, add after the `critique` method (line ~578):

```python
    async def capture_real_frame(self) -> "bytes | None":
        """The REAL rendered engine frame from the attached browser client, or
        None when the art stage should skip: no capture broker, no art critic
        wired, or no client answered within art_capture_timeout (headless REST
        rebuild, backend replay e2e). Never raises — a skip is not a failure."""
        if self._ctx.capture_broker is None or self._ctx.scene_art_critic is None:
            return None
        try:
            return await self._ctx.capture_broker.request_capture(
                self._ctx.game_id, timeout=get_settings().art_capture_timeout)
        except (asyncio.TimeoutError, Exception):
            return None

    async def art_grade(self, request):
        return await self._ctx.scene_art_critic.grade(request)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_compose_deps_capture.py -v`
Expected: PASS (all four).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_compose_deps_capture.py
git commit -m "feat(scene): _SceneComposeDeps real-frame capture + art_grade seams"
```

---

## Task 6: Backend e2e — skip-when-no-client and grade-when-answered

**Files:**
- Create: `studio/backend/tests/e2e/test_scene_art.py`
- Create: `studio/backend/tests/fixtures/replay/scene_art/pirate-regen.json`
- Test: the file itself.

**Interfaces:**
- Consumes: the `live_server` fixture + the compose run cassette `run/compose-pirate-scene.json` (theme `"pirate slot"`), mirroring `tests/e2e/test_scene_compose.py`.

**Note on isolation:** the compose prompt's theme is `"pirate slot"`. The default `scene_art/default.json` (premium, no regen) applies to every compose test. This task's `pirate-regen.json` is keyed to theme `"pirate slot"` and would override the default FOR THIS THEME — which would also affect `test_scene_compose.py` and the browser spec. To avoid coupling, **do NOT key the regen cassette to `"pirate slot"`.** Instead assert the two integration paths behaviorally (capture requested vs. skipped) using the default cassette; keep the regen-applied assertion in the Task 4 unit tests where it is deterministic. `pirate-regen.json` is therefore only used if a future isolated prompt/theme is added — create it keyed to a unique theme so it never collides.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/e2e/test_scene_art.py`:

```python
"""Backend non-browser e2e for the real-frame art stage (sub-project B).

Both tests drive the SAME pirate compose prompt as test_scene_compose.py through
the design-router (replay). One attaches a fake client that answers the capture
request (so the art stage runs its real capture round trip); the other never
answers (so the art stage times out fast and skips). Uses the default scene_art
cassette (premium, no regen) — the regenerate PATH is covered deterministically in
tests/test_compose_art_stage.py.
"""
import asyncio

import httpx
import pytest
import socketio

PROMPT = "make a pirate theme game with a background and a logo centered at the top"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "ArtE2E"})).json()
        return room["id"], room["gameId"]


async def _run_prompt(live_server, *, answer_capture: bool) -> list[dict]:
    room_id, game_id = await _make_room(live_server)
    client = socketio.AsyncClient()
    run_completions: list[dict] = []
    capture_requests: list[dict] = []
    client.on("run_completed", lambda d: run_completions.append(d))

    import base64

    async def _on_capture_request(data):
        capture_requests.append(data)
        if answer_capture:
            png = "data:image/png;base64," + base64.b64encode(b"\x89PNGtest").decode()
            await client.emit("scene_capture_result",
                              {"gameId": data["gameId"],
                               "captureId": data["captureId"], "png": png})

    client.on("scene_capture_request", _on_capture_request)
    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)
    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 40
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    await client.disconnect()
    assert run_completions, "run_completed not received"
    assert run_completions[0]["status"] == "completed", run_completions
    return capture_requests


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_art_stage_captures_real_frame_when_client_answers(live_server):
    capture_requests = await _run_prompt(live_server, answer_capture=True)
    # The art stage fired the real capture round trip against the attached client.
    assert capture_requests, "art stage did not request a real-frame capture"


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_art_stage_skips_and_build_completes_without_client(live_server):
    # A client is joined but NEVER answers capture -> art stage times out
    # (art_capture_timeout ~3s) and skips; the build still completes.
    capture_requests = await _run_prompt(live_server, answer_capture=False)
    assert capture_requests, "capture should still be requested"
    # The run completed despite no capture answer (asserted inside _run_prompt).
```

- [ ] **Step 2: Run test to verify it fails (RED)**

Run: `uv --directory studio/backend run pytest tests/e2e/test_scene_art.py -v`
Expected: FAIL initially only if the art stage isn't wired end-to-end — i.e. `capture_requests` is empty because `compose_scene` doesn't yet reach the art stage with a real broker. (Tasks 4–5 supply the wiring; if they're already merged this may pass — that is the GREEN signal. Run it to confirm the assertions hold.)

- [ ] **Step 3: Create the isolated regen cassette (future-proofing)**

Create `studio/backend/tests/fixtures/replay/scene_art/pirate-regen.json` (keyed to a UNIQUE theme so it never collides with the shared `"pirate slot"` prompt):

```json
{
  "theme": "art regen probe",
  "passes": [
    {
      "premium": false,
      "summary": "logo washed out by the glow",
      "regenerate": [{ "target_handle": "logo", "why": "lost to background glow" }]
    },
    { "premium": true, "summary": "logo now reads clearly" }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes (GREEN)**

Run: `uv --directory studio/backend run pytest tests/e2e/test_scene_art.py -v`
Expected: PASS (both). If `test_art_stage_skips...` is slow, confirm `art_capture_timeout` defaults to 3.0 (Task 2).

- [ ] **Step 5: Run the full backend suite (no regression)**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS — including the existing `tests/e2e/test_scene_compose.py` (now also exercises the art stage via its fake capture responder + default cassette).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/tests/e2e/test_scene_art.py studio/backend/tests/fixtures/replay/scene_art/pirate-regen.json
git commit -m "test(scene): backend e2e for real-frame art stage (capture + skip paths)"
```

---

## Task 7: Browser e2e — real capture → grade → verdict in chat

**Files:**
- Create: `studio/frontend/e2e/scene-art.spec.ts`
- Test: the spec itself (Playwright, local, offset-1 replay stack).

**Interfaces:**
- Consumes: the same harness as `studio/frontend/e2e/compose-loop.spec.ts` (open the Game Scene pane so the engine attaches and answers capture; drive the pirate build prompt). Relies on `format_compose_summary` including the art note in the `compose_scene` step output, and the default `scene_art/default.json` summary `"Scene reads as a premium slot."`.

- [ ] **Step 1: Write the spec**

Create `studio/frontend/e2e/scene-art.spec.ts`:

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack at this
// worktree's BLOOM_PORT_OFFSET=1: runtime client (4301), replay backend (8001),
// studio (4201). Proves sub-project B end-to-end in a real browser: with the
// engine attached and answering capture, the compose build runs the real-frame
// art/effects grade and its verdict surfaces in the chat feed.

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
  await page.getByPlaceholder(/new room/i).fill(`Scene Art E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test.setTimeout(300_000);

test('the compose build runs the real-frame art grade and reports its verdict', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();

  // Open the Game Scene pane so the engine attaches and answers the art stage's
  // capture request.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 25_000 }).toBe(true);

  await page.getByTestId('chat-composer').fill(PROMPT);
  await page.getByTestId('chat-send').click();

  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('compose_scene', { timeout: 90_000 });
  // The real-frame art/effects grade ran (not skipped) and its verdict surfaced.
  await expect(feed).toContainText('Scene reads as a premium slot', { timeout: 90_000 });

  // No engine errors during the composed build + capture.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});
```

- [ ] **Step 2: Start the offset-1 replay stack**

In the worktree (`C:\code\bloom.wt\scene-vision-b`), in separate persistent terminals, with `BLOOM_PORT_OFFSET=1` from `.env`:
```
just backend-serve-replay      # backend on 8001 (replay)
just serve-runtime-client      # Pixi client on 4301
```
(The Playwright config starts/uses the studio dev server on 4201; global-setup does a `/health` parity check against :8001.)

- [ ] **Step 3: Run the spec (expect it to exercise the real path)**

From the worktree with the offset exported:
```
$env:BLOOM_PORT_OFFSET=1; npx playwright test e2e/scene-art.spec.ts
```
(or `just e2e` to run the whole suite). Expected: PASS — `compose_scene` and the art verdict `Scene reads as a premium slot` both appear in the feed.

**If the art note does not render in the feed:** the `compose_scene` step body may collapse `format_compose_summary` output. Fallback: assert on the run step's expandable output region for that step, or expose the compose summary via the existing step payload. Prefer surfacing the note in the visible feed over weakening the assertion — the art verdict being visible to the user IS the client-behavior contract.

- [ ] **Step 4: Run the existing browser compose spec (no regression)**

```
$env:BLOOM_PORT_OFFSET=1; npx playwright test e2e/compose-loop.spec.ts
```
Expected: PASS (the art stage is additive; its notes don't break the existing assertions).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/scene-art.spec.ts
git commit -m "test(scene): browser e2e — real-frame art grade verdict in chat feed"
```

---

## Task 8 (OPTIONAL STRETCH): Surface the real frame + verdict in the A3 approval card

**Only attempt if Tasks 1–7 land cleanly and time allows. This is the spec's flagged optional stretch, not a required deliverable.**

**Files:**
- Modify: the A3 approval-gate payload builder (`studio/backend/app/agent_tools.py`, the `rebuild_scene` interrupt payload) to include the captured real frame + `SceneArtVerdict`.
- Modify: the frontend `ApprovalCard` component to render the real frame thumbnail + verdict summary/notes when present.
- Create: `studio/frontend/e2e/scene-art-approval.spec.ts` — approve-against-real-frame spec.

**Approach (high level — detail during execution after re-reading the A3 code):**
- The `rebuild_scene` tool already gates via `interrupt()` with an `ApprovalCard`-shaped payload (mirrors `delete_asset`). Extend that payload with an optional `frame` (data URL) + `art` ({summary, notes, regenerate}) captured at the gate.
- The `ApprovalCard` renders them additively — absent fields keep today's behavior (no regression for `delete_asset`/geometry-only rebuilds).
- e2e: with a live client, trigger a rebuild that reaches the gate, assert the card shows the real frame + verdict, then approve.

- [ ] **Step 1:** Re-read the current A3 approval-gate code (`build_rebuild_scene_tool`, the interrupt payload, and the frontend `ApprovalCard`) before writing any test — the exact payload shape must match today's `delete_asset` gate.
- [ ] **Step 2:** TDD the payload extension (backend unit) → frontend render (component/unit) → Playwright approval spec, committing per step.

---

## Self-Review

**1. Spec coverage:**
- Additive art critic on the real frame, geometry on proxy untouched → Tasks 1–2 (seam), Task 4 (stage runs after geometry loop; proxy path unchanged). ✓
- Final whole-scene grade; regenerate + report; bounded re-grade → Task 4 (`art_passes`, premium short-circuit, shared budget). ✓
- Graceful skip when headless + own cassette seam → Task 1 (benign default), Task 5 (`capture_real_frame` → None), Task 6 (skip e2e). ✓
- New dedicated seam mirroring existing critics (Replay/Live/build_/pure builder/cassette dir) → Tasks 1–2. ✓
- Short `art_capture_timeout` → Task 2. ✓
- Shared regen budget → Task 4 (`regen_left`), unit `test_art_shares_regen_budget`. ✓
- Ordering guarantee (ops emitted before capture request) → holds by construction (Task 4 runs after the awaited element loop; capture emitted on the same room); asserted behaviorally by Task 6/7. ✓
- Wiring through ToolContext/RoomHub/main; REST sites intentionally None → Task 3 + wiring note. ✓
- Testing tiers (unit + backend e2e + Playwright) → Tasks 4/5 (unit), 6 (backend e2e), 7 (browser). ✓
- Non-goals (no effect actuators, no C changes, no new persisted state) → enforced by design; art critic only emits `regenerate`; no schema/store added. ✓
- A3 surfacing optional stretch → Task 8. ✓

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step shows complete code. The Task 6 note explicitly steers away from a fragile cassette coupling rather than leaving it vague. ✓

**3. Type consistency:** `SceneArtRequest`/`SceneArtVerdict`/`ArtRegen`/`SceneArtCritic`/`ReplaySceneArtCritic`/`LiveSceneArtCritic`/`build_scene_art_critic`/`build_art_messages`/`ART_SYSTEM_PROMPT`/`load_scene_art_cassettes` are used identically across Tasks 1–7. `capture_real_frame`/`art_grade` signatures match between the `ComposeDeps` Protocol (Task 4), the fake (Task 4 test), and `_SceneComposeDeps` (Task 5). `art_passes`/`art_passes_run` names consistent. `art_capture_timeout` consistent (Tasks 2, 5). ✓
