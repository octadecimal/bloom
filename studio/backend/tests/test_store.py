from datetime import datetime, timezone

import pytest

from app.games import GameStore
from app.store import ConversationStore


def _legacy_room_doc(room_id: str, name: str) -> dict:
    # A room inserted before per-room games existed: no game_id field at all.
    return {"_id": room_id, "name": name, "model": "m", "created_at": datetime.now(timezone.utc)}


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
async def test_list_rooms_backfills_missing_game_id(mongo_db):
    # Legacy rooms predate per-room games; the board must still bind to a game.
    games = GameStore(mongo_db)
    store = ConversationStore(mongo_db, games)
    await mongo_db["rooms"].insert_one(_legacy_room_doc("legacy1", "Legacy"))

    rooms = await store.list_rooms()
    legacy = next(r for r in rooms if r.id == "legacy1")
    assert legacy.game_id is not None  # backfilled on read

    game = await games.get_game(legacy.game_id)
    assert game is not None
    assert game.name == "Legacy"  # game named after the room

    # Persisted + idempotent: a second read keeps the same game, makes no new one.
    rooms_again = await store.list_rooms()
    legacy_again = next(r for r in rooms_again if r.id == "legacy1")
    assert legacy_again.game_id == legacy.game_id
    assert len(await games.list_games()) == 1


@pytest.mark.asyncio
async def test_get_room_backfills_missing_game_id(mongo_db):
    games = GameStore(mongo_db)
    store = ConversationStore(mongo_db, games)
    await mongo_db["rooms"].insert_one(_legacy_room_doc("legacy2", "Legacy2"))

    room = await store.get_room("legacy2")
    assert room is not None
    assert room.game_id is not None
    assert (await games.get_game(room.game_id)) is not None


@pytest.mark.asyncio
async def test_list_rooms_without_games_store_leaves_game_id_none(mongo_db):
    # A store with no games dependency must not crash or fabricate ids (back-compat).
    store = ConversationStore(mongo_db)
    await mongo_db["rooms"].insert_one(_legacy_room_doc("legacy3", "Legacy3"))

    rooms = await store.list_rooms()
    legacy = next(r for r in rooms if r.id == "legacy3")
    assert legacy.game_id is None


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
