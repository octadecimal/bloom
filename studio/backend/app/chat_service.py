from typing import AsyncIterator

from app.models import Message
from app.providers import LLMProvider


def build_turns(messages: list[Message]) -> list[dict]:
    turns: list[dict] = []
    for m in messages:
        if m.role == "user":
            turns.append({"role": "user", "content": f"{m.author}: {m.content}"})
        else:
            turns.append({"role": "assistant", "content": m.content})
    return turns


class ChatService:
    def __init__(self, provider: LLMProvider):
        self._provider = provider

    async def stream(self, messages: list[Message], model: str) -> AsyncIterator[str]:
        async for token in self._provider.stream(build_turns(messages), model):
            yield token
