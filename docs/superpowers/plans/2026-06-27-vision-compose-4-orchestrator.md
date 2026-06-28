# Vision-in-the-loop scene composition — Plan 4: compose-loop orchestrator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tie Plans 1–3 together into a **bounded, deterministic compose loop** — for each element the user names, `generate_and_place` it, then repeatedly _capture the real rendered frame → critique its composition → apply transform/regenerate edits_ until the critic says `done` or the caps are hit — and route design-router branch 4 ("build a scene") into it so the loop discipline lives in code, not skippable router prose.

**Architecture:** A new pure orchestration core `app/scene/compose_loop.py` (`run_compose`) owns the loop and its bounds (look-behind N=3, max-passes=3, regen budget K=5, transform-first) against an injected `ComposeDeps` Protocol, so the loop logic is unit-testable with fakes. A new `compose_scene` agent tool (`build_compose_scene_tool` in `agent_tools.py`) wires real deps — `generate_and_place` for placement, `SceneCaptureBroker.request_capture` for the frame (Plan 3), `SceneCritic.critique` for the judgment (Plan 2), `adjust_element` / `regenerate_element` for the edits (Plan 1) — and runs `run_compose`. The critic + capture broker reach the tool through two new optional `ToolContext` fields. Design-router branch 4 calls `compose_scene` once with the extracted build list instead of emitting bare `generate_and_place` calls.

**Tech Stack:** Python 3 / FastAPI backend, LangChain `StructuredTool`, LangGraph `create_react_agent`, Pydantic v2, MongoDB (motor), python-socketio, pytest + pytest-asyncio, Playwright (local-only). Backend-only source changes (no frontend — Plan 3 already wired the capture relay end-to-end); plus a backend replay e2e and a Playwright spec. This is plan #4 of 4 and completes the effort.

## Roadmap (this plan is #4 of 4)

The approved spec (`docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`) decomposes into four sequential, independently-shippable plans:

