import logging
from dataclasses import dataclass
from typing import AsyncIterator, Optional

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import create_react_agent
from langgraph.types import Command

logger = logging.getLogger(__name__)

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


@dataclass
class ApprovalRequired:
    action: dict
    index: int


RunEvent = object  # documentation alias


class TurnRunner:
    def __init__(self, chat_model_factory, tool_factory):
        self._model_factory = chat_model_factory
        self._tools = tool_factory

    async def run(self, *, messages, model, skill, args, ctx, run_id=None, on_approval=None) -> AsyncIterator[RunEvent]:
        if not (skill and skill.tools):
            # No-tool path (plain chat): stream the chat model directly without
            # building a react agent or binding tools. The model is used WITHOUT
            # bind_tools, so the replay model stays in text mode and reproduces
            # the legacy prompt-keyed LLM-cassette behavior. No system prompt is
            # added so the replay prompt-key falls on the last human message,
            # matching the existing plain-chat behavior.
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
                approval_index = state["index"]; state["index"] += 1
                yield ApprovalRequired(pending, approval_index)
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

    async def _run_no_tools(self, messages, model) -> AsyncIterator[RunEvent]:
        """Stream the chat model directly for the no-tool (plain chat) path."""
        chat_model = self._model_factory(model)
        lc = [
            HumanMessage(m["content"]) if m["role"] == "user" else AIMessage(m["content"])
            for m in messages
        ]
        text_open = False
        text_buf = ""
        status = "completed"
        try:
            async for chunk in chat_model.astream(lc):
                delta = getattr(chunk, "content", "") or ""
                if not delta:
                    continue
                if not text_open:
                    text_open = True
                    yield StepStarted(0, "final")
                text_buf += delta
                yield StepToken(0, delta)
            if text_open:
                yield StepCompleted(0, "complete", text_buf)
        except Exception:
            logger.exception("plain chat run failed")
            status = "error"
            if text_open:
                yield StepCompleted(0, "error", text_buf)
        yield RunFinished(status)
