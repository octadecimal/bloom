import asyncio
import json as _json
from typing import TypedDict

import pytest
from langgraph.types import Command
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START

from app.agent_tools import ToolContext, ToolFactory


def _question_tool():
    factory = ToolFactory(asset_store=None, asset_hub=None)
    ctx = ToolContext("r1", "g1", None, None)
    return factory.build(["ask_user_question"], ctx)[0]


@pytest.mark.asyncio
async def test_ask_user_question_is_registered():
    tool = _question_tool()
    assert tool.name == "ask_user_question"


@pytest.mark.asyncio
async def test_resume_with_suggestion_returns_value():
    """Drive the tool through a tiny LangGraph so interrupt() can resume."""
    tool = _question_tool()

    class S(TypedDict):
        out: str

    async def node(state: S) -> S:
        ans = await tool.ainvoke({"question": "RTP target?",
                                  "suggestions": ["96%", "94%"]})
        return {"out": ans}

    g = StateGraph(S)
    g.add_node("ask", node)
    g.add_edge(START, "ask")
    app = g.compile(checkpointer=MemorySaver())
    cfg = {"configurable": {"thread_id": "t1"}}

    # First pass parks at the interrupt.
    await app.ainvoke({"out": ""}, cfg)
    # Resume with a chosen suggestion.
    final = await app.ainvoke(
        Command(resume={"type": "suggestion", "value": "96%"}), cfg
    )
    assert final["out"] == "96%"


@pytest.mark.asyncio
async def test_resume_with_delegate_returns_sentinel():
    tool = _question_tool()

    class S(TypedDict):
        out: str

    async def node(state: S) -> S:
        return {"out": await tool.ainvoke({"question": "Volatility?"})}

    g = StateGraph(S)
    g.add_node("ask", node)
    g.add_edge(START, "ask")
    app = g.compile(checkpointer=MemorySaver())
    cfg = {"configurable": {"thread_id": "t2"}}
    await app.ainvoke({"out": ""}, cfg)
    final = await app.ainvoke(Command(resume={"type": "delegate"}), cfg)
    assert "judgment" in final["out"].lower()


# --- RoomHub-level question-gate coverage (spec §10) ---------------------
# Mirrors the existing approval-gate test in test_room_hub.py, but drives a
# gated runner that yields ApprovalRequired with an action whose kind=="question"
# and resolves it via hub.resolve_question with an answer dict.

from app.room_hub import RoomHub
from app.turn_runner import (
    ApprovalRequired,
    StepStarted,
    StepCompleted,
    RunFinished,
)
from tests.test_room_hub import (
    FakeSio,
    SkillFakeStore,
    GatedChatService,
    FakeSkillsWithManageAssets,
    _wait,
    _wait_event,
)


class _QuestionRunner:
    """Yields an ApprovalRequired carrying a question action (index=1), awaits
    on_approval (which parks until resolve_question), then finishes."""

    def __init__(self):
        self.answer = None

    async def run(self, *, messages, model, skill, args, ctx, run_id=None, on_approval=None):
        action = {
            "kind": "question",
            "tool": "ask_user_question",
            "question": "RTP target?",
            "suggestions": ["96%", "94%"],
        }
        # index=0 reserved for the question step
        yield ApprovalRequired(action, 0)
        answer = await on_approval(action)
        self.answer = answer
        yield StepStarted(1, "final")
        yield StepCompleted(1, "complete", f"answer={answer}")
        yield RunFinished("completed")


def _build_question_hub(mongo_db, runner):
    from app.runs import RunStore
    sio = FakeSio()
    store = SkillFakeStore()
    chat = GatedChatService()
    run_store = RunStore(mongo_db)
    skills = FakeSkillsWithManageAssets()
    hub = RoomHub(sio, store, chat, run_store=run_store, turn_runner=runner, skills=skills)
    return hub


@pytest.mark.asyncio
async def test_skill_run_emits_question_step_and_resolves(mongo_db):
    runner = _QuestionRunner()
    hub = _build_question_hub(mongo_db, runner)
    sio = hub._sio

    await hub.handle_skill_run("r1", "Alice", "manage-assets", {"target": "knight"})

    # Wait until the question run_step_started event appears.
    await asyncio.wait_for(
        _wait(lambda: any(
            e == "run_step_started" and d.get("step", {}).get("type") == "question"
            for e, d, _ in sio.events
        )),
        timeout=2,
    )

    run_id = next(d["run"]["id"] for e, d, _ in sio.events if e == "run_started")

    # Resolve the parked question with an answer dict.
    answer = {"type": "suggestion", "value": "96%"}
    await hub.resolve_question("r1", run_id, answer)

    await asyncio.wait_for(_wait_event(sio, "run_completed"), timeout=2)

    # Run completed successfully and the runner received the answer dict.
    completed_events = [(e, d) for e, d, _ in sio.events if e == "run_completed"]
    assert completed_events and completed_events[-1][1]["status"] == "completed"
    assert runner.answer == answer

    # The question step started at index 0.
    question_started = [
        d for e, d, _ in sio.events
        if e == "run_step_started" and d.get("step", {}).get("type") == "question"
    ]
    assert question_started and question_started[0]["step"]["index"] == 0

    # run_step_completed at stepIndex=0 carries the answer in its content.
    question_completed = [
        d for e, d, _ in sio.events
        if e == "run_step_completed" and d.get("stepIndex") == 0
    ]
    assert question_completed, "run_step_completed for question step must be emitted"
    content = _json.loads(question_completed[0]["content"])
    assert content.get("answer") == answer
    assert content.get("question") == "RTP target?"  # action preserved


@pytest.mark.asyncio
async def test_resolve_question_ignored_for_approval_kind(mongo_db):
    """resolve_question must not resolve a non-question (approval) entry."""
    runner = _QuestionRunner()
    hub = _build_question_hub(mongo_db, runner)
    # Register a fake approval entry (no kind) and confirm resolve_question is a no-op.
    loop = asyncio.get_running_loop()
    fut = loop.create_future()
    hub._pending_approvals["runX"] = {"future": fut, "step_index": 1, "action": {}}
    await hub.resolve_question("r1", "runX", {"type": "suggestion", "value": "x"})
    assert not fut.done()
    fut.cancel()
