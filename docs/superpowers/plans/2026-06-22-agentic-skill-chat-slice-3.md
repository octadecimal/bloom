# Agentic Skill Chat — Slice 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a read tool (`list_assets`) and its first destructive, human-gated tool (`delete_asset`), with the pause/approve/deny gate built on LangGraph's native `interrupt()` + checkpointer, surfaced as an approval card in the run timeline and driven end-to-end by a new `manage-assets` skill.

**Architecture:** The react agent and the single forward `astream_events` pass are reused. The gated tool calls LangGraph `interrupt()`; the runner detects the interrupt after the stream, emits an `ApprovalRequired` event, asks the human via an injected `on_approval` callback, then resumes the graph with `Command(resume=decision)` from a `MemorySaver` checkpoint. The hub provides the callback: it projects an `approval` run step, awaits a per-run `asyncio.Future` (timeout → deny), and a new `resolve_approval` socket event resolves it. The frontend renders the `approval` step as a floating-card with Approve/Deny.

**Tech Stack:** Python 3.12, FastAPI, python-socketio, LangGraph (`>=0.2`, `create_react_agent` + `interrupt`/`Command` + `MemorySaver`), LangChain, MongoDB (motor), pydantic v2; frontend React + TypeScript + Dockview + a socket client, vitest, Playwright.

## Global Constraints

- **TypeScript interfaces use the `I` prefix** (`IRunStep`, `IRun`, `IApprovalAction`) — `docs/coding-standards.md`.
- **Studio design language is authoritative** — the approval card is a floating-card surface with a single rationed accent on the destructive action; **no raw colors outside `studio/frontend/src/styles.css`** (guard test enforces this) — `docs/design-language.md`.
- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, then commit.
- **Test/real parity is mandatory** — no new provider surface; the gate adds **no model invocation** (it sits between existing graph steps), so the replay prompt sequence is unchanged. Replay fixtures are recorded-real-shaped and committed; the committed-fixtures guard (`tests/test_fixtures_committed.py`) must stay green.
- **Browser e2e (Playwright) is NOT run in CI** — run locally via `just e2e` (replay backend on :8000). Unit + non-browser suites are CI-affordable.
- **Semantic commits** (`feat`/`test`/`docs`/...), imperative mood, ~50-char subject — `AGENTS.md`.
- **Backend runs via `uv`** from `studio/backend` (PowerShell, PATH refreshed) — `bloom-backend-toolchain`. Run pytest with `uv run pytest`.
- **Skills stay git-only/PR-reviewed** — `manage-assets.md` is a repo artifact under `skills/`.

## Reference map (exact paths the tasks touch)

Backend (`studio/backend/`):
- `app/agent_tools.py` — `ToolContext`, `build_generate_asset_tool`, `ToolFactory._BUILDERS`.
- `app/turn_runner.py` — `TurnRunner.run`, `StepStarted/StepToken/StepCompleted/RunFinished`.
- `app/room_hub.py` — `_run_skill`, `_project_run_event`, `attach_subscriber`, `_emit_status`.
- `app/sockets.py` — `register_socket_handlers` (`run_skill`, etc.).
- `app/runs.py` — `RunStep.type` Literal.
- `app/providers.py` — `ReplayToolCallingChatModel.bind_tools/_agenerate/_astream`.
- `app/assets/store.py` — `AssetStore.list_assets/get_asset/delete_asset`.
- `app/assets/hub.py` — `AssetHub` (`asset_completed` emit pattern at line 91).
- `app/skills.py` — `SkillRegistry` (loads `skills/*.md`, unknown-tool check).
- Tests: `tests/test_agent_tools.py`, `tests/test_turn_runner.py`, `tests/test_room_hub.py`, `tests/test_providers.py`, `tests/test_run_store.py`, `tests/test_skills.py`, `tests/test_asset_hub.py`, `tests/e2e/test_skill_runs.py`.
- Fixtures: `tests/fixtures/replay/run/default.json`.

Frontend (`studio/frontend/src/plugins/`):
- `llm-chat/state.ts` — `IRunStep` (line 47), `IRun` (line 55), `ILlmChatState.runs`.
- `llm-chat/reducers.ts` — `startStep/appendStepToken/completeStep/...`.
- `llm-chat/socketClient.ts` — inbound handlers (32–117), `emit` helper (150), `runSkill` (161).
- `llm-chat/actions.ts` — `runSkill` action (123).
- `llm-chat/RunTimeline.tsx` — `RunStepCard` dispatch on `step.type` (11–40).
- `assets/socketClient.ts` — asset board inbound handlers (20–50).
- `assets/reducers.ts` — `upsertAsset`.
- `assets/state.ts` — `IAsset`, `assets: IAsset[]`.

Skill: `skills/manage-assets.md` (new). Repo-root `skills/` is the registry source.

---

### Task 1: `list_assets` read tool (ungated)

**Files:**
- Modify: `studio/backend/app/agent_tools.py`
- Test: `studio/backend/tests/test_agent_tools.py`

**Interfaces:**
- Consumes: `ToolContext(room_id, game_id, asset_store, asset_hub)`; `AssetStore.list_assets(game_id) -> list[Asset]` (each `Asset` has `.id`, `.name`, `.category`).
- Produces: `build_list_assets_tool(ctx) -> BaseTool` named `list_assets`; `ToolFactory._BUILDERS["list_assets"]`.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_agent_tools.py`:

```python
import pytest

from app.agent_tools import build_list_assets_tool, ToolContext


class _Asset:
    def __init__(self, id, name, category):
        self.id, self.name, self.category = id, name, category


class _ListStore:
    def __init__(self, assets):
        self._assets = assets
    async def list_assets(self, game_id):
        assert game_id == "g1"
        return self._assets


@pytest.mark.asyncio
async def test_list_assets_returns_id_name_category_summary():
    store = _ListStore([_Asset("a1", "knight", "sprite"), _Asset("a2", "sky", None)])
    tool = build_list_assets_tool(ToolContext("r1", "g1", store, None))
    out = await tool.ainvoke({})
    assert "a1" in out and "knight" in out and "sprite" in out
    assert "a2" in out and "sky" in out
```

- [ ] **Step 2: Run test to verify it fails**

Run (PowerShell, from `studio/backend`): `uv run pytest tests/test_agent_tools.py::test_list_assets_returns_id_name_category_summary -v`
Expected: FAIL — `ImportError: cannot import name 'build_list_assets_tool'`.

- [ ] **Step 3: Write minimal implementation**

In `studio/backend/app/agent_tools.py`, add after `build_generate_asset_tool`:

```python
def build_list_assets_tool(ctx: ToolContext) -> BaseTool:
    async def list_assets() -> str:
        assets = await ctx.asset_store.list_assets(ctx.game_id)
        if not assets:
            return "The Asset Board is empty."
        lines = [
            f"- {a.id}: {a.name}" + (f" ({a.category})" if getattr(a, 'category', None) else "")
            for a in assets
        ]
        return "Assets on the board:\n" + "\n".join(lines)

    return StructuredTool.from_function(
        coroutine=list_assets,
        name="list_assets",
        description="List the assets on the Asset Board (id, name, category) for the current game.",
    )
