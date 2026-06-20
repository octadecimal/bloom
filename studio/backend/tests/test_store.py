import pytest

from app.store import ConversationStore


@pytest.mark.asyncio
async def test_create_and_get_room(mongo_db):
    store = ConversationStore(mongo_db)
    room = await store.create_room(name="General", model="m:free")
    assert room.id
    assert room.game_id is None

    fetched = await store.get_room(room.id)
    assert fetched is not None
    assert fetched.name == "General"


@pytest.mark.asyncio
async def test_messages_round_trip_in_order(mongo_db):
    store = ConversationStore(mongo_db)
    room = await store.create_room(name="R", model="m:free")

    await store.add_message(room.id, "Alice", "user", "hello", "complete")
    assistant = await store.add_message(room.id, "assistant", "assistant", "", "streaming")
    await store.complete_message(assistant.id, "hi there")

    messages = await store.list_messages(room.id)
    assert [m.content for m in messages] == ["hello", "hi there"]
    assert messages[1].status == "complete"
