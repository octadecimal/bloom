# Vision-in-the-loop scene composition — Plan 2: `SceneCritic` seam

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a swappable `SceneCritic` seam — a vision-capable composition critic that grades a rendered scene PNG and returns a **structured edit list** `{done, edits:[{target_handle, action, params, why}]}` — with a live `claude-sonnet-4-6` (via OpenRouter) implementation and a deterministic, offline replay implementation backed by a new critic-cassette format.

**Architecture:** `studio/backend/app/scene/critic.py` defines the structured-output schema (Pydantic `Critique` / `CritiqueEdit` / `EditParams`), a `CritiqueRequest` input bundle (frame PNG + scene context + look-behind window + theme + regen budget + pass index), a `SceneCritic` Protocol, and two impls behind a `build_scene_critic(settings)` factory that mirrors `build_chat_model` in `providers.py`. The **live** impl is a _direct_ `ChatOpenAI(...).with_structured_output(Critique)` call carrying a base64 image part — deliberately **not** a bound tool, because the existing `ReplayToolCallingChatModel` only replays recorded _tool calls_ and cannot reproduce a direct structured+image completion. The **replay** impl reads per-target, per-pass critiques from a new `tests/fixtures/replay/critic/` cassette directory via a new `load_critic_cassettes` loader in `replay/cassette.py`.

**Tech Stack:** Python 3 / FastAPI backend, LangChain (`langchain-core` messages, `langchain-openai` `ChatOpenAI.with_structured_output`), Pydantic v2, pytest + pytest-asyncio. Backend-only; no frontend, no orchestrator (those are Plans 3–4). This plan ships independently: it produces a callable, replay-tested critic seam that Plan 4 will drive in a loop.

## Roadmap (this plan is #2 of 4)

The approved spec (`docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`) decomposes into four sequential, independently-shippable plans:

1. **`adjust_element` transform actuator** — the cheap layout lever (**MERGED**, PR #116). `adjust_element(ref, x?, y?, scale?, z?)` moves/scales/reorders a placed sprite without regenerating art.
2. **`SceneCritic` seam (THIS PLAN)** — swappable vision critic, structured-output schema, live + replay impls, new critic-cassette format. Backend, replay-cassette tested. The critic is a _direct structured+image LLM call_, NOT a bound tool.
3. **Real-frame capture handshake** — extend the runtime-client postMessage protocol with a `capture` request + a render-settled `captured` reply carrying a PNG. Frontend + Playwright.
4. **Compose-loop orchestrator** — ties 1–3 together with the bounds (look-behind N=3, max-passes=3, regen budget K=5, transform-first), streams each critique/edit into the chat feed, and routes design-router branch 4 ("build a scene") into it. Backend integration + replay e2e + Playwright.

---

## Global Constraints

Copied from the spec and repo standards (`AGENTS.md`, `docs/coding-standards.md`). Every task implicitly includes these.

- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, then refactor.
- **Semantic (Conventional Commits) format** for every commit — `feat(scope): …`, imperative mood, ~50-char subject.
- **Backend unit tests:** `cd studio/backend && uv run pytest -m "not e2e"` — requires a `mongod` on `:27017` (a shared singleton; tests use DB `bloom_studio_test`). The critic tests in this plan touch **no Mongo and no network** — they construct cassettes/requests in-memory — but the full-suite gate still needs the DB up.
- **Worktree port/data isolation:** work in a fresh worktree off `main` (created via `superpowers:using-git-worktrees`, e.g. `just wt-new vision-critic`). Unit tests bind no port; if you run the live/replay stack, use the worktree's `BLOOM_PORT_OFFSET` ports, never the defaults.
- **The critic is a DIRECT structured+image call, not a tool.** Do **not** route it through `ReplayToolCallingChatModel` / `bind_tools` / the run cassettes — it has its own seam (`SceneCritic`) and its own cassette dir (`tests/fixtures/replay/critic/`). This is the load-bearing design constraint from the spec (§3, "Swappable seam + replay") and the roadmap note in Plan 1.
- **Mirror, don't fork, the provider seam.** `build_scene_critic(settings)` selects by `settings.provider_mode` exactly like `build_chat_model` (`providers.py:295`); the cassette loader mirrors `load_run_cassettes` (`replay/cassette.py:38`) including `normalize_prompt` keying and a `__default__` fallback.
- **No behavior change** to `providers.py`, `build_chat_model`, `ReplayToolCallingChatModel`, or any existing cassette loader — this plan is purely additive (one new module, one new loader function, one new Settings field).

---

## File Structure

- `studio/backend/app/scene/critic.py` — **create.** The whole seam: schema (`EditParams`, `CritiqueEdit`, `Critique`), input bundle (`CritiqueRequest`), `SceneCritic` Protocol, `ReplaySceneCritic`, `LiveSceneCritic`, the pure message-builder `build_critic_messages`, the `CRITIC_SYSTEM_PROMPT` constant, and the `build_scene_critic(settings)` factory.
- `studio/backend/app/replay/cassette.py` — **modify.** Add `load_critic_cassettes(fixtures_dir) -> dict[str, list[dict]]` next to `load_run_cassettes` (~line 38). Keyed by `normalize_prompt(target)`; `default.json` → `__default__`. No change to existing loaders.
- `studio/backend/app/config.py` — **modify.** Add one Settings field: `critic_model: str = "anthropic/claude-sonnet-4-6"` (~line 18, next to `default_model`).
- `studio/backend/.env.example` — **modify.** Document `CRITIC_MODEL` next to the other model knobs.
- `studio/backend/tests/fixtures/replay/critic/default.json` — **create.** The fallback cassette: one pass, `done:true`, no edits.
- `studio/backend/tests/fixtures/replay/critic/shrink-captain.json` — **create.** A keyed two-pass cassette (scale-down then `done`) exercising the round-trip.
- `studio/backend/tests/test_scene_critic.py` — **create.** All unit tests (schema, replay round-trip, factory, message-builder, config).

---

### Task 1: Critic schema + `CritiqueRequest` input bundle

The structured-output contract the critic returns, and the input bundle it consumes. Pure data types — no I/O — so they can be locked first and reused by every later task.

**Files:**

- Create: `studio/backend/app/scene/critic.py`
- Create: `studio/backend/tests/test_scene_critic.py`

**Interfaces:**

- Consumes (existing): `pydantic.BaseModel`, `pydantic.Field`; `typing.Literal`, `typing.Protocol`; `dataclasses.dataclass`.
- Produces (relied on by Tasks 2–3):
  - `class EditParams(BaseModel)` — optional `x: float|None`, `y: float|None`, `scale: float|None`, `z: int|None`, all defaulting to `None`. Maps 1:1 onto `adjust_element(ref, x?, y?, scale?, z?)` (Plan 1).
  - `class CritiqueEdit(BaseModel)` — `target_handle: str`, `action: Literal["move","scale","reorder","regenerate"]`, `params: EditParams = Field(default_factory=EditParams)`, `why: str = ""`.
  - `class Critique(BaseModel)` — `done: bool = False`, `edits: list[CritiqueEdit] = Field(default_factory=list)`.
  - `@dataclass(frozen=True) class CritiqueRequest` — `frame_png: bytes`, `scene: dict`, `target_handle: str`, `window: list[str]`, `theme: str = ""`, `regen_budget_left: int = 0`, `pass_index: int = 0`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_scene_critic.py`:

```python
import pytest

from app.scene.critic import Critique, CritiqueEdit, CritiqueRequest, EditParams


def test_critique_parses_structured_edit_list():
    c = Critique(
        **{
            "done": False,
            "edits": [
                {
                    "target_handle": "captain",
                    "action": "scale",
                    "params": {"scale": 0.6},
                    "why": "dominates the reel area",
                }
            ],
        }
    )
    assert c.done is False
    assert len(c.edits) == 1
    edit = c.edits[0]
    assert edit.target_handle == "captain"
    assert edit.action == "scale"
    assert edit.params.scale == 0.6
    assert edit.params.x is None and edit.params.z is None
    assert edit.why == "dominates the reel area"


def test_critique_defaults_are_done_false_and_empty_edits():
    c = Critique()
    assert c.done is False
    assert c.edits == []


def test_critique_rejects_unknown_action():
    with pytest.raises(Exception):  # pydantic ValidationError
        CritiqueEdit(target_handle="logo", action="teleport", params={}, why="x")


def test_edit_params_accepts_all_four_levers():
    p = EditParams(x=100, y=50, scale=0.4, z=5)
    assert (p.x, p.y, p.scale, p.z) == (100, 50, 0.4, 5)


def test_critique_request_bundles_frame_and_context():
    req = CritiqueRequest(
        frame_png=b"\x89PNG...",
        scene={"nodes": []},
        target_handle="captain",
        window=["background", "logo", "captain"],
        theme="premium pirate slot",
        regen_budget_left=5,
        pass_index=1,
    )
    assert req.frame_png.startswith(b"\x89PNG")
    assert req.target_handle == "captain"
    assert req.window[-1] == "captain"
    assert req.regen_budget_left == 5
    assert req.pass_index == 1
    # frozen: reassignment is rejected
    with pytest.raises(Exception):
        req.pass_index = 2


def test_critique_request_defaults():
    req = CritiqueRequest(
        frame_png=b"", scene={}, target_handle="logo", window=["logo"]
    )
    assert req.theme == ""
    assert req.regen_budget_left == 0
    assert req.pass_index == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_scene_critic.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.scene.critic'`.

- [ ] **Step 3: Write the minimal implementation**

Create `studio/backend/app/scene/critic.py`:

```python
"""Vision-in-the-loop scene composition critic — swappable seam.

The critic grades a *rendered* scene PNG against slot-aesthetic guidance and
returns a structured edit list. It is a DIRECT structured+image LLM call, NOT a
bound tool: the existing ``ReplayToolCallingChatModel`` only replays recorded
*tool calls* and cannot reproduce a direct structured+image completion, so the
critic has its own seam (this module) and its own cassette format
(``tests/fixtures/replay/critic/``). See
``docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`` §3.
"""

from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, Field


class EditParams(BaseModel):
    """Action-specific levers. Maps 1:1 onto ``adjust_element`` (Plan 1).

    ``move`` uses x/y; ``scale`` uses scale; ``reorder`` uses z; ``regenerate``
    leaves all None (it repaints in place, keeping position/scale/z).
    """

    x: float | None = None
    y: float | None = None
    scale: float | None = None
    z: int | None = None


class CritiqueEdit(BaseModel):
    target_handle: str
    action: Literal["move", "scale", "reorder", "regenerate"]
    params: EditParams = Field(default_factory=EditParams)
    why: str = ""


class Critique(BaseModel):
    done: bool = False
    edits: list[CritiqueEdit] = Field(default_factory=list)


@dataclass(frozen=True)
class CritiqueRequest:
    """Everything the critic needs to grade one re-look pass.

    ``scene`` is the structured ``read_scene`` context (every placed sprite's
    handle/role/asset/x,y/size/z). ``window`` is the look-behind set of handles
    the critic may target. ``pass_index`` is the re-look pass number within the
    current element (the replay impl keys on it; the live impl ignores it and
    just grades the current frame).
    """

    frame_png: bytes
    scene: dict
    target_handle: str
    window: list[str]
    theme: str = ""
    regen_budget_left: int = 0
    pass_index: int = 0
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_scene_critic.py -v`
Expected: PASS (all six tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/critic.py studio/backend/tests/test_scene_critic.py
git commit -m "feat(critic): add SceneCritic structured-output schema and request bundle"
```

---

### Task 2: Critic cassette loader + `ReplaySceneCritic`

The offline, deterministic critic: a new cassette directory + loader (mirroring `load_run_cassettes`) and a `ReplaySceneCritic` that returns per-target, per-pass recorded critiques. This is the "replay-cassette tested" deliverable from the spec.

**Files:**

- Modify: `studio/backend/app/replay/cassette.py` (add `load_critic_cassettes` after `load_run_cassettes` ~line 61)
- Modify: `studio/backend/app/scene/critic.py` (add `SceneCritic` Protocol + `ReplaySceneCritic`)
- Create: `studio/backend/tests/fixtures/replay/critic/default.json`
- Create: `studio/backend/tests/fixtures/replay/critic/shrink-captain.json`
- Modify: `studio/backend/tests/test_scene_critic.py` (add replay round-trip tests)

**Interfaces:**

- Consumes: `Critique`, `CritiqueRequest` (Task 1); `normalize_prompt` (`replay/cassette.py:8`).
- Produces (relied on by Task 3 + Plan 4):
  - `load_critic_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]` — keys are `normalize_prompt(target)`; value is the cassette's `passes` list (each pass a dict shaped like `Critique`). `default.json` is also stored under `"__default__"`.
  - `class SceneCritic(Protocol)` with `async def critique(self, request: CritiqueRequest) -> Critique: ...`.
  - `class ReplaySceneCritic` constructed with the loaded `dict[str, list[dict]]`; `critique` selects `passes` by `normalize_prompt(request.target_handle)` → `__default__` → raise; returns `Critique(**passes[pass_index])`, or `Critique(done=True, edits=[])` when `pass_index` runs past the recorded passes (so an over-iterating loop terminates safely).

- [ ] **Step 1: Write the cassette fixtures**

Create `studio/backend/tests/fixtures/replay/critic/default.json`:

```json
{
  "passes": [{ "done": true, "edits": [] }]
}
```

Create `studio/backend/tests/fixtures/replay/critic/shrink-captain.json`:

```json
{
  "target": "captain",
  "passes": [
    {
      "done": false,
      "edits": [
        {
          "target_handle": "captain",
          "action": "scale",
          "params": { "scale": 0.6 },
          "why": "The captain overwhelms the reel grid; shrinking him keeps the figure readable while clearing the play area. No move alone fixes the scale."
        }
      ]
    },
    { "done": true, "edits": [] }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Append to `studio/backend/tests/test_scene_critic.py`:

```python
from app.replay.cassette import DEFAULT_FIXTURES_DIR, load_critic_cassettes
from app.scene.critic import ReplaySceneCritic


def _req(target, pass_index=0):
    return CritiqueRequest(
        frame_png=b"\x89PNG",
        scene={"nodes": []},
        target_handle=target,
        window=[target],
        pass_index=pass_index,
    )


def test_load_critic_cassettes_keys_by_target_and_default():
    cassettes = load_critic_cassettes(DEFAULT_FIXTURES_DIR)
    assert "captain" in cassettes  # from shrink-captain.json (target "captain")
    assert "__default__" in cassettes  # from default.json
    assert cassettes["captain"][0]["edits"][0]["action"] == "scale"


@pytest.mark.asyncio
async def test_replay_critic_returns_recorded_pass_zero():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("captain", pass_index=0))
    assert out.done is False
    assert out.edits[0].action == "scale"
    assert out.edits[0].params.scale == 0.6


@pytest.mark.asyncio
async def test_replay_critic_advances_to_pass_one_done():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("captain", pass_index=1))
    assert out.done is True
    assert out.edits == []


@pytest.mark.asyncio
async def test_replay_critic_out_of_range_pass_is_done():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("captain", pass_index=99))
    assert out.done is True
    assert out.edits == []


@pytest.mark.asyncio
async def test_replay_critic_unknown_target_falls_back_to_default():
    critic = ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    out = await critic.critique(_req("no-such-handle", pass_index=0))
    assert out.done is True  # default.json: single done pass
    assert out.edits == []


@pytest.mark.asyncio
async def test_replay_critic_raises_when_no_cassette_and_no_default():
    critic = ReplaySceneCritic({})  # neither keyed nor __default__
    with pytest.raises(RuntimeError, match="critic cassette"):
        await critic.critique(_req("captain"))
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_scene_critic.py -v`
Expected: FAIL — `ImportError: cannot import name 'load_critic_cassettes'` (and `ReplaySceneCritic`).

- [ ] **Step 4: Add the cassette loader**

In `studio/backend/app/replay/cassette.py`, append after `load_run_cassettes` (after line 61):

```python
def load_critic_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]:
    """Load vision-critic cassettes keyed by normalized target handle.

    Each ``critic/*.json`` is ``{passes: [<Critique-shaped dict>, ...]}`` with an
    optional ``target``. ``default.json`` becomes ``"__default__"`` (the
    fallback). Files with a ``target`` are also keyed by
    ``normalize_prompt(target)``. Mirrors ``load_run_cassettes`` — the critic is
    a direct structured+image call with its OWN cassette format (per-pass
    critiques), distinct from the tool-call run cassettes.
    """
    out: dict[str, list[dict]] = {}
    critic_dir = Path(fixtures_dir) / "critic"
    if not critic_dir.is_dir():
        return out
    for path in sorted(critic_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        passes = list(data.get("passes", []))
        if path.name == "default.json":
            out["__default__"] = passes
        if "target" in data:
            out[normalize_prompt(data["target"])] = passes
    return out
```

- [ ] **Step 5: Add the Protocol + `ReplaySceneCritic`**

In `studio/backend/app/scene/critic.py`, update the imports at the top:

```python
from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.replay.cassette import normalize_prompt
```

Then append after the `CritiqueRequest` dataclass:

```python
class SceneCritic(Protocol):
    async def critique(self, request: CritiqueRequest) -> Critique: ...


class ReplaySceneCritic:
    """Deterministic, offline critic. Returns recorded per-target, per-pass
    critiques from ``tests/fixtures/replay/critic/`` (loaded by
    ``load_critic_cassettes``)."""

    def __init__(self, cassettes: dict[str, list[dict]]):
        self._cassettes = cassettes

    async def critique(self, request: CritiqueRequest) -> Critique:
        passes = self._cassettes.get(normalize_prompt(request.target_handle))
        if passes is None:
            passes = self._cassettes.get("__default__")
        if passes is None:
            raise RuntimeError(
                f"No critic cassette for target '{request.target_handle}' and no "
                f"default.json under tests/fixtures/replay/critic/. Add a keyed "
                f"cassette (target='{request.target_handle}') or a default."
            )
        if request.pass_index >= len(passes):
            # Over-iterated past the recorded passes: report done so a loop ends.
            return Critique(done=True, edits=[])
        return Critique(**passes[request.pass_index])
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_scene_critic.py -v`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/scene/critic.py studio/backend/app/replay/cassette.py studio/backend/tests/fixtures/replay/critic/ studio/backend/tests/test_scene_critic.py
git commit -m "feat(critic): add replay critic seam + critic-cassette loader"
```

---

### Task 3: `LiveSceneCritic`, message builder, config, and `build_scene_critic` factory

The live vision call + the mode-selecting factory + the model config knob. The factory completes the seam so Plan 4 can call `build_scene_critic(settings)` and get the right impl. The live HTTP call is **not** exercised in tests (no network in CI); the testable surface is the pure message-builder, the config default, and the factory's mode selection.

**Files:**

- Modify: `studio/backend/app/config.py` (add `critic_model` field)
- Modify: `studio/backend/.env.example` (document `CRITIC_MODEL`)
- Modify: `studio/backend/app/scene/critic.py` (add `CRITIC_SYSTEM_PROMPT`, `build_critic_messages`, `LiveSceneCritic`, `build_scene_critic`)
- Modify: `studio/backend/tests/test_scene_critic.py` (factory, message-builder, config tests)

**Interfaces:**

- Consumes: `Critique`, `CritiqueRequest`, `SceneCritic`, `ReplaySceneCritic` (Tasks 1–2); `load_critic_cassettes`, `DEFAULT_FIXTURES_DIR` (`replay/cassette.py`); `app.config.Settings` with `provider_mode`, `openrouter_api_key`, `openrouter_base_url`, and the new `critic_model`; `langchain_core.messages.{BaseMessage,HumanMessage,SystemMessage}`; `langchain_openai.ChatOpenAI` (imported lazily inside `LiveSceneCritic.critique`, mirroring `LiveOpenRouterProvider`).
- Produces (relied on by Plan 4):
  - `Settings.critic_model: str = "anthropic/claude-sonnet-4-6"`.
  - `build_critic_messages(request: CritiqueRequest) -> list[BaseMessage]` — `[SystemMessage(CRITIC_SYSTEM_PROMPT), HumanMessage(content=[{type:text,...}, {type:image_url, image_url:{url:"data:image/png;base64,…"}}])]`.
  - `class LiveSceneCritic` (`critique` does `ChatOpenAI(model=critic_model,…).with_structured_output(Critique).ainvoke(build_critic_messages(request))`).
  - `build_scene_critic(settings: Settings) -> SceneCritic` — `replay` → `ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))`; else `LiveSceneCritic(...)`.

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_scene_critic.py`:

```python
from langchain_core.messages import HumanMessage, SystemMessage

from app.config import Settings
from app.scene.critic import (
    LiveSceneCritic,
    build_critic_messages,
    build_scene_critic,
)


def test_critic_model_config_default():
    assert Settings().critic_model == "anthropic/claude-sonnet-4-6"


def test_factory_selects_replay_critic():
    critic = build_scene_critic(Settings(provider_mode="replay"))
    assert isinstance(critic, ReplaySceneCritic)


def test_factory_selects_live_critic():
    critic = build_scene_critic(Settings(provider_mode="live"))
    assert isinstance(critic, LiveSceneCritic)


def test_message_builder_embeds_png_as_data_url():
    req = CritiqueRequest(
        frame_png=b"\x89PNG\r\n\x1a\n", scene={"nodes": []},
        target_handle="captain", window=["background", "logo", "captain"],
        theme="premium pirate slot", regen_budget_left=3,
    )
    msgs = build_critic_messages(req)
    assert isinstance(msgs[0], SystemMessage)
    assert isinstance(msgs[1], HumanMessage)
    parts = msgs[1].content
    image_part = next(p for p in parts if p["type"] == "image_url")
    assert image_part["image_url"]["url"].startswith("data:image/png;base64,")


def test_message_builder_text_carries_window_target_and_budget():
    req = CritiqueRequest(
        frame_png=b"x", scene={"nodes": [{"handle": "logo"}]},
        target_handle="captain", window=["background", "logo", "captain"],
        theme="premium pirate slot", regen_budget_left=3,
    )
    text = next(
        p["text"] for p in build_critic_messages(req)[1].content if p["type"] == "text"
    )
    assert "captain" in text  # just-added target
    assert "logo" in text  # window member
    assert "3" in text  # regen budget left
    assert "premium pirate slot" in text  # theme


def test_critic_system_prompt_is_slot_aware():
    from app.scene.critic import CRITIC_SYSTEM_PROMPT

    low = CRITIC_SYSTEM_PROMPT.lower()
    assert "reel" in low  # slot anatomy
    assert "transform" in low  # transform-first discipline
    assert "window" in low  # look-behind constraint
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_scene_critic.py -v`
Expected: FAIL — `AttributeError: 'Settings' object has no attribute 'critic_model'` / `ImportError` for `build_scene_critic`, `LiveSceneCritic`, `build_critic_messages`.

- [ ] **Step 3: Add the config field**

In `studio/backend/app/config.py`, add immediately after the `default_model` line (line 17):

```python
    default_model: str = "openai/gpt-5.5"
    # Vision composition critic (Plan 2). Direct structured+image call via the
    # SceneCritic seam — an OpenRouter slug, tunable without code changes. See
    # docs/.../vision-in-the-loop-scene-composition-design.md (decided: sonnet-4-6).
    critic_model: str = "anthropic/claude-sonnet-4-6"
```

In `studio/backend/.env.example`, add a line next to the other model settings (match the existing `KEY=value` style of that file):

```
CRITIC_MODEL=anthropic/claude-sonnet-4-6
```

- [ ] **Step 4: Add the message builder, system prompt, live impl, and factory**

In `studio/backend/app/scene/critic.py`, extend the imports at the top so the full set is:

```python
import base64
import json
from dataclasses import dataclass
from typing import Literal, Protocol

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR,
    load_critic_cassettes,
    normalize_prompt,
)
```

Then append at the end of the module:

```python
CRITIC_SYSTEM_PROMPT = (
    "You are a slot-game composition critic. You are shown a RENDERED frame of a "
    "slot game scene being assembled element-by-element, plus structured context "
    "for every placed element. Judge the COMPOSITION of the assembled frame — not "
    "the quality of any single asset — and return corrective edits as structured "
    "output.\n\n"
    "Canonical slot anatomy (aesthetic guidance, NOT a hard region map — content "
    "and style stay free):\n"
    "- Background fills the frame (full-bleed), sits at the back.\n"
    "- The reel grid is centered and is the visual focus; symbols sit INSIDE the "
    "grid, never spilling outside it.\n"
    "- The logo sits in the top band, clear of the play area.\n"
    "- The spin button sits bottom-center.\n"
    "- Foreground flourishes FRAME the play area, they do not cover it.\n\n"
    "Discipline:\n"
    "- TRANSFORM-FIRST. Prefer move / scale / reorder. Reach for 'regenerate' "
    "only when no transform can fix the element because the asset is wrong FOR "
    "ITS ROLE (e.g. a dense rectangular blob that cannot be salvaged by "
    "moving/scaling). A 'regenerate' edit MUST justify in 'why' that no transform "
    "fixes it, and is refused once the regeneration budget is exhausted.\n"
    "- Edit ONLY elements inside the provided editable look-behind WINDOW. Never "
    "target a handle that is not in the window.\n"
    "- When the composition is acceptable, return done=true with an empty edit "
    "list. Do not invent busywork edits.\n\n"
    "Return: {done, edits:[{target_handle, action, params, why}]} where action is "
    "one of move|scale|reorder|regenerate and params carries x, y (move), scale "
    "(scale), or z (reorder)."
)


def _data_url(frame_png: bytes) -> str:
    b64 = base64.b64encode(frame_png).decode("ascii")
    return f"data:image/png;base64,{b64}"


def build_critic_messages(request: CritiqueRequest) -> list[BaseMessage]:
    """Pure builder: render a CritiqueRequest into the LLM message list (system
    prompt + a multimodal human turn carrying the scene context and the frame
    PNG as a base64 data URL). Kept pure so it is unit-testable without a network
    call."""
    context = {
        "theme": request.theme,
        "just_added": request.target_handle,
        "editable_window": request.window,
        "regen_budget_left": request.regen_budget_left,
        "scene": request.scene,
    }
    text = (
        "Critique the rendered slot scene shown in the image and return corrective "
        "edits.\n"
        f"Just-added element (judge it hardest): {request.target_handle}\n"
        f"Editable look-behind window (you may ONLY target these handles): "
        f"{request.window}\n"
        f"Regenerations left in budget: {request.regen_budget_left}\n"
        f"Theme/intent: {request.theme}\n\n"
        f"Scene context (JSON):\n{json.dumps(context, indent=2)}"
    )
    return [
        SystemMessage(CRITIC_SYSTEM_PROMPT),
        HumanMessage(
            content=[
                {"type": "text", "text": text},
                {"type": "image_url", "image_url": {"url": _data_url(request.frame_png)}},
            ]
        ),
    ]


class LiveSceneCritic:
    """Live vision critic: a DIRECT structured+image completion via OpenRouter.

    NOT a bound tool — it calls ``ChatOpenAI.with_structured_output(Critique)``
    with a multimodal message and returns the validated ``Critique`` directly.
    """

    def __init__(self, api_key: str, base_url: str, model: str):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    async def critique(self, request: CritiqueRequest) -> Critique:
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(
            model=self._model, api_key=self._api_key, base_url=self._base_url
        )
        structured = llm.with_structured_output(Critique)
        return await structured.ainvoke(build_critic_messages(request))


def build_scene_critic(settings: Settings) -> SceneCritic:
    """Select the critic impl by provider mode — mirrors ``build_chat_model``."""
    if settings.provider_mode == "replay":
        return ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    return LiveSceneCritic(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        model=settings.critic_model,
    )
```

- [ ] **Step 5: Run the critic tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_scene_critic.py -v`
Expected: PASS (all Task 1–3 tests).

- [ ] **Step 6: Run the full backend unit suite to verify nothing regressed**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — the new `test_scene_critic.py`, plus **all existing tests** including `test_providers.py` and `test_config.py` (the additive `critic_model` field and new module touch nothing they assert).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/scene/critic.py studio/backend/app/config.py studio/backend/.env.example studio/backend/tests/test_scene_critic.py
git commit -m "feat(critic): add live vision critic, message builder, and mode-selecting factory"
```

---

## Self-Review

- **Spec coverage (this plan's slice — spec §3 "Vision critic"):**
  - _Structured output, no prose parsing_ → `Critique`/`CritiqueEdit`/`EditParams` Pydantic schema (Task 1), returned directly by both impls. ✓
  - _Output shape `{done, edits:[{target_handle, action, params, why}]}`_ → matched exactly; `params` is a typed `EditParams` object (x/y/scale/z) that maps 1:1 onto Plan 1's `adjust_element`, a deliberate refinement of the spec's free-form `{...}` for structured-output reliability and clean hand-off. ✓
  - _Input: PNG + read_scene context + just-added handle + look-behind window + theme + remaining regen budget_ → `CritiqueRequest` carries all six (plus `pass_index` for replay keying). ✓
  - _Slot-aware system prompt (anatomy, transform-first, window constraint, regen budget)_ → `CRITIC_SYSTEM_PROMPT`, asserted slot-aware by test (Task 3). ✓
  - _Swappable seam + replay, deterministic & offline (`PROVIDER_MODE=replay`)_ → `SceneCritic` Protocol + `build_scene_critic` mode-select mirroring `build_chat_model`; `ReplaySceneCritic` + new `critic/` cassette format with `load_critic_cassettes` (Tasks 2–3). ✓
  - _Vision model decided: `claude-sonnet-4-6` via OpenRouter, behind the seam as a config string_ → `Settings.critic_model = "anthropic/claude-sonnet-4-6"` (Task 3). ✓
  - _Critic is a DIRECT call, NOT a bound tool (roadmap/Plan-1 note)_ → `LiveSceneCritic` calls `with_structured_output(...).ainvoke(...)` directly; does not touch `bind_tools`/run cassettes; has its own cassette dir. ✓
- **Out of scope (correctly deferred):** the discipline _enforcement in code_ (rejecting out-of-window targets / transform-first `why` / over-budget regen) is the orchestrator/actuator's job — the spec puts enforcement "in the prompt **and** in code (§4)", and §4's actuator + the compose loop are Plans 1 and 4. Plan 2 ships the prompt-side discipline and the schema; Plan 4 wires the code-side gate. The real-frame capture handshake is Plan 3; the compose loop, streaming, and design-router branch-4 routing are Plan 4. ✓
- **Placeholder scan:** no TBDs; every code step shows complete code and every run step an exact command + expected result. ✓
- **Type consistency:** `Critique`/`CritiqueEdit`/`EditParams`/`CritiqueRequest` names are identical across Tasks 1–3 and the fixtures. `load_critic_cassettes` returns `dict[str, list[dict]]`; `ReplaySceneCritic.__init__` consumes exactly that; cassette JSON uses `passes` (loader reads `data.get("passes")`, fixtures emit `passes`). `build_scene_critic` returns the `SceneCritic` Protocol; both impls satisfy `async def critique(self, request) -> Critique`. `critic_model` is the name added to `Settings` (Task 3) and read by `build_scene_critic` (Task 3). The data-URL prefix `data:image/png;base64,` is identical in the builder and its assertion. ✓
- **Reuse check:** `load_critic_cassettes` mirrors `load_run_cassettes` and reuses `normalize_prompt` + `Path` keying; `build_scene_critic` mirrors `build_chat_model`'s mode switch; `LiveSceneCritic` lazily imports `ChatOpenAI` exactly like `LiveOpenRouterProvider`. No forked provider plumbing, no new cassette-keying scheme invented. ✓
