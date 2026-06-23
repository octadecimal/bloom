# Agentic Skill Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the text-only `llm-chat` into a Claude-Code-like tool-calling agent, driven by git-authored markdown **skills**, proven end-to-end with one skill (`generate-sprite`) over the existing ComfyUI pipeline.

**Architecture:** Every turn becomes a LangGraph agent invocation behind a new `TurnRunner`. A new provider seam, `build_chat_model`, supplies a tool-capable LangChain chat model (live `ChatOpenAI`; a new deterministic `ReplayToolCallingChatModel` for offline parity). Skills are markdown files at the repo root `skills/`, loaded by a `SkillRegistry`; each declares typed args + a tool allowlist. A skill run is a first-class `Run` (Mongo) whose ordered steps stream to every room participant as `run_*` socket events, rendered as a `RunTimeline`. Plain chat keeps the existing wire protocol and is migrated onto `TurnRunner` **last**, behind the authoritative realtime e2e suite as the safety net.

**Tech Stack:** Python 3.12, FastAPI, python-socketio, motor (MongoDB), **LangGraph** (`create_react_agent`) + langchain-openai/langchain-core, pydantic; React/Nx + hookstate + socket.io-client + vitest; Playwright (local-only).

**Spec:** `docs/superpowers/specs/2026-06-22-agentic-skill-chat-design.md`

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IRun`, `IRunStep`, `ISkill`). (`docs/coding-standards.md`)
- **Test/real parity is mandatory.** The agent loop MUST run under `PROVIDER_MODE=replay` deterministically; recorded-real cassettes over fakes; active mode stays visible at `/health`.
- **E2e is the authoritative behavioral contract.** Browser e2e (Playwright) is **NOT** run in CI; non-browser e2e (pytest realtime) IS CI-affordable and gates CI.
- **TDD is mandatory** — RED → GREEN → REFACTOR per behavior.
- **Studio UI MUST follow `docs/design-language.md`** — 4 surfaces, 2 hairlines, 3 text tiers, 1 rationed accent, floating-card model. Raw colors outside `styles.css` are blocked by a guard test.
- **Conventional Commits** for every commit; branch off `main` (protected) and land via PR.
- **Backend test command:** `cd studio/backend && uv run pytest <path> -v`
- **Frontend single-spec command:** `cd studio/frontend && npx vitest run <path>`
- **Frontend full gate (pre-PR):** `cd studio/frontend && npx prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
- **Skills live at the repo root `skills/` directory.** Backend loads them via `settings.skills_dir` (default `<repo-root>/skills`).
- **Provider-mode values are exactly `live` and `replay`.** Error sentinel model is exactly `bloom/force-error`.

---

## File Structure

**Backend — new files**

- `studio/backend/app/skills.py` — `SkillArg`, `SkillSpec` models; `SkillRegistry` (load/validate repo-root `skills/*.md`, `list_skills`, `get`).
- `studio/backend/app/runs.py` — `RunStep`, `Run` models; `RunStore` (Mongo, mirrors `AssetStore`).
- `studio/backend/app/agent_tools.py` — `ToolContext`, `ToolFactory`, `build_generate_asset_tool` (LangChain tool wrapping the asset pipeline).
- `studio/backend/app/turn_runner.py` — `RunEvent` union; `TurnRunner.run(...)` (LangGraph agent + event mapping).
- `skills/generate-sprite.md` — the one shipped skill (repo root).

**Backend — modified files**

- `studio/backend/app/providers.py` — add `build_chat_model`, `ReplayToolCallingChatModel`.
- `studio/backend/app/replay/cassette.py` — add `load_run_cassette` + extended schema.
- `studio/backend/app/replay/record.py` — record a tool-calling run cassette.
- `studio/backend/app/config.py` — add `skills_dir`.
- `studio/backend/app/room_hub.py` — generalize the per-room queue to turn descriptors; add `handle_skill_run` + `_run_skill` + `run_snapshot`; (final task) route plain chat through `TurnRunner`.
- `studio/backend/app/sockets.py` — add `run_skill` handler.
- `studio/backend/app/rest.py` — add `GET /skills`.
- `studio/backend/app/main.py` — construct + wire `SkillRegistry`, `RunStore`, `ToolFactory`, `TurnRunner`.
- `studio/backend/pyproject.toml` — add `langgraph`, `python-frontmatter`, `pyyaml`.
- `studio/backend/tests/e2e/test_skill_runs.py` — authoritative realtime suite.
- `studio/backend/tests/test_fixtures_committed.py` — guard the run cassette.

**Frontend — modified files** (all under `studio/frontend/src/plugins/llm-chat/`)

- `state.ts` — `ISkill`, `IRunStep`, `IRun` interfaces; slice fields `skills`, `skillsStatus`, `runs`, `activeRunId`.
- `reducers.ts` — `startRun`, `startStep`, `appendStepToken`, `completeStep`, `completeRun`, `applyRunSnapshot`.
- `socketClient.ts` — `run_*` inbound handlers; `runSkill` emit.
- `actions.ts` — `runSkill(skillName, args)`.
- `restClient.ts` — `getSkills()`.
- `RunTimeline.tsx` (new) — renders run steps as design-language cards.
- `ChatRoomPane.tsx` — slash-command composer + skill autocomplete + mount `RunTimeline`.

**Frontend — new e2e**

- `studio/frontend/e2e/skill-run.spec.ts` (or repo e2e dir) — Playwright local-only.

---

## Task Ordering Rationale

Backend foundation first (skills → runs → tool → chat-model seam → runner), then realtime surfacing (hub → sockets/REST/wiring → authoritative e2e), then frontend (state → socket/actions → rest → timeline → composer → Playwright), then the plain-chat migration **last** so the existing green suite proves no regression.

---

## Task 1: Skill model + SkillRegistry + the shipped skill

**Files:**

- Create: `studio/backend/app/skills.py`
- Create: `skills/generate-sprite.md`
- Modify: `studio/backend/app/config.py`
- Modify: `studio/backend/pyproject.toml` (add `python-frontmatter`, `pyyaml`)
- Test: `studio/backend/tests/test_skills.py`

**Interfaces:**

- Produces:
  - `class SkillArg(BaseModel): name: str; type: Literal["string","number","boolean"]; required: bool = False`
  - `class SkillSpec(BaseModel): name: str; description: str; args: list[SkillArg] = []; tools: list[str] = []; body: str`
  - `class SkillRegistry:`
    - `def __init__(self, skills_dir: Path, known_tools: set[str])`
    - `def load(self) -> None` — parses every `*.md`, validates; raises `SkillError` if a skill names a tool not in `known_tools` or has malformed frontmatter.
    - `def list_skills(self) -> list[dict]` — `[{name, description, args}]` (camelCase wire dicts).
    - `def get(self, name: str) -> SkillSpec | None`
    - `def validate_args(self, spec: SkillSpec, args: dict) -> dict` — required present + coerced; raises `SkillError` on mismatch.
  - `class SkillError(Exception)`
- Consumes: `settings.skills_dir`

- [ ] **Step 1: Add deps**

In `studio/backend/pyproject.toml` dependencies add:

```
python-frontmatter>=1.1
pyyaml>=6.0
```

Run: `cd studio/backend && uv sync`

- [ ] **Step 2: Add `skills_dir` to config**

In `studio/backend/app/config.py`, inside `Settings`, add (the default resolves to the repo root `skills/`, four parents up from `app/config.py`: `app` → `backend` → `studio` → repo root):

```python
    skills_dir: str = str(
        (__import__("pathlib").Path(__file__).resolve().parents[3] / "skills")
    )
```

- [ ] **Step 3: Write failing tests**

`studio/backend/tests/test_skills.py`:

```python
from pathlib import Path

import pytest

from app.skills import SkillRegistry, SkillError


def write(dir: Path, name: str, text: str) -> None:
    (dir / name).write_text(text, encoding="utf-8")


GOOD = """---
name: generate-sprite
description: Generate a game sprite and add it to the Asset Board.
args:
  - { name: description, type: string, required: true }
  - { name: style, type: string, required: false }
tools: [generate_asset]
---
Use the generate_asset tool to create one sprite. Confirm what you made.
"""


def test_loads_and_lists_skill(tmp_path):
    write(tmp_path, "generate-sprite.md", GOOD)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    listed = reg.list_skills()
    assert listed == [
        {
            "name": "generate-sprite",
            "description": "Generate a game sprite and add it to the Asset Board.",
            "args": [
                {"name": "description", "type": "string", "required": True},
                {"name": "style", "type": "string", "required": False},
            ],
        }
    ]
    assert "generate_asset" in reg.get("generate-sprite").body


def test_unknown_tool_fails_fast(tmp_path):
    write(tmp_path, "bad.md", GOOD.replace("generate_asset", "nuke_everything"))
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    with pytest.raises(SkillError):
        reg.load()


def test_validate_args_requires_required(tmp_path):
    write(tmp_path, "generate-sprite.md", GOOD)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.get("generate-sprite")
    assert reg.validate_args(spec, {"description": "a knight"}) == {"description": "a knight"}
    with pytest.raises(SkillError):
        reg.validate_args(spec, {})  # missing required 'description'
```

