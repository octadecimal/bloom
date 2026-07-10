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


class FakeComposeStore:
    def __init__(self, doc=None):
        self._doc = doc

    async def get(self, game_id):
        return self._doc


class FakeDoc:
    def __init__(self):
        self.definition = {"family": "composed@1"}
        self.presentation = {}


class FakeComposedSpin:
    def __init__(self, result=None, error=None):
        self._result, self._error = result, error
        self.calls: list[str] = []

    async def spin(self, package_id):
        self.calls.append(package_id)
        if self._error:
            raise self._error
        return self._result


class FailingSpinRunner:
    async def run(self, model, seed):
        raise AssertionError("legacy spin must not run for composed games")


@pytest.mark.asyncio
async def test_composed_game_spin_proxies_to_the_runtime_server():
    sio, hub = FakeSio(), FakeHub()
    round_ = {"seed": "11", "outcome": {"mechanic": "composed@1", "total_payout": 5},
              "trace": [{"t": "round_end", "total_payout": 5}]}
    spin = FakeComposedSpin(result=round_)
    register_scene_handlers(sio, hub, None, FakeModelStore(), FailingSpinRunner(),
                            FakeComposeStore(FakeDoc()), spin)
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1"})
    assert spin.calls == ["g1"]
    event, data, room = sio.emitted[-1]
    assert event == "scene_spin_trace" and room == "g1"
    assert data["trace"][-1]["t"] == "round_end"


@pytest.mark.asyncio
async def test_composed_spin_failure_emits_scene_spin_error():
    from app.scene.composed_spin import ComposedSpinError
    sio, hub = FakeSio(), FakeHub()
    spin = FakeComposedSpin(error=ComposedSpinError("runtime server unreachable"))
    register_scene_handlers(sio, hub, None, FakeModelStore(), FailingSpinRunner(),
                            FakeComposeStore(FakeDoc()), spin)
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1"})
    event, data, _ = sio.emitted[-1]
    assert event == "scene_spin_error"
    assert "unreachable" in data["message"]


@pytest.mark.asyncio
async def test_game_without_definition_keeps_the_legacy_slotmodel_spin():
    # compose_store.get -> None must land on spin_runner + scene_spin_outcome
    # exactly as before the composed-routing change.
    sio, hub = FakeSio(), FakeHub()
    runner = FakeSpinRunner(result={"grid": [[0, 1, 2], [9, 0, 1], [2, 2, 2]],
                                    "basePayout": 0, "totalPayout": 0})
    register_scene_handlers(sio, hub, None, FakeModelStore(templates.get_model("classic-3x3")),
                            runner, FakeComposeStore(None), FakeComposedSpin())
    await sio.handlers["scene_spin"]("sid", {"gameId": "g1", "seed": 42})
    event, data, room = sio.emitted[-1]
    assert event == "scene_spin_outcome"
    assert room == "g1"
    assert data["outcome"]["grid"] == [["0", "1", "2"], ["9", "0", "1"], ["2", "2", "2"]]


@pytest.mark.asyncio
async def test_scene_add_module_handler_is_gone():
    sio, hub = FakeSio(), FakeHub()
    register_scene_handlers(sio, hub, None, FakeModelStore(), FakeSpinRunner(result={}),
                            FakeComposeStore(None), FakeComposedSpin())
    assert "scene_add_module" not in sio.handlers
