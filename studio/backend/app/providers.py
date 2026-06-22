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


def build_chat_model(settings: Settings, model: str) -> BaseChatModel:
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
