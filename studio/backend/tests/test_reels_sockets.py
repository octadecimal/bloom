import pytest
from app.math import templates
from app.scene.reels_spin import FakeSpinRunner
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
    def __init__(self, model=None):
        self._model = model

    async def get_or_seed(self, game_id):
        from types import SimpleNamespace
        return SimpleNamespace(model=self._model or templates.default_model())


@pytest.mark.asyncio
async def test_add_module_with_no_realized_model_derives_from_the_seeded_template():
    # No per-game SlotModel yet -> get_or_seed returns the default template
    # (video-5x3: 5 reels x 3 rows) and the handler derives the declaration from it.
    sio, hub = FakeSio(), FakeHub()
    register_scene_handlers(sio, hub, None, FakeModelStore(None),
                            FakeSpinRunner(result={"grid": [[0]], "basePayout": 0, "totalPayout": 0}))
    await sio.handlers["scene_add_module"]("sid", {"gameId": "g1"})
    assert hub.modules == [{"id": "reels", "type": "reels",
                            "config": {"cols": 5, "rows": 3,
                                       "symbols": ["0", "1", "2", "3", "4", "5", "9"],
                                       "parentId": "root"}}]


@pytest.mark.asyncio
async def test_spin_maps_kernel_grid_to_string_outcome():
    sio, hub = FakeSio(), FakeHub()
    runner = FakeSpinRunner(result={"grid": [[0, 1, 2], [9, 0, 1], [2, 2, 2]],
                                    "basePayout": 0, "totalPayout": 0})
    register_scene_handlers(sio, hub, None, FakeModelStore(templates.get_model("classic-3x3")), runner)
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1", "seed": 42})
    event, data, room = sio.emitted[-1]
    assert event == "scene_spin_outcome"
    assert room == "g1"
    assert data["outcome"]["grid"] == [["0", "1", "2"], ["9", "0", "1"], ["2", "2", "2"]]