- [ ] **Step 4: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_skills.py -v`
Expected: FAIL (`ModuleNotFoundError: app.skills`).

- [ ] **Step 5: Implement `app/skills.py`**

```python
from pathlib import Path
from typing import Literal

import frontmatter
from pydantic import BaseModel, ValidationError


class SkillError(Exception):
    pass


class SkillArg(BaseModel):
    name: str
    type: Literal["string", "number", "boolean"]
    required: bool = False


class SkillSpec(BaseModel):
    name: str
    description: str
    args: list[SkillArg] = []
    tools: list[str] = []
    body: str


_COERCE = {
    "string": str,
    "number": float,
    "boolean": lambda v: v if isinstance(v, bool) else str(v).lower() == "true",
}


class SkillRegistry:
    def __init__(self, skills_dir: Path, known_tools: set[str]):
        self._dir = Path(skills_dir)
        self._known = known_tools
        self._skills: dict[str, SkillSpec] = {}

    def load(self) -> None:
        self._skills = {}
        if not self._dir.is_dir():
            return
        for path in sorted(self._dir.glob("*.md")):
            post = frontmatter.load(str(path))
            try:
                spec = SkillSpec(body=post.content.strip(), **post.metadata)
            except ValidationError as e:
                raise SkillError(f"{path.name}: invalid skill frontmatter: {e}") from e
            unknown = set(spec.tools) - self._known
            if unknown:
                raise SkillError(f"{path.name}: unknown tools {sorted(unknown)}")
            self._skills[spec.name] = spec

    def get(self, name: str) -> SkillSpec | None:
        return self._skills.get(name)

    def list_skills(self) -> list[dict]:
        return [
            {
                "name": s.name,
                "description": s.description,
                "args": [a.model_dump() for a in s.args],
            }
            for s in self._skills.values()
        ]

    def validate_args(self, spec: SkillSpec, args: dict) -> dict:
        out: dict = {}
        for a in spec.args:
            if a.name not in args or args[a.name] in (None, ""):
                if a.required:
                    raise SkillError(f"missing required arg '{a.name}'")
                continue
            try:
                out[a.name] = _COERCE[a.type](args[a.name])
            except (ValueError, TypeError) as e:
                raise SkillError(f"arg '{a.name}' must be {a.type}") from e
        return out
```

- [ ] **Step 6: Run — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_skills.py -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Ship the real skill**

`skills/generate-sprite.md`:

```markdown
---
name: generate-sprite
description: Generate a game sprite from a description and add it to the Asset Board.
args:
  - { name: description, type: string, required: true }
  - { name: style, type: string, required: false }
tools: [generate_asset]
---

You generate a single game sprite for the current game. Derive a clear, concrete
image prompt from the user's description (and style, if given) and call the
generate_asset tool exactly once. When it returns, confirm in one sentence what
you created and that it was added to the Asset Board.
```

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/skills.py studio/backend/app/config.py \
  studio/backend/pyproject.toml studio/backend/uv.lock \
  studio/backend/tests/test_skills.py skills/generate-sprite.md
git commit -m "feat(studio): skill registry + repo-root skills/ with generate-sprite"
```

---

## Task 2: Run model + RunStore

**Files:**

- Create: `studio/backend/app/runs.py`
- Test: `studio/backend/tests/test_run_store.py`

**Interfaces:**

- Produces:
  - `class RunStep(_WireModel): index: int; type: Literal["thinking","tool_call","tool_result","final"]; tool_name: str | None = None; content: str = ""; status: Literal["running","complete","error"] = "running"`
  - `class Run(_WireModel): id: str; room_id: str; skill_name: str; args: dict; status: Literal["running","completed","error"] = "running"; steps: list[RunStep] = []; created_at: datetime; completed_at: datetime | None = None`
  - `def run_wire(run: Run) -> dict`
  - `class RunStore:`
    - `def __init__(self, db)`
    - `async def create_run(self, room_id: str, skill_name: str, args: dict) -> Run`
    - `async def get_run(self, run_id: str) -> Run | None`
    - `async def append_step(self, run_id: str, step: RunStep) -> Run`
    - `async def append_step_token(self, run_id: str, index: int, delta: str) -> None`
    - `async def complete_step(self, run_id: str, index: int, status: str, content: str | None = None) -> None`
    - `async def complete_run(self, run_id: str, status: str) -> Run`
- Consumes: motor db handle (`mongo[settings.mongo_db]`), the `_WireModel` base from `app.models`.

- [ ] **Step 1: Write failing tests** (use `mongomock_motor` already present in test deps, mirroring `tests/test_store.py` — confirm its import there and copy the fixture style)

`studio/backend/tests/test_run_store.py`:

```python
import pytest

from app.runs import RunStore, RunStep


@pytest.fixture
def store(mongo_db):  # mongo_db fixture mirrors tests/test_store.py
    return RunStore(mongo_db)


async def test_create_and_get_run(store):
    run = await store.create_run("r1", "generate-sprite", {"description": "knight"})
    assert run.status == "running" and run.room_id == "r1" and run.steps == []
    again = await store.get_run(run.id)
    assert again.skill_name == "generate-sprite"


async def test_append_step_token_and_complete(store):
    run = await store.create_run("r1", "generate-sprite", {})
    await store.append_step(run.id, RunStep(index=0, type="final", content=""))
    await store.append_step_token(run.id, 0, "Hel")
    await store.append_step_token(run.id, 0, "lo")
    await store.complete_step(run.id, 0, "complete")
    done = await store.complete_run(run.id, "completed")
    assert done.status == "completed" and done.completed_at is not None
    assert done.steps[0].content == "Hello" and done.steps[0].status == "complete"
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_run_store.py -v`
Expected: FAIL (`ModuleNotFoundError: app.runs`).

- [ ] **Step 3: Implement `app/runs.py`**

```python
import uuid
from datetime import datetime, timezone
from typing import Literal

from app.models import _WireModel


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RunStep(_WireModel):
    index: int
    type: Literal["thinking", "tool_call", "tool_result", "final"]
    tool_name: str | None = None
    content: str = ""
    status: Literal["running", "complete", "error"] = "running"


class Run(_WireModel):
    id: str
    room_id: str
    skill_name: str
    args: dict
    status: Literal["running", "completed", "error"] = "running"
    steps: list[RunStep] = []
    created_at: datetime
    completed_at: datetime | None = None


def run_wire(run: Run) -> dict:
    return run.model_dump(by_alias=True, mode="json")


def _from_doc(doc: dict) -> Run:
    return Run(
        id=doc["_id"],
        room_id=doc["room_id"],
        skill_name=doc["skill_name"],
        args=doc.get("args", {}),
        status=doc["status"],
        steps=[RunStep(**s) for s in doc.get("steps", [])],
        created_at=doc["created_at"],
        completed_at=doc.get("completed_at"),
    )


class RunStore:
    def __init__(self, db):
        self._runs = db["runs"]

    async def create_run(self, room_id: str, skill_name: str, args: dict) -> Run:
        doc = {
            "_id": str(uuid.uuid4()),
            "room_id": room_id,
            "skill_name": skill_name,
            "args": args,
            "status": "running",
            "steps": [],
            "created_at": _now(),
            "completed_at": None,
        }
        await self._runs.insert_one(doc)
        return _from_doc(doc)

    async def get_run(self, run_id: str) -> Run | None:
        doc = await self._runs.find_one({"_id": run_id})
        return _from_doc(doc) if doc else None

    async def append_step(self, run_id: str, step: RunStep) -> Run:
        await self._runs.update_one(
            {"_id": run_id}, {"$push": {"steps": step.model_dump()}}
        )
        return await self.get_run(run_id)

    async def append_step_token(self, run_id: str, index: int, delta: str) -> None:
        run = await self.get_run(run_id)
        content = run.steps[index].content + delta
        await self._runs.update_one(
            {"_id": run_id}, {"$set": {f"steps.{index}.content": content}}
        )

    async def complete_step(self, run_id, index, status, content=None) -> None:
        update = {f"steps.{index}.status": status}
        if content is not None:
            update[f"steps.{index}.content"] = content
        await self._runs.update_one({"_id": run_id}, {"$set": update})

    async def complete_run(self, run_id: str, status: str) -> Run:
        await self._runs.update_one(
            {"_id": run_id},
            {"$set": {"status": status, "completed_at": _now()}},
        )
        return await self.get_run(run_id)
```

