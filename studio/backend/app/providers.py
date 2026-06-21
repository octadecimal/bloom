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
