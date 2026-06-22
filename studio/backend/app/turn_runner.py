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
