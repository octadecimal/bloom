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
    # index contract: approval reserves its own slot, no collision with step indices
    assert approval.index == 1
    started = [(e.index, e.type) for e in events if type(e).__name__ == "StepStarted"]
    assert started == [(0, "tool_call"), (2, "tool_result"), (3, "final")]
    assert sorted([i for i, _ in started] + [approval.index]) == [0, 1, 2, 3]


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