```

- [ ] **Step 4: Register the builder**

In `ToolFactory._BUILDERS`:

```python
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/test_agent_tools.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(tools): add ungated list_assets agent tool"
```

---

### Task 2: `delete_asset` destructive tool with `interrupt()` + board-removal notify

**Files:**
- Modify: `studio/backend/app/agent_tools.py`
- Modify: `studio/backend/app/assets/hub.py`
- Test: `studio/backend/tests/test_agent_tools.py`
- Test: `studio/backend/tests/test_asset_hub.py`

**Interfaces:**
- Consumes: `AssetStore.get_asset(asset_id) -> Asset | None`, `AssetStore.delete_asset(asset_id) -> None`; `AssetHub.notify_deleted(game_id, asset_id)` (added here); module-level `interrupt` (patchable seam).
- Produces: `build_delete_asset_tool(ctx) -> BaseTool` named `delete_asset`; `ToolFactory._BUILDERS["delete_asset"]`; `AssetHub.notify_deleted` emitting `asset_deleted`.
- Interrupt payload contract: `{"tool": "delete_asset", "args": {"asset_id": <id>}, "label": "Delete '<name>' (id <id>) — this can't be undone."}`. Resume value is the string `"approve"` or `"deny"`.

- [ ] **Step 1: Write the failing AssetHub test**

Append to `studio/backend/tests/test_asset_hub.py`:

```python
@pytest.mark.asyncio
async def test_notify_deleted_emits_asset_deleted_to_game_room():
    class _Sio:
        def __init__(self): self.emits = []
        async def emit(self, event, data, room=None, to=None):
            self.emits.append((event, data, room))
    from app.assets.hub import AssetHub
    sio = _Sio()
    hub = AssetHub(sio, asset_store=None, comfy=None, media=None)
    await hub.notify_deleted("g1", "a1")
    assert ("asset_deleted", {"gameId": "g1", "assetId": "a1"}, "g1") in sio.emits
```

(If `pytest` / asyncio imports are not already at the top of the file, add `import pytest`.)

- [ ] **Step 2: Run it — verify it fails**

Run: `uv run pytest tests/test_asset_hub.py::test_notify_deleted_emits_asset_deleted_to_game_room -v`
Expected: FAIL — `AttributeError: 'AssetHub' object has no attribute 'notify_deleted'`.

- [ ] **Step 3: Implement `notify_deleted`**

In `studio/backend/app/assets/hub.py`, add a method to `AssetHub` (mirror the `asset_completed` emit at line 91):

```python
    async def notify_deleted(self, game_id: str, asset_id: str) -> None:
        await self._sio.emit("asset_deleted", {"gameId": game_id, "assetId": asset_id}, room=game_id)
```

- [ ] **Step 4: Run it — verify it passes**

Run: `uv run pytest tests/test_asset_hub.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing delete_asset tool tests**

Append to `studio/backend/tests/test_agent_tools.py`:

```python
from app.agent_tools import build_delete_asset_tool
import app.agent_tools as agent_tools


class _DelStore:
    def __init__(self, asset):
        self._asset = asset
        self.deleted = []
    async def get_asset(self, asset_id):
        return self._asset if (self._asset and self._asset.id == asset_id) else None
    async def delete_asset(self, asset_id):
        self.deleted.append(asset_id)


class _DelHub:
    def __init__(self): self.notified = []
    async def notify_deleted(self, g, a): self.notified.append((g, a))


@pytest.mark.asyncio
async def test_delete_asset_approve_deletes_and_notifies(monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "approve")
    store = _DelStore(_Asset("a1", "knight", "sprite"))
    hub = _DelHub()
    tool = build_delete_asset_tool(ToolContext("r1", "g1", store, hub))
    out = await tool.ainvoke({"asset_id": "a1"})
    assert store.deleted == ["a1"]
    assert hub.notified == [("g1", "a1")]
    assert "knight" in out


@pytest.mark.asyncio
async def test_delete_asset_deny_does_not_delete(monkeypatch):
    monkeypatch.setattr(agent_tools, "interrupt", lambda payload: "deny")
    store = _DelStore(_Asset("a1", "knight", "sprite"))
    hub = _DelHub()
    tool = build_delete_asset_tool(ToolContext("r1", "g1", store, hub))
    out = await tool.ainvoke({"asset_id": "a1"})
    assert store.deleted == []
    assert hub.notified == []
    assert "denied" in out.lower()


@pytest.mark.asyncio
async def test_delete_asset_unknown_id_returns_not_found_without_interrupt(monkeypatch):
    def _boom(payload):
        raise AssertionError("interrupt must not be called for unknown asset")
    monkeypatch.setattr(agent_tools, "interrupt", _boom)
    store = _DelStore(None)
    tool = build_delete_asset_tool(ToolContext("r1", "g1", store, _DelHub()))
    out = await tool.ainvoke({"asset_id": "missing"})
    assert "not found" in out.lower()
    assert store.deleted == []
```

- [ ] **Step 6: Run them — verify they fail**

Run: `uv run pytest tests/test_agent_tools.py -k delete_asset -v`
Expected: FAIL — `ImportError: cannot import name 'build_delete_asset_tool'`.

- [ ] **Step 7: Implement `delete_asset`**

In `studio/backend/app/agent_tools.py`, add the import at the top:

```python
from langgraph.types import interrupt
```

Then add the builder:

```python
def build_delete_asset_tool(ctx: ToolContext) -> BaseTool:
    async def delete_asset(asset_id: str) -> str:
        asset = await ctx.asset_store.get_asset(asset_id)
        if asset is None:
            return f"No asset with id {asset_id} was found; nothing deleted."
        label = f"Delete '{asset.name}' (id {asset_id}) — this can't be undone."
        decision = interrupt(
            {"tool": "delete_asset", "args": {"asset_id": asset_id}, "label": label}
        )
        if decision != "approve":
            return "Deletion denied by the user."
        await ctx.asset_store.delete_asset(asset_id)
        await ctx.asset_hub.notify_deleted(ctx.game_id, asset_id)
        return f"Deleted '{asset.name}' (id {asset_id}) from the Asset Board."

    return StructuredTool.from_function(
        coroutine=delete_asset,
        name="delete_asset",
        description=(
            "Delete an asset from the Asset Board by its id. This is destructive and "
            "irreversible; the studio will ask the human to approve before it runs."
        ),
    )
```

Register it in `ToolFactory._BUILDERS`:

```python
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "delete_asset": build_delete_asset_tool,
    }
```

- [ ] **Step 8: Run them — verify they pass**

Run: `uv run pytest tests/test_agent_tools.py tests/test_asset_hub.py -v`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/assets/hub.py studio/backend/tests/test_agent_tools.py studio/backend/tests/test_asset_hub.py
git commit -m "feat(tools): add interrupt-gated delete_asset tool + asset_deleted notify"
```

---

### Task 3: `approval` RunStep type

**Files:**
- Modify: `studio/backend/app/runs.py`
- Test: `studio/backend/tests/test_run_store.py`

**Interfaces:**
- Produces: `RunStep.type` Literal now includes `"approval"`.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_run_store.py`:

```python
def test_run_step_accepts_approval_type():
    from app.runs import RunStep
    step = RunStep(index=2, type="approval", content="{}", status="running")
    assert step.type == "approval"
```

- [ ] **Step 2: Run it — verify it fails**

Run: `uv run pytest tests/test_run_store.py::test_run_step_accepts_approval_type -v`
Expected: FAIL — pydantic `ValidationError` (input not in the Literal).

- [ ] **Step 3: Implement**

In `studio/backend/app/runs.py`, extend the `RunStep.type` Literal:

```python
    type: Literal["thinking", "tool_call", "tool_result", "final", "approval"]
```

- [ ] **Step 4: Run it — verify it passes**

Run: `uv run pytest tests/test_run_store.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/runs.py studio/backend/tests/test_run_store.py
git commit -m "feat(runs): add approval RunStep type"
```

---

### Task 4: `TurnRunner` interrupt detection + resume via `on_approval` callback

