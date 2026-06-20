import pytest

from app.games import GameStore
from app.store import ConversationStore


@pytest.mark.asyncio
async def test_create_and_list_games(mongo_db):
    store = GameStore(mongo_db)
    game = await store.create_game(name="Zombie Slots")
    assert game.id
    assert game.name == "Zombie Slots"

    games = await store.list_games()
    assert [g.id for g in games] == [game.id]

    fetched = await store.get_game(game.id)
    assert fetched is not None and fetched.name == "Zombie Slots"


@pytest.mark.asyncio
async def test_create_room_also_creates_game(mongo_db):
    games = GameStore(mongo_db)
    store = ConversationStore(mongo_db, games)
    room = await store.create_room(name="My Slot", model="m:free")

    assert room.game_id is not None
    game = await games.get_game(room.game_id)
    assert game is not None and game.name == "My Slot"
