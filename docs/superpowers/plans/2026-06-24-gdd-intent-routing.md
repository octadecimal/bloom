# GDD Design-Intent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a freeform chat message in a game room (e.g. _"set the bonus hit rate to 1:200"_) route to a `set_gdd_fields` call — editing the GDD without an explicit `/design-game` — while keeping casual chat as plain conversation.

**Architecture:** This is Problem A, the deferred second half of the GDD structured-content work (Problem B — the typed schema, renderer, and `set_gdd_fields` tool — is merged). Plain chat in a game room no longer takes the no-tool path (`turn_runner.py:56`). Instead `room_hub` builds a synthetic **design-router** `SkillSpec` — a system prompt seeded with a **field catalog** (`field_catalog()` over the schemas) plus the GDD tool allowlist — and runs it through the **existing** `TurnRunner` skill/run path. The router agent decides per message: concrete decision → `set_gdd_fields` + confirm; ambiguous target → `ask_user_question`; not a design edit → plain reply. No new executor, no new wire protocol, no classifier. Because every room is backed by a game (`store.create_room` always links one), this routes all game-room chat through the router; run cassettes become **prompt-keyed** so casual chat replays a plain reply instead of the shared default's tool calls.

**Tech Stack:** Python 3.12, pydantic v2, LangChain/LangGraph react-agent, Motor (async MongoDB), pytest / pytest-asyncio, python-socketio. Backend lives under `studio/backend`; run pytest from there (`uv run pytest ...`).

## Global Constraints

- **Source of truth for client behavior is the e2e suite.** Browser e2e (Playwright) is **not** run in CI; backend service e2e (socket/REST, `tests/e2e/`) is CI-affordable and is what this plan adds. Run `just backend-serve-replay` then `cd studio/backend && uv run pytest tests/e2e/<file> -v -m e2e`.
- **Replay determinism:** e2e runs under `PROVIDER_MODE=replay`. Tool-bearing turns replay the **run cassette**; the replay model filters cassette `tool_calls` by the _bound_ tool names and (new in this plan) selects the cassette by the last Human prompt, falling back to `__default__` (`run/default.json`). Hand-authoring keyed cassettes matches established practice (the GDD paytable call was hand-added to `default.json`).
- **Do not modify `run/default.json`.** Existing skill e2e (design-game, generate-sprite, delete-asset) rely on it via bound-filtering. New behavior comes from _new_ keyed cassette files only.
- **Reuse, don't rebuild:** route through the existing `TurnRunner` skill path and the existing approval/question gate in `room_hub`. No new run executor; no new socket events.
- **TDD:** every task is RED → GREEN → commit. Write the failing test first, watch it fail, implement minimally, watch it pass.
- **Commits:** Conventional Commits (`feat(gdd): …`, `test(gdd): …`).
- **Spec reference:** `docs/superpowers/specs/2026-06-24-gdd-structured-content-design.md` §8 (intent routing), §9 (`room_hub` change), §12 (routing e2e).
- **Frontend:** unchanged. The unified chronological feed already renders runs; a routed plain-chat turn appears as a run. The GDD viewer updates live via the existing `gdd_doc_updated` path.

---

## Phase 1 — Router building blocks

### Task 1: `field_catalog()` over the aspect schemas

**Files:**

- Modify: `studio/backend/app/gdd/schemas.py`
- Test: `studio/backend/tests/test_gdd_schemas.py` (add to existing)

**Interfaces:**

- Consumes: `ASPECT_SCHEMAS`, `Field` (already in `schemas.py`).
- Produces: `field_catalog() -> dict[str, list[dict]]` — maps aspect → ordered list of `{key, label, type, role, required, enum}`. Pure; the machine-readable surface the design-router prompt is seeded with.

- [ ] **Step 1: Write the failing test** (append to `tests/test_gdd_schemas.py`)

```python
def test_field_catalog_covers_all_aspects_with_field_metadata():
    from app.gdd.schemas import field_catalog
    cat = field_catalog()
    assert set(cat) == set(ASPECT_SCHEMAS)
    mm = {f["key"]: f for f in cat["math-model"]}
    assert mm["bonus_hit_rate"]["type"] == "ratio"
    assert mm["bonus_hit_rate"]["required"] is True
    assert mm["volatility"]["enum"] == ["low", "medium", "medium-high", "high"]
    # text/number fields carry enum=None, not a missing key
    assert mm["rtp"]["enum"] is None
    for fields in cat.values():
        for f in fields:
            assert {"key", "label", "type", "role", "required", "enum"} <= set(f)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_schemas.py -v -k field_catalog`
Expected: FAIL with `ImportError: cannot import name 'field_catalog'`

- [ ] **Step 3: Write minimal implementation** (append to `app/gdd/schemas.py`)