- [ ] **Step 4: Run — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_run_store.py -v`
Expected: PASS (2 tests). If `_WireModel` is not exported from `app.models`, change its definition there to be importable (it already is module-level).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/runs.py studio/backend/tests/test_run_store.py
git commit -m "feat(studio): Run model + RunStore (Mongo)"
```

---

## Task 3: generate_asset tool + ToolFactory

**Files:**

- Create: `studio/backend/app/agent_tools.py`
- Test: `studio/backend/tests/test_agent_tools.py`

**Interfaces:**

- Produces:
  - `@dataclass class ToolContext: room_id: str; game_id: str; asset_store; asset_hub`
  - `class ToolFactory:`
    - `def __init__(self, asset_store, asset_hub)`
    - `def known_tool_names(self) -> set[str]` → `{"generate_asset"}`
    - `def build(self, allowlist: list[str], ctx: ToolContext) -> list[BaseTool]` — returns only allowlisted tools, each bound to `ctx`.
  - The `generate_asset` tool: async, signature `(description: str, style: str = "") -> str`, returns a human-readable result string containing the new asset id; side effect: an asset is created + generated + attached to `ctx.game_id`.
- Consumes: `AssetStore` (`create_asset`, `add_generation`, `set_status`), `AssetHub.request_generation(game_id, asset_id)` from Task-0 codebase.

**Note on awaiting generation:** `AssetHub.request_generation` is fire-and-forget (queues + `create_task`). For the tool we need to _await completion_. Add a small awaitable to `AssetHub`: `async def generate_and_wait(self, game_id, asset_id) -> None` that runs `_run` inline (reusing existing `_run`) and returns when done. Implement it in this task (modify `assets/hub.py`) with a unit test.

- [ ] **Step 1: Write failing test for `generate_and_wait`** in `studio/backend/tests/test_asset_hub.py` (append):

```python
async def test_generate_and_wait_completes_inline(asset_hub_with_replay):
    hub, store = asset_hub_with_replay  # existing fixture pattern in this test file
    asset = await store.create_asset("g1", "spr", "a knight", 512, 512, "schnell-transparent")
    await hub.generate_and_wait("g1", asset.id)
    done = await store.get_asset(asset.id)
    assert done.status == "done" and len(done.generations) == 1
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_asset_hub.py -k generate_and_wait -v`
Expected: FAIL (`AttributeError: generate_and_wait`).

- [ ] **Step 3: Implement `generate_and_wait`** in `studio/backend/app/assets/hub.py` — factor the body of `_run` so it can be awaited directly:

```python
    async def generate_and_wait(self, game_id: str, asset_id: str) -> None:
        await self._run(game_id, asset_id)
```

(If `_run` currently assumes queue/lock bookkeeping, keep that bookkeeping in `_drain` and ensure `_run` itself is self-contained generation — adjust only if the test reveals coupling.)

- [ ] **Step 4: Run — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_asset_hub.py -k generate_and_wait -v`
Expected: PASS.

- [ ] **Step 5: Write failing test for the tool**

`studio/backend/tests/test_agent_tools.py`:

```python
from app.agent_tools import ToolFactory, ToolContext


class FakeHub:
    def __init__(self, store):
        self._store = store
        self.calls = []

    async def generate_and_wait(self, game_id, asset_id):
        self.calls.append((game_id, asset_id))
        await self._store.add_generation(asset_id, "gen1", 7, "g1/asset/gen1.png")


async def test_known_tool_names():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert f.known_tool_names() == {"generate_asset"}


async def test_generate_asset_creates_and_attaches(asset_store):  # fixture from test_assets_store.py
    hub = FakeHub(asset_store)
    factory = ToolFactory(asset_store, hub)
    ctx = ToolContext(room_id="r1", game_id="g1", asset_store=asset_store, asset_hub=hub)
    tools = factory.build(["generate_asset"], ctx)
    assert [t.name for t in tools] == ["generate_asset"]
    result = await tools[0].ainvoke({"description": "a knight", "style": "pixel"})
    assets = await asset_store.list_assets("g1")
    assert len(assets) == 1 and assets[0].status == "done"
    assert assets[0].id in result and hub.calls == [("g1", assets[0].id)]


async def test_build_filters_to_allowlist(asset_store):
    factory = ToolFactory(asset_store, FakeHub(asset_store))
    ctx = ToolContext("r1", "g1", asset_store, FakeHub(asset_store))
    assert factory.build([], ctx) == []
```

- [ ] **Step 6: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_agent_tools.py -v`
Expected: FAIL (`ModuleNotFoundError: app.agent_tools`).

- [ ] **Step 7: Implement `app/agent_tools.py`**

```python
from dataclasses import dataclass

from langchain_core.tools import BaseTool, StructuredTool


@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object


def build_generate_asset_tool(ctx: ToolContext) -> BaseTool:
    async def generate_asset(description: str, style: str = "") -> str:
        prompt = description if not style else f"{description}, {style} style"
        asset = await ctx.asset_store.create_asset(
            ctx.game_id, description[:40] or "sprite", prompt, 512, 512, "schnell-transparent"
        )
        await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
        return f"Generated sprite '{asset.name}' (asset {asset.id}) and added it to the Asset Board."

    return StructuredTool.from_function(
        coroutine=generate_asset,
        name="generate_asset",
        description="Generate a game sprite image from a text description and add it to the Asset Board.",
    )


class ToolFactory:
    _BUILDERS = {"generate_asset": build_generate_asset_tool}

    def __init__(self, asset_store, asset_hub):
        self._asset_store = asset_store
        self._asset_hub = asset_hub

    def known_tool_names(self) -> set[str]:
        return set(self._BUILDERS)

    def build(self, allowlist, ctx: ToolContext) -> list[BaseTool]:
        return [self._BUILDERS[name](ctx) for name in allowlist if name in self._BUILDERS]
```

- [ ] **Step 8: Run — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_agent_tools.py tests/test_asset_hub.py -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/assets/hub.py \
  studio/backend/tests/test_agent_tools.py studio/backend/tests/test_asset_hub.py
git commit -m "feat(studio): generate_asset LangChain tool + ToolFactory + awaitable generation"
```

---

## Task 4: Chat-model seam + ReplayToolCallingChatModel + cassette schema

**Files:**

- Modify: `studio/backend/app/providers.py`
- Modify: `studio/backend/app/replay/cassette.py`
- Test: `studio/backend/tests/test_providers.py` (append), `studio/backend/tests/test_replay.py` (append)

**Interfaces:**

- Produces:
  - `def build_chat_model(settings: Settings, model: str) -> BaseChatModel`
  - `class ReplayToolCallingChatModel(BaseChatModel)` — deterministic; emits a recorded `AIMessage(tool_calls=[...])` then, on the follow-up invocation (after a `ToolMessage`), a recorded text answer. Driven by a **run cassette**.
  - `def load_run_cassette(fixtures_dir: Path) -> dict` in `cassette.py`.
- Consumes: `settings.provider_mode`, existing `DEFAULT_FIXTURES_DIR`.

**Run cassette schema** (`tests/fixtures/replay/run/default.json`):

```json
{
  "tool_calls": [{ "name": "generate_asset", "args": { "description": "a knight", "style": "pixel" } }],
  "final": ["All set — ", "I generated a knight sprite."]
}
```

Semantics: first model invocation (no prior `ToolMessage` in input) → return `AIMessage` with those `tool_calls` and empty content. A subsequent invocation (a `ToolMessage` is present) → stream the `final` chunks as the answer with no tool calls. This deterministically drives one tool round-trip.

- [ ] **Step 1: Add `load_run_cassette`** to `studio/backend/app/replay/cassette.py`:

```python
import json


def load_run_cassette(fixtures_dir: Path) -> dict:
    path = Path(fixtures_dir) / "run" / "default.json"
    if not path.exists():
        return {"tool_calls": [], "final": ["ok"]}
    return json.loads(path.read_text(encoding="utf-8"))
```

- [ ] **Step 2: Write the seed cassette**

`studio/backend/tests/fixtures/replay/run/default.json`:

```json
{
  "tool_calls": [{ "name": "generate_asset", "args": { "description": "a knight", "style": "pixel" } }],
  "final": ["All set — ", "I generated a knight sprite and added it to the Asset Board."]
}
```

- [ ] **Step 3: Write failing test**

`studio/backend/tests/test_providers.py` (append):

```python
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.providers import ReplayToolCallingChatModel


def _cassette():
    return {
        "tool_calls": [{"name": "generate_asset", "args": {"description": "a knight"}}],
        "final": ["Done ", "now."],
    }


async def test_replay_model_first_turn_emits_tool_call():
    m = ReplayToolCallingChatModel(cassette=_cassette())
    res = await m.ainvoke([HumanMessage("make a knight")])
    assert res.tool_calls and res.tool_calls[0]["name"] == "generate_asset"
    assert res.tool_calls[0]["args"] == {"description": "a knight"}


async def test_replay_model_after_tool_emits_final_text():
    m = ReplayToolCallingChatModel(cassette=_cassette())
    msgs = [
        HumanMessage("make a knight"),
        AIMessage("", tool_calls=[{"name": "generate_asset", "args": {"description": "a knight"}, "id": "c1"}]),
        ToolMessage("Generated.", tool_call_id="c1"),
    ]
    res = await m.ainvoke(msgs)
    assert res.tool_calls == [] and res.content == "Done now."
```

- [ ] **Step 4: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_providers.py -k replay_model -v`
Expected: FAIL (`ImportError: ReplayToolCallingChatModel`).

- [ ] **Step 5: Implement in `studio/backend/app/providers.py`** (append; keep existing `LLMProvider`/`build_provider` intact for the not-yet-migrated plain-chat path):

```python
from typing import Any, Optional

from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult


class ReplayToolCallingChatModel(BaseChatModel):
    cassette: dict

    @property
    def _llm_type(self) -> str:
        return "replay-tool-calling"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        raise NotImplementedError("async only")

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Optional[AsyncCallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        has_tool_result = any(isinstance(m, ToolMessage) for m in messages)
        if not has_tool_result and self.cassette.get("tool_calls"):
            calls = [
                {"name": c["name"], "args": c["args"], "id": f"call_{i}"}
                for i, c in enumerate(self.cassette["tool_calls"])
            ]
            msg = AIMessage(content="", tool_calls=calls)
        else:
            msg = AIMessage(content="".join(self.cassette.get("final", ["ok"])))
        return ChatResult(generations=[ChatGeneration(message=msg)])


def build_chat_model(settings: "Settings", model: str) -> BaseChatModel:
    if settings.provider_mode == "replay":
        from app.replay.cassette import DEFAULT_FIXTURES_DIR, load_run_cassette

        return ReplayToolCallingChatModel(cassette=load_run_cassette(DEFAULT_FIXTURES_DIR))
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=model,
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        streaming=True,
    )
```

(`bind_tools` is provided by `BaseChatModel`’s default; `create_react_agent` will call it. The replay model ignores bound tools and replays the scripted calls — deterministic by design.)

- [ ] **Step 6: Run — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_providers.py -k replay_model -v`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/providers.py studio/backend/app/replay/cassette.py \
  studio/backend/tests/fixtures/replay/run/default.json studio/backend/tests/test_providers.py
git commit -m "feat(studio): tool-capable chat-model seam + deterministic replay tool-calling model"
```

---

## Task 5: TurnRunner (LangGraph agent + RunEvent mapping)

**Files:**

- Create: `studio/backend/app/turn_runner.py`
- Modify: `studio/backend/pyproject.toml` (add `langgraph`)
- Test: `studio/backend/tests/test_turn_runner.py`

**Interfaces:**

- Produces:
  - RunEvent dataclasses: `StepStarted(index, type, tool_name=None)`, `StepToken(index, delta)`, `StepCompleted(index, status, content, result=None)`, `RunFinished(status)`.
  - `class TurnRunner:`
    - `def __init__(self, chat_model_factory, tool_factory)` where `chat_model_factory(model) -> BaseChatModel`.
    - `async def run(self, *, messages: list[dict], model: str, skill, args: dict, ctx: ToolContext) -> AsyncIterator[RunEvent]` — builds `create_react_agent`, streams events, yields ordered RunEvents. `messages` are `[{role, content}]` turns; `skill` is a `SkillSpec | None` (None → no tools, system prompt base only).
- Consumes: `ToolFactory.build`, `SkillSpec.body`/`tools`, `build_chat_model`.

**Event-mapping contract (assert this ordering in tests):** model text before any tool call opens a `final`/`thinking` text step that streams tokens; a tool call closes the open text step and emits `tool_call` (StepStarted+StepCompleted with args) then `tool_result` (StepCompleted with the tool's return); trailing model text opens a `final` step. For slice 1 the replay model emits: tool_call → tool_result → final text. So expected RunEvent order is: `StepStarted(0, tool_call, generate_asset)`, `StepCompleted(0, complete, <args json>)`, `StepStarted(1, tool_result, generate_asset)`, `StepCompleted(1, complete, <tool return>)`, `StepStarted(2, final)`, `StepToken(2, ...)`×N, `StepCompleted(2, complete, <full text>)`, `RunFinished(completed)`.

- [ ] **Step 1: Add `langgraph`** to `studio/backend/pyproject.toml` dependencies:

```
langgraph>=0.2
```

Run: `cd studio/backend && uv sync`

- [ ] **Step 2: Write failing test**

`studio/backend/tests/test_turn_runner.py`:

```python
from app.providers import ReplayToolCallingChatModel
from app.turn_runner import TurnRunner, StepStarted, StepCompleted, StepToken, RunFinished
from app.agent_tools import ToolContext


class FakeStore:
    async def create_asset(self, *a, **k):
        class A: id = "asset1"; name = "knight"
        return A()
    async def list_assets(self, g): return []


class FakeHub:
    async def generate_and_wait(self, g, a): return None


class OneToolFactory:
    def known_tool_names(self): return {"generate_asset"}
    def build(self, allowlist, ctx):
        from app.agent_tools import build_generate_asset_tool
        return [build_generate_asset_tool(ctx)] if "generate_asset" in allowlist else []


class FakeSkill:
    body = "Use generate_asset once."
    tools = ["generate_asset"]


async def test_run_emits_ordered_tool_then_final():
    cassette = {
        "tool_calls": [{"name": "generate_asset", "args": {"description": "a knight"}}],
        "final": ["Done ", "now."],
    }
    runner = TurnRunner(
        chat_model_factory=lambda model: ReplayToolCallingChatModel(cassette=cassette),
        tool_factory=OneToolFactory(),
    )
    ctx = ToolContext("r1", "g1", FakeStore(), FakeHub())
    events = [
        e async for e in runner.run(
            messages=[{"role": "user", "content": "make a knight"}],
            model="x", skill=FakeSkill(), args={"description": "a knight"}, ctx=ctx,
        )
    ]
    types = [(type(e).__name__, getattr(e, "type", None)) for e in events]
    assert ("StepStarted", "tool_call") in types
    assert ("StepStarted", "tool_result") in types
    assert ("StepStarted", "final") in types
    assert isinstance(events[-1], RunFinished) and events[-1].status == "completed"
    final_text = "".join(e.delta for e in events if isinstance(e, StepToken))
    assert "Done now." in final_text
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_turn_runner.py -v`
Expected: FAIL (`ModuleNotFoundError: app.turn_runner`).

- [ ] **Step 4: Implement `app/turn_runner.py`**

```python
from dataclasses import dataclass
from typing import AsyncIterator, Optional

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.prebuilt import create_react_agent

BASE_SYSTEM = "You are a game-development assistant operating inside a studio. Be concise."


@dataclass
class StepStarted:
    index: int
    type: str
    tool_name: Optional[str] = None


@dataclass
class StepToken:
    index: int
    delta: str


@dataclass
class StepCompleted:
    index: int
    status: str
    content: str
    tool_name: Optional[str] = None


@dataclass
class RunFinished:
    status: str


RunEvent = object  # documentation alias


class TurnRunner:
    def __init__(self, chat_model_factory, tool_factory):
        self._model_factory = chat_model_factory
        self._tools = tool_factory

    async def run(self, *, messages, model, skill, args, ctx) -> AsyncIterator[RunEvent]:
        tools = self._tools.build(skill.tools, ctx) if skill else []
        system = BASE_SYSTEM + ("\n\n" + skill.body if skill else "")
        agent = create_react_agent(self._model_factory(model), tools, prompt=system)

        lc = [HumanMessage(m["content"]) for m in messages if m["role"] == "user"]
        index = 0
        text_open = False
        text_index = -1
        text_buf = ""
        status = "completed"
        try:
            async for ev in agent.astream_events({"messages": lc}, version="v2"):
                kind = ev["event"]
                if kind == "on_chat_model_stream":
                    chunk = ev["data"]["chunk"]
                    delta = getattr(chunk, "content", "") or ""
                    if not delta:
                        continue
                    if not text_open:
                        text_index = index; index += 1
                        text_open = True; text_buf = ""
                        yield StepStarted(text_index, "final")
                    text_buf += delta
                    yield StepToken(text_index, delta)
                elif kind == "on_tool_start":
                    if text_open:
                        yield StepCompleted(text_index, "complete", text_buf)
                        text_open = False
                    name = ev["name"]
                    call_index = index; index += 1
                    yield StepStarted(call_index, "tool_call", name)
                    yield StepCompleted(call_index, "complete", str(ev["data"].get("input", "")), name)
                elif kind == "on_tool_end":
                    name = ev["name"]
                    res_index = index; index += 1
                    yield StepStarted(res_index, "tool_result", name)
                    yield StepCompleted(res_index, "complete", str(ev["data"].get("output", "")), name)
            if text_open:
                yield StepCompleted(text_index, "complete", text_buf)
        except Exception:
            status = "error"
        yield RunFinished(status)
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_turn_runner.py -v`
Expected: PASS. (If `astream_events` field names differ in the installed langgraph version, adjust the `ev["data"]` keys to match — the test asserts the contract; print one `ev` to confirm shape if it fails.)

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/turn_runner.py studio/backend/pyproject.toml \
  studio/backend/uv.lock studio/backend/tests/test_turn_runner.py
git commit -m "feat(studio): TurnRunner — LangGraph agent loop mapped to ordered RunEvents"
```

---

## Task 6: RoomHub skill path (generalized queue + run\_\* events + snapshot)

**Files:**

- Modify: `studio/backend/app/room_hub.py`
- Test: `studio/backend/tests/test_room_hub.py` (append)

**Interfaces:**

- Produces on `RoomHub`:
  - `async def handle_skill_run(self, room_id, author, skill_name, args) -> None`
  - extends `active_snapshot`/`attach_subscriber` to also emit `run_snapshot` when a run is live.
  - emits server events: `run_started {roomId, run}`, `run_step_started {roomId, runId, step}`, `run_step_token {roomId, runId, stepIndex, delta}`, `run_step_completed {roomId, runId, stepIndex, status, content}`, `run_completed {roomId, runId, status}`, `run_snapshot {roomId, run}`.
- Consumes: `RunStore`, `TurnRunner`, `SkillRegistry`, `ToolFactory`, `GameStore`/room `game_id`.

**Constructor change:** `RoomHub.__init__(self, sio, store, chat_service, *, run_store=None, turn_runner=None, skills=None, tool_factory=None)` — keyword-only new deps default `None` so existing tests/constructors stay valid; the skill path requires them.

**Queue generalization:** replace `self._queues[room_id]: list[str]` (message ids) with `list[dict]` turn descriptors `{"kind": "prompt", "messageId": id}` or `{"kind": "skill", "author":…, "skillName":…, "args":…}`. `handle_prompt` pushes a `prompt` descriptor; `_drain` dispatches: `prompt` → existing `_run_generation`; `skill` → new `_run_skill`. Plain-prompt behavior is byte-for-byte unchanged (existing e2e stays green).

- [ ] **Step 1: Write failing test** with a fake sio capturing emits and a stub TurnRunner yielding a scripted RunEvent sequence:

`studio/backend/tests/test_room_hub.py` (append):

```python
from app.turn_runner import StepStarted, StepToken, StepCompleted, RunFinished


class FakeSio:
    def __init__(self): self.events = []
    async def emit(self, event, data=None, room=None, to=None, skip_sid=None):
        self.events.append((event, data))
    async def enter_room(self, sid, room): pass


class StubRunner:
    async def run(self, **kw):
        yield StepStarted(0, "tool_call", "generate_asset")
        yield StepCompleted(0, "complete", "{'description': 'knight'}", "generate_asset")
        yield StepStarted(1, "final")
        yield StepToken(1, "Done.")
        yield StepCompleted(1, "complete", "Done.")
        yield RunFinished("completed")


async def test_handle_skill_run_emits_run_events(room_hub_with_skill):
    hub, sio = room_hub_with_skill  # fixture wires StubRunner + real RunStore + a skill + a room with game_id
    await hub.handle_skill_run("r1", "alice", "generate-sprite", {"description": "knight"})
    names = [e for (e, _) in sio.events]
    assert names[0] == "run_started"
    assert "run_step_started" in names and "run_step_token" in names
    assert names[-1] == "run_completed"
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_room_hub.py -k skill -v`
Expected: FAIL (`AttributeError: handle_skill_run`).

- [ ] **Step 3: Implement** — add keyword deps to `__init__`, add a `self._active_runs: dict[str, dict] = {}`, generalize the queue, and add:

```python
    async def handle_skill_run(self, room_id, author, skill_name, args):
        spec = self._skills.get(skill_name)
        if spec is None:
            await self._sio.emit("error", {"roomId": room_id, "message": f"unknown skill {skill_name}"}, room=room_id)
            return
        try:
            clean = self._skills.validate_args(spec, args)
        except Exception as e:
            await self._sio.emit("error", {"roomId": room_id, "message": str(e)}, room=room_id)
            return
        async with self._lock(room_id):
            self._queues.setdefault(room_id, []).append(
                {"kind": "skill", "author": author, "skillName": skill_name, "args": clean}
            )
            if room_id in self._busy:
                await self._emit_status(room_id, "queued")
                return
            self._busy.add(room_id)
        import asyncio
        asyncio.create_task(self._drain(room_id))

    async def _run_skill(self, room_id, descriptor):
        from app.runs import run_wire, RunStep
        from app.agent_tools import ToolContext
        room = await self._store.get_room(room_id)
        spec = self._skills.get(descriptor["skillName"])
        run = await self._run_store.create_run(room_id, spec.name, descriptor["args"])
        await self._emit_status(room_id, "generating")
        await self._sio.emit("run_started", {"roomId": room_id, "run": run_wire(run)}, room=room_id)
        async with self._lock(room_id):
            self._active_runs[room_id] = {"runId": run.id}

        history = await self._store.list_messages(room_id)
        messages = [{"role": m.role, "content": m.content} for m in history]
        ctx = ToolContext(room_id, room.game_id, self._asset_store, self._asset_hub)
        status = "completed"
        try:
            async for ev in self._runner.run(
                messages=messages, model=room.model, skill=spec, args=descriptor["args"], ctx=ctx
            ):
                await self._project_run_event(room_id, run.id, ev)
                if type(ev).__name__ == "RunFinished":
                    status = ev.status
        finally:
            async with self._lock(room_id):
                self._active_runs.pop(room_id, None)
        await self._run_store.complete_run(run.id, status)
        await self._sio.emit("run_completed", {"roomId": room_id, "runId": run.id, "status": status}, room=room_id)

    async def _project_run_event(self, room_id, run_id, ev):
        from app.runs import RunStep
        name = type(ev).__name__
        if name == "StepStarted":
            await self._run_store.append_step(run_id, RunStep(index=ev.index, type=ev.type, tool_name=ev.tool_name))
            await self._sio.emit("run_step_started", {"roomId": room_id, "runId": run_id,
                "step": {"index": ev.index, "type": ev.type, "toolName": ev.tool_name, "content": "", "status": "running"}}, room=room_id)
        elif name == "StepToken":
            await self._run_store.append_step_token(run_id, ev.index, ev.delta)
            await self._sio.emit("run_step_token", {"roomId": room_id, "runId": run_id, "stepIndex": ev.index, "delta": ev.delta}, room=room_id)
        elif name == "StepCompleted":
            await self._run_store.complete_step(run_id, ev.index, ev.status, ev.content)
            await self._sio.emit("run_step_completed", {"roomId": room_id, "runId": run_id, "stepIndex": ev.index, "status": ev.status, "content": ev.content}, room=room_id)
```

In `_drain`, change the dequeue to read the descriptor and dispatch:

```python
                descriptor = queue.pop(0)
            try:
                if descriptor["kind"] == "skill":
                    await self._run_skill(room_id, descriptor)
                else:
                    await self._run_generation(room_id)
```

And in `handle_prompt`, push `{"kind": "prompt", "messageId": user_msg.id}` instead of the bare id. Extend `attach_subscriber` to also emit a `run_snapshot` when `self._active_runs.get(room_id)` is set (fetch the run via `self._run_store.get_run` and emit `{"roomId", "run": run_wire(run)}`).

- [ ] **Step 4: Run — expect PASS** (and re-run the whole hub suite to prove plain-chat is untouched)

Run: `cd studio/backend && uv run pytest tests/test_room_hub.py -v`
Expected: PASS — new skill tests pass and **all existing prompt/queue/snapshot tests stay green**.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/room_hub.py studio/backend/tests/test_room_hub.py
git commit -m "feat(studio): RoomHub skill turns — run_* events, persistence, run_snapshot resume"
```

---

## Task 7: Socket `run_skill` + REST `GET /skills` + main.py wiring

**Files:**

- Modify: `studio/backend/app/sockets.py`, `studio/backend/app/rest.py`, `studio/backend/app/main.py`
- Test: `studio/backend/tests/test_rest.py` (append), `studio/backend/tests/test_sockets.py` (append if present, else cover in e2e Task 8)

**Interfaces:**

- Produces: client→server `run_skill {roomId, skillName, args}`; REST `GET /skills → [{name, description, args}]`.
- Consumes: `request.app.state.skill_registry`, `hub.handle_skill_run`.

- [ ] **Step 1: Write failing REST test**

`studio/backend/tests/test_rest.py` (append, mirroring the existing `GET /models` test + app fixture):

```python
def test_get_skills_lists_registered(client):  # client fixture builds the app (see existing tests)
    res = client.get("/skills")
    assert res.status_code == 200
    names = [s["name"] for s in res.json()]
    assert "generate-sprite" in names
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/backend && uv run pytest tests/test_rest.py -k skills -v`
Expected: FAIL (404).

- [ ] **Step 3: Implement the route** in `studio/backend/app/rest.py`:

```python
@router.get("/skills")
async def list_skills(request: Request) -> list[dict]:
    return request.app.state.skill_registry.list_skills()
```

- [ ] **Step 4: Add the socket handler** in `studio/backend/app/sockets.py` (inside `register_socket_handlers`):

```python
    @sio.on("run_skill")
    async def run_skill(sid, data):
        session = await sio.get_session(sid)
        await hub.handle_skill_run(
            data["roomId"], session["displayName"], data["skillName"], data.get("args", {})
        )
```

- [ ] **Step 5: Wire in `studio/backend/app/main.py`** — in `build(settings)`, after `chat_service` and the asset subsystem are constructed:

```python
    from app.agent_tools import ToolFactory
    from app.runs import RunStore
    from app.skills import SkillRegistry
    from app.turn_runner import TurnRunner
    from app.providers import build_chat_model

    run_store = RunStore(mongo[settings.mongo_db])
    tool_factory = ToolFactory(asset_store, asset_hub)
    skill_registry = SkillRegistry(Path(settings.skills_dir), tool_factory.known_tool_names())
    skill_registry.load()
    turn_runner = TurnRunner(lambda model: build_chat_model(settings, model), tool_factory)

    fastapi_app.state.skill_registry = skill_registry
```

Update the `RoomHub(...)` construction to pass the new keyword deps:

```python
    hub = RoomHub(
        sio, store, chat_service,
        run_store=run_store, turn_runner=turn_runner,
        skills=skill_registry, tool_factory=tool_factory,
    )
```

(Also give `RoomHub` references to `asset_store`/`asset_hub` it uses in `_run_skill` — pass them as keyword deps too, or attach via the existing `asset_hub`; keep them on `self._asset_store`/`self._asset_hub`.)

- [ ] **Step 6: Run — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_rest.py -k skills -v`
Expected: PASS. Then full backend unit suite: `cd studio/backend && uv run pytest -q` → all green.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/sockets.py studio/backend/app/rest.py studio/backend/app/main.py \
  studio/backend/tests/test_rest.py
git commit -m "feat(studio): run_skill socket event + GET /skills + agent wiring in main"
```

---

## Task 8: Authoritative realtime e2e + record-fixtures + committed guard

**Files:**

- Create: `studio/backend/tests/e2e/test_skill_runs.py`
- Modify: `studio/backend/app/replay/record.py`, `studio/backend/tests/test_fixtures_committed.py`

**Interfaces:** Consumes the running ASGI app + two Socket.IO clients (mirror `tests/e2e/test_realtime.py`).

- [ ] **Step 1: Write the authoritative e2e** (`tests/e2e/test_skill_runs.py`) — two clients join one room; client A emits `run_skill`; **both** receive ordered `run_started → run_step_started(tool_call) → run_step_completed(tool_result) → run_started(final)/tokens → run_completed`, and an asset is attached to the room's game. Add a serialization case (two concurrent `run_skill`s do not overlap) and a mid-run join receiving `run_snapshot`. Model the structure exactly on the existing two-client realtime test in `tests/e2e/test_realtime.py` (same fixtures, same `socketio.AsyncSimpleClient` usage).

```python
async def test_two_clients_watch_a_skill_run(e2e_app):  # fixture mirrors test_realtime.py
    a = await connect_client(e2e_app, "alice")
    b = await connect_client(e2e_app, "bob")
    room = await create_room(e2e_app, game=True)
    await a.emit("join_room", {"roomId": room}); await b.emit("join_room", {"roomId": room})
    await a.emit("run_skill", {"roomId": room, "skillName": "generate-sprite", "args": {"description": "a knight"}})
    a_events = await collect_until(a, "run_completed")
    b_events = await collect_until(b, "run_completed")
    assert [e for e, _ in a_events] == [e for e, _ in b_events]
    assert "run_step_started" in [e for e, _ in a_events]
    assets = await list_assets(e2e_app, room)
    assert len(assets) == 1 and assets[0]["status"] == "done"
```

- [ ] **Step 2: Run under replay — expect PASS**

Run: `cd studio/backend && PROVIDER_MODE=replay uv run pytest tests/e2e/test_skill_runs.py -v`
Expected: PASS (deterministic via the run cassette + replay comfy).

- [ ] **Step 3: Extend `record.py`** with `_record_run(settings, out)` that, under `PROVIDER_MODE=live`, runs the real agent once over the `generate-sprite` skill and captures `{tool_calls, final}` into `tests/fixtures/replay/run/default.json`. Wire it into the module's `main()` alongside `_record_llm`/`_record_comfy`.

- [ ] **Step 4: Guard the run cassette** in `tests/test_fixtures_committed.py`:

```python
def test_run_cassette_is_real():
    from app.replay.cassette import load_run_cassette, DEFAULT_FIXTURES_DIR
    cas = load_run_cassette(DEFAULT_FIXTURES_DIR)
    assert cas["tool_calls"] and "".join(cas["final"]).strip()
```

- [ ] **Step 5: Run the committed guard — expect PASS**

Run: `cd studio/backend && uv run pytest tests/test_fixtures_committed.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/tests/e2e/test_skill_runs.py studio/backend/app/replay/record.py \
  studio/backend/tests/test_fixtures_committed.py
git commit -m "test(studio): authoritative skill-run realtime e2e + run cassette record/guard"
```

---

## Task 9: Frontend state + run reducers

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/state.ts`
- Modify: `studio/frontend/src/plugins/llm-chat/reducers.ts`
- Test: `studio/frontend/src/plugins/llm-chat/reducers.spec.ts` (append)

**Interfaces:**

- Produces:
  - `interface ISkill { name: string; description: string; args: { name: string; type: 'string'|'number'|'boolean'; required: boolean }[] }`
  - `interface IRunStep { index: number; type: 'thinking'|'tool_call'|'tool_result'|'final'; toolName: string|null; content: string; status: 'running'|'complete'|'error' }`
  - `interface IRun { id: string; roomId: string; skillName: string; status: 'running'|'completed'|'error'; steps: IRunStep[] }`
  - slice fields: `skills: ISkill[]; skillsStatus: 'idle'|'loading'|'error'; runs: IRun[]; activeRunId: string|null`
  - reducers: `startRun(runs, run)`, `startStep(runs, runId, step)`, `appendStepToken(runs, runId, index, delta)`, `completeStep(runs, runId, index, status, content)`, `completeRun(runs, runId, status)`, `applyRunSnapshot(runs, run)`. All pure/immutable like existing reducers.

- [ ] **Step 1: Add interfaces + slice fields** to `state.ts` (extend `ILlmChatState` and `makeInitialState` with `skills: [], skillsStatus: 'idle', runs: [], activeRunId: null`).

- [ ] **Step 2: Write failing reducer tests** in `reducers.spec.ts` (append):

```typescript
import { startRun, startStep, appendStepToken, completeStep, completeRun } from './reducers';
import type { IRun } from './state';

const run = (over: Partial<IRun> = {}): IRun => ({ id: 'run1', roomId: 'r1', skillName: 'generate-sprite', status: 'running', steps: [], ...over });

it('startRun adds a run; startStep + appendStepToken build a streaming step', () => {
  let runs = startRun([], run());
  runs = startStep(runs, 'run1', { index: 0, type: 'final', toolName: null, content: '', status: 'running' });
  runs = appendStepToken(runs, 'run1', 0, 'He');
  runs = appendStepToken(runs, 'run1', 0, 'llo');
  expect(runs[0].steps[0].content).toBe('Hello');
});

it('completeStep and completeRun set terminal status without mutating input', () => {
  const base = startStep(startRun([], run()), 'run1', { index: 0, type: 'final', toolName: null, content: 'x', status: 'running' });
  const out = completeRun(completeStep(base, 'run1', 0, 'complete', 'x'), 'run1', 'completed');
  expect(out[0].status).toBe('completed');
  expect(out[0].steps[0].status).toBe('complete');
  expect(base[0].status).toBe('running'); // input untouched
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/reducers.spec.ts`
Expected: FAIL (exports missing).

- [ ] **Step 4: Implement the reducers** in `reducers.ts` (pure, immutable — mirror `appendToken`/`completeMessage`):

```typescript
import type { IRun, IRunStep } from './state';

export function startRun(runs: IRun[], run: IRun): IRun[] {
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx === -1) return [...runs, run];
  const next = runs.slice();
  next[idx] = run;
  return next;
}

function patchRun(runs: IRun[], runId: string, fn: (r: IRun) => IRun): IRun[] {
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx === -1) return runs;
  const next = runs.slice();
  next[idx] = fn(next[idx]);
  return next;
}

export function startStep(runs: IRun[], runId: string, step: IRunStep): IRun[] {
  return patchRun(runs, runId, (r) => ({ ...r, steps: [...r.steps, step] }));
}

export function appendStepToken(runs: IRun[], runId: string, index: number, delta: string): IRun[] {
  return patchRun(runs, runId, (r) => ({
    ...r,
    steps: r.steps.map((s) => (s.index === index ? { ...s, content: s.content + delta } : s)),
  }));
}

export function completeStep(runs: IRun[], runId: string, index: number, status: IRunStep['status'], content: string): IRun[] {
  return patchRun(runs, runId, (r) => ({
    ...r,
    steps: r.steps.map((s) => (s.index === index ? { ...s, status, content } : s)),
  }));
}

export function completeRun(runs: IRun[], runId: string, status: IRun['status']): IRun[] {
  return patchRun(runs, runId, (r) => ({ ...r, status }));
}

export function applyRunSnapshot(runs: IRun[], run: IRun): IRun[] {
  return startRun(runs, run);
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/reducers.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/reducers.ts \
  studio/frontend/src/plugins/llm-chat/reducers.spec.ts
git commit -m "feat(frontend): run-timeline state + pure run reducers"
```

---

## Task 10: socketClient run\_\* handlers + runSkill emit + action

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/socketClient.ts`, `actions.ts`
- Test: `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts` (append), `actions.spec.ts` (append)

**Interfaces:**

- Produces: inbound handlers for `run_started`, `run_step_started`, `run_step_token`, `run_step_completed`, `run_completed`, `run_snapshot` (each guarded by `isActive(roomId)`); socket emit `runSkill(roomId, skillName, args)`; action `runSkill(skillName, args)`.

- [ ] **Step 1: Write failing socket test** (`socketClient.spec.ts`, append, mirroring the `token` test idiom):

```typescript
it('run_started + run_step_token build a run in the slice', () => {
  const { sock } = connected(); // existing helper; sets activeRoomId='r1'
  sock.fire('run_started', { roomId: 'r1', run: { id: 'run1', roomId: 'r1', skillName: 'generate-sprite', status: 'running', steps: [] } });
  sock.fire('run_step_started', { roomId: 'r1', runId: 'run1', step: { index: 0, type: 'final', toolName: null, content: '', status: 'running' } });
  sock.fire('run_step_token', { roomId: 'r1', runId: 'run1', stepIndex: 0, delta: 'Hi' });
  expect(chatSlice().runs.get()[0].steps[0].content).toBe('Hi');
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/socketClient.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `socketClient.ts` `registerInboundHandlers` (mirror existing guard+reduce idiom), importing the new reducers:

```typescript
s.on('run_started', (p) => {
  const { roomId, run } = p as { roomId: string; run: IRun };
  if (!isActive(roomId)) return;
  slice().runs.set(startRun(slice().runs.get({ noproxy: true }) as IRun[], run));
  slice().activeRunId.set(run.id);
});
s.on('run_step_started', (p) => {
  const { roomId, runId, step } = p as { roomId: string; runId: string; step: IRunStep };
  if (!isActive(roomId)) return;
  slice().runs.set(startStep(slice().runs.get({ noproxy: true }) as IRun[], runId, step));
});
s.on('run_step_token', (p) => {
  const { roomId, runId, stepIndex, delta } = p as { roomId: string; runId: string; stepIndex: number; delta: string };
  if (!isActive(roomId)) return;
  slice().runs.set(appendStepToken(slice().runs.get({ noproxy: true }) as IRun[], runId, stepIndex, delta));
});
s.on('run_step_completed', (p) => {
  const { roomId, runId, stepIndex, status, content } = p as { roomId: string; runId: string; stepIndex: number; status: IRunStep['status']; content: string };
  if (!isActive(roomId)) return;
  slice().runs.set(completeStep(slice().runs.get({ noproxy: true }) as IRun[], runId, stepIndex, status, content));
});
s.on('run_completed', (p) => {
  const { roomId, runId, status } = p as { roomId: string; runId: string; status: IRun['status'] };
  if (!isActive(roomId)) return;
  slice().runs.set(completeRun(slice().runs.get({ noproxy: true }) as IRun[], runId, status));
});
s.on('run_snapshot', (p) => {
  const { roomId, run } = p as { roomId: string; run: IRun };
  if (!isActive(roomId)) return;
  slice().runs.set(applyRunSnapshot(slice().runs.get({ noproxy: true }) as IRun[], run));
});
```

Add to the emit API: `runSkill: (roomId: string, skillName: string, args: Record<string, unknown>) => emit('run_skill', { roomId, skillName, args })`.

- [ ] **Step 4: Add the action** in `actions.ts` (mirror `sendPrompt`, include in the injectable `socket` `Pick<...>` type):

```typescript
export function runSkill(skillName: string, args: Record<string, unknown>): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().runSkill(roomId, skillName, args);
}
```

- [ ] **Step 5: Write + run the action test** (`actions.spec.ts`, append):

```typescript
it('runSkill forwards to the socket for the active room', () => {
  actions.__setDeps({ socket });
  chatSlice().activeRoomId.set('r1');
  actions.runSkill('generate-sprite', { description: 'knight' });
  expect(socket.runSkill).toHaveBeenCalledWith('r1', 'generate-sprite', { description: 'knight' });
});
```

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/socketClient.spec.ts src/plugins/llm-chat/actions.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/actions.ts \
  studio/frontend/src/plugins/llm-chat/socketClient.spec.ts studio/frontend/src/plugins/llm-chat/actions.spec.ts
git commit -m "feat(frontend): run_* socket handlers + runSkill action"
```

---

## Task 11: restClient.getSkills + skill loading

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/restClient.ts`, `actions.ts` (load skills on init)
- Test: `studio/frontend/src/plugins/llm-chat/restClient.spec.ts` (append)

- [ ] **Step 1: Write failing test** (`restClient.spec.ts`, append, mirror `getModels` test):

```typescript
it('getSkills GETs /skills', async () => {
  const fetchMock = mockFetch([{ name: 'generate-sprite', description: 'd', args: [] }]);
  vi.stubGlobal('fetch', fetchMock);
  const out = await getSkills();
  expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/skills`);
  expect(out[0].name).toBe('generate-sprite');
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/restClient.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `restClient.ts`:

```typescript
import type { ISkill } from './state';
export async function getSkills(): Promise<ISkill[]> {
  return okJson<ISkill[]>(await fetch(`${BACKEND_URL}/skills`));
}
```

In `actions.ts` `initChat()`, fetch skills into the slice (set `skillsStatus` 'loading' → write `skills` → 'idle'; on throw → 'error'), mirroring how rooms/models are loaded.

- [ ] **Step 4: Run — expect PASS**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/restClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/restClient.ts studio/frontend/src/plugins/llm-chat/actions.ts \
  studio/frontend/src/plugins/llm-chat/restClient.spec.ts
git commit -m "feat(frontend): GET /skills client + load skills on init"
```

---

## Task 12: RunTimeline component (design-language cards)

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/RunTimeline.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/RunTimeline.spec.tsx`

**Interfaces:** A component subscribing to `runs` (scoped) and rendering each run's steps as cards: `tool_call`/`tool_result` → a tool card (tool name + status + content), `final`/`thinking` → streamed text. Uses only design-language tokens/classes (no raw colors). `data-testid="run-timeline"`, per-step `data-testid={`run-step-${index}`}`.

- [ ] **Step 1: Write failing render test** (`RunTimeline.spec.tsx`):

```typescript
import { render, screen } from '@testing-library/react';
import { RunTimeline } from './RunTimeline';
import { chatSlice } from './state';

it('renders tool and final steps for the active run', () => {
  chatSlice().runs.set([{ id: 'run1', roomId: 'r1', skillName: 'generate-sprite', status: 'running', steps: [
    { index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{...}', status: 'complete' },
    { index: 1, type: 'final', toolName: null, content: 'Done.', status: 'running' },
  ] }]);
  render(<RunTimeline />);
  expect(screen.getByTestId('run-timeline')).toBeInTheDocument();
  expect(screen.getByText(/generate_asset/)).toBeInTheDocument();
  expect(screen.getByText('Done.')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/RunTimeline.spec.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `RunTimeline.tsx`** — subscribe to `runs` via `llmChatHooks.usePluginState()`, render each run's steps. Use existing design-language card classes (match the surface/hairline/text-tier classes used in `ChatRoomPane.tsx`/asset cards; no raw hex). Tool steps render the tool name + a status indicator; text steps render `content`.

- [ ] **Step 4: Run — expect PASS** + verify the design-language guard test still passes.

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/RunTimeline.spec.tsx`
Then the guard: `cd studio/frontend && npx vitest run` (full) to confirm the raw-color guard is green.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/RunTimeline.tsx studio/frontend/src/plugins/llm-chat/RunTimeline.spec.tsx
git commit -m "feat(frontend): RunTimeline — streamed tool-call cards in the design language"
```

---

## Task 13: Slash-command composer + skill autocomplete

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` (append)

**Interfaces:** The composer detects a leading `/`; shows an autocomplete list of `skills` (testid `skill-autocomplete`, items `skill-option-<name>`); on submit of `/<name> key=value …`, parse into `{skillName, args}` and call `runSkill`; plain text still calls `sendPrompt`. Mount `<RunTimeline/>` above the composer (SLOT 1). Add a pure helper `parseSlashCommand(text): { skillName: string; args: Record<string,string> } | null` (exported for unit test).

- [ ] **Step 1: Write failing tests** (`ChatRoomPane.spec.tsx`, append):

```typescript
import { parseSlashCommand } from './ChatRoomPane';

it('parseSlashCommand extracts name + key=value args', () => {
  expect(parseSlashCommand('/generate-sprite description="a knight" style=pixel')).toEqual({
    skillName: 'generate-sprite', args: { description: 'a knight', style: 'pixel' },
  });
  expect(parseSlashCommand('hello world')).toBeNull();
});

it('typing "/" shows skill autocomplete', () => {
  chatSlice().skills.set([{ name: 'generate-sprite', description: 'd', args: [] }]);
  render(<ChatRoomPane />);
  fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: '/gen' } });
  expect(screen.getByTestId('skill-autocomplete')).toBeInTheDocument();
  expect(screen.getByTestId('skill-option-generate-sprite')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** — export `parseSlashCommand` (regex: `^/(\S+)\s*(.*)$`, then match `key="..."|key=value` pairs); in the composer `onChange`, when `draft.startsWith('/')` filter `skills` by prefix and render `skill-autocomplete`; in `submit`, branch on `parseSlashCommand(draft)` → `runSkill(parsed.skillName, parsed.args)` else `sendPrompt(draft)`. Mount `<RunTimeline/>` at SLOT 1. Keep all subscriptions scoped (composer keeps local `draft`).

- [ ] **Step 4: Run — expect PASS** + render-count discipline test stays green.

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
git commit -m "feat(frontend): slash-command composer + skill autocomplete + mount RunTimeline"
```

---

## Task 14: Playwright e2e (local-only)

**Files:**

- Create: `studio/frontend/e2e/skill-run.spec.ts` (match the repo's existing Playwright e2e location/config)
- Test harness: existing `just e2e` (replay backend on :8000)

**Interfaces:** Drives the real UI against a replay backend.

- [ ] **Step 1: Write the spec** — open the studio, open/create a room bound to a game, type `/generate-sprite description="a knight"`, submit, assert the `run-timeline` shows a `generate_asset` tool card and a final message, then assert the generated asset appears on the Asset Board. Add a second-browser-context assertion that a second client watching the same room sees the run. Model structure on the existing chat Playwright spec.

```typescript
test('generate-sprite skill runs end to end and lands on the Asset Board', async ({ page }) => {
  await openRoomWithGame(page);
  await page.getByTestId('chat-composer').fill('/generate-sprite description="a knight"');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('run-timeline')).toContainText('generate_asset');
  await expect(page.getByTestId('run-timeline')).toContainText(/Asset Board/i);
  await openAssetBoard(page);
  await expect(page.getByTestId('asset-card').first()).toBeVisible();
});
```

- [ ] **Step 2: Run locally** (per `always-run-e2e-before-pr`: start replay backend first, the delicate :8000 swap):

Run: `just backend-serve-replay` (in one shell), then `just e2e`
Expected: PASS for the new spec + existing specs.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/skill-run.spec.ts
git commit -m "test(studio): Playwright e2e — generate-sprite skill run to Asset Board"
```

---

## Task 15: Migrate plain chat onto TurnRunner (LAST — behind the green suite)

**Files:**

- Modify: `studio/backend/app/room_hub.py`
- Test: existing `tests/test_room_hub.py` + `tests/e2e/test_realtime.py` (must stay green — the safety net)

**Interfaces:** `_run_generation` is reimplemented to drive `TurnRunner.run(..., skill=None, args={})` and **project the RunEvent stream onto the existing `message_created`/`token`/`message_completed` events** (NOT `run_*`). Wire protocol for plain chat is unchanged; `chat_service.stream` is no longer used in the hot path.

- [ ] **Step 1: Confirm the baseline is green** (capture the safety net before touching it)

Run: `cd studio/backend && uv run pytest tests/test_room_hub.py tests/e2e/test_realtime.py -v`
Expected: PASS (record this as the contract to preserve).

- [ ] **Step 2: Reimplement `_run_generation`** to use the runner with no skill, mapping events to legacy wire events: open the assistant message as today (`add_message` + `message_created`), then for each `StepToken` emit `token` (accumulating content into `self._active[room_id]` exactly as now, preserving `stream_snapshot`), ignore tool steps (there are none with `skill=None`), and on `RunFinished` call `complete_message` + emit `message_completed`. Keep `self._active` bookkeeping identical so the existing `stream_snapshot` resume test passes unchanged.

- [ ] **Step 3: Run the safety net — expect PASS, unchanged**

Run: `cd studio/backend && uv run pytest tests/test_room_hub.py tests/e2e/test_realtime.py -v`
Expected: PASS — identical behavior. **If any test goes red and cannot be made green by mapping (not by changing the test), STOP and revert this task**: plain chat falls back to `chat_service.stream`; the shipped skill feature is unaffected (escape hatch per spec §3.2).

- [ ] **Step 4: Full backend suite + replay e2e**

Run: `cd studio/backend && uv run pytest -q` then `cd studio/backend && PROVIDER_MODE=replay uv run pytest tests/e2e -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/room_hub.py
git commit -m "refactor(studio): route plain chat through TurnRunner (unified executor), wire-compatible"
```

---

## Final: whole-branch review + PR

- [ ] Run the full frontend gate: `cd studio/frontend && npx prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
- [ ] Run the full backend suite + replay e2e (above).
- [ ] Run `just e2e` locally (replay backend) — exhaustive client validation is the source of truth.
- [ ] Use `superpowers:requesting-code-review` for a whole-branch review.
- [ ] `git push -u origin feat/agentic-skill-chat && gh pr create` (default to push + PR; `main` is protected).

---

## Self-Review (against the spec)

**Spec coverage:**

- §3.1 agentic on LangChain → Tasks 3–5 (tool, chat-model seam, LangGraph runner). ✅
- §3.2 unified executor + wire-compat + migration-last → Tasks 6 (skill path on runner) + 15 (plain-chat migration behind the suite). ✅
- §3.3 explicit `/skill` → Tasks 7 (`run_skill`) + 13 (composer). ✅
- §3.4 repo-root `skills/` git-authored → Task 1 (`skills_dir` default = repo root; `skills/generate-sprite.md`). ✅
- §3.5 frontmatter typed args + tool allowlist → Task 1 (`SkillSpec`, `validate_args`, unknown-tool fail-fast). ✅
- §3.6 structured run timeline → Tasks 2 (Run model), 6 (run\_\* events), 9/12 (state + RunTimeline). ✅
- §3.7 auto-run, no gate → Task 3 (tool runs inline, no approval). ✅
- §5.1 `build_chat_model` seam → Task 4. ✅
- §5.5 replay tool-calling + record + committed guard → Tasks 4 + 8. ✅
- §5.6 run model/events/snapshot + lock serialization → Tasks 2 + 6 + 8 (serialization/snapshot e2e). ✅
- §5.7 `generate_asset` per-run ToolContext → Task 3. ✅
- §5.8 composer + RunTimeline + I-prefix interfaces → Tasks 9–13. ✅
- §6 test ladder (pytest unit/realtime, replay parity, vitest, Playwright) → Tasks 1–14. ✅

**Placeholder scan:** No TBD/TODO; every code step carries real code. The two soft spots — exact `astream_events` field shapes (Task 5 Step 5) and the existing test-fixture helper names (`mongo_db`, `client`, `connect_client`) — are explicitly flagged to mirror named existing files, not left vague.

**Type consistency:** `RunStep`/`Run` fields, `run_*` event payload keys, and the frontend `IRun`/`IRunStep` shapes match across backend emit (Task 6) and frontend handlers/reducers (Tasks 9–10): `index`, `type`, `toolName`, `content`, `status`, `stepIndex`, `delta`, `runId`, `roomId`. `TurnRunner` RunEvent class names (`StepStarted`/`StepToken`/`StepCompleted`/`RunFinished`) are consistent between Task 5 (produced) and Task 6 (consumed via `type(ev).__name__`).
