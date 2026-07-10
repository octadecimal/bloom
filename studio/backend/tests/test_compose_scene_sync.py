import pytest

from app.compose.scene_sync import derive_scene_modules, sync_scene_modules, DEFAULT_CANVAS


def _definition():
    return {
        "family": "composed@1",
        "mechanics": [
            {"id": "main_reels", "type": "reels@1",
             "config": {"strips": [[0, 1], [1, 2], [2, 0]], "rows": 3,
                        "symbols": [{"id": 0, "role": "normal"}, {"id": 1, "role": "normal"},
                                    {"id": 2, "role": "normal"}, {"id": 9, "role": "scatter"}]}},
            {"id": "bonus_meter", "type": "meter@1",
             "config": {"target": 6, "count_symbol": 9, "reset_on_full": True}},
        ],
    }


def test_reels_config_prefers_the_presentation_manifest():
    pres = {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}
    mods = derive_scene_modules(_definition(), pres)
    reels = next(m for m in mods if m["type"] == "reels")
    assert reels["id"] == "main_reels"
    assert reels["config"] == {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}


def test_reels_config_falls_back_to_the_mechanic_config():
    mods = derive_scene_modules(_definition(), None)
    reels = next(m for m in mods if m["type"] == "reels")
    assert reels["config"] == {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}


def test_meter_maps_target_and_skips_non_numeric():
    mods = derive_scene_modules(_definition(), None)
    meter = next(m for m in mods if m["type"] == "meter")
    assert meter == {"id": "bonus_meter", "type": "meter", "config": {"target": 6}}
    broken = _definition()
    broken["mechanics"][1]["config"]["target"] = "six"
    assert all(m["type"] != "meter" for m in derive_scene_modules(broken, None))


def test_unknown_mechanics_and_empty_definitions_are_skipped():
    d = _definition()
    d["mechanics"].append({"id": "x", "type": "wheel@1", "config": {}})
    assert len(derive_scene_modules(d, None)) == 2
    assert derive_scene_modules(None, None) == []
    assert derive_scene_modules({}, None) == []


class FakeHub:
    def __init__(self):
        self.roots: list[tuple[str, tuple[int, int]]] = []
        self.modules: list[tuple[str, list[dict]]] = []

    async def ensure_root(self, game_id, canvas):
        self.roots.append((game_id, canvas))
        return {"root_id": "root", "canvas": canvas}

    async def set_modules(self, game_id, modules):
        self.modules.append((game_id, modules))
        return {}


@pytest.mark.asyncio
async def test_sync_scene_modules_ensures_root_then_sets_modules():
    hub = FakeHub()
    await sync_scene_modules(hub, "g1", _definition(), None)
    assert hub.roots == [("g1", DEFAULT_CANVAS)]
    assert hub.modules[0][0] == "g1"
    assert [m["id"] for m in hub.modules[0][1]] == ["main_reels", "bonus_meter"]
