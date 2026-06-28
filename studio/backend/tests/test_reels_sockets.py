import pytest
from app.scene.reels_spin import DEMO_SLOT_MODEL, FakeSpinRunner
from app.scene.sockets import register_scene_handlers


class FakeSio:
    def __init__(self):
        self.handlers = {}
        self.emitted = []

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn
        return deco

    def event(self, fn):
        self.handlers[fn.__name__] = fn
        return fn

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room or to))

    async def enter_room(self, sid, room):
        pass


class FakeHub:
    def __init__(self):
        self.modules = None

    async def ensure_root(self, game_id, canvas):
        return {"root_id": "root", "canvas": canvas}

    async def set_modules(self, game_id, modules):
        self.modules = modules
        return {"version": 1, "nodes": {}, "edges": [], "modules": modules}


class FakeModelStore:
    def __init__(self, model):
        self._model = model

    async def get(self, game_id):
        from types import SimpleNamespace
        return None if self._model is None else SimpleNamespace(model=self._model)


@pytest.mark.asyncio
async def test_add_module_with_no_realized_model_derives_from_the_demo_model():
    # No per-game SlotModel yet -> the handler falls back to DEMO_SLOT_MODEL
    # (3 reels x 3 rows, symbols 0,1,2,9) and derives the declaration from it.
    sio, hub = FakeSio(), FakeHub()
    register_scene_handlers(sio, hub, None, FakeModelStore(None),
                            FakeSpinRunner(result={"grid": [[0]], "basePayout": 0, "totalPayout": 0}))
    await sio.handlers["scene_add_module"]("sid", {"gameId": "g1"})
    assert hub.modules == [{"id": "reels", "type": "reels",
                            "config": {"cols": 3, "rows": 3,
                                       "symbols": ["0", "1", "2", "9"], "parentId": "root"}}]


@pytest.mark.asyncio
async def test_spin_maps_kernel_grid_to_string_outcome():
    sio, hub = FakeSio(), FakeHub()
    runner = FakeSpinRunner(result={"grid": [[0, 1, 2], [9, 0, 1], [2, 2, 2]],
                                    "basePayout": 0, "totalPayout": 0})
    register_scene_handlers(sio, hub, None, FakeModelStore(DEMO_SLOT_MODEL), runner)
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1", "seed": 42})
    event, data, room = sio.emitted[-1]
    assert event == "scene_spin_outcome"
    assert room == "g1"
    assert data["outcome"]["grid"] == [["0", "1", "2"], ["9", "0", "1"], ["2", "2", "2"]]