1. **`adjust_element` transform actuator** — the cheap layout lever (**MERGED**, PR #116). `adjust_element(ref, x?, y?, scale?, z?)` moves/scales/reorders a placed sprite without regenerating art.
2. **`SceneCritic` seam** — swappable vision critic, structured-output schema `{done, edits:[{target_handle, action, params, why}]}`, live + replay impls (**MERGED**, PR #117).
3. **Real-frame capture handshake** — `capture`/`captured` postMessage round-trip with a render-settled barrier + canvas→PNG extraction, relayed studio→backend over the socket; the backend `SceneCaptureBroker.request_capture` awaitable seam (**MERGED**, PR #118).
4. **Compose-loop orchestrator (THIS PLAN)** — ties 1–3 together with the bounds and transform-first discipline, surfaces each pass into the run, and routes design-router branch 4 into it.

---

## Global Constraints

Copied from the spec and repo standards (`AGENTS.md`, `docs/coding-standards.md`). Every task implicitly includes these.

- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, then refactor.
- **Semantic (Conventional Commits) format** for every commit — `feat(scope): …`, imperative mood, ~50-char subject.
- **Worktree:** this work happens in `C:\code\bloom.wt\vision-compose-4` on branch `feat/vision-compose-4` with `BLOOM_PORT_OFFSET=1` (backend `:8001`, studio `:4201`, runtime client `:4301`). **Never use the default ports** — another live session holds `:4200/:4300/:8000`. Run all commands from inside the worktree.
- **Backend unit tests:** `cd studio/backend && uv run pytest -m "not e2e"` — requires a `mongod` on `:27017` (a shared singleton; tests use DB `bloom_studio_test`). The pure-loop tests touch **no Mongo and no network** (in-memory fakes), but the full-suite gate still needs the DB up.
- **Backend e2e (non-browser, replay):** `cd studio/backend && uv run pytest -m e2e` — spins a real uvicorn at `PROVIDER_MODE=replay` via the `live_server` fixture (`tests/e2e/conftest.py`). This tier IS the authoritative behavioral contract per `AGENTS.md`.
- **Browser e2e (Playwright, local-only, never CI):** runs via `just e2e` against a replay backend at the worktree offset ports. Start `just backend-serve-replay` first; the suite needs a backend on `:8001`.
- **Reuse existing seams, don't duplicate:** placement goes through `build_generate_and_place_tool` / `_place_in_scene`; transforms through `build_adjust_element_tool`; regeneration through `build_regenerate_element_tool` / `_regenerate_and_rebind`; element listing through `_placed_elements`; the frame through `SceneCaptureBroker.request_capture`; the judgment through `SceneCritic.critique` / `build_scene_critic`. **Do not hand-roll node lookups, direct Mongo writes, or a second critic/capture path.**
- **Do not change** the behavior of `generate_and_place`, `adjust_element`, `regenerate_element`, `read_scene`, `SceneCritic`, `SceneCaptureBroker`, `TurnRunner`, or the `RunStep` index model — Plan 4 is additive (one new module, one new tool, two new `ToolContext` fields, branch-4 prose, tests + cassettes).
- **Vision model is config, not code:** the critic is `build_scene_critic(settings)` (replay vs `anthropic/claude-sonnet-4-6` live). The orchestrator never names a model.

---

## Design decisions locked for this plan

These resolve the spec's "Open decisions for the plan" (§ Open decisions) and the architectural questions that shaped the task list. Implementers should not relitigate them.

1. **`compose_scene` is an agent _tool_, not a sibling LangGraph executor.** The loop must be deterministic code (spec § "Key insight"), but the build request still needs LLM routing + element extraction (which the react-agent does reliably). Making the loop the body of a single tool gives both: the design-router LLM extracts the element list into one `compose_scene(elements=[…])` call, and once that tool runs, the capture→critique→edit loop is pure Python that cannot be skipped. This also keeps the loop _inside_ the existing `TurnRunner` run, so streaming/persistence/cancellation reuse the run machinery unchanged.
2. **Per-pass progress surfaces via (a) the live scene reflow and (b) a rich `compose_scene` tool-result, _not_ as separate run-feed steps.** The `RunStep.index` is a literal Mongo array position (`runs.py:76` `append_step_token` does `run.steps[index]`; `complete_step` does `steps.{index}.status`), and `TurnRunner` owns a single contiguous index counter (`turn_runner.py:75,129–135`). A tool cannot inject extra contiguous run steps mid-execution without corrupting that counter. So each applied edit streams live to the Game Scene pane as a `scene_op` (via `scene_hub.apply_batch`, which the studio already renders — the user literally watches sprites move/scale), and the `compose_scene` tool returns a readable per-element / per-pass narrative that the chat feed shows as the tool result. **Finer-grained per-step chat-feed streaming and a user-driven loop `interrupt()` are documented deferred follow-ups** (see "Known limitations") — the bounded caps already prevent runaway, satisfying the spec's bounded-v1 intent.
3. **Capture is best-effort.** If `request_capture` times out or errors (e.g. no engine attached — a headless backend e2e, or the scene pane closed), the orchestrator **skips the critique loop for that element and continues placing**. This makes `compose_scene` degrade gracefully to "just place the elements" exactly like today's branch-4 flow, and removes any hard dependency on a live browser for the placement half.
4. **The look-behind window includes the target.** At element _K_ the editable window is the handles `[K-3 … K]` in placement order — i.e. the last `look_behind + 1 = 4` placed handles. Edits whose `target_handle` falls outside it are rejected in code (spec § 3 "Edits are constrained to the look-behind window; out-of-window targets are rejected").
5. **Branch 4 routes _every_ create/place request through `compose_scene`** — multi-element builds and single "add a chest bottom-right" adds alike (a 1-element build that then gets one critique pass). Changing/replacing something already on screen stays on branch 5 (`adjust_element` / `regenerate_element`). The existing `compose-pirate-scene.json` cassette + `test_scene_compose.py` are migrated to the new one-`compose_scene`-call shape (Task 4) so the suite stays green.

---

## File Structure

- `studio/backend/app/scene/compose_loop.py` — **create.** The pure orchestration core: `ComposeBounds`, `ComposeResult`, `BuildElement`, the `ComposeDeps` Protocol, and `run_compose(...)`. No Mongo, no network, no LLM — all I/O is behind `ComposeDeps`. (Note: `app/scene/compose.py` already exists as the sprite-op builder `build_sprite_ops`/`DEFAULT_CANVAS` imported by `agent_tools.py`; it is a different responsibility and is left untouched — the orchestrator gets its own module.)
- `studio/backend/app/agent_tools.py` — **modify.** Add two optional `ToolContext` fields (`scene_critic`, `capture_broker`); add `_SceneComposeDeps` + `build_compose_scene_tool(ctx)` after `build_adjust_element_tool`; register `"compose_scene"` in `_BUILDERS`.
- `studio/backend/app/room_hub.py` — **modify.** Accept `scene_critic` + `capture_broker` in `RoomHub.__init__`; pass them into the `ToolContext` built in `_run_skill`.
- `studio/backend/app/main.py` — **modify.** Build the critic (`build_scene_critic(settings)`), move `SceneCaptureBroker` construction above `RoomHub`, and pass both into `RoomHub`.
- `studio/backend/app/gdd/router.py` — **modify.** Add `"compose_scene"` to the tools set; rewrite branch 4 to call `compose_scene` once with the build list.
- `studio/backend/tests/test_compose_loop.py` — **create.** Unit tests for `run_compose` (bounds, window, budget, capture-skip, stop-on-done) against a hand-rolled `FakeDeps`.
- `studio/backend/tests/test_compose_scene_tool.py` — **create.** Unit tests for `_SceneComposeDeps` (transform/regenerate/listing paths against real Mongo + fakes) and the `ToolFactory` registry.
- `studio/backend/tests/test_design_router.py` — **modify.** Assert the router binds + mentions `compose_scene`.
- `studio/backend/tests/fixtures/replay/run/compose-pirate-scene.json` — **modify.** One `compose_scene` call carrying the two elements (was two `generate_and_place` rounds).
- `studio/backend/tests/fixtures/replay/run/compose-loop-secretary.json` — **create.** The compose-loop e2e's run cassette: one `compose_scene` call.
- `studio/backend/tests/fixtures/replay/critic/secretary.json` — **create.** A keyed two-pass critique (scale-down then `done`) for the e2e.
- `studio/backend/tests/fixtures/replay/critic/desk.json` — **create.** A keyed critique exercising a regenerate edit + budget.
- `studio/backend/tests/e2e/test_compose_loop.py` — **create.** Backend replay e2e: a full compose run with a capture responder + critic cassettes; asserts capture→critique→transform, regen ≤ K, window-bounded, convergence.
- `studio/backend/tests/e2e/test_scene_compose.py` — **modify.** Migrate the existing compose e2e to the `compose_scene` flow (add a capture responder; keep the placement/order assertions).
- `studio/frontend/e2e/compose-loop.spec.ts` — **create.** Playwright: drive "build a pirate slot" in a real browser; assert the `compose_scene` step + the scene visibly reflowing.

---

### Task 1: Thread the critic + capture broker into `ToolContext`

The `compose_scene` tool (Task 3) needs the `SceneCritic` and the `SceneCaptureBroker`, but neither is on `ToolContext` today (the broker lives only on `app.state`). Add them as optional fields and wire them through `RoomHub` → `main.py`. Additive and behavior-preserving for every existing tool.

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (extend the `ToolContext` dataclass, ~line 14)
- Modify: `studio/backend/app/room_hub.py` (`__init__` params + the `ctx` built in `_run_skill`, ~line 288)
- Modify: `studio/backend/app/main.py` (build critic, reorder broker, pass both to `RoomHub`)
- Modify: `studio/backend/tests/test_compose_scene_tool.py` — **created here** for the dataclass test (more tests added in Task 3)

**Interfaces:**

- Consumes (existing): `ToolContext` dataclass (`agent_tools.py:14`); `RoomHub.__init__` keyword deps (`room_hub.py:14`); `RoomHub._run_skill` builds `ToolContext(...)` (`room_hub.py:288`); `build_scene_critic(settings)` (`app/scene/critic.py:191`); `SceneCaptureBroker(sio)` (`app/scene/capture.py:22`); `main.build(settings)` wiring (`app/main.py:64`).
- Produces (relied on by Task 3): `ToolContext.scene_critic: object = None` and `ToolContext.capture_broker: object = None`; `RoomHub` accepts `scene_critic=` / `capture_broker=` and forwards them into the run `ToolContext`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_compose_scene_tool.py`:

```python
from app.agent_tools import ToolContext


def test_tool_context_carries_critic_and_capture_broker():
    sentinel_critic = object()
    sentinel_broker = object()
    ctx = ToolContext(
        "r1", "g1", None, None,
        scene_critic=sentinel_critic, capture_broker=sentinel_broker,
    )
    assert ctx.scene_critic is sentinel_critic
    assert ctx.capture_broker is sentinel_broker


def test_tool_context_critic_and_broker_default_to_none():
    ctx = ToolContext("r1", "g1", None, None)
    assert ctx.scene_critic is None
    assert ctx.capture_broker is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py -v`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'scene_critic'`.

- [ ] **Step 3: Extend the `ToolContext` dataclass**

In `studio/backend/app/agent_tools.py`, the dataclass currently is:

```python
@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object
    gdd_store: object = None
    gdd_hub: object = None
    scene_store: object = None
    scene_hub: object = None
    sim_store: object = None
    tuner_store: object = None
    tuner_hub: object = None
```

Add two fields at the end (keep them last so positional callers are unaffected):

```python
    tuner_hub: object = None
    # Vision-compose Plan 4: the compose-loop orchestrator (compose_scene tool)
    # grades the rendered frame and edits placement. The critic judges; the
    # capture broker fetches the real engine frame (Plans 2 & 3).
    scene_critic: object = None
    capture_broker: object = None
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py -v`
Expected: PASS (both tests).

- [ ] **Step 5: Wire `RoomHub` to forward the deps**

In `studio/backend/app/room_hub.py`, add two params to `RoomHub.__init__` (after `tuner_hub=None,` in the signature, ~line 32):

```python
        tuner_hub=None,
        scene_critic=None,
        capture_broker=None,
    ):
```

Store them alongside the other assignments (after `self._tuner_hub = tuner_hub`, ~line 49):

```python
        self._tuner_hub = tuner_hub
        self._scene_critic = scene_critic
        self._capture_broker = capture_broker
```

Then in `_run_skill`, extend the `ToolContext(...)` construction (~line 288) to pass them:

```python
        ctx = ToolContext(room_id, room.game_id, self._asset_store, self._asset_hub,
                         gdd_store=self._gdd_store, gdd_hub=self._gdd_hub,
                         scene_store=self._scene_store, scene_hub=self._scene_hub,
                         sim_store=self._sim_store, tuner_store=self._tuner_store,
                         tuner_hub=self._tuner_hub,
                         scene_critic=self._scene_critic,
                         capture_broker=self._capture_broker)
```

- [ ] **Step 6: Wire `main.py`**

In `studio/backend/app/main.py`, add the critic import near the other scene imports (next to `from app.scene.capture import SceneCaptureBroker` at line 24):

```python
from app.scene.capture import SceneCaptureBroker
from app.scene.critic import build_scene_critic
```

`SceneCaptureBroker` is currently constructed at line 142, _after_ `RoomHub` (line 116). Move its construction **above** `RoomHub` and build the critic there too. Replace the `RoomHub(` construction block (lines 116–124) so it is immediately preceded by the broker + critic and passes them in:

```python
    presence = PresenceRegistry()
    capture_broker = SceneCaptureBroker(sio)
    scene_critic = build_scene_critic(settings)
    hub = RoomHub(
        sio, store, chat_service,
        run_store=run_store, turn_runner=turn_runner,
        skills=skill_registry, tool_factory=tool_factory,
        asset_store=asset_store, asset_hub=asset_hub,
        gdd_store=gdd_store, gdd_hub=gdd_hub,
        scene_store=scene_store, scene_hub=scene_hub,
        sim_store=sim_store, tuner_store=tuner_store, tuner_hub=tuner_hub,
        scene_critic=scene_critic, capture_broker=capture_broker,
    )
    register_socket_handlers(sio, hub, presence)
```

Then delete the now-duplicate broker construction at the old site (lines 142–143) and keep only the wiring that uses it:

```python
    register_asset_handlers(sio, asset_hub)
    register_gdd_handlers(sio, gdd_hub)
    fastapi_app.state.capture_broker = capture_broker
    register_scene_handlers(sio, scene_hub, capture_broker)
    register_sim_handlers(sio, sim_hub)
    register_tuner_handlers(sio, tuner_hub)
```

(The single `capture_broker` instance is now shared between `RoomHub` — so the orchestrator awaits the same broker the socket handler resolves — and the `scene_capture_result` handler. This is load-bearing: a second broker instance would never see the result.)

- [ ] **Step 7: Run the backend unit suite to confirm nothing regressed**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — the new dataclass tests plus **all existing tests** (the new fields default to `None`; `RoomHub`'s new params are keyword-only with defaults; `main.build` still wires one broker).

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/room_hub.py studio/backend/app/main.py studio/backend/tests/test_compose_scene_tool.py
git commit -m "feat(scene): thread SceneCritic + capture broker into ToolContext"
```

---

### Task 2: The pure compose-loop core (`run_compose`)

The heart of the feature, with **zero I/O** so the bounds/window/budget/stop logic is exhaustively unit-testable with fakes. All placement, capture, critique, and edit I/O is behind the `ComposeDeps` Protocol (Task 3 supplies the real impl).

**Files:**

- Create: `studio/backend/app/scene/compose_loop.py`
- Create: `studio/backend/tests/test_compose_loop.py`

**Interfaces:**

- Consumes (existing): `app.scene.critic.Critique`, `CritiqueEdit`, `EditParams`, `CritiqueRequest` (`app/scene/critic.py:28–70`); `pydantic.BaseModel`; `typing.Protocol`; `dataclasses.dataclass`.
- Produces (relied on by Task 3):
  - `@dataclass(frozen=True) class ComposeBounds` — `look_behind: int = 3`, `max_passes: int = 3`, `regen_budget: int = 5`, `capture_timeout: float = 8.0`.
  - `class BuildElement(BaseModel)` — the per-element build spec mirroring `generate_and_place` args: `description: str = ""`, `style: str = ""`, `size: str = "512x512"`, `transparent: bool = True`, `slot: str = ""`, `role: str = ""`, `parent: str = "root"`, `x: float | None = None`, `y: float | None = None`, `anchor_x: float = 0.5`, `anchor_y: float = 0.5`, `fit: str = "none"`, `z_index: int = 0`.
  - `@dataclass class ComposeResult` — `passes: int`, `edits_applied: int`, `regens_spent: int`, `rejected: int`, `elements_placed: int`, `notes: list[str]`.
  - `class ComposeDeps(Protocol)` with async methods: `place(self, element: BuildElement) -> str`, `placed_handles(self) -> list[str]` (placement order), `scene_context(self) -> dict`, `capture(self) -> bytes` (raises on timeout/failure), `critique(self, request: CritiqueRequest) -> Critique`, `adjust(self, handle: str, params: EditParams) -> str`, `regenerate(self, handle: str) -> str`.
  - `async def run_compose(elements: list[BuildElement], theme: str, deps: ComposeDeps, bounds: ComposeBounds = ComposeBounds()) -> ComposeResult`.

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_compose_loop.py`:

```python
import asyncio

import pytest

from app.scene.compose_loop import (
    BuildElement,
    ComposeBounds,
    ComposeResult,
    run_compose,
)
from app.scene.critic import Critique, CritiqueEdit, EditParams


class FakeDeps:
    """Scriptable ComposeDeps for unit-testing run_compose with no I/O.

    `placements` is the running list of placed handles (placement order).
    `script` maps a placed handle -> list of Critique (one per pass).
    `capture_fail` is a set of handles whose capture() raises (no-frame path).
    Records adjust/regenerate calls for assertions.
    """

    def __init__(self, script, *, capture_fail=frozenset()):
        self._script = script
        self._capture_fail = capture_fail
        self.placements: list[str] = []
        self.adjusts: list[tuple[str, EditParams]] = []
        self.regens: list[str] = []
        self.captures = 0

    async def place(self, element: BuildElement) -> str:
        self.placements.append(element.slot)
        return f"placed {element.slot}"

    async def placed_handles(self) -> list[str]:
        return list(self.placements)

    async def scene_context(self) -> dict:
        return {"elements": list(self.placements)}

    async def capture(self) -> bytes:
        self.captures += 1
        target = self.placements[-1]
        if target in self._capture_fail:
            raise asyncio.TimeoutError()
        return b"\x89PNG-fake-frame"

    async def critique(self, request) -> Critique:
        passes = self._script.get(request.target_handle, [])
        if request.pass_index >= len(passes):
            return Critique(done=True, edits=[])
        return passes[request.pass_index]

    async def adjust(self, handle: str, params: EditParams) -> str:
        self.adjusts.append((handle, params))
        return f"adjusted {handle}"

    async def regenerate(self, handle: str) -> str:
        self.regens.append(handle)
        return f"regenerated {handle}"


def _el(slot: str) -> BuildElement:
    return BuildElement(slot=slot, description=f"a {slot}")


@pytest.mark.asyncio
async def test_places_every_element_in_order():
    deps = FakeDeps({})  # default critic => done on pass 0, no edits
    result = await run_compose([_el("background"), _el("logo")], "pirate", deps)
    assert deps.placements == ["background", "logo"]
    assert result.elements_placed == 2
    assert result.edits_applied == 0


@pytest.mark.asyncio
async def test_applies_a_transform_then_stops_on_done():
    script = {
        "logo": [
            Critique(edits=[CritiqueEdit(
                target_handle="logo", action="scale",
                params=EditParams(scale=0.6), why="too big")]),
            Critique(done=True),
        ]
    }
    deps = FakeDeps(script)
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.adjusts == [("logo", EditParams(scale=0.6))]
    assert result.edits_applied == 1
    assert result.passes == 2  # pass 0 edited, pass 1 returned done


@pytest.mark.asyncio
async def test_respects_max_passes_when_critic_never_says_done():
    # critic always returns an in-window edit and never `done`
    forever = [Critique(edits=[CritiqueEdit(
        target_handle="logo", action="move",
        params=EditParams(x=10, y=10), why="nudge")]) for _ in range(10)]
    deps = FakeDeps({"logo": forever})
    result = await run_compose(
        [_el("logo")], "pirate", deps, ComposeBounds(max_passes=3))
    assert result.passes == 3  # capped
    assert result.edits_applied == 3


@pytest.mark.asyncio
async def test_rejects_edits_outside_the_look_behind_window():
    # place 5 elements; while editing e4, target e0 (3 behind the window of 4)
    els = [_el(f"e{i}") for i in range(5)]
    script = {
        "e4": [
            Critique(edits=[CritiqueEdit(
                target_handle="e0", action="move",
                params=EditParams(x=1, y=1), why="out of window")]),
            Critique(done=True),
        ]
    }
    deps = FakeDeps(script)
    result = await run_compose(els, "pirate", deps, ComposeBounds(look_behind=3))
    assert deps.adjusts == []          # e0 is outside [e1..e4]
    assert result.rejected == 1
    assert result.edits_applied == 0


@pytest.mark.asyncio
async def test_regenerate_edits_are_capped_by_the_budget():
    script = {
        "a": [Critique(edits=[CritiqueEdit(
            target_handle="a", action="regenerate", why="wrong for role")]),
            Critique(done=True)],
        "b": [Critique(edits=[CritiqueEdit(
            target_handle="b", action="regenerate", why="wrong for role")]),
            Critique(done=True)],
    }
    deps = FakeDeps(script)
    result = await run_compose(
        [_el("a"), _el("b")], "pirate", deps, ComposeBounds(regen_budget=1))
    assert deps.regens == ["a"]        # only the first regenerate is funded
    assert result.regens_spent == 1
    assert result.rejected == 1        # b's regenerate refused (budget exhausted)


@pytest.mark.asyncio
async def test_capture_failure_skips_critique_for_that_element():
    script = {"logo": [Critique(edits=[CritiqueEdit(
        target_handle="logo", action="scale",
        params=EditParams(scale=0.5), why="x")])]}
    deps = FakeDeps(script, capture_fail={"logo"})
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.adjusts == []          # never critiqued — no frame
    assert result.passes == 0
    assert deps.captures == 1          # tried once, failed, moved on
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_compose_loop.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.scene.compose'`.

- [ ] **Step 3: Write `app/scene/compose_loop.py`**

Create `studio/backend/app/scene/compose_loop.py`:

```python
"""Vision-in-the-loop scene composition — compose-loop orchestrator core.

`run_compose` owns the bounded build loop described in the spec (§1): for each
element the user named, place it, then repeatedly capture the real rendered
frame, critique its composition, and apply transform/regenerate edits until the
critic returns `done` or the caps are hit. It is pure: all I/O (placement,
capture, critique, edits) is behind the `ComposeDeps` Protocol so the bounds /
window / budget / stop logic is unit-testable without Mongo, sockets, or an LLM.
See docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md.
"""

import logging
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel

from app.scene.critic import Critique, CritiqueRequest, EditParams

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ComposeBounds:
    """Liberal v1 defaults from the spec (§1 Bounds)."""

    look_behind: int = 3        # editable window = [K-look_behind .. K]
    max_passes: int = 3         # re-look passes per element
    regen_budget: int = 5       # hard ceiling on regenerations per build
    capture_timeout: float = 8.0


class BuildElement(BaseModel):
    """One element of a build list — mirrors `generate_and_place` args 1:1 so the
    orchestrator can forward it straight to the placement verb."""

    description: str = ""
    style: str = ""
    size: str = "512x512"
    transparent: bool = True
    slot: str = ""
    role: str = ""
    parent: str = "root"
    x: float | None = None
    y: float | None = None
    anchor_x: float = 0.5
    anchor_y: float = 0.5
    fit: str = "none"
    z_index: int = 0


@dataclass
class ComposeResult:
    passes: int = 0
    edits_applied: int = 0
    regens_spent: int = 0
    rejected: int = 0
    elements_placed: int = 0
    notes: list[str] = field(default_factory=list)


class ComposeDeps(Protocol):
    """The I/O surface the loop drives. Task 3 supplies the real impl; tests a
    fake. Every method is async."""

    async def place(self, element: BuildElement) -> str: ...
    async def placed_handles(self) -> list[str]: ...
    async def scene_context(self) -> dict: ...
    async def capture(self) -> bytes: ...
    async def critique(self, request: CritiqueRequest) -> Critique: ...
    async def adjust(self, handle: str, params: EditParams) -> str: ...
    async def regenerate(self, handle: str) -> str: ...


async def run_compose(
    elements: list[BuildElement],
    theme: str,
    deps: ComposeDeps,
    bounds: ComposeBounds = ComposeBounds(),
) -> ComposeResult:
    """Drive the bounded compose loop. Returns a tally + per-step notes."""
    result = ComposeResult()
    regen_left = bounds.regen_budget

    for element in elements:
        await deps.place(element)
        result.elements_placed += 1
        handles = await deps.placed_handles()
        if not handles:
            continue
        target = handles[-1]
        k = len(handles) - 1
        window = handles[max(0, k - bounds.look_behind):k + 1]
        result.notes.append(f"placed {target} (window={window})")

        for pass_index in range(bounds.max_passes):
            try:
                frame = await deps.capture()
            except Exception:
                # Best-effort capture (decision 3): no frame -> cannot grade this
                # element. Skip its critique loop and move on.
                result.notes.append(f"{target}: no frame, skipped critique")
                logger.info("compose: capture failed for %s; skipping", target)
                break

            scene = await deps.scene_context()
            critique = await deps.critique(CritiqueRequest(
                frame_png=frame, scene=scene, target_handle=target,
                window=window, theme=theme, regen_budget_left=regen_left,
                pass_index=pass_index,
            ))
            result.passes += 1
            if critique.done or not critique.edits:
                break

            for edit in critique.edits:
                if edit.target_handle not in window:
                    result.rejected += 1
                    result.notes.append(
                        f"rejected {edit.action} on {edit.target_handle} "
                        f"(outside window {window})")
                    continue
                if edit.action == "regenerate":
                    if regen_left <= 0:
                        result.rejected += 1
                        result.notes.append(
                            f"refused regenerate {edit.target_handle} "
                            f"(budget exhausted)")
                        continue
                    regen_left -= 1
                    result.regens_spent += 1
                    await deps.regenerate(edit.target_handle)
                    result.notes.append(
                        f"regenerated {edit.target_handle}: {edit.why}")
                else:
                    await deps.adjust(edit.target_handle, edit.params)
                    result.notes.append(
                        f"{edit.action} {edit.target_handle}: {edit.why}")
                result.edits_applied += 1

    return result
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_compose_loop.py -v`
Expected: PASS (all six tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/compose_loop.py studio/backend/tests/test_compose_loop.py
git commit -m "feat(scene): compose-loop core with bounds, window, regen budget"
```

---

### Task 3: `compose_scene` tool — real `ComposeDeps` + registration

Wire `run_compose` to the real seams behind `ComposeDeps`, expose it as the `compose_scene` agent tool, and register it. The deps' transform/regenerate/listing methods are unit-tested against **real Mongo** (matching `test_adjust_element_tool.py`) with fake asset/critic/broker; the full place→critique→edit path is covered by the e2e (Task 5), since placement needs the replay ComfyUI stack.

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (add `_SceneComposeDeps` + `build_compose_scene_tool` after `build_adjust_element_tool` ~line 377; register `"compose_scene"` in `_BUILDERS` ~line 1051)
- Modify: `studio/backend/tests/test_compose_scene_tool.py` (deps + registry tests)

**Interfaces:**

- Consumes (existing): `ToolContext` with `scene_store`, `scene_hub`, `asset_store`, `scene_critic`, `capture_broker`, `game_id` (Task 1); `_placed_elements(document, assets) -> list[PlacedElement]` (`agent_tools.py:_placed_elements`); `PlacedElement` fields `handle/role/asset/position/size/z_index/sprite_id` (`agent_tools.py`); `build_generate_and_place_tool(ctx)`, `build_adjust_element_tool(ctx)`, `build_regenerate_element_tool(ctx)` (`agent_tools.py`); `SceneCaptureBroker.request_capture(game_id, *, timeout) -> bytes` (`app/scene/capture.py:30`); `SceneCritic.critique(request) -> Critique` (`app/scene/critic.py:73`); `run_compose`, `ComposeBounds`, `BuildElement`, `ComposeResult` (Task 2); `EditParams` (`app/scene/critic.py:28`); `StructuredTool`, `BaseTool`.
- Produces (relied on by Task 4 + e2e): a registered tool `compose_scene(elements: list[dict], theme: str = "") -> str` that runs the bounded loop and returns a human-readable summary; `_SceneComposeDeps(ctx)` implementing `ComposeDeps`.

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_compose_scene_tool.py` (the file already exists from Task 1):

```python
import pytest

from app.agent_tools import (
    ToolContext,
    ToolFactory,
    _SceneComposeDeps,
    build_compose_scene_tool,
)
from app.scene.compose_loop import BuildElement
from app.scene.critic import EditParams
from app.scene.hub import GameSceneHub
from app.scene.store import GameSceneStore


class _SilentSio:
    async def emit(self, *a, **k): ...
    async def enter_room(self, *a, **k): ...


class _NoAssets:
    async def list_assets(self, game_id):
        return []


class _FakeBroker:
    def __init__(self, png=b"\x89PNG-frame"):
        self.png = png
        self.calls = 0

    async def request_capture(self, game_id, *, timeout=10.0):
        self.calls += 1
        return self.png


async def _seed_sprite(hub, game_id, handle, role, *, pos=(640, 360), z=0):
    await hub.apply_batch(game_id, [
        {"kind": "addNode", "id": "root", "type": "Root", "props": {}},
        {"kind": "addNode", "id": f"spr.{handle}", "type": "Sprite", "props": {
            "position": {"x": pos[0], "y": pos[1]},
            "anchor": {"x": 0.5, "y": 0.5},
            "scale": {"x": 1, "y": 1}, "zIndex": z, "role": role}},
        {"kind": "connect", "edgeId": f"e.child.{handle}", "type": "child",
         "from": {"node": "root", "port": "children"},
         "to": {"node": f"spr.{handle}", "port": "parent"}},
    ])


@pytest.mark.asyncio
async def test_compose_deps_lists_placed_handles_in_order(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    await _seed_sprite(hub, "g1", "logo", "logo", pos=(640, 100))
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub,
                      capture_broker=_FakeBroker())
    deps = _SceneComposeDeps(ctx)
    assert await deps.placed_handles() == ["background", "logo"]
    ctxt = await deps.scene_context()
    assert any(e["handle"] == "logo" for e in ctxt["elements"])
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_compose_deps_capture_calls_the_broker(mongo_db):
    broker = _FakeBroker(png=b"\x89PNGxyz")
    ctx = ToolContext("r1", "g1", _NoAssets(), None,
                      scene_store=GameSceneStore(mongo_db), scene_hub=None,
                      capture_broker=broker)
    deps = _SceneComposeDeps(ctx)
    assert await deps.capture() == b"\x89PNGxyz"
    assert broker.calls == 1


@pytest.mark.asyncio
async def test_compose_deps_adjust_applies_a_scale(mongo_db):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "logo", "logo")
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)
    deps = _SceneComposeDeps(ctx)
    await deps.adjust("logo", EditParams(scale=0.4))
    props = (await store.get_document("g1"))["nodes"]["spr.logo"]["props"]
    assert props["scale"] == {"x": 0.4, "y": 0.4}
    await mongo_db["game_scenes"].delete_many({})


def test_tool_factory_builds_compose_scene():
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=None, scene_hub=None)
    tools = ToolFactory().build(["compose_scene"], ctx)
    assert [t.name for t in tools] == ["compose_scene"]
```

(`mongo_db` is the shared fixture used by `test_adjust_element_tool.py`; `ToolFactory().build([...])` is the registry entrypoint asserted by Plan 1's tests.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py -v`
Expected: FAIL — `ImportError: cannot import name '_SceneComposeDeps'` / `build_compose_scene_tool`.

- [ ] **Step 3: Add `_SceneComposeDeps` + `build_compose_scene_tool`**

In `studio/backend/app/agent_tools.py`, add the imports near the top of the file (next to the existing scene imports — verify the exact existing import lines and add only what's missing):

```python
from app.scene.compose_loop import BuildElement, ComposeBounds, run_compose
from app.scene.critic import CritiqueRequest, EditParams
```

Then add this immediately after `build_adjust_element_tool` ends (after ~line 377, before `build_read_scene_tool`):

```python
class _SceneComposeDeps:
    """Real `ComposeDeps` for `run_compose`: reuses the existing placement,
    listing, transform, regenerate, capture, and critic seams. No new node
    walking or Mongo writes — every method delegates to a merged seam."""

    def __init__(self, ctx: ToolContext):
        self._ctx = ctx
        # Build the sub-verbs once; each is a StructuredTool we ainvoke.
        self._place_tool = build_generate_and_place_tool(ctx)
        self._adjust_tool = build_adjust_element_tool(ctx)
        self._regen_tool = build_regenerate_element_tool(ctx)

    async def _elements(self) -> list:
        document = await self._ctx.scene_store.get_document(self._ctx.game_id)
        if not document or not document.get("nodes"):
            return []
        assets = await self._ctx.asset_store.list_assets(self._ctx.game_id)
        return _placed_elements(document, assets)

    async def place(self, element: BuildElement) -> str:
        return await self._place_tool.ainvoke(element.model_dump())

    async def placed_handles(self) -> list[str]:
        return [el.handle for el in await self._elements()]

    async def scene_context(self) -> dict:
        out = []
        for el in await self._elements():
            name = getattr(el.asset, "name", None) or "(unbound)"
            out.append({
                "handle": el.handle, "role": el.role, "asset": name,
                "x": el.position[0] if el.position else None,
                "y": el.position[1] if el.position else None,
                "w": el.size[0] if el.size else None,
                "h": el.size[1] if el.size else None,
                "z": el.z_index,
            })
        return {"elements": out}

    async def capture(self) -> bytes:
        return await self._ctx.capture_broker.request_capture(
            self._ctx.game_id, timeout=ComposeBounds().capture_timeout)

    async def critique(self, request: CritiqueRequest):
        return await self._ctx.scene_critic.critique(request)

    async def adjust(self, handle: str, params: EditParams) -> str:
        return await self._adjust_tool.ainvoke({
            "ref": handle, "x": params.x, "y": params.y,
            "scale": params.scale, "z": params.z})

    async def regenerate(self, handle: str) -> str:
        return await self._regen_tool.ainvoke({"ref": handle})


def build_compose_scene_tool(ctx: ToolContext) -> BaseTool:
    async def compose_scene(elements: list[dict], theme: str = "") -> str:
        if not elements:
            return "Pass at least one element to build."
        if ctx.scene_critic is None or ctx.capture_broker is None:
            return ("Compose loop unavailable: no critic/capture wired. "
                    "Place elements individually with generate_and_place.")
        build = [BuildElement(**e) for e in elements]
        deps = _SceneComposeDeps(ctx)
        result = await run_compose(build, theme, deps)
        head = (f"Composed {result.elements_placed} element(s) over "
                f"{result.passes} critique pass(es): {result.edits_applied} "
                f"edit(s) applied, {result.regens_spent} regeneration(s), "
                f"{result.rejected} edit(s) refused.")
        body = "\n".join(f"- {n}" for n in result.notes)
        return head + ("\n" + body if body else "")

    return StructuredTool.from_function(
        coroutine=compose_scene, name="compose_scene",
        description=(
            "BUILD a slot-game scene from a list of elements, composing them with "
            "a vision critic in the loop. Pass `elements` — an ordered list, one "
            "dict per visual element with the SAME fields as generate_and_place "
            "(description, slot, role, size 'WxH', transparent, x, y, anchor_x, "
            "anchor_y, fit, z_index) — and `theme` (the user's intent, e.g. "
            "'premium pirate slot'). For EACH element this generates+places it, "
            "then captures the real rendered frame and lets the critic move/scale/"
            "reorder (and, sparingly, regenerate) elements until the composition "
            "settles. Use this for ANY request to create or place new scene art — "
            "a whole build ('make a pirate game with a background and a logo') or a "
            "single add ('add a treasure chest bottom-right'). Do NOT use it to "
            "change something already on screen — that is adjust_element / "
            "regenerate_element."
        ),
    )
```

Then register it in the `_BUILDERS` dict (~line 1051), immediately after the `"adjust_element"` entry:

```python
        "adjust_element": build_adjust_element_tool,
        "compose_scene": build_compose_scene_tool,
        "read_scene": build_read_scene_tool,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py -v`
Expected: PASS (all Task 1 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_compose_scene_tool.py
git commit -m "feat(scene): add compose_scene orchestrator tool"
```

---

### Task 4: Route design-router branch 4 into `compose_scene` (and keep the suite green)

Bind `compose_scene` into the design-router and rewrite branch 4 so a "build a scene" request routes into the deterministic orchestrator instead of emitting bare `generate_and_place` calls. Because this changes what the LLM emits for build prompts, migrate the existing compose replay cassette + the existing compose e2e to the new one-`compose_scene`-call shape so nothing regresses.

**Files:**

- Modify: `studio/backend/app/gdd/router.py` (tools set + branch-4 prose)
- Modify: `studio/backend/tests/test_design_router.py` (router binds + mentions `compose_scene`)
- Modify: `studio/backend/tests/fixtures/replay/run/compose-pirate-scene.json` (one `compose_scene` call)
- Modify: `studio/backend/tests/e2e/test_scene_compose.py` (capture responder; keep placement/order assertions)

**Interfaces:**

- Consumes: `build_design_router_spec() -> SkillSpec` with `.tools` (set) and `.body` (str) (`app/gdd/router.py:116`); the `tool_call_rounds` cassette shape consumed by `ReplayToolCallingChatModel` (`app/providers.py`); the `live_server` e2e fixture + socketio client pattern (`tests/e2e/conftest.py`, `tests/e2e/test_scene_compose.py`).
- Produces: `compose_scene` ∈ `build_design_router_spec().tools` and named in `.body`; the existing compose prompt now replays as a single `compose_scene` call.

- [ ] **Step 1: Update the router tests for the new branch-4 behavior**

Two existing tests in `studio/backend/tests/test_design_router.py` encode the OLD branch-4 behavior (interleave via `generate_and_place`). One is now obsolete and must be **replaced**; the others stay green because branch 4 keeps the `add_sprite` / `fit` / `background` / `logo` mentions (Step 3).

**Replace** the obsolete `test_router_compose_branch_interleaves_via_generate_and_place` (lines ~16–28) entirely with a `compose_scene`-oriented test:

```python
def test_router_compose_branch_routes_to_compose_scene():
    """Branch 4 (build/compose the scene) routes the whole build into the
    deterministic compose_scene orchestrator with an ordered `elements` list —
    NOT a series of bare generate_and_place calls (the loop discipline lives in
    code, not skippable prose)."""
    spec = build_design_router_spec()
    assert "compose_scene" in spec.tools
    body = spec.body
    low = body.lower()
    assert "compose_scene" in body
    # it hands the whole build list to the orchestrator, one entry per element
    assert "elements" in low
    assert "single `compose_scene` call" in body or "a single `compose_scene`" in body.lower()
    # still steers builds element-by-element (the orchestrator owns the loop)
    assert "one entry per element" in low or "in order" in low
```

(`test_router_binds_visual_compose_tools` at line 10 still passes — `generate_and_place` stays in the tools set. `test_router_body_documents_visual_compose_branch` at line 31 still passes — Step 3's prose keeps `add_sprite`/`fit`/`background`/`logo`. `test_router_body_guides_backgrounds_to_be_text_free` still passes — Step 3 keeps the "no text, no words…" guidance.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_design_router.py::test_router_compose_branch_routes_to_compose_scene -v`
Expected: FAIL — `compose_scene` is not yet in the tools set/body.

- [ ] **Step 3: Bind the tool + rewrite branch 4**

In `studio/backend/app/gdd/router.py`, add `"compose_scene"` to the `tools=sorted({…})` set inside `build_design_router_spec()` (alphabetical position is irrelevant — `sorted()` orders it):

```python
        tools=sorted(
            GDD_TOOL_NAMES
            | {"realize_symbol", "generate_asset", "add_sprite", "list_assets",
               "generate_and_place", "regenerate_element", "read_scene",
               "adjust_element", "compose_scene"}
        ),
```

Then replace **branch 4** in `_BODY_TEMPLATE` (the block starting `4. A request to CREATE or PLACE visual art…` through the end of that numbered item, up to but not including `5. A request to FIX…`) with:

```
4. A request to CREATE or PLACE visual art, or to build/compose the scene
   (e.g. "make a pirate game with a background and a logo at the top", "add a
   treasure chest bottom-right"): make a SINGLE `compose_scene` call. Extract the
   visual elements the user named into the `elements` list — one entry per
   element, IN ORDER — and pass the user's overall `theme` (e.g. "premium pirate
   slot"). `compose_scene` generates and places each element AND runs a vision
   critic in the loop that nudges placement (move/scale/reorder, and sparingly
   regenerate) so the composition reads as a real slot machine. Each `elements`
   entry takes the same fields you would pass to generate_and_place:
     - description: a vivid, concrete description; choose a stable `slot` handle
       (e.g. slot="background", slot="logo"). set transparent=false for a
       full-bleed background, true for logos and props; pass size like "1280x720"
       for a background or "768x512" for a logo.
       For a BACKGROUND, describe it as pure scenery/environment art and END the
       description with "no text, no words, no letters, no title, no logo, no UI".
       Do NOT call a background a "slot game", "title screen", or "game logo" and
       do NOT put the game's name in it. Keep all wordmarks on the LOGO asset.
     - placement: a short `role` plus the position. A background uses fit="cover"
       and z_index=0; for "centered at the top" pass y=0 and anchor_y=0 and omit x
       (x defaults to centred).
   Do NOT emit individual generate_and_place calls for a build — `compose_scene`
   owns the whole element-by-element loop. (To place an asset that already exists
   without regenerating you may instead call `add_sprite`; to generate without
   placing, `generate_asset`; use `list_assets` to see what is already on the
   board.) If the user is CHANGING or REPLACING something ALREADY in the scene
   rather than adding new art, do NOT use `compose_scene` — handle it as a layout
   edit or regenerate (point 5); call `read_scene` first if unsure whether the
   element is already placed.
```

> The retained `add_sprite` / `generate_asset` / `list_assets` / `fit` / `background` / `logo` / "no text" mentions keep `test_router_binds_visual_compose_tools`, `test_router_body_documents_visual_compose_branch`, and `test_router_body_guides_backgrounds_to_be_text_free` green.

- [ ] **Step 4: Run the router tests**

Run: `cd studio/backend && uv run pytest tests/test_design_router.py -v`
Expected: PASS — the replaced `test_router_compose_branch_routes_to_compose_scene` plus all other router tests (the retained `add_sprite`/`fit`/`background`/`logo`/"no text" prose keeps the documents-branch and text-free tests green, per the note in Step 1).

- [ ] **Step 5: Migrate the existing compose run cassette**

Replace the contents of `studio/backend/tests/fixtures/replay/run/compose-pirate-scene.json` with a single `compose_scene` call carrying both elements:

```json
{
  "prompt": "make a pirate theme game with a background and a logo centered at the top",
  "tool_call_rounds": [
    [
      {
        "name": "compose_scene",
        "args": {
          "theme": "pirate slot",
          "elements": [
            {
              "description": "a pirate ship on the high seas at sunset, full scene background, no text, no words, no letters, no title, no logo, no UI",
              "slot": "background",
              "size": "1280x720",
              "transparent": false,
              "role": "background",
              "fit": "cover",
              "z_index": 0
            },
            {
              "description": "a pirate game logo with bold gold lettering and a skull",
              "slot": "logo",
              "size": "768x512",
              "transparent": true,
              "role": "logo",
              "y": 0,
              "anchor_y": 0
            }
          ]
        }
      }
    ]
  ],
  "final": ["Placed a pirate background and a logo at the top of the scene."]
}
```

> The critic for these targets falls back to `critic/default.json` (one `done` pass), so this cassette places both elements and converges immediately — preserving the existing e2e's assertions (both assets generated, background placed before logo).

- [ ] **Step 6: Add a capture responder to the existing compose e2e**

The orchestrator now requests a frame after each placement. In `studio/backend/tests/e2e/test_scene_compose.py`, make the test's socketio client answer `scene_capture_request` so the loop's capture resolves instead of waiting out the timeout. Add this handler registration right after the other `client.on(...)` handlers (alongside `client.on("scene_op", …)`):

```python
    import base64

    async def _on_capture_request(data):
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNGtest").decode()
        await client.emit(
            "scene_capture_result",
            {"gameId": data["gameId"], "captureId": data["captureId"], "png": png},
        )

    client.on("scene_capture_request", _on_capture_request)
```

Leave the existing assertions unchanged (assets exist for both slots; `spr.background` added before `spr.logo`). They still hold: `compose_scene` places background then logo internally, and the default critic returns `done` immediately so no transforms perturb the result.

- [ ] **Step 7: Run the full backend suite (unit + e2e)**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — all unit tests including the router test.

Run: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_scene_compose.py -v`
Expected: PASS — the migrated compose e2e drives one `compose_scene` call, captures resolve via the responder, both assets are placed in order.

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_design_router.py studio/backend/tests/fixtures/replay/run/compose-pirate-scene.json studio/backend/tests/e2e/test_scene_compose.py
git commit -m "feat(router): route scene builds into compose_scene orchestrator"
```

---

### Task 5: Backend replay e2e — the full compose loop (authoritative)

The spec's authoritative test (§ Testing → e2e): a recorded compose run with a **critic cassette** that builds a multi-element scene and asserts the loop **captures → critiques → applies transforms**, spends **≤ K** regenerations, edits only within the look-behind window, and converges. This is the non-browser, replay-backed contract.

**Files:**

- Create: `studio/backend/tests/fixtures/replay/run/compose-loop-secretary.json`
- Create: `studio/backend/tests/fixtures/replay/critic/secretary.json`
- Create: `studio/backend/tests/fixtures/replay/critic/desk.json`
- Create: `studio/backend/tests/e2e/test_compose_loop.py`

**Interfaces:**

- Consumes: the `live_server` fixture (`tests/e2e/conftest.py`) at `PROVIDER_MODE=replay`; the socketio events `join_room` / `join_scene` / `send_prompt` / `scene_op` / `scene_snapshot` / `run_completed` / `scene_capture_request` / `scene_capture_result`; the `_make_room` helper pattern from `test_scene_compose.py`; the run-cassette key = normalized prompt; the critic-cassette key = normalized target handle (`load_critic_cassettes`).
- Produces: a passing e2e proving the bounded loop end-to-end through the real backend (broker round-trip + replay critic + transform actuators).

- [ ] **Step 1: Write the run cassette**

Create `studio/backend/tests/fixtures/replay/run/compose-loop-secretary.json` — one `compose_scene` call building two elements (`desk`, then `secretary`):

```json
{
  "prompt": "build a secretary office slot: a desk background and a secretary character, and tidy the composition",
  "tool_call_rounds": [
    [
      {
        "name": "compose_scene",
        "args": {
          "theme": "office secretary slot",
          "elements": [
            {
              "description": "a tidy office desk scene, full background, no text, no words, no letters, no logo, no UI",
              "slot": "desk",
              "size": "1280x720",
              "transparent": false,
              "role": "background",
              "fit": "cover",
              "z_index": 0
            },
            {
              "description": "a friendly secretary character, transparent cutout",
              "slot": "secretary",
              "size": "768x1024",
              "transparent": true,
              "role": "character",
              "z_index": 2
            }
          ]
        }
      }
    ]
  ],
  "final": ["Built the office and tidied the secretary into frame."]
}
```

- [ ] **Step 2: Write the critic cassettes**

Create `studio/backend/tests/fixtures/replay/critic/desk.json` — the background is fine, but pass 0 asks for ONE regenerate (to exercise the budget path), then `done`:

```json
{
  "target": "desk",
  "passes": [
    {
      "done": false,
      "edits": [
        {
          "target_handle": "desk",
          "action": "regenerate",
          "params": {},
          "why": "The desk art is a dense rectangular blob that can't be salvaged by moving or scaling; it needs a cleaner background plate."
        }
      ]
    },
    { "done": true, "edits": [] }
  ]
}
```

Create `studio/backend/tests/fixtures/replay/critic/secretary.json` — pass 0 scales + repositions the character (transform-first), then `done`:

```json
{
  "target": "secretary",
  "passes": [
    {
      "done": false,
      "edits": [
        {
          "target_handle": "secretary",
          "action": "scale",
          "params": { "scale": 0.6 },
          "why": "The secretary dominates the play area; shrinking her clears the reel space while keeping her readable."
        },
        {
          "target_handle": "secretary",
          "action": "move",
          "params": { "x": 320, "y": 540 },
          "why": "Nudge her to the lower-left so she frames the reels instead of covering them."
        }
      ]
    },
    { "done": true, "edits": [] }
  ]
}
```

> Both targets (`desk`, `secretary`) are inside their own look-behind window (each is the just-placed element), so no edit is window-rejected here — the window rejection path is exhaustively covered by the unit test (Task 2). This e2e proves capture→critique→transform, the regen-budget path (one regenerate spent, ≤ K), and convergence (`done`).

- [ ] **Step 3: Write the e2e**

Create `studio/backend/tests/e2e/test_compose_loop.py`:

```python
import asyncio
import base64

import httpx
import pytest
import socketio

PROMPT = ("build a secretary office slot: a desk background and a secretary "
          "character, and tidy the composition")


async def _make_room(base_url: str) -> tuple[str, str]:
    """Create a room (a game is created with it — copied from test_scene_compose.py)."""
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "Compose Loop E2E"})).json()
    return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_compose_loop_captures_critiques_and_transforms(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    scene_ops: list[dict] = []
    run_completions: list[dict] = []
    scene_snapshots: list[dict] = []
    capture_requests: list[dict] = []

    client.on("scene_op", lambda d: scene_ops.append(d))
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    @client.on("scene_capture_request")
    async def _on_capture(data):
        capture_requests.append(data)
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNGframe").decode()
        await client.emit("scene_capture_result", {
            "gameId": data["gameId"], "captureId": data["captureId"], "png": png})

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)

    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 60
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received for compose-loop prompt"
    assert run_completions[0]["status"] == "completed"

    # The loop captured the real frame at least once per element.
    assert len(capture_requests) >= 2

    # Both elements were placed.
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    by_slot = {a.get("slot"): a for a in assets}
    assert "desk" in by_slot and "secretary" in by_slot

    # The critic's transforms landed: the secretary was scaled to 0.6 and moved.
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    doc = scene_snapshots[-1]["document"]
    secretary = doc["nodes"]["spr.secretary"]["props"]
    assert secretary["scale"] == {"x": 0.6, "y": 0.6}
    assert secretary["position"] == {"x": 320, "y": 540}

    # A setProp scale op streamed to the room (the scene visibly reflowed).
    scale_ops = [o for o in scene_ops
                 if o.get("op", {}).get("kind") == "setProp"
                 and o["op"].get("id") == "spr.secretary"
                 and o["op"].get("path") == "scale.x"]
    assert scale_ops, "expected a live scale op for the secretary"

    await client.disconnect()
```

> If `/rooms` / `/rooms/{id}/game` / `/games/{id}/assets` route shapes differ from this sketch, copy the exact helper from `tests/e2e/test_scene_compose.py` (it already creates a room+game and reads assets the right way) rather than guessing — that file is the authoritative pattern.

- [ ] **Step 4: Run the e2e**

Run: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_compose_loop.py -v`
Expected: PASS — the loop captures (≥2 requests), the replay critic drives a scale+move on the secretary and one budgeted regenerate on the desk, and the final scene shows the transformed secretary.

> Debug aid if the scale assertion fails: confirm the critic cassette `target` keys (`desk`/`secretary`) match the placed handles (the `slot` values), since `ReplaySceneCritic` keys on `normalize_prompt(target_handle)`. If captures never arrive, confirm the client joined `game_id`'s scene room before the prompt (the broker emits to `room=game_id`). Use `superpowers:systematic-debugging`.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/tests/fixtures/replay/run/compose-loop-secretary.json studio/backend/tests/fixtures/replay/critic/secretary.json studio/backend/tests/fixtures/replay/critic/desk.json studio/backend/tests/e2e/test_compose_loop.py
git commit -m "test(e2e): compose-loop captures, critiques, and transforms (replay)"
```

---

### Task 6: Playwright e2e — compose loop in a real browser

The client-perspective contract (`AGENTS.md`): drive a real "build" request against the replay backend and assert the Game Scene visibly reflows (the critic's transform lands on a real sprite) and the chat feed shows the `compose_scene` step. Local-only, never CI. Mirrors `e2e/compose-scene.spec.ts` + `e2e/scene-capture.spec.ts`.

**Files:**

- Create: `studio/frontend/e2e/compose-loop.spec.ts`

**Interfaces:**

- Consumes: `seedLocalStorage` (`e2e/helpers.ts`); the room-create + pane-open flow and dev hooks (`__gameActiveId`, `__engineMsgs`, the `__engineRenderer` query hooks) from `compose-scene.spec.ts`; testids `chat-composer` / `chat-send` / `chat-messages` / `menu-view` / `view-open-game/preview` / `game-engine-frame` / `workbench`; the replay run cassette `compose-pirate-scene.json` (migrated in Task 4 to a `compose_scene` call). The Playwright config derives `baseURL` + engine origin from `BLOOM_PORT_OFFSET` — the spec stays port-agnostic.
- Produces: a local-only browser test proving the compose loop reflows the scene and shows the orchestrator step in the feed.

- [ ] **Step 1: Write the spec**

Create `studio/frontend/e2e/compose-loop.spec.ts`:

```typescript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack at this
// worktree's BLOOM_PORT_OFFSET: engine (runtime client), replay backend, studio.
// Proves the compose-loop orchestrator end-to-end in a real browser: one build
// prompt routes design-router branch 4 -> compose_scene, which places each
// element and (with the replay critic) nudges placement; the Game Scene pane
// reflows live and the chat feed shows the compose_scene step.

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
  await page.getByPlaceholder(/new room/i).fill(`Compose Loop E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

test.setTimeout(300_000);

test('one build prompt composes a scene through the critic loop, rendered live', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__gameActiveId ?? null), { timeout: 10_000 }).not.toBeNull();

  // Open the Game Scene pane first so the engine is attached and answers the
  // orchestrator's capture requests during the build.
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game/preview')).toBeVisible();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 25_000 })
    .toBe(true);

  // Send the build prompt.
  await page.getByTestId('chat-composer').fill(PROMPT);
  await page.getByTestId('chat-send').click();

  // The chat feed shows the compose_scene orchestrator step and the final reply.
  const feed = page.getByTestId('chat-messages');
  await expect(feed).toContainText('compose_scene', { timeout: 90_000 });
  await expect(feed).toContainText('Placed a pirate background and a logo', { timeout: 90_000 });

  // Both sprites render with real textures (the scene composed).
  const frameHandle = await page.getByTestId('game-engine-frame').elementHandle();
  const frame = await frameHandle!.contentFrame();
  for (const id of ['spr.background', 'spr.logo']) {
    await expect
      .poll(async () => frame!.evaluate((sid) => (window as any).__engineRenderer?.textureSizeOf(sid)?.width ?? 0, id), { timeout: 25_000 })
      .toBeGreaterThan(64);
  }

  // No engine errors during the composed build.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});
```

> This spec reuses the migrated `compose-pirate-scene.json` cassette (default critic → immediate `done`), so it proves the **full studio→engine→backend round-trip** (build → place → capture handshake → critic → render) without depending on a keyed critique. The transform-applied assertion lives in the backend e2e (Task 5), where the replay critic is deterministic; here the value is the real-browser render + the orchestrator step in the feed. If the feed testid or the room-create copy differs, copy the exact selectors from `e2e/compose-scene.spec.ts` (do not invent testids).

- [ ] **Step 2: Bring up the stack at this worktree's ports**

From the worktree root, in separate terminals (ports derive from `BLOOM_PORT_OFFSET=1`):

```bash
just backend-serve-replay     # backend on :8001 (replay)
npx nx serve client           # runtime engine on :4301
npx nx serve frontend         # studio on :4201
```

Confirm replay mode: `curl -s http://localhost:8001/health` and check `"mode":"replay"`.

- [ ] **Step 3: Run the spec**

Run: `just e2e` (runs the Playwright suite against the replay backend at the worktree ports), or target just this file:
`cd studio/frontend && BLOOM_PORT_OFFSET=1 npx playwright test e2e/compose-loop.spec.ts`
Expected: PASS — the build prompt composes the scene, both sprites render, and the feed shows `compose_scene`.

- [ ] **Step 4: Format + commit**

```bash
node_modules/.bin/prettier --write studio/frontend/e2e/compose-loop.spec.ts
git add studio/frontend/e2e/compose-loop.spec.ts
git commit -m "test(e2e): compose-loop build renders live in the browser"
```

---

### Task 7: Whole-branch verification

Final gate before the PR: run every affected suite and confirm green. No new code — a verification + cleanup checkpoint.

**Files:** none (verification only).

- [ ] **Step 1: Backend unit suite**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — `test_compose_loop.py`, `test_compose_scene_tool.py`, `test_design_router.py`, and all pre-existing suites.

- [ ] **Step 2: Backend e2e suite (replay)**

Run: `cd studio/backend && uv run pytest -m e2e -q`
Expected: PASS — `test_compose_loop.py` and the migrated `test_scene_compose.py`.

- [ ] **Step 3: Backend formatting gate**

Run: `cd studio/backend && uv run ruff format --check . && uv run ruff check .`
(If the repo uses a different backend formatter/linter, run that — match `just`'s backend lint recipe. Fix any findings, then re-run.)
Expected: PASS / no changes.

- [ ] **Step 4: Browser e2e (replay backend up at :8001)**

With `just backend-serve-replay` + `npx nx serve client` + `npx nx serve frontend` running at offset 1:
Run: `just e2e`
Expected: PASS — including `compose-loop.spec.ts`, `compose-scene.spec.ts`, and `scene-capture.spec.ts` (Plan 3's capture round-trip still green).

- [ ] **Step 5: Whole-branch review**

Dispatch `superpowers:requesting-code-review` over the full branch diff (`git diff main...HEAD`). Address findings via `superpowers:receiving-code-review`. Re-run Steps 1–2 after any change.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/vision-compose-4
gh pr create --fill
```

---

## Self-Review

- **Spec coverage (Plan 4's slice — the whole compose loop):**
  - _§1 Compose-loop orchestrator: for each element, generate_and_place → re-look loop (capture → critic → apply) → advance_ → `run_compose` (Task 2) drives exactly this; `_SceneComposeDeps` (Task 3) wires the real verbs. ✓
  - _Bounds: LOOK_BEHIND N=3, MAX_PASSES=3, GLOBAL_REGEN_BUDGET K=5; stop on done/caps_ → `ComposeBounds` defaults + the loop's window/pass/budget/`done` handling, unit-tested per-bound (Task 2). ✓
  - _Real-frame capture (§2) drives the critic_ → `deps.capture()` → `SceneCaptureBroker.request_capture` (Plan 3), best-effort on timeout (decision 3), exercised through the real broker round-trip in the backend e2e (Task 5). ✓
  - _Vision critic (§3) structured edits; transform-first; out-of-window rejected; regen budgeted_ → `deps.critique()` → `SceneCritic` (Plan 2); window rejection + regen-budget refusal enforced **in code** in `run_compose` (Task 2), matching the spec's "in the prompt _and_ in code (§4)". ✓
  - _Actuators (§4): transform liberal via adjust_element; regenerate conservative via regenerate_element_ → `deps.adjust` / `deps.regenerate` reuse Plan 1's `adjust_element` and the existing `regenerate_element` (Task 3). ✓
  - _Home: sibling to design-router; branch 4 routes into it instead of bare generate_and_place_ → branch 4 rewritten to one `compose_scene` call (Task 4); the deterministic loop lives in the tool body, satisfying the spec's "deterministic orchestration in code, not router prose" (§ Key insight). ✓
  - _Streaming + interruptible_ → the live scene reflow (`scene_op` per edit) + the rich `compose_scene` tool-result give the "watch it compose" experience; finer per-step feed streaming + loop `interrupt()` are **documented deferred follow-ups** (decision 2 / Known limitations), justified by the `RunStep` contiguous-index constraint and bounded-v1 caps. Called out, not hidden. ✓
  - _Testing: unit (critic contract, orchestrator bounds, capture barrier, actuators) + replay e2e (compose run with critic cassette: capture→critique→transform, ≤K regen, window-bounded, converges) + Playwright (scene reflows, feed shows steps)_ → Tasks 2, 3, 5, 6 respectively. The orchestrator-bounds and window/budget contracts are exhaustively unit-tested (Task 2); the authoritative replay e2e asserts capture+transform+budget+convergence (Task 5). ✓
  - _Vision model decided: claude-sonnet-4-6 behind the seam_ → untouched; the orchestrator calls `ctx.scene_critic` (built by `build_scene_critic(settings)` in `main.py`, Task 1) and never names a model. ✓
- **Known limitations (logged, not hidden):**
  - **No per-step chat-feed streaming / no loop interrupt() in v1** (decision 2) — progress surfaces via the live scene reflow + the compose-step tool-result. The deferred follow-up is a run-step seam that lets a long-running tool emit contiguous feed steps (requires `TurnRunner` to cede index allocation), plus a cancel gate.
  - **No up-front layout plan** — inherited from the spec's own "Known limitation"; the windowed retroactive loop is the experiment. Unchanged by this plan.
- **Placeholder scan:** no TBDs; every code step shows complete code, every run step an exact command + expected result. The two "copy the exact selector/helper from the sibling file" notes (Tasks 5–6) are deliberate guards against guessing route/testid shapes, not placeholders — the referenced files exist and are authoritative. ✓
- **Type consistency:** `ComposeBounds`/`ComposeResult`/`BuildElement`/`ComposeDeps`/`run_compose` names are identical across Task 2 (definition), Task 3 (`_SceneComposeDeps` implements `ComposeDeps`; `build_compose_scene_tool` calls `run_compose`), and the tests. `compose_scene` is the tool name registered in `_BUILDERS` (Task 3), asserted by `ToolFactory().build(["compose_scene"], …)` (Task 3), and added to the router tools set + body (Task 4). `EditParams` fields (`x/y/scale/z`) flow unchanged from the critic (Plan 2) through `deps.adjust` into `adjust_element`'s `ref/x/y/scale/z` args. `request_capture(game_id, *, timeout)` and `critique(request) -> Critique` signatures match the merged Plan 2/3 source. `ToolContext.scene_critic` / `.capture_broker` are the names added in Task 1 and read in Task 3. ✓
- **Reuse check:** placement (`build_generate_and_place_tool`), transforms (`build_adjust_element_tool`), regeneration (`build_regenerate_element_tool`), element listing (`_placed_elements`), capture (`SceneCaptureBroker.request_capture`), and critique (`SceneCritic.critique` / `build_scene_critic`) all go through existing merged seams — no duplicated node-walking, Mongo writes, capture path, or critic call. The one shared `capture_broker` instance (Task 1) is deliberately singletonized so the orchestrator awaits the same broker the socket handler resolves. ✓
```
