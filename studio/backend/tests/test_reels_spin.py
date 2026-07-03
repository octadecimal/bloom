import pytest
from app.math import templates
from app.scene.reels_spin import derive_reels_config, map_grid, FakeSpinRunner


def test_classic_template_shape():
    m = templates.get_model("classic-3x3")
    assert len(m["reels"]) == 3
    assert m["rows"] == 3
    assert {s["id"] for s in m["symbols"]} == {0, 1, 2, 9}


def test_derive_config_from_model():
    cfg = derive_reels_config(templates.get_model("classic-3x3"))
    assert cfg == {"cols": 3, "rows": 3, "symbols": ["0", "1", "2", "9"], "parentId": "root"}


def test_derive_config_falls_back_on_empty_model():
    cfg = derive_reels_config({})
    assert cfg["cols"] == 5 and cfg["rows"] == 3 and cfg["parentId"] == "root"
    assert cfg["symbols"] == ["0", "1", "2", "3", "4"]


def test_map_grid_ids_to_strings_without_transpose():
    assert map_grid([[0, 1, 2], [9, 0, 1]]) == [["0", "1", "2"], ["9", "0", "1"]]


@pytest.mark.asyncio
async def test_fake_runner_returns_its_result():
    runner = FakeSpinRunner(result={"grid": [[0, 0, 0]], "basePayout": 0, "totalPayout": 0})
    out = await runner.run(templates.get_model("classic-3x3"), 7)
    assert out["grid"] == [[0, 0, 0]]
