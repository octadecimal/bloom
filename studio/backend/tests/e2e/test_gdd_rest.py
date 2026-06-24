import httpx
import pytest


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_gdd_docs_endpoint_returns_empty_list_for_new_game(live_server):
    async with httpx.AsyncClient(base_url=live_server) as http:
        # Create a game implicitly via POST /rooms (auto-creates a game)
        room = (await http.post("/rooms", json={"name": "GddRest"})).json()
        game_id = room["gameId"]
        res = await http.get(f"/games/{game_id}/gdd/docs")
        assert res.status_code == 200
        assert res.json() == []  # nothing seeded until a design-game run starts
