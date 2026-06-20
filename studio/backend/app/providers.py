import asyncio
from typing import AsyncIterator, Protocol

from app.config import Settings


class LLMProvider(Protocol):
    def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]: ...


class FakeProvider:
    """Deterministic streaming provider for tests/CI. Echoes the last turn."""

    def __init__(self, delay: float = 0.0):
        self._delay = delay

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        last = turns[-1]["content"] if turns else ""
        reply = f"echo: {last}"
        for word in reply.split(" "):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield word + " "


class LangchainOpenRouterProvider:
    """Streams via langchain-openai's ChatOpenAI pointed at OpenRouter."""

    def __init__(self, api_key: str, base_url: str):
        self._api_key = api_key
        self._base_url = base_url

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        from langchain_core.messages import AIMessage, HumanMessage
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(
            model=model,
            api_key=self._api_key,
            base_url=self._base_url,
            streaming=True,
        )
        lc_messages = [
            HumanMessage(t["content"]) if t["role"] == "user" else AIMessage(t["content"])
            for t in turns
        ]
        async for chunk in llm.astream(lc_messages):
            text = chunk.content
            if text:
                yield text


def build_provider(settings: Settings) -> LLMProvider:
    if settings.llm_backend == "fake":
        return FakeProvider(delay=settings.fake_token_delay)
    return LangchainOpenRouterProvider(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )
