import asyncio
import pytest
from app.scene.hub import GameSceneHub


class _FakeStore:
    """Reproduces apply_op's read-modify-write with a yield point in the middle."""
    def __init__(self):
        self.docs = {}

    async def get_or_create(self, game_id):
        return self.docs.setdefault(game_id, {"version": 1, "nodes": {}, "edges": []})

    async def apply_op(self, game_id, op):
        doc = await self.get_or_create(game_id)
        nodes = dict(doc["nodes"])          # read
        await asyncio.sleep(0)              # yield — lets a racing op interleave
        nodes[op["id"]] = {"id": op["id"], "type": op["type"], "props": {}}
        self.docs[game_id] = {"version": doc["version"] + 1, "nodes": nodes, "edges": doc["edges"]}
        return self.docs[game_id]

    async def apply_batch(self, game_id, ops):
        for op in ops:
            await self.apply_op(game_id, op)
        return self.docs[game_id]


class _FakeSio:
    async def emit(self, *a, **k):
        return None


@pytest.mark.asyncio
async def test_concurrent_apply_op_does_not_lose_updates():
    hub = GameSceneHub(_FakeSio(), _FakeStore())
    ops = [{"kind": "addNode", "id": f"n{i}", "type": "Container"} for i in range(20)]
    await asyncio.gather(*(hub.apply_op("g1", op) for op in ops))
    doc = await hub._store.get_or_create("g1")
    assert len(doc["nodes"]) == 20
    assert doc["version"] == 21  # 1 seed + 20 applied
