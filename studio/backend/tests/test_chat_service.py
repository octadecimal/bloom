from datetime import datetime, timezone

import pytest

from app.chat_service import ChatService, build_turns
from app.models import Message
from app.providers import ReplayLLMProvider


def _msg(author, role, content):
    return Message(
        id=f"{author}-{content}",
        room_id="r1",
        author=author,
        role=role,
        content=content,
        status="complete",
        created_at=datetime.now(timezone.utc),
    )


def test_build_turns_attributes_user_messages():
    messages = [
        _msg("Alice", "user", "hello"),
        _msg("assistant", "assistant", "hi"),
    ]
    turns = build_turns(messages)
    assert turns == [
        {"role": "user", "content": "Alice: hello"},
        {"role": "assistant", "content": "hi"},
    ]


@pytest.mark.asyncio
async def test_chat_service_streams_tokens():
    cassettes = {"bob: ping": ["pong", " response"], "__default__": ["ok"]}
    service = ChatService(ReplayLLMProvider(cassettes, delay=0.0))
    messages = [_msg("Bob", "user", "ping")]
    tokens = [tok async for tok in service.stream(messages, "m:free")]
    assert len(tokens) > 0
    assert "".join(tokens) != ""