**Files:**
- Modify: `studio/backend/app/turn_runner.py`
- Test: `studio/backend/tests/test_turn_runner.py`

**Interfaces:**
- Consumes: `create_react_agent(model, tools, prompt=...)`, `MemorySaver`, `Command`; the gated tool's `interrupt(...)` payload `{"tool","args","label"}`.
- Produces:
  - New event dataclass `ApprovalRequired(action: dict)` (the interrupt payload).
  - `TurnRunner.run(*, messages, model, skill, args, ctx, run_id=None, on_approval=None)`:
    - builds the react agent with a `MemorySaver` checkpointer and `config={"configurable": {"thread_id": run_id or "run"}}`;
    - streams as today; **after** the stream, inspects `await agent.aget_state(config)`; if a task interrupt is pending, yields `ApprovalRequired(payload)`, then:
      - if `on_approval` is provided, `decision = await on_approval(payload)`; otherwise `decision = "deny"`;
      - resumes with `agent.astream_events(Command(resume=decision), config, version="v2")`, **suppressing the first `on_tool_start` for the gated tool** (it re-fires because LangGraph re-runs the node on resume), and continues projecting `StepStarted/StepToken/StepCompleted`;
    - loops the detect/resume cycle until no interrupt remains, then yields `RunFinished(status)`.
  - The no-tool (plain chat) path (`skill=None`) is unchanged: it never interrupts.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_turn_runner.py`:

```python
import pytest

from app.turn_runner import ApprovalRequired
from app.agent_tools import build_delete_asset_tool


class _DelStore2:
    def __init__(self):
        class A: id = "a1"; name = "knight"
        self._a = A()
        self.deleted = []
    async def get_asset(self, aid):
        return self._a if aid == "a1" else None
    async def delete_asset(self, aid):
        self.deleted.append(aid)


class _DelHub2:
    def __init__(self): self.notified = []
    async def notify_deleted(self, g, a): self.notified.append((g, a))


class _DeleteToolFactory:
    def known_tool_names(self): return {"delete_asset"}
    def build(self, allowlist, ctx):
        return [build_delete_asset_tool(ctx)] if "delete_asset" in allowlist else []


class _DeleteSkill:
    body = "Delete the asset the user names."
    tools = ["delete_asset"]


def _runner():
    return TurnRunner(
        chat_model_factory=lambda model: ReplayToolCallingChatModel(
            cassette={
                "tool_calls": [{"name": "delete_asset", "args": {"asset_id": "a1"}}],
                "final": ["Done — ", "removed it."],
            }
        ),
        tool_factory=_DeleteToolFactory(),
    )


@pytest.mark.asyncio
async def test_runner_emits_approval_then_resumes_on_approve():
    store, hub = _DelStore2(), _DelHub2()
    ctx = ToolContext("r1", "g1", store, hub)
    events = []
    async for e in _runner().run(
        messages=[{"role": "user", "content": "delete a1"}],
        model="x", skill=_DeleteSkill(), args={}, ctx=ctx,
        run_id="run-1", on_approval=lambda action: _approve(action),
    ):
        events.append(e)
    names = [type(e).__name__ for e in events]
    assert "ApprovalRequired" in names
    approval = next(e for e in events if isinstance(e, ApprovalRequired))
    assert approval.action["tool"] == "delete_asset"
    assert approval.action["args"]["asset_id"] == "a1"
    assert store.deleted == ["a1"]
    assert hub.notified == [("g1", "a1")]
    assert isinstance(events[-1], RunFinished) and events[-1].status == "completed"
    # the gated tool_call step is not duplicated after resume
    tool_calls = [e for e in events if type(e).__name__ == "StepStarted" and getattr(e, "type", None) == "tool_call"]
    assert len(tool_calls) == 1


@pytest.mark.asyncio
async def test_runner_deny_does_not_delete():
    store, hub = _DelStore2(), _DelHub2()
    ctx = ToolContext("r1", "g1", store, hub)
    saw_approval = False
    async for e in _runner().run(
        messages=[{"role": "user", "content": "delete a1"}],
        model="x", skill=_DeleteSkill(), args={}, ctx=ctx,
        run_id="run-2", on_approval=lambda action: _deny(action),
    ):
        if isinstance(e, ApprovalRequired):
            saw_approval = True
    assert saw_approval
    assert store.deleted == []
    assert hub.notified == []


async def _approve(action): return "approve"
async def _deny(action): return "deny"
```

- [ ] **Step 2: Run them — verify they fail**

Run: `uv run pytest tests/test_turn_runner.py -k approval -v`
Expected: FAIL — `ImportError: cannot import name 'ApprovalRequired'`.

- [ ] **Step 3: Implement the runner changes**

In `studio/backend/app/turn_runner.py`:

Add imports near the top:

```python
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
```

Add the event dataclass next to the others:

```python
@dataclass
class ApprovalRequired:
    action: dict
```

Replace the tool-path body of `run` (the branch after the `_run_no_tools` early-return) with a version that streams in a helper and loops on interrupts. Use this structure:

```python
    async def run(self, *, messages, model, skill, args, ctx, run_id=None, on_approval=None):
        if not (skill and skill.tools):
            async for ev in self._run_no_tools(messages, model):
                yield ev
            return

        tools = self._tools.build(skill.tools, ctx)
        system = BASE_SYSTEM + "\n\n" + skill.body
        agent = create_react_agent(
            self._model_factory(model), tools, prompt=system, checkpointer=MemorySaver()
        )
        config = {"configurable": {"thread_id": run_id or "run"}}
        lc = [HumanMessage(m["content"]) for m in messages if m["role"] == "user"]

        state = {"index": 0, "text_open": False, "text_index": -1, "text_buf": "", "skip_tool_start": None}
        status = "completed"
        stream_input = {"messages": lc}
        try:
            while True:
                async for ev in self._project_stream(agent, stream_input, config, state):
                    yield ev
                pending = await self._pending_interrupt(agent, config)
                if pending is None:
                    break
                yield ApprovalRequired(pending)
                decision = await on_approval(pending) if on_approval else "deny"
                state["skip_tool_start"] = pending.get("tool")
                stream_input = Command(resume=decision)
            if state["text_open"]:
                yield StepCompleted(state["text_index"], "complete", state["text_buf"])
        except Exception:
            logger.exception("turn run failed")
            status = "error"
            if state["text_open"]:
                yield StepCompleted(state["text_index"], "error", state["text_buf"])
        yield RunFinished(status)

    async def _pending_interrupt(self, agent, config):
        snap = await agent.aget_state(config)
        for task in snap.tasks:
            for intr in task.interrupts:
                return intr.value
        return None

    async def _project_stream(self, agent, stream_input, config, st):
        async for ev in agent.astream_events(stream_input, config, version="v2"):
            kind = ev["event"]
            if kind == "on_chat_model_stream":
                delta = getattr(ev["data"]["chunk"], "content", "") or ""
                if not delta:
                    continue
                if not st["text_open"]:
                    st["text_index"] = st["index"]; st["index"] += 1
                    st["text_open"] = True; st["text_buf"] = ""
                    yield StepStarted(st["text_index"], "final")
                st["text_buf"] += delta
                yield StepToken(st["text_index"], delta)
            elif kind == "on_tool_start":
                name = ev["name"]
                if st["skip_tool_start"] == name:
                    # LangGraph re-runs the node on resume; do not duplicate the
                    # gated tool_call step that was already emitted pre-interrupt.
                    st["skip_tool_start"] = None
                    continue
                if st["text_open"]:
                    yield StepCompleted(st["text_index"], "complete", st["text_buf"])
                    st["text_open"] = False
                call_index = st["index"]; st["index"] += 1
                yield StepStarted(call_index, "tool_call", name)
                yield StepCompleted(call_index, "complete", str(ev["data"].get("input", "")), name)
            elif kind == "on_tool_end":
                name = ev["name"]
                res_index = st["index"]; st["index"] += 1
                yield StepStarted(res_index, "tool_result", name)
                yield StepCompleted(res_index, "complete", str(ev["data"].get("output", "")), name)
```

Keep `_run_no_tools` unchanged. Keep the existing `StepStarted/StepToken/StepCompleted/RunFinished` dataclasses.

- [ ] **Step 4: Run the new tests — verify they pass**

Run: `uv run pytest tests/test_turn_runner.py -v`
Expected: PASS (both new tests and the existing `test_run_emits_ordered_tool_then_final`).

- [ ] **Step 5: Run the full backend suite to catch signature fallout**

Run: `uv run pytest -q`
Expected: PASS. (The `run` signature gained optional kwargs `run_id`/`on_approval`; existing callers in `room_hub.py` still pass the old kwargs and are unaffected until Task 6.)

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/turn_runner.py studio/backend/tests/test_turn_runner.py
git commit -m "feat(runner): detect interrupt, request approval, resume from checkpoint"
```

---

### Task 5: Replay model selects cassette tool-calls by bound tools

**Files:**
- Modify: `studio/backend/app/providers.py`
- Test: `studio/backend/tests/test_providers.py`

**Interfaces:**
- Produces: `ReplayToolCallingChatModel.bind_tools` records the bound tool **names**; `_agenerate`/`_astream` emit only cassette `tool_calls` whose `name` is in the bound set. With a single bound tool (e.g. `generate-sprite`) behavior is byte-for-byte unchanged; a different skill (`manage-assets`) replays only its own calls.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_providers.py`:

```python
import pytest
from langchain_core.messages import HumanMessage
from app.providers import ReplayToolCallingChatModel


class _T:
    def __init__(self, name): self.name = name


@pytest.mark.asyncio
async def test_bound_tools_filter_cassette_tool_calls():
    cassette = {
        "tool_calls": [
            {"name": "generate_asset", "args": {"description": "knight"}},
            {"name": "delete_asset", "args": {"asset_id": "a1"}},
        ],
        "final": ["ok"],
    }
    model = ReplayToolCallingChatModel(cassette=cassette)
    bound = model.bind_tools([_T("delete_asset")])
    result = await bound._agenerate([HumanMessage("go")])
    calls = result.generations[0].message.tool_calls
    assert [c["name"] for c in calls] == ["delete_asset"]
```

- [ ] **Step 2: Run it — verify it fails**

Run: `uv run pytest tests/test_providers.py::test_bound_tools_filter_cassette_tool_calls -v`
Expected: FAIL — currently all cassette `tool_calls` are emitted (assertion shows both names).

- [ ] **Step 3: Implement**

In `studio/backend/app/providers.py`:

Add a field to `ReplayToolCallingChatModel` (next to `_has_tools`):

```python
    _bound_names: set = set()
```

Update `bind_tools` to record names:

```python
    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        self._has_tools = bool(tools)
        self._bound_names = {getattr(t, "name", None) for t in tools}
        return self
```

Add a helper and use it in both `_agenerate` and `_astream` where `self.cassette.get("tool_calls")` is read:

```python
    def _cassette_tool_calls(self) -> list:
        calls = self.cassette.get("tool_calls") or []
        if self._bound_names:
            calls = [c for c in calls if c["name"] in self._bound_names]
        return calls
```

In `_agenerate`, replace `if not has_tool_result and self.cassette.get("tool_calls"):` with:

```python
        cassette_calls = self._cassette_tool_calls()
        if not has_tool_result and cassette_calls:
            calls = [
                {"name": c["name"], "args": c["args"], "id": f"call_{i}"}
                for i, c in enumerate(cassette_calls)
            ]
            msg = AIMessage(content="", tool_calls=calls)
```

In `_astream`, replace `if not has_tool_result and self.cassette.get("tool_calls"):` with `if not has_tool_result and self._cassette_tool_calls():` (the body already delegates to `_agenerate`).

- [ ] **Step 4: Run it + the full provider/runner suites — verify they pass**

Run: `uv run pytest tests/test_providers.py tests/test_turn_runner.py -v`
Expected: PASS. (Single-tool skills still emit their one call; `generate-sprite` parity intact.)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/providers.py studio/backend/tests/test_providers.py
git commit -m "feat(replay): filter cassette tool-calls by bound tools"
```

---

### Task 6: RoomHub approval orchestration + `resolve_approval` + timeout

**Files:**
- Modify: `studio/backend/app/room_hub.py`
- Test: `studio/backend/tests/test_room_hub.py`

**Interfaces:**
- Consumes: `TurnRunner.run(..., run_id, on_approval)`, `ApprovalRequired`, `RunStep(type="approval")`.
- Produces:
  - `_run_skill` passes `run_id=run.id` and `on_approval=self._make_approval_cb(room_id, run.id)` to the runner; projects `ApprovalRequired` as an `approval` run step (`content` = `json.dumps(action)`, status `running`) and registers a per-run `asyncio.Future`.
  - `_make_approval_cb` returns a coroutine that awaits the Future with a timeout (`APPROVAL_TIMEOUT_SECONDS = 300`); on timeout returns `"deny"`; on resolution returns the decision and completes the `approval` step (`status` `complete`, content includes the decision).
  - `resolve_approval(room_id, run_id, decision)` resolves the matching Future idempotently (ignored if unknown/already resolved); constrained to `"approve" | "deny"`.

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_room_hub.py` (mirror the existing fakes in that file; this assumes a `FakeSio` recording `emit` and a builder for `RoomHub` already present — reuse them. If not present, add the minimal `FakeSio` shown):

```python
import asyncio
import json
import pytest

from app.turn_runner import ApprovalRequired, StepStarted, StepCompleted, RunFinished
from app.runs import RunStore  # use the real run model; store can be a fake


class _ApprovalRunner:
    """Yields a delete tool_call, an ApprovalRequired, then (via on_approval) finishes."""
    async def run(self, *, messages, model, skill, args, ctx, run_id=None, on_approval=None):
        yield StepStarted(0, "tool_call", "delete_asset")
        yield StepCompleted(0, "complete", "{'asset_id': 'a1'}", "delete_asset")
        action = {"tool": "delete_asset", "args": {"asset_id": "a1"}, "label": "Delete 'knight'."}
        yield ApprovalRequired(action)
        decision = await on_approval(action)
        self.decision = decision
        yield StepStarted(2, "final")
        yield StepCompleted(2, "complete", f"decision={decision}")
        yield RunFinished("completed")


@pytest.mark.asyncio
async def test_skill_run_emits_approval_step_and_resolves_approve():
    hub = _build_hub_with_runner(_ApprovalRunner())  # helper added in Step 3
    room_id = await _seed_room(hub)
    task = asyncio.create_task(hub.handle_skill_run(room_id, "Alice", "manage-assets", {"target": "knight"}))
    # wait until the approval step has been emitted
    await _wait(lambda: any(e[0] == "run_step_started" and e[1]["step"]["type"] == "approval"
                            for e in hub._sio.emits))
    run_id = next(e[1]["runId"] for e in hub._sio.emits if e[0] == "run_started")
    await hub.resolve_approval(room_id, run_id, "approve")
    await asyncio.wait_for(task, timeout=2)
    completed = [e for e in hub._sio.emits if e[0] == "run_completed"]
    assert completed and completed[-1][1]["status"] == "completed"


@pytest.mark.asyncio
async def test_approval_timeout_denies():
    hub = _build_hub_with_runner(_ApprovalRunner(), approval_timeout=0.1)
    room_id = await _seed_room(hub)
    await hub.handle_skill_run(room_id, "Alice", "manage-assets", {"target": "knight"})
    # no resolve_approval; the timeout path must drive the run to completion with deny
    await _wait(lambda: any(e[0] == "run_completed" for e in hub._sio.emits), timeout=3)
    runner = hub._runner
    assert runner.decision == "deny"
```

(Use the file's existing `_wait`/seed helpers if present; otherwise add a small `async def _wait(pred, timeout=2)` polling loop.)

- [ ] **Step 2: Run them — verify they fail**

Run: `uv run pytest tests/test_room_hub.py -k approval -v`
Expected: FAIL — `AttributeError: 'RoomHub' object has no attribute 'resolve_approval'` (and/or missing helper).

- [ ] **Step 3: Implement RoomHub changes**

In `studio/backend/app/room_hub.py`:

Add at the top:

```python
import json

APPROVAL_TIMEOUT_SECONDS = 300
```

Add an instance map in `__init__`:

```python
        # run_id -> {"future": asyncio.Future, "step_index": int}
        self._pending_approvals: dict[str, dict] = {}
        self._approval_timeout = APPROVAL_TIMEOUT_SECONDS
```

In `_run_skill`, change the runner call to pass `run_id` and the callback, and handle `ApprovalRequired` in the projection. Update the `async for` loop:

```python
            async for ev in self._runner.run(
                messages=messages, model=room.model, skill=spec, args=descriptor["args"],
                ctx=ctx, run_id=run.id, on_approval=self._make_approval_cb(room_id, run.id),
            ):
                if type(ev).__name__ == "ApprovalRequired":
                    await self._begin_approval(room_id, run.id, ev.action)
                    continue
                await self._project_run_event(room_id, run.id, ev)
                if type(ev).__name__ == "RunFinished":
                    status = ev.status
```

Add the helper methods:

```python
    async def _begin_approval(self, room_id, run_id, action) -> None:
        from app.runs import RunStep
        loop = asyncio.get_event_loop()
        fut = loop.create_future()
        # the approval step takes the next index after whatever was emitted so far
        run = await self._run_store.get_run(run_id)
        index = len(run.steps)
        self._pending_approvals[run_id] = {"future": fut, "step_index": index, "action": action}
        await self._run_store.append_step(
            run_id, RunStep(index=index, type="approval", content=json.dumps(action), status="running")
        )
        await self._sio.emit(
            "run_step_started",
            {"roomId": room_id, "runId": run_id,
             "step": {"index": index, "type": "approval", "toolName": None,
                      "content": json.dumps(action), "status": "running"}},
            room=room_id,
        )

    def _make_approval_cb(self, room_id, run_id):
        async def _cb(action) -> str:
            entry = self._pending_approvals.get(run_id)
            fut = entry["future"]
            try:
                decision = await asyncio.wait_for(fut, timeout=self._approval_timeout)
            except asyncio.TimeoutError:
                decision = "deny"
            await self._complete_approval(room_id, run_id, decision)
            return decision
        return _cb

    async def _complete_approval(self, room_id, run_id, decision) -> None:
        entry = self._pending_approvals.pop(run_id, None)
        if entry is None:
            return
        index = entry["step_index"]
        # Preserve the action (tool/args/label) alongside the decision so the card
        # can still render the label after resolution.
        content = json.dumps({**entry["action"], "decision": decision})
        await self._run_store.complete_step(run_id, index, "complete", content)
        await self._sio.emit(
            "run_step_completed",
            {"roomId": room_id, "runId": run_id, "stepIndex": index,
             "status": "complete", "content": content},
            room=room_id,
        )

    async def resolve_approval(self, room_id, run_id, decision) -> None:
        if decision not in ("approve", "deny"):
            return
        entry = self._pending_approvals.get(run_id)
        if entry is None or entry["future"].done():
            return
        entry["future"].set_result(decision)
```

(Note: `_complete_approval` is invoked from the callback after the future resolves — `resolve_approval` only sets the future result; the callback path does the step completion so timeout and explicit-resolve share one completion path.)

- [ ] **Step 4: Add the `_build_hub_with_runner` / `_seed_room` helpers**

If `tests/test_room_hub.py` lacks them, add near the top (reuse the file's existing `FakeSio`/store fakes where available):

```python
async def _seed_room(hub):
    room = await hub._store.create_room("ApprovalRoom", "x")
    return room.id


def _build_hub_with_runner(runner, approval_timeout=None):
    hub = _make_hub(runner=runner)  # the file's existing hub-builder with injected deps
    if approval_timeout is not None:
        hub._approval_timeout = approval_timeout
    return hub
```

If the file has no shared hub-builder, construct `RoomHub(...)` directly with the in-file fakes (`FakeSio`, an in-memory store, a `RunStore` over a fake db, a `skills` stub whose `get("manage-assets")` returns a spec with `tools=["list_assets","delete_asset"]` and `validate_args` returning the args). Keep it minimal and local to the test module.

- [ ] **Step 5: Run them — verify they pass**

Run: `uv run pytest tests/test_room_hub.py -v`
Expected: PASS (new approval tests + existing room-hub tests).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/room_hub.py studio/backend/tests/test_room_hub.py
git commit -m "feat(hub): orchestrate approval step, resolve_approval, timeout->deny"
```

---

### Task 7: `resolve_approval` inbound socket event

**Files:**
- Modify: `studio/backend/app/sockets.py`
- Test: `studio/backend/tests/e2e/test_sockets.py`

**Interfaces:**
- Consumes: `RoomHub.resolve_approval(room_id, run_id, decision)`.
- Produces: `@sio.on("resolve_approval")` reading `{roomId, runId, decision}` → `hub.resolve_approval(...)`.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/e2e/test_sockets.py` a focused handler test. Prefer the file's existing pattern (a fake `sio` capturing `@sio.on` registrations, or a real `AsyncServer`). If the file registers handlers against a fake recorder, mirror it:

```python
@pytest.mark.asyncio
async def test_resolve_approval_handler_forwards_to_hub():
    from app.sockets import register_socket_handlers

    calls = []

    class _Hub:
        async def resolve_approval(self, room_id, run_id, decision):
            calls.append((room_id, run_id, decision))

    handlers = {}

    class _Sio:
        def event(self, fn): handlers[fn.__name__] = fn; return fn
        def on(self, name):
            def deco(fn): handlers[name] = fn; return fn
            return deco
        async def save_session(self, *a, **k): pass
        async def get_session(self, sid): return {"displayName": "Alice"}
        async def emit(self, *a, **k): pass
        async def enter_room(self, *a, **k): pass

    register_socket_handlers(_Sio(), _Hub(), presence=_FakePresence())
    await handlers["resolve_approval"]("sid1", {"roomId": "r1", "runId": "run1", "decision": "approve"})
    assert calls == [("r1", "run1", "approve")]
```

(Reuse the module's existing `_FakePresence`/sio fake if one already exists; the shape above matches `register_socket_handlers(sio, hub, presence)`.)

- [ ] **Step 2: Run it — verify it fails**

Run: `uv run pytest tests/e2e/test_sockets.py::test_resolve_approval_handler_forwards_to_hub -v`
Expected: FAIL — `KeyError: 'resolve_approval'` (handler not registered).

- [ ] **Step 3: Implement**

In `studio/backend/app/sockets.py`, add inside `register_socket_handlers` (next to `run_skill`):

```python
    @sio.on("resolve_approval")
    async def resolve_approval(sid, data):
        await hub.resolve_approval(data["roomId"], data["runId"], data["decision"])
```

- [ ] **Step 4: Run it — verify it passes**

Run: `uv run pytest tests/e2e/test_sockets.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/sockets.py studio/backend/tests/e2e/test_sockets.py
git commit -m "feat(sockets): add resolve_approval inbound event"
```

---

### Task 8: `manage-assets` skill

**Files:**
- Create: `skills/manage-assets.md`
- Test: `studio/backend/tests/test_skills.py`

**Interfaces:**
- Consumes: `SkillRegistry.load()` with `known_tools` including `list_assets` and `delete_asset` (Tasks 1–2).
- Produces: a loadable skill `manage-assets` with `tools=["list_assets", "delete_asset"]` and one required `target` string arg.

- [ ] **Step 1: Write the failing test**

Append to `studio/backend/tests/test_skills.py` (mirror the existing skill-loading test that points the registry at the repo `skills/` dir; reuse its fixture/helper for the dir + known tools):

```python
def test_manage_assets_skill_loads_with_asset_tools(tmp_path):
    # Point the registry at the repo skills dir with the real known tools.
    from pathlib import Path
    from app.skills import SkillRegistry
    skills_dir = Path(__file__).resolve().parents[2] / "skills"
    reg = SkillRegistry(skills_dir, known_tools={"generate_asset", "list_assets", "delete_asset"})
    reg.load()
    spec = reg.get("manage-assets")
    assert spec is not None
    assert spec.tools == ["list_assets", "delete_asset"]
    assert any(a.name == "target" and a.required for a in spec.args)
```

(Adjust `parents[...]` depth so it resolves the repo-root `skills/` dir; from `studio/backend/tests/` that is `parents[3]`. Verify with the existing skill test's path computation and match it.)

- [ ] **Step 2: Run it — verify it fails**

Run: `uv run pytest tests/test_skills.py::test_manage_assets_skill_loads_with_asset_tools -v`
Expected: FAIL — `spec is None` (file does not exist yet).

- [ ] **Step 3: Create the skill**

Create `skills/manage-assets.md`:

```markdown
---
name: manage-assets
description: Review the Asset Board and remove assets you no longer want (deletion is confirmed).
args:
  - { name: target, type: string, required: true, description: 'Which asset(s) to remove, described in words' }
tools: [list_assets, delete_asset]
---

You help curate the game's Asset Board. First call list_assets to see what exists. Then,
for each asset that matches the target, call delete_asset with its id — each deletion will
be confirmed by a human before it happens. After acting, state in one sentence what was
removed (or that nothing matched / the human declined).
```

- [ ] **Step 4: Run it — verify it passes**

Run: `uv run pytest tests/test_skills.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/manage-assets.md studio/backend/tests/test_skills.py
git commit -m "feat(skills): add manage-assets skill (list + gated delete)"
```

---

### Task 9: Replay run cassette — add `delete_asset` call

**Files:**
- Modify: `studio/backend/tests/fixtures/replay/run/default.json`
- Test: `studio/backend/tests/test_fixtures_committed.py` (guard must stay green), `tests/test_turn_runner.py` (already covers delete via inline cassette).

**Interfaces:**
- Produces: the global run cassette gains a `delete_asset` tool-call entry. Because the replay model now filters by bound tools (Task 5), `generate-sprite` still emits only `generate_asset`, and `manage-assets` emits only `delete_asset`. The `delete_asset` call targets the deterministic seeded id `e2e-doomed-asset` used by the Playwright test (Task 13).

- [ ] **Step 1: Update the fixture**

Edit `studio/backend/tests/fixtures/replay/run/default.json` to:

```json
{
  "tool_calls": [
    { "name": "generate_asset", "args": { "description": "a knight", "style": "pixel" } },
    { "name": "delete_asset", "args": { "asset_id": "e2e-doomed-asset" } }
  ],
  "final": ["All set — ", "I generated a knight sprite and added it to the Asset Board."]
}
```

- [ ] **Step 2: Verify the existing skill-run realtime e2e still passes (generate-sprite parity)**

Start a replay backend, then run the realtime suite (these need a server per `tests/e2e/conftest.py`'s `live_server` fixture, which boots its own uvicorn in replay mode):

Run: `uv run pytest tests/e2e/test_skill_runs.py -v -m e2e`
Expected: PASS — `generate-sprite` emits only `generate_asset` (bound-tool filtering), asset attached, sequences match.

- [ ] **Step 3: Verify the committed-fixtures guard**

Run: `uv run pytest tests/test_fixtures_committed.py -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add studio/backend/tests/fixtures/replay/run/default.json
git commit -m "test(replay): add delete_asset call to run cassette"
```

---

### Task 10: Frontend — `approval` step type + parsed action shape

**Files:**
- Modify: `studio/frontend/src/plugins/llm-chat/state.ts`
- Test: `studio/frontend/src/plugins/llm-chat/state.test.ts` (or the existing state/reducers test file — match the project's vitest layout)

**Interfaces:**
- Produces:
  - `IRunStep.type` union includes `'approval'`.
  - `IApprovalAction { tool: string; args: Record<string, unknown>; label: string }`.
  - `parseApprovalAction(step: IRunStep): IApprovalAction | null` — parses `step.content` JSON for an `approval` step; returns `null` on any other type or parse failure.

- [ ] **Step 1: Write the failing test**

Add to the llm-chat state/unit test file:

```ts
import { describe, it, expect } from 'vitest';
import { parseApprovalAction, type IRunStep } from './state';