```python
def field_catalog() -> dict[str, list[dict]]:
    """Machine-readable catalog of every aspect's fields for the design router.

    Maps aspect -> ordered list of {key, label, type, role, required, enum}.
    Seeds the design-router prompt with the addressable design surface.
    """
    return {
        aspect: [
            {
                "key": f.key,
                "label": f.label,
                "type": f.type,
                "role": f.role,
                "required": f.required,
                "enum": list(f.enum) if f.enum else None,
            }
            for f in fields
        ]
        for aspect, fields in ASPECT_SCHEMAS.items()
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_schemas.py -v -k field_catalog`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/schemas.py studio/backend/tests/test_gdd_schemas.py
git commit -m "feat(gdd): add field_catalog() over aspect schemas"
```

---

### Task 2: `build_design_router_spec()` — the synthetic router skill

**Files:**

- Create: `studio/backend/app/gdd/router.py`
- Test: `studio/backend/tests/test_gdd_router.py`

**Interfaces:**

- Consumes: `field_catalog` (`app.gdd.schemas`, Task 1), `GDD_TOOL_NAMES` (`app.gdd.models`), `SkillSpec` (`app.skills`).
- Produces: `DESIGN_ROUTER_NAME: str = "design-router"`; `build_design_router_spec() -> SkillSpec` — a `SkillSpec` named `design-router`, `tools=sorted(GDD_TOOL_NAMES)`, `args=[]`, `body` = router instructions with the rendered field catalog inlined.

> No import cycle: `app.gdd.*` does not import `app.skills`, and `app.skills` does not import `app.gdd.router`. `router.py` importing `SkillSpec` from `app.skills` is one-directional.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_gdd_router.py
from app.gdd.router import build_design_router_spec, DESIGN_ROUTER_NAME
from app.gdd.models import GDD_TOOL_NAMES


def test_router_spec_binds_gdd_tools():
    spec = build_design_router_spec()
    assert spec.name == DESIGN_ROUTER_NAME
    assert set(spec.tools) == GDD_TOOL_NAMES
    assert spec.args == []


def test_router_spec_seeds_field_catalog_into_prompt():
    body = build_design_router_spec().body
    # addressable surface: aspects, field keys, types, the routing tools
    assert "math-model" in body
    assert "bonus_hit_rate" in body and "ratio" in body
    assert "set_gdd_fields" in body and "ask_user_question" in body
    # disambiguation discipline is stated
    assert "ambiguous" in body.lower()


def test_router_tools_are_a_subset_of_the_real_tool_universe():
    # The router spec must only reference tools the ToolFactory can build,
    # otherwise TurnRunner could not assemble it.
    from app.agent_tools import ToolFactory
    known = ToolFactory(None, None).known_tool_names()
    assert set(build_design_router_spec().tools) <= known
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_gdd_router.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.gdd.router'`

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/gdd/router.py
from app.gdd.models import GDD_TOOL_NAMES
from app.gdd.schemas import field_catalog
from app.skills import SkillSpec

DESIGN_ROUTER_NAME = "design-router"


def _render_catalog(catalog: dict[str, list[dict]]) -> str:
    lines: list[str] = []
    for aspect, fields in catalog.items():
        lines.append(f"- {aspect}")
        for f in fields:
            extra = ", required" if f["required"] else ""
            if f["enum"]:
                extra += f", one of: {', '.join(str(e) for e in f['enum'])}"
            lines.append(f"    - {f['key']} ({f['type']}{extra}) — {f['label']}")
    return "\n".join(lines)


_BODY_TEMPLATE = """\
You route ONE chat message in a game's design room to the Game Design Document
(GDD). The GDD has 7 aspects, each a typed form of named fields. The addressable
fields, by aspect, are:

{catalog}

Decide what the latest user message is:

1. A concrete design decision or parameter (e.g. "set the bonus hit rate to
   1:200", "make it high volatility", "RTP 96%"): resolve the target aspect and
   field key from the catalog above and call `set_gdd_fields` with that aspect
   and a {{field_key: value}} patch. Pass real values — percents like "96%",
   ratios like "1:200", enums by their allowed value, table fields as a list of
   row objects. Then confirm in ONE short sentence, e.g. "Set Math Model → bonus
   hit rate = 1:200."
2. A real decision whose target field is AMBIGUOUS (e.g. "set the hit rate to
   1:200" could mean base hit frequency or bonus hit rate): call
   `ask_user_question` with a focused question and 2-4 concrete options to
   disambiguate. Do NOT guess. Apply the answer with `set_gdd_fields` when it
   arrives.
3. Not a design edit (a greeting, a question, chit-chat): reply normally in
   plain text and call NO tool.

Call `read_gdd_doc` first if unsure of an aspect's exact field keys. Never invent
keys that are not in the catalog. Make at most one design edit per message unless
the user clearly asked for several.
"""


