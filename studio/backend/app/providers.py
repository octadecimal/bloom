import asyncio
from typing import AsyncIterator, Protocol

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR, load_llm_cassettes, normalize_prompt,
)

ERROR_SENTINEL_MODEL = "bloom/force-error"


class LLMProvider(Protocol):
    def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]: ...


class ReplayLLMProvider:
    """Replays recorded-real streamed completions captured from the live provider."""

    def __init__(self, cassettes: dict[str, list[str]], delay: float = 0.0):
        self._cassettes = cassettes
        self._delay = delay

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        if model == ERROR_SENTINEL_MODEL:
            raise RuntimeError("forced replay error (sentinel model)")
        last = turns[-1]["content"] if turns else ""
        chunks = self._cassettes.get(normalize_prompt(last)) or self._cassettes.get("__default__") or []
        for chunk in chunks:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield chunk


class LiveOpenRouterProvider:
    """Streams via langchain-openai's ChatOpenAI pointed at OpenRouter."""

    def __init__(self, api_key: str, base_url: str):
        self._api_key = api_key
        self._base_url = base_url

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        from langchain_core.messages import AIMessage, HumanMessage
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=model, api_key=self._api_key, base_url=self._base_url, streaming=True)
        lc_messages = [
            HumanMessage(t["content"]) if t["role"] == "user" else AIMessage(t["content"])
            for t in turns
        ]
        async for chunk in llm.astream(lc_messages):
            text = chunk.content
            if text:
                yield text


def build_provider(settings: Settings) -> LLMProvider:
    if settings.provider_mode == "replay":
        return ReplayLLMProvider(
            load_llm_cassettes(DEFAULT_FIXTURES_DIR),
            delay=settings.replay_token_delay,
        )
    return LiveOpenRouterProvider(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )


# ---------------------------------------------------------------------------
# Tool-capable chat-model seam (Task 4+)
# ---------------------------------------------------------------------------

from typing import Any, Optional

from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult


class ReplayToolCallingChatModel(BaseChatModel):
    """Replay chat model with two modes.

    * **Tool mode** (`bind_tools` was called, i.e. a skill run): reproduces the
      recorded agentic turn from the *run* cassette — a tool-call turn followed
      by the final reply.
    * **Text mode** (no tools bound, i.e. plain chat): reproduces the legacy
      ``ReplayLLMProvider`` behavior — looks up the prompt-keyed *LLM* cassette
      by the last Human message and streams those chunks as plain text.

    Text mode requires LLM cassettes to be present; when none were supplied
    (e.g. the provider unit tests that construct the model with only a run
    cassette) the model falls back to run-cassette behavior so those existing
    contracts are preserved.
    """

    cassette: dict
    llm_cassettes: dict = {}
    replay_token_delay: float = 0.0
    model: str = ""
    _has_tools: bool = False

    @property
    def _llm_type(self) -> str:
        return "replay-tool-calling"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        raise NotImplementedError("async only")

    def bind_tools(self, tools, *, tool_choice=None, **kwargs):
        """Record that tools were bound (a skill run); the replay model knows its
        tool calls from the run cassette and ignores the actual tool objects."""
        self._has_tools = bool(tools)
        return self

    def _text_mode(self) -> bool:
        return not self._has_tools and bool(self.llm_cassettes)

    def _text_chunks(self, messages: list[BaseMessage]) -> list[str]:
        last_human = ""
        for m in messages:
            if isinstance(m, HumanMessage):
                last_human = m.content if isinstance(m.content, str) else str(m.content)
        key = normalize_prompt(last_human)
        return (
            self.llm_cassettes.get(key)
            or self.llm_cassettes.get("__default__")
            or []
        )

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Optional[AsyncCallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        if self.model == ERROR_SENTINEL_MODEL:
            raise RuntimeError("forced replay error (sentinel model)")
        if self._text_mode():
            msg = AIMessage(content="".join(self._text_chunks(messages)))
            return ChatResult(generations=[ChatGeneration(message=msg)])
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

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: Optional[list[str]] = None,
        run_manager: Optional[AsyncCallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ):
        """Stream tokens for the final reply; tool-call turn uses _agenerate (no streaming)."""
        if self.model == ERROR_SENTINEL_MODEL:
            raise RuntimeError("forced replay error (sentinel model)")
        if self._text_mode():
            # Plain chat: stream prompt-keyed LLM cassette chunks as plain text,
            # mirroring ReplayLLMProvider (incl. the per-chunk replay delay that
            # keeps timing-dependent behavior — e.g. late-joiner resume — intact).
            for token in self._text_chunks(messages):
                if self.replay_token_delay:
                    await asyncio.sleep(self.replay_token_delay)
                chunk = AIMessageChunk(content=token)
                if run_manager:
                    await run_manager.on_llm_new_token(token, chunk=chunk)
                yield ChatGenerationChunk(message=chunk)
            return
        has_tool_result = any(isinstance(m, ToolMessage) for m in messages)
        if not has_tool_result and self.cassette.get("tool_calls"):
            # First turn: emit a single non-streaming tool-call chunk
            result = await self._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
            msg = result.generations[0].message
            yield ChatGenerationChunk(message=AIMessageChunk(content=msg.content, tool_calls=msg.tool_calls))
        else:
            # Final turn: stream each token from the cassette
            for token in self.cassette.get("final", ["ok"]):
                chunk = AIMessageChunk(content=token)
                if run_manager:
                    await run_manager.on_llm_new_token(token, chunk=chunk)
                yield ChatGenerationChunk(message=chunk)


def build_chat_model(settings: Settings, model: str) -> BaseChatModel:
    if settings.provider_mode == "replay":
        from app.replay.cassette import DEFAULT_FIXTURES_DIR, load_run_cassette

        return ReplayToolCallingChatModel(
            cassette=load_run_cassette(DEFAULT_FIXTURES_DIR),
            llm_cassettes=load_llm_cassettes(DEFAULT_FIXTURES_DIR),
            replay_token_delay=settings.replay_token_delay,
            model=model,
        )
    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=model,
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        streaming=True,
    )