describe('parseApprovalAction', () => {
  it('parses an approval step content', () => {
    const step: IRunStep = {
      index: 1, type: 'approval', toolName: null,
      content: JSON.stringify({ tool: 'delete_asset', args: { asset_id: 'a1' }, label: "Delete 'knight'." }),
      status: 'running',
    };
    const action = parseApprovalAction(step);
    expect(action?.tool).toBe('delete_asset');
    expect(action?.label).toContain('knight');
  });

  it('returns null for non-approval steps', () => {
    const step: IRunStep = { index: 0, type: 'final', toolName: null, content: 'hi', status: 'complete' };
    expect(parseApprovalAction(step)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run (from `studio/frontend`): `npx vitest run src/plugins/llm-chat/state.test.ts`
Expected: FAIL — `parseApprovalAction` is not exported / `'approval'` not in the union.

- [ ] **Step 3: Implement**

In `studio/frontend/src/plugins/llm-chat/state.ts`:

Extend the `IRunStep.type` union:

```ts
  type: 'thinking' | 'tool_call' | 'tool_result' | 'final' | 'approval';
```

Add the interface and parser:

```ts
export interface IApprovalAction {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export function parseApprovalAction(step: IRunStep): IApprovalAction | null {
  if (step.type !== 'approval') return null;
  try {
    const a = JSON.parse(step.content) as IApprovalAction;
    if (typeof a?.tool === 'string' && typeof a?.label === 'string') return a;
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run src/plugins/llm-chat/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/state.test.ts
git commit -m "feat(chat): add approval run-step type + action parser"
```

---

### Task 11: Frontend — `resolveApproval` emit + action

**Files:**
- Modify: `studio/frontend/src/plugins/llm-chat/socketClient.ts`
- Modify: `studio/frontend/src/plugins/llm-chat/actions.ts`
- Test: the socketClient/actions vitest file (match existing layout)

**Interfaces:**
- Produces:
  - `socketClient.resolveApproval(roomId, runId, decision)` → `emit('resolve_approval', { roomId, runId, decision })`.
  - `actions.resolveApproval(runId, decision)` → uses `activeRoomId` and calls the socket method (mirror `runSkill` at `actions.ts:123`).

- [ ] **Step 1: Write the failing test**

Mirror the existing `runSkill` emit test (find it in the socketClient test file) for the new method:

```ts
it('resolveApproval emits resolve_approval with the decision', () => {
  const emitted: Array<[string, unknown]> = [];
  const fakeSock = { emit: (e: string, p: unknown) => emitted.push([e, p]) };
  const client = makeSocketClient(fakeSock as never); // use the file's existing factory/seam
  client.resolveApproval('r1', 'run1', 'approve');
  expect(emitted).toContainEqual(['resolve_approval', { roomId: 'r1', runId: 'run1', decision: 'approve' }]);
});
```

(Use the exact construction the existing `runSkill` emit test uses — same factory/mocking seam.)

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run` (scoped to the socketClient test file)
Expected: FAIL — `resolveApproval` is not a function.

- [ ] **Step 3: Implement**

In `socketClient.ts`, add to the returned object next to `runSkill` (line ~161):

```ts
    resolveApproval: (roomId: string, runId: string, decision: 'approve' | 'deny') =>
      emit('resolve_approval', { roomId, runId, decision }),
```

In `actions.ts`, add next to `runSkill` (line ~123):

```ts
  resolveApproval(runId: string, decision: 'approve' | 'deny') {
    const roomId = /* activeRoomId, exactly as runSkill reads it */;
    socket?.resolveApproval(roomId, runId, decision);
  },
```

(Match how `runSkill` obtains `activeRoomId` and the `socket` reference in this file — do not invent a new accessor.)

- [ ] **Step 4: Run it — verify it passes**

Run: `npx vitest run` (socketClient + actions tests)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/actions.ts
git commit -m "feat(chat): emit resolve_approval from socket client + action"
```

---

### Task 12: Frontend — approval card in the run timeline

**Files:**
- Create: `studio/frontend/src/plugins/llm-chat/ApprovalCard.tsx`
- Modify: `studio/frontend/src/plugins/llm-chat/RunTimeline.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/ApprovalCard.test.tsx`

**Interfaces:**
- Consumes: `parseApprovalAction` (Task 10), `actions.resolveApproval` (Task 11), `IRunStep`.
- Produces: `ApprovalCard({ runId, step })` — renders the label + Approve/Deny; calls `resolveApproval(runId, decision)`; disables both buttons once `step.status === 'complete'`, then shows the recorded decision (parsed from the completed step content). `RunStepCard` dispatches `step.type === 'approval'` → `ApprovalCard`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/ApprovalCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';
import * as actions from './actions';

const pending = {
  index: 1, type: 'approval' as const, toolName: null,
  content: JSON.stringify({ tool: 'delete_asset', args: { asset_id: 'a1' }, label: "Delete 'knight' — can't be undone." }),
  status: 'running' as const,
};

describe('ApprovalCard', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('shows the label and wires Approve', () => {
    const spy = vi.spyOn(actions, 'resolveApproval').mockImplementation(() => {});
    render(<ApprovalCard runId="run1" step={pending} />);
    expect(screen.getByText(/can't be undone/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(spy).toHaveBeenCalledWith('run1', 'approve');
  });

  it('wires Deny', () => {
    const spy = vi.spyOn(actions, 'resolveApproval').mockImplementation(() => {});
    render(<ApprovalCard runId="run1" step={pending} />);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(spy).toHaveBeenCalledWith('run1', 'deny');
  });

  it('disables buttons after resolution', () => {
    const resolved = { ...pending, status: 'complete' as const, content: JSON.stringify({ decision: 'approve' }) };
    render(<ApprovalCard runId="run1" step={resolved} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
  });
});
```

(If `actions.resolveApproval` is a method on an object rather than a named export, adapt the spy target to match the file's actual export shape — keep the assertion semantics.)

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/plugins/llm-chat/ApprovalCard.test.tsx`
Expected: FAIL — cannot find `./ApprovalCard`.

- [ ] **Step 3: Implement the card**

Create `studio/frontend/src/plugins/llm-chat/ApprovalCard.tsx`. Use only design-system class names / tokens already used by `RunTimeline.tsx` / `RunStepCard` (no raw colors — the rationed accent for Approve must come from an existing accent class/token). Structure:

```tsx
import type { IRunStep } from './state';
import { parseApprovalAction } from './state';
import { resolveApproval } from './actions';

export function ApprovalCard({ runId, step }: { runId: string; step: IRunStep }) {
  const resolved = step.status === 'complete';
  const action = parseApprovalAction(step);            // label survives completion (hub preserves it)
  const label = action?.label ?? 'Approve this action?';
  const decision = resolved ? safeDecision(step.content) : null;
  return (
    <div className="floating-card approval-card">
      <p className="approval-card__label">{label}</p>
      <div className="approval-card__actions">
        <button
          className="btn btn--accent"
          disabled={resolved}
          onClick={() => resolveApproval(runId, 'approve')}
        >Approve</button>
        <button
          className="btn"
          disabled={resolved}
          onClick={() => resolveApproval(runId, 'deny')}
        >Deny</button>
      </div>
      {resolved && <p className="approval-card__outcome">{decision === 'approve' ? 'Approved' : 'Denied'}</p>}
    </div>
  );
}

function safeDecision(content: string): string | null {
  try { return (JSON.parse(content) as { decision?: string }).decision ?? null; } catch { return null; }
}
```

Because the hub preserves the action (`tool`/`args`/`label`) in the completed step's content (Task 6 `_complete_approval`), `parseApprovalAction(step)` returns the label in **both** the `running` and `complete` states — no separate label persistence is needed. Replace the class names above with the actual design-language classes used by neighboring cards in `RunTimeline.tsx`; run the raw-color guard test (Step 5) to confirm compliance.

- [ ] **Step 4: Dispatch it from `RunStepCard`**

In `studio/frontend/src/plugins/llm-chat/RunTimeline.tsx`, add a branch in the `step.type` dispatch (lines 11–40). `RunStepCard` needs the `runId`; thread it from `RunStepList` (which has the `run`). Add:

```tsx
  if (step.type === 'approval') {
    return <ApprovalCard runId={runId} step={step} />;
  }
```

Update `RunStepList` to pass `runId={run.id}` into each `RunStepCard`, and add `runId: string` to `RunStepCard`'s props. Import `ApprovalCard`.

- [ ] **Step 5: Run vitest + the design-language guard**

Run: `npx vitest run src/plugins/llm-chat/ApprovalCard.test.tsx`
Then run the repo's raw-color guard test (the design-language guard — find it under `studio/frontend` tests; e.g. `npx vitest run` filtered to the guard spec).
Expected: PASS for both; no raw colors introduced.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/ApprovalCard.tsx studio/frontend/src/plugins/llm-chat/RunTimeline.tsx studio/frontend/src/plugins/llm-chat/ApprovalCard.test.tsx
git commit -m "feat(chat): render approval card in run timeline"
```

---

### Task 13: Frontend — asset board reacts to `asset_deleted`

**Files:**
- Modify: `studio/frontend/src/plugins/assets/socketClient.ts`
- Modify: `studio/frontend/src/plugins/assets/reducers.ts`
- Test: the assets reducers/socketClient vitest file

**Interfaces:**
- Consumes: socket event `asset_deleted` `{ gameId, assetId }`.
- Produces: `removeAsset(assets: IAsset[], assetId: string): IAsset[]` reducer; an `asset_deleted` inbound handler that drops the asset from board state when `gameId` is active (mirror the `asset_completed` handler at `assets/socketClient.ts:40–45`).

- [ ] **Step 1: Write the failing reducer test**

Add to the assets reducers test file:

```ts
import { removeAsset } from './reducers';

it('removeAsset drops the matching asset', () => {
  const assets = [{ id: 'a1' } as never, { id: 'a2' } as never];
  expect(removeAsset(assets, 'a1').map((a: { id: string }) => a.id)).toEqual(['a2']);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run` (scoped to the assets reducers test)
Expected: FAIL — `removeAsset` is not exported.

- [ ] **Step 3: Implement the reducer**

In `studio/frontend/src/plugins/assets/reducers.ts`:

```ts
export function removeAsset(assets: IAsset[], assetId: string): IAsset[] {
  return assets.filter((a) => a.id !== assetId);
}
```

- [ ] **Step 4: Wire the socket handler**

In `studio/frontend/src/plugins/assets/socketClient.ts`, inside `registerInboundHandlers` (near the `asset_completed` handler), add — matching the file's `isActive(gameId)` / slice-write pattern exactly:

```ts
  s.on('asset_deleted', (p) => {
    const { gameId, assetId } = p as { gameId: string; assetId: string };
    if (!isActive(gameId)) return;
    slice().assets.set(removeAsset(read(), assetId));
  });
```

(Use the precise `slice()/read()/isActive` helpers the neighboring handlers use; import `removeAsset`.)

- [ ] **Step 5: Run it — verify it passes**

Run: `npx vitest run` (assets tests)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/assets/socketClient.ts studio/frontend/src/plugins/assets/reducers.ts
git commit -m "feat(assets): drop asset from board on asset_deleted"
```

---

### Task 14: Playwright e2e — manage-assets approval flow (local-only)

**Files:**
- Create: `studio/frontend/e2e/manage-assets-approval.spec.ts` (match the existing e2e dir/layout)
- Possibly modify: an e2e setup helper for seeding (match existing patterns)

**Interfaces:**
- Consumes: the full stack under replay; the seeded asset id `e2e-doomed-asset` referenced by the run cassette (Task 9).
- Produces: an exhaustive client-side validation of the gate: approval card appears, Approve removes the asset from the board, Deny leaves it.

**Pre-req / determinism note:** the replay run cassette deletes the fixed id `e2e-doomed-asset`. The spec must ensure an asset with that id exists on the active room's game before invoking `manage-assets`. Seed it deterministically by inserting one asset doc with `_id = "e2e-doomed-asset"` into the e2e Mongo db (`bloom_studio_e2e`) in the spec's setup (the e2e harness already controls the backend env). Use the same DB-access approach other e2e setup/global-setup code uses; if none exists, add a tiny seeding helper that connects to `MONGO_URL`/`bloom_studio_e2e` and upserts the doc (game_id = the room's game). Tear it down after.

- [ ] **Step 1: Write the e2e spec (RED — it will fail until seeding + UI are correct)**

Create `studio/frontend/e2e/manage-assets-approval.spec.ts` following the existing skill-run e2e spec's structure (room creation, opening the chat pane, invoking a skill via the form). Outline:

```ts
import { test, expect } from '@playwright/test';
import { seedAsset, removeSeed } from './helpers/seed'; // add if no equivalent exists

test.describe('manage-assets approval gate', () => {
  test('Approve removes the asset from the board', async ({ page }) => {
    const { roomUrl, gameId } = await /* create a room via the app/API as other specs do */;
    await seedAsset(gameId, 'e2e-doomed-asset', 'doomed');
    await page.goto(roomUrl);
    // open the Asset Board; assert the doomed asset is visible
    await expect(page.getByText('doomed')).toBeVisible();
    // invoke manage-assets via the composer form (target: "doomed")
    await /* select manage-assets, fill target, submit — mirror the slice-2 form e2e */;
    // approval card appears
    const card = page.getByText(/can't be undone/i);
    await expect(card).toBeVisible();
    await page.getByRole('button', { name: /approve/i }).click();
    // asset removed from the board
    await expect(page.getByText('doomed')).toHaveCount(0);
    await removeSeed(gameId, 'e2e-doomed-asset');
  });

  test('Deny leaves the asset on the board', async ({ page }) => {
    const { roomUrl, gameId } = await /* create a room */;
    await seedAsset(gameId, 'e2e-doomed-asset', 'doomed');
    await page.goto(roomUrl);
    await /* invoke manage-assets with target "doomed" */;
    await expect(page.getByText(/can't be undone/i)).toBeVisible();
    await page.getByRole('button', { name: /deny/i }).click();
    // still present; the run concludes gracefully
    await expect(page.getByText('doomed')).toBeVisible();
    await removeSeed(gameId, 'e2e-doomed-asset');
  });
});
```

Fill the `/* ... */` placeholders by copying the concrete selectors/flow from the existing slice-2 form-invocation e2e spec (skill autocomplete, typed form, submit) and the room-creation helper used across `studio/frontend/e2e`.

- [ ] **Step 2: Start the replay backend and run the suite**

Per `always-run-e2e-before-pr`: bring up the replay backend on :8000 (`just backend-serve-replay`), then:

Run: `just e2e` (or `npx playwright test e2e/manage-assets-approval.spec.ts`)
Expected: the two new cases PASS; the existing e2e suite stays green. Restore the :8000 backend state afterward as the memory describes.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/manage-assets-approval.spec.ts studio/frontend/e2e/helpers/seed.ts
git commit -m "test(e2e): manage-assets approval gate (approve/deny)"
```

---

### Task 15: Full verification + finish the branch

**Files:** none (verification only).

- [ ] **Step 1: Backend suite**

Run (from `studio/backend`): `uv run pytest -q`
Expected: PASS (unit + non-browser e2e).

- [ ] **Step 2: Frontend CI gates** (per `frontend-ci-gates` — all four):

Run (from `studio/frontend`):
- `npx prettier --check .`
- `npx nx typecheck` (or the repo's typecheck command)
- `npx vitest run`
- the build (`npx nx build` or repo equivalent)
Expected: all PASS. (vitest green ≠ types valid — run all four.)

- [ ] **Step 3: Browser e2e** (local, not CI): `just e2e` with the replay backend on :8000. Expected: green, including the new approval specs.

- [ ] **Step 4: Preflight** (per `test-real-parity`): `just preflight` — confirm the backend is not left in replay mode for the next human session (restore live mode / :8000 as needed).

- [ ] **Step 5: Push + open a PR** (per `AGENTS.md` — `main` is protected; default to PR, don't ask):

```bash
git push -u origin feat/agentic-skill-chat-slice-3   # or the branch you implemented on
gh pr create --fill
```

Then `gh pr merge --squash --delete-branch` once checks pass (0 approvals required; self-merge OK).

---

## Notes on coverage & deliberate scope

- **Realtime gate protocol is covered deterministically at the hub/unit level** (Task 6) rather than via a live_server delete e2e, mirroring the repo's existing choice to cover `run_snapshot` at the unit level (see `tests/e2e/test_skill_runs.py` Case 3) — a replay socket delete-e2e would need a dynamic asset id the static cassette can't target. The **Playwright** test (Task 14) provides the real-client end-to-end via a deterministic seeded id.
- **Out of scope (foundation supports them):** always-allow / "don't ask again", edit-args before approval, per-tool policy memory, a durable Mongo checkpointer, additional destructive tools, and a generic per-skill `requires_approval` config UI. The `MemorySaver` → Mongo checkpointer swap and the interrupt payload (`tool`/`args`/`label`) are the documented seams those slices extend.
- **Late-joiner approval card** comes for free: the `approval` step is persisted via `RunStore.append_step`, so the existing `run_snapshot` replay (room_hub `attach_subscriber`) shows a pending approval to a client that joins mid-gate. The hub test in Task 6 can assert this with an extra `attach_subscriber` call if desired.