def build_design_router_spec() -> SkillSpec:
    """A synthetic skill spec: the design-router turn for game-room plain chat."""
    return SkillSpec(
        name=DESIGN_ROUTER_NAME,
        description="Route a freeform design-room message to the GDD.",
        args=[],
        tools=sorted(GDD_TOOL_NAMES),
        body=_BODY_TEMPLATE.format(catalog=_render_catalog(field_catalog())),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_gdd_router.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_gdd_router.py
git commit -m "feat(gdd): add design-router skill spec seeded with field catalog"
```

---

### Task 3: Prompt-keyed run cassettes

**Files:**

- Modify: `studio/backend/app/replay/cassette.py`
- Modify: `studio/backend/app/providers.py`
- Test: `studio/backend/tests/test_replay_run_cassettes.py` (new)

**Interfaces:**

- Produces: `load_run_cassettes(fixtures_dir) -> dict[str, dict]` — maps `normalize_prompt(prompt)` → `{tool_calls, final}`, plus `"__default__"` from `run/default.json`. `load_run_cassette` (singular) is retained unchanged.
- Modifies: `ReplayToolCallingChatModel` gains `run_cassettes: dict = {}` and selects the per-turn cassette by the last Human message in **tool mode**, falling back to `__default__` then to `cassette`. Text mode (plain chat with no tools bound) is unchanged.

> Why this is needed: the router binds the GDD tools, so a routed turn would replay `run/default.json`'s `set_gdd_fields(paytable)` + `ask_user_question` for **any** message — casual chat would spuriously draft a paytable and park on a question. Prompt-keying lets each scenario (and plain "hello") map to its own recorded tool-call sequence; unknown prompts fall back to the default, exactly as today. This mirrors how LLM (text) cassettes are already prompt-keyed.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_replay_run_cassettes.py
import json
from types import SimpleNamespace

import pytest
from langchain_core.messages import HumanMessage

from app.replay.cassette import load_run_cassettes, normalize_prompt
from app.providers import ReplayToolCallingChatModel


def _write(root, name, data):
    run = root / "run"
    run.mkdir(parents=True, exist_ok=True)
    (run / name).write_text(json.dumps(data), encoding="utf-8")


def test_load_run_cassettes_keys_by_prompt_and_default(tmp_path):
    _write(tmp_path, "default.json", {"tool_calls": [{"name": "x", "args": {}}], "final": ["d"]})
    _write(tmp_path, "set.json", {
        "prompt": "Set the bonus hit rate to 1:200",
        "tool_calls": [{"name": "set_gdd_fields", "args": {"aspect": "math-model"}}],
        "final": ["ok"],
    })
    cass = load_run_cassettes(tmp_path)
    assert cass["__default__"]["final"] == ["d"]
    keyed = cass[normalize_prompt("set the bonus hit rate to 1:200")]
    assert keyed["tool_calls"][0]["name"] == "set_gdd_fields"


def _tool(name):
    return SimpleNamespace(name=name)


@pytest.mark.asyncio
async def test_tool_mode_selects_cassette_by_prompt():
    cass = {
        "__default__": {"tool_calls": [], "final": ["ok"]},
        normalize_prompt("set the bonus hit rate to 1:200"): {
            "tool_calls": [{"name": "set_gdd_fields",
                            "args": {"aspect": "math-model",
                                     "fields": {"bonus_hit_rate": "1:200"}}}],
            "final": ["Set it."],
        },
    }
    model = ReplayToolCallingChatModel(
        cassette=cass["__default__"], run_cassettes=cass, model="m"
    )
    model.bind_tools([_tool("set_gdd_fields"), _tool("ask_user_question")])
    res = await model._agenerate([HumanMessage("Set the bonus hit rate to 1:200")])
    tc = res.generations[0].message.tool_calls
    assert tc and tc[0]["name"] == "set_gdd_fields"
    assert tc[0]["args"]["fields"]["bonus_hit_rate"] == "1:200"


@pytest.mark.asyncio
async def test_tool_mode_unknown_prompt_falls_back_to_default():
    cass = {"__default__": {"tool_calls": [], "final": ["hi"]}}
    model = ReplayToolCallingChatModel(
        cassette=cass["__default__"], run_cassettes=cass, model="m"
    )
    model.bind_tools([_tool("set_gdd_fields")])
    res = await model._agenerate([HumanMessage("hello there")])
    msg = res.generations[0].message
    assert not msg.tool_calls and msg.content == "hi"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_replay_run_cassettes.py -v`
Expected: FAIL with `ImportError: cannot import name 'load_run_cassettes'`

- [ ] **Step 3a: Add the keyed loader** (append to `app/replay/cassette.py`)

```python
def load_run_cassettes(fixtures_dir: Path) -> dict[str, dict]:
    """Load run cassettes keyed by normalized prompt.

    Each ``run/*.json`` is ``{tool_calls, final}`` with an optional ``prompt``.
    ``default.json`` becomes ``"__default__"`` (the fallback). Files with a
    ``prompt`` are also keyed by ``normalize_prompt(prompt)``.
    """
    out: dict[str, dict] = {}
    run_dir = Path(fixtures_dir) / "run"
    if not run_dir.is_dir():
        return out
    for path in sorted(run_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        cassette = {
            "tool_calls": data.get("tool_calls", []),
            "final": data.get("final", ["ok"]),
        }
        if path.name == "default.json":
            out["__default__"] = cassette
        if "prompt" in data:
            out[normalize_prompt(data["prompt"])] = cassette
    return out
```

- [ ] **Step 3b: Make the replay model prompt-aware** (edit `app/providers.py`)

Add the field to `ReplayToolCallingChatModel` (after the `cassette: dict` line):

```python
    cassette: dict
    run_cassettes: dict = {}
    llm_cassettes: dict = {}
```

Replace the `_cassette_tool_calls` method:

```python
    def _cassette_tool_calls(self) -> list:
        calls = self.cassette.get("tool_calls") or []
        if self._bound_names:
            calls = [c for c in calls if c["name"] in self._bound_names]
        return calls
```

with:

```python
    def _last_human(self, messages: list[BaseMessage]) -> str:
        last = ""
        for m in messages:
            if isinstance(m, HumanMessage):
                last = m.content if isinstance(m.content, str) else str(m.content)
        return last

    def _run_cassette(self, messages: list[BaseMessage]) -> dict:
        """Pick the run cassette for this turn.

        With prompt-keyed run cassettes, select by the last Human message
        (mirroring text-mode keying), falling back to the default run cassette.
        Otherwise use the single ``cassette`` (legacy / unit-test shape).
        """
        if self.run_cassettes:
            key = normalize_prompt(self._last_human(messages))
            return (
                self.run_cassettes.get(key)
                or self.run_cassettes.get("__default__")
                or self.cassette
            )
        return self.cassette

    def _tool_calls_for(self, cassette: dict) -> list:
        calls = cassette.get("tool_calls") or []
        if self._bound_names:
            calls = [c for c in calls if c["name"] in self._bound_names]
        return calls
```

In `_agenerate`, replace the non-text-mode body (from `has_tool_result = ...` through the `return ChatResult(...)` at the end of the method):

```python
        has_tool_result = any(isinstance(m, ToolMessage) for m in messages)
        cassette = self._run_cassette(messages)
        cassette_calls = self._tool_calls_for(cassette)
        if not has_tool_result and cassette_calls:
            calls = [
                {"name": c["name"], "args": c["args"], "id": f"call_{i}"}
                for i, c in enumerate(cassette_calls)
            ]
            msg = AIMessage(content="", tool_calls=calls)
        else:
            msg = AIMessage(content="".join(cassette.get("final", ["ok"])))
        return ChatResult(generations=[ChatGeneration(message=msg)])
```

In `_astream`, replace the non-text-mode body (from `has_tool_result = ...` to the end of the method):

```python
        has_tool_result = any(isinstance(m, ToolMessage) for m in messages)
        cassette = self._run_cassette(messages)
        if not has_tool_result and self._tool_calls_for(cassette):
            # First turn: emit a single non-streaming tool-call chunk
            result = await self._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
            msg = result.generations[0].message
            yield ChatGenerationChunk(message=AIMessageChunk(content=msg.content, tool_calls=msg.tool_calls))
        else:
            # Final turn: stream each token from the cassette
            for token in cassette.get("final", ["ok"]):
                chunk = AIMessageChunk(content=token)
                if run_manager:
                    await run_manager.on_llm_new_token(token, chunk=chunk)
                yield ChatGenerationChunk(message=chunk)
```

Update `build_chat_model` (replace the `if settings.provider_mode == "replay":` block body):

```python
    if settings.provider_mode == "replay":
        from app.replay.cassette import (
            DEFAULT_FIXTURES_DIR, load_run_cassettes,
        )

        run_cassettes = load_run_cassettes(DEFAULT_FIXTURES_DIR)
        default = run_cassettes.get("__default__", {"tool_calls": [], "final": ["ok"]})
        return ReplayToolCallingChatModel(
            cassette=default,
            run_cassettes=run_cassettes,
            llm_cassettes=load_llm_cassettes(DEFAULT_FIXTURES_DIR),
            replay_token_delay=settings.replay_token_delay,
            model=model,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_replay_run_cassettes.py -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the existing provider/replay suite to confirm no regression**

Run: `uv run pytest -q -k "provider or replay or turn or skill_run"`
Expected: PASS. Existing constructions of `ReplayToolCallingChatModel(cassette=...)` (no `run_cassettes`) keep their behavior because `_run_cassette` returns `self.cassette` when `run_cassettes` is empty.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/replay/cassette.py studio/backend/app/providers.py studio/backend/tests/test_replay_run_cassettes.py
git commit -m "feat(replay): prompt-key run cassettes for tool-mode turns"
```

---

## Phase 2 — Wiring

### Task 4: Route game-room plain chat through the design-router

**Files:**

- Modify: `studio/backend/app/room_hub.py`
- Test: `studio/backend/tests/test_room_hub.py` (add to existing)

**Interfaces:**

- Consumes: `build_design_router_spec`, `DESIGN_ROUTER_NAME` (`app.gdd.router`, Task 2); existing `_run_skill`, `_run_generation`, `GDD_TOOL_NAMES`.
- Produces: `RoomHub._prompt_descriptor(room_id, author) -> dict` (chooses `kind="skill"` with the router spec for game rooms, else `kind="prompt"`); `RoomHub._design_router_spec()` (cached); `RoomHub._can_route_design() -> bool`. `_run_skill` resolves its spec from `descriptor.get("spec")` before the registry.

> Routing happens at prompt-enqueue time. A game room (room has `game_id`) with the agent stack wired (`gdd_hub` + `run_store` + `turn_runner`) enqueues a router skill turn; the user's already-persisted message is the agent's input (no second "invocation" message). Everything else — run lifecycle, the question/approval gate, `gdd_doc_updated` emission — is the existing skill path. `seed_taxonomy` is idempotent, so seeding on every routed turn is safe.

- [ ] **Step 1: Write the failing test** (append to `tests/test_room_hub.py`)

```python
# --- design-router routing (Problem A) ---
class RoutingFakeGddHub:
    def __init__(self):
        self.seeded: list[str] = []

    async def seed_taxonomy(self, game_id):
        self.seeded.append(game_id)
        return []


class RouterStubRunner:
    """Captures the spec it ran and emits a minimal final run."""

    def __init__(self):
        self.skill = None

    async def run(self, *, messages, model, skill, args, ctx, run_id=None, on_approval=None):
        self.skill = skill
        yield StepStarted(0, "final")
        yield StepToken(0, "Set Math Model → bonus hit rate = 1:200.")
        yield StepCompleted(0, "complete", "Set Math Model → bonus hit rate = 1:200.")
        yield RunFinished("completed")


@pytest.mark.asyncio
async def test_game_room_plain_chat_routes_through_design_router(mongo_db):
    from app.runs import RunStore
    from app.gdd.router import DESIGN_ROUTER_NAME

    sio = FakeSio()
    store = SkillFakeStore()          # get_room sets game_id="g1"
    runner = RouterStubRunner()
    gdd_hub = RoutingFakeGddHub()
    hub = RoomHub(
        sio, store, GatedChatService(), run_store=RunStore(mongo_db),
        turn_runner=runner, skills=FakeSkills(), gdd_hub=gdd_hub,
    )

    await hub.handle_prompt("r1", "Alice", "set the bonus hit rate to 1:200")
    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=2)

    names = sio.names()
    assert "run_started" in names and "run_completed" in names
    assert "message_completed" not in names            # not the legacy plain path
    assert runner.skill is not None
    assert runner.skill.name == DESIGN_ROUTER_NAME
    assert "set_gdd_fields" in runner.skill.tools
    assert "g1" in gdd_hub.seeded                       # taxonomy seeded for the game


@pytest.mark.asyncio
async def test_plain_chat_without_game_uses_no_tool_path(mongo_db):
    from app.runs import RunStore

    sio = FakeSio()
    store = FakeStore()               # get_room → game_id=None
    runner = RouterStubRunner()
    gdd_hub = RoutingFakeGddHub()
    hub = RoomHub(
        sio, store, GatedChatService(), run_store=RunStore(mongo_db),
        turn_runner=runner, skills=FakeSkills(), gdd_hub=gdd_hub,
    )

    await hub.handle_prompt("r1", "Alice", "hello")
    await asyncio.wait_for(_wait_event(sio, "message_completed"), timeout=2)

    assert "run_started" not in sio.names()             # legacy plain path
    assert gdd_hub.seeded == []                          # router never engaged
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_room_hub.py -v -k "design_router or no_tool_path"`
Expected: FAIL — `test_game_room_plain_chat_routes_through_design_router` sees no `run_started` (plain chat still takes the no-tool path).

- [ ] **Step 3: Write minimal implementation** (edit `app/room_hub.py`)

In `__init__`, add the cached spec slot (after `self._gdd_hub = gdd_hub`):

```python
        self._gdd_hub = gdd_hub
        self._router_spec = None
```

Replace `handle_prompt`'s queue-append (the line that appends `{"kind": "prompt", "messageId": user_msg.id}`) by computing a descriptor first:

```python
    async def handle_prompt(self, room_id: str, author: str, text: str) -> None:
        user_msg = await self._store.add_message(room_id, author, "user", text, "complete")
        await self._sio.emit("message_created", {"message": message_wire(user_msg)}, room=room_id)

        descriptor = await self._prompt_descriptor(room_id, author)

        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append(descriptor)
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
                return
            self._busy.add(room_id)

        asyncio.create_task(self._drain(room_id))
```

Add the routing helpers (place them right after `handle_prompt`):

```python
    def _can_route_design(self) -> bool:
        """The design-router needs the full agent/run stack plus a GDD hub."""
        return (
            self._gdd_hub is not None
            and self._run_store is not None
            and self._runner is not None
        )

    def _design_router_spec(self):
        from app.gdd.router import build_design_router_spec

        if self._router_spec is None:
            self._router_spec = build_design_router_spec()
        return self._router_spec

    async def _prompt_descriptor(self, room_id: str, author: str) -> dict:
        """Decide how a plain-chat prompt runs.

        In a game room with the agent stack wired, freeform chat runs the
        design-router agent so a design decision can edit the GDD without an
        explicit /design-game. Rooms without a game keep the no-tool path.
        """
        if self._can_route_design():
            room = await self._store.get_room(room_id)
            if room is not None and getattr(room, "game_id", None):
                spec = self._design_router_spec()
                return {
                    "kind": "skill", "author": author,
                    "skillName": spec.name, "args": {}, "spec": spec,
                }
        return {"kind": "prompt"}
```

In `_run_skill`, change the spec lookup so a descriptor-supplied (synthetic) spec wins:

```python
        room = await self._store.get_room(room_id)
        spec = descriptor.get("spec") or self._skills.get(descriptor["skillName"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_room_hub.py -v -k "design_router or no_tool_path"`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full room_hub suite to confirm existing plain-chat + skill paths are intact**

Run: `uv run pytest tests/test_room_hub.py -v`
Expected: PASS. Existing plain-chat tests use `FakeStore` (no `game_id`) and/or omit the stack, so they keep the no-tool path; skill tests pass a `spec` only via the registry, and `descriptor.get("spec")` is `None` for them.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/room_hub.py studio/backend/tests/test_room_hub.py
git commit -m "feat(gdd): route game-room plain chat through the design-router"
```

---

## Phase 3 — End-to-end (authoritative client behavior)

### Task 5: E2e — routed set and disambiguation

**Files:**

- Create: `studio/backend/tests/e2e/test_gdd_routing.py`
- Create: `studio/backend/tests/fixtures/replay/run/route-set-bonus.json`
- Create: `studio/backend/tests/fixtures/replay/run/route-ambiguous.json`

**Interfaces:**

- Consumes: the full stack (Tasks 1–4) under a replay backend on `:8000`. The router binds the GDD tools; the replay model selects the keyed cassette by the prompt and bound-filters its calls.

> Browser-free backend service e2e (socket + REST), mirroring `tests/e2e/test_gdd.py`. Deterministic under replay via the two keyed cassettes below.

- [ ] **Step 1: Author the keyed cassettes**

`studio/backend/tests/fixtures/replay/run/route-set-bonus.json`:

```json
{
  "prompt": "set the bonus hit rate to 1:200",
  "tool_calls": [
    {
      "name": "set_gdd_fields",
      "args": {
        "aspect": "math-model",
        "fields": { "bonus_hit_rate": "1:200" }
      }
    }
  ],
  "final": ["Set Math Model → bonus hit rate = 1:200."]
}
```

`studio/backend/tests/fixtures/replay/run/route-ambiguous.json`:

```json
{
  "prompt": "set the hit rate to 1:200",
  "tool_calls": [
    {
      "name": "ask_user_question",
      "args": {
        "question": "Which hit rate do you mean?",
        "suggestions": ["Base-game hit frequency", "Bonus hit rate"],
        "aspect": "math-model"
      }
    }
  ],
  "final": ["Which hit rate did you mean?"]
}
```

- [ ] **Step 2: Write the failing e2e**

```python
# studio/backend/tests/e2e/test_gdd_routing.py
"""Backend service e2e for design-intent routing on plain chat (replay).

Plain chat in a game room runs the design-router: a concrete design decision
routes to set_gdd_fields without an explicit /design-game; an ambiguous target
triggers a disambiguation question. Offline under PROVIDER_MODE=replay.
"""
import asyncio
import json

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "RouteE2E"})).json()
        return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_plain_chat_sets_a_field_without_design_game(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    updates: list[dict] = []
    client.on("gdd_doc_updated", lambda d: updates.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("send_prompt",
                      {"roomId": room_id, "text": "set the bonus hit rate to 1:200"})

    # Poll the math-model doc until the routed set_gdd_fields lands.
    math = None
    async with httpx.AsyncClient(base_url=live_server) as http:
        deadline = asyncio.get_event_loop().time() + 15
        while asyncio.get_event_loop().time() < deadline:
            docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
            math = next((d for d in docs if d["aspect"] == "math-model"), None)
            if math and math.get("data", {}).get("bonus_hit_rate"):
                break
            await asyncio.sleep(0.1)

    assert math is not None, "math-model doc missing"
    assert math["data"]["bonus_hit_rate"] == "1:200", f"field not set: {math['data']}"
    assert "1:200" in math["body"]

    # Viewer reflects it live via gdd_doc_updated for math-model.
    math_updates = [u for u in updates if u["doc"]["aspect"] == "math-model"]
    assert math_updates, "no live gdd_doc_updated for math-model"
    assert math_updates[-1]["doc"]["data"]["bonus_hit_rate"] == "1:200"

    await client.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_ambiguous_hit_rate_triggers_disambiguation(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    question_steps: list[dict] = []

    def _on_step(d):
        if d.get("step", {}).get("type") == "question":
            question_steps.append(d)

    client.on("run_step_started", _on_step)

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_gdd", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("send_prompt",
                      {"roomId": room_id, "text": "set the hit rate to 1:200"})

    deadline = asyncio.get_event_loop().time() + 15
    while not question_steps and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert question_steps, "ambiguous edit must trigger a disambiguation question"
    payload = json.loads(question_steps[0]["step"]["content"])
    assert payload["kind"] == "question"

    # The ambiguous edit must NOT have blindly set a hit-rate field.
    async with httpx.AsyncClient(base_url=live_server) as http:
        docs = (await http.get(f"/games/{game_id}/gdd/docs")).json()
    math = next(d for d in docs if d["aspect"] == "math-model")
    assert not math.get("data", {}).get("bonus_hit_rate")
    assert not math.get("data", {}).get("hit_frequency")

    await client.disconnect()
```

- [ ] **Step 3: Run to verify it passes against a replay backend**

```bash
# terminal 1
just backend-serve-replay
# terminal 2
cd studio/backend && uv run pytest tests/e2e/test_gdd_routing.py -v -m e2e
```

Expected: PASS — the first test sees `math-model.bonus_hit_rate == "1:200"` (via REST and a live `gdd_doc_updated`); the second reaches a `question` step and leaves the hit-rate fields empty.

> If a test fails because the run replayed the default cassette (e.g. a paytable update appears), the prompt text in the test and the `prompt` field in the cassette have diverged — `normalize_prompt` lower-cases and collapses whitespace, so they must match after that. Fix the cassette `prompt` to equal the sent text.

- [ ] **Step 4: Commit**

```bash
git add studio/backend/tests/e2e/test_gdd_routing.py studio/backend/tests/fixtures/replay/run/route-set-bonus.json studio/backend/tests/fixtures/replay/run/route-ambiguous.json
git commit -m "test(gdd): e2e for design-intent routing and disambiguation"
```

---

### Task 6: Migrate the realtime plain-chat e2e to the run wire

**Files:**

- Modify: `studio/backend/tests/e2e/test_realtime.py`
- Create: `studio/backend/tests/fixtures/replay/run/chat-hello.json`
- Create: `studio/backend/tests/fixtures/replay/run/chat-first.json`
- Create: `studio/backend/tests/fixtures/replay/run/chat-second.json`

**Interfaces:**

- Consumes: the routed stack. Because every room is a game room, `test_realtime.py`'s plain-chat prompts now run the design-router and produce **runs**, not assistant messages. The three keyed cassettes give those prompts a plain, tool-free reply so the run streams a final and completes.

> Why this migration is required, and its limits: under routing, plain chat emits `run_started` / `run_step_token` / `run_completed` instead of `token` / `message_completed`, and the assistant side is a `Run` (not a `Message`). The late-joiner test asserts a `run_snapshot` for the in-flight run and that the run completes — it does **not** assert byte-exact gap-free token reconstruction, because the run-token path (`_project_run_event`) is best-effort and not lock-synchronized with `attach_subscriber` (unlike the no-tool path). Tightening that is out of scope for intent routing. The no-tool token path remains covered by `tests/test_room_hub.py` unit tests for gameless rooms.

- [ ] **Step 1: Author the plain-reply cassettes**

`studio/backend/tests/fixtures/replay/run/chat-hello.json`:

```json
{
  "prompt": "hello",
  "tool_calls": [],
  "final": ["Hi! ", "Tell ", "me ", "about ", "the ", "slot ", "you ", "want ", "to ", "design."]
}
```

`studio/backend/tests/fixtures/replay/run/chat-first.json`:

```json
{ "prompt": "first", "tool_calls": [], "final": ["Reply ", "to ", "the ", "first ", "message."] }
```

`studio/backend/tests/fixtures/replay/run/chat-second.json`:

```json
{ "prompt": "second", "tool_calls": [], "final": ["Reply ", "to ", "the ", "second ", "message."] }
```

> The serialization test fires "first" and "second" in one room. The router keys on the **last** Human message, so both runs may resolve to the `second` cassette; both `first` and `second` cassettes are tool-free, so whichever is selected, the run produces a plain reply with no interrupt. The multi-token `hello` final widens the mid-flight window for the late-joiner test.

- [ ] **Step 2: Rewrite `test_realtime.py` to the run wire** (replace the whole file)

```python
import asyncio

import httpx
import pytest
import socketio


async def _make_room(base_url: str) -> str:
    async with httpx.AsyncClient(base_url=base_url) as client:
        resp = await client.post("/rooms", json={"name": "Realtime"})
        return resp.json()["id"]


class RunRecorder:
    """Records the run-wire events a routed plain-chat turn produces."""

    def __init__(self, client: socketio.AsyncClient):
        self.created: list[dict] = []     # message_created (user messages)
        self.tokens: list[dict] = []      # run_step_token
        self.completed: list[dict] = []   # run_completed
        client.on("message_created", lambda d: self.created.append(d))
        client.on("run_step_token", lambda d: self.tokens.append(d))
        client.on("run_completed", lambda d: self.completed.append(d))

    def text_for(self, run_id: str) -> str:
        return "".join(t["delta"] for t in self.tokens if t["runId"] == run_id)


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_both_clients_receive_streamed_run_tokens(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra, rb = RunRecorder(alice), RunRecorder(bob)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    deadline = asyncio.get_event_loop().time() + 8
    while (not ra.completed or not rb.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert ra.completed and rb.completed, "both clients must see the run complete"
    run_id = ra.completed[-1]["runId"]

    # both clients reconstruct the same streamed run text
    assert ra.text_for(run_id) == rb.text_for(run_id)
    assert ra.text_for(run_id).strip(), "router reply must be non-empty"

    # Alice's user message is attributed to Alice and seen by Bob
    user_msgs = [c["message"] for c in rb.created if c["message"]["role"] == "user"]
    assert user_msgs[-1]["author"] == "Alice"

    await alice.disconnect()
    await bob.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_concurrent_prompts_serialize_into_two_runs(live_server):
    room_id = await _make_room(live_server)
    alice, bob = socketio.AsyncClient(), socketio.AsyncClient()
    ra = RunRecorder(alice)

    await alice.connect(live_server, auth={"displayName": "Alice"})
    await bob.connect(live_server, auth={"displayName": "Bob"})
    await alice.emit("join_room", {"roomId": room_id})
    await bob.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    # fire two prompts almost simultaneously; REPLAY_TOKEN_DELAY=0.15 keeps run 1 busy
    await alice.emit("send_prompt", {"roomId": room_id, "text": "first"})
    await bob.emit("send_prompt", {"roomId": room_id, "text": "second"})

    deadline = asyncio.get_event_loop().time() + 10
    while len(ra.completed) < 2 and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    assert len(ra.completed) == 2, "both prompts answered by exactly one run each"

    async with httpx.AsyncClient(base_url=live_server) as client:
        history = (await client.get(f"/rooms/{room_id}/messages")).json()
        runs = (await client.get(f"/rooms/{room_id}/runs")).json()
    assert [m["role"] for m in history].count("user") == 2   # 2 user messages persisted
    assert len(runs) == 2 and all(r["status"] == "completed" for r in runs)

    # Serialization: run-token streams (by runId) must NOT interleave -> two contiguous runs.
    seq = []
    for t in ra.tokens:
        if not seq or seq[-1] != t["runId"]:
            seq.append(t["runId"])
    assert len(seq) == 2, f"run token streams interleaved: {seq}"

    await alice.disconnect()
    await bob.disconnect()


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_late_joiner_resumes_in_flight_run(live_server):
    room_id = await _make_room(live_server)
    alice = socketio.AsyncClient()
    ra = RunRecorder(alice)
    await alice.connect(live_server, auth={"displayName": "Alice"})
    await alice.emit("join_room", {"roomId": room_id})
    await asyncio.sleep(0.2)

    await alice.emit("send_prompt", {"roomId": room_id, "text": "hello"})

    # Wait until the run is genuinely mid-flight: >=1 token, not completed.
    deadline = asyncio.get_event_loop().time() + 5
    while (len(ra.tokens) < 1 or ra.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.02)
    assert ra.tokens and not ra.completed, "need an in-flight run to resume"
    run_id = ra.tokens[-1]["runId"]

    # Carol joins mid-run and must catch up via run_snapshot.
    carol = socketio.AsyncClient()
    snapshots: list[dict] = []
    carol.on("run_snapshot", lambda d: snapshots.append(d))
    rc = RunRecorder(carol)
    await carol.connect(live_server, auth={"displayName": "Carol"})
    await carol.emit("join_room", {"roomId": room_id})

    deadline = asyncio.get_event_loop().time() + 5
    while (not ra.completed or not rc.completed) and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert rc.completed, "late joiner must see the run complete"

    assert snapshots, "late joiner must receive a run_snapshot"
    snap = snapshots[-1]["run"]
    assert snap["id"] == run_id
    assert snap["status"] == "running"

    await alice.disconnect()
    await carol.disconnect()
```

- [ ] **Step 3: Run to verify it passes against a replay backend**

```bash
# terminal 1
just backend-serve-replay
# terminal 2
cd studio/backend && uv run pytest tests/e2e/test_realtime.py -v -m e2e
```

Expected: PASS (3 tests). If the late-joiner test is flaky (Carol misses the mid-flight window), add tokens to `chat-hello.json`'s `final` to lengthen the stream.

- [ ] **Step 4: Run the full backend e2e suite to confirm no cross-test regression**

```bash
cd studio/backend && uv run pytest tests/e2e -v -m e2e
```

Expected: PASS — `test_gdd.py` (design-game still uses `__default__` via bound-filtering), `test_assets.py`, `test_skill_runs.py`, `test_sockets.py`, `test_gdd_rest.py`, plus the new `test_gdd_routing.py` and the migrated `test_realtime.py`.

- [ ] **Step 5: Prettier-check repo-gated files**

Run (from repo root): `npx prettier --check .`
Expected: clean. The repo gates `*.md`/`*.json`/TS; fix anything flagged with `npx prettier --write <file>`.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/tests/e2e/test_realtime.py studio/backend/tests/fixtures/replay/run/chat-hello.json studio/backend/tests/fixtures/replay/run/chat-first.json studio/backend/tests/fixtures/replay/run/chat-second.json
git commit -m "test(gdd): migrate realtime plain-chat e2e to the routed run wire"
```

---

## Self-Review

**Spec coverage (§8 intent routing + §9 `room_hub` + §12 routing e2e):**

- §8 "react-agent with the GDD toolset bound and a design-router system prompt seeded with the field catalog" → Task 1 (`field_catalog`) + Task 2 (`build_design_router_spec`).
- §8 "concrete decision → resolve aspect+field, call `set_gdd_fields`, confirm" → router prompt (Task 2) + Task 5 test 1.
- §8 "ambiguous → `ask_user_question` to disambiguate" → router prompt (Task 2) + Task 5 test 2.
- §8 "not a design edit → respond as normal chat"; "rooms without a game keep the no-tool path" → Task 4 (`_prompt_descriptor` gate) + Task 4 test 2 + Task 6 cassettes (tool-free replies).
- §8 / §9 implementation note "routing decided in `room_hub`; construct a synthetic design-router skill spec and run it through the existing `TurnRunner`; no new executor" → Task 4 (`_prompt_descriptor`, `_run_skill` spec resolution; reuses run/question/approval machinery).
- §8 "viewer updates live via existing `gdd_doc_updated`" → Task 5 test 1 asserts the `gdd_doc_updated` payload.
- §12 "plain chat sets `math-model.bonus_hit_rate` and viewer reflects it" → Task 5 test 1.
- §12 "ambiguous triggers a disambiguation question" → Task 5 test 2.
- §12 "replay cassettes re-recorded for the tool-bearing plain-chat turn" → Task 3 (prompt-keyed cassettes) + Tasks 5–6 (keyed cassette files); hand-authored, matching the established practice for the GDD run cassette.
- Field catalog test (§12 "`field_catalog()` shape for the router prompt") → Task 1.
- **Discovered, not in spec:** every room is game-backed, so routing changes all plain chat → the realtime plain-chat e2e is migrated to the run wire (Task 6), and run cassettes are prompt-keyed (Task 3) so casual chat does not replay the default's tool calls.

**Placeholder scan:** none. Every code step shows complete code or complete JSON; every command states expected output. The only environment action is starting `just backend-serve-replay` before the e2e steps.

**Type consistency:**

- `field_catalog() -> dict[str, list[dict]]` defined in Task 1; consumed by `_render_catalog` in Task 2 (iterates `cat.items()`, reads `f["key"|"label"|"type"|"required"|"enum"]`) — matches the emitted keys exactly.
- `build_design_router_spec() -> SkillSpec` (Task 2) returns `name`, `tools`, `args=[]`, `body`; consumed in Task 4 via `spec.name` / `spec.tools` (used by `_run_skill`'s `set(spec.tools) & GDD_TOOL_NAMES` seed guard).
- `load_run_cassettes(fixtures_dir) -> dict[str, dict]` (Task 3) feeds `ReplayToolCallingChatModel.run_cassettes: dict` (Task 3) and `build_chat_model` (Task 3) — consistent.
- `_run_cassette(messages) -> dict` and `_tool_calls_for(cassette) -> list` (Task 3) are used by both `_agenerate` and `_astream` with the same selected cassette.
- Descriptor shape `{"kind": "skill", "skillName", "args", "spec"}` (Task 4) is consumed by `_run_skill` via `descriptor.get("spec")` and `descriptor["args"]` — both present.
- Run-wire fields asserted in Tasks 5–6 (`run_step_token.runId`/`.delta`, `run_completed.runId`/`.status`, `run_snapshot.run.{id,status,steps}`, `gdd_doc_updated.doc.{aspect,data}`) match `runs.py` / `gdd/models.py` / `room_hub.py` emitters.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-24-gdd-intent-routing.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh implementer subagent per task, a task review after each, broad whole-branch review at the end. Tasks 1 and 3 are independent (parallelizable); Task 2 depends on Task 1; Task 4 depends on Task 2; Tasks 5–6 depend on Tasks 3 + 4 and require a replay backend on `:8000`.

**2. Inline Execution** — execute tasks in this session with checkpoints.

Per repo default (AGENTS.md) and the user's request, this will be executed **subagent-driven in a fresh worktree** unless you choose otherwise.
