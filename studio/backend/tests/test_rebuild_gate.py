import pytest

import app.agent_tools as at
from app.agent_tools import ToolContext


class _DocStore:
    async def get_document(self, game_id):
        return {"nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.reels": {"id": "spr.reels", "type": "Sprite",
                          "props": {"role": "reels", "position": {"x": 10, "y": 10}}},
        }}


def _ctx():
    return ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                       gdd_store=None, scene_store=_DocStore())


@pytest.mark.asyncio
async def test_gate_denied_does_not_rebuild(monkeypatch):
    monkeypatch.setattr(at, "interrupt", lambda payload: "deny")
    ran = {"core": False}

    async def _fake_core(ctx, theme=""):
        ran["core"] = True
        return "Rebuilt scene from current design intent. ok"

    monkeypatch.setattr(at, "rebuild_scene_core", _fake_core)
    tool = at.build_rebuild_scene_tool(_ctx())
    out = await tool.coroutine(theme="")
    assert "cancelled" in out.lower()
    assert ran["core"] is False


@pytest.mark.asyncio
async def test_gate_approved_runs_rebuild_with_summary_label(monkeypatch):
    seen = {}
    monkeypatch.setattr(at, "interrupt", lambda payload: seen.setdefault("p", payload) and "approve" or "approve")

    async def _fake_core(ctx, theme=""):
        return "Rebuilt scene from current design intent. ok"

    monkeypatch.setattr(at, "rebuild_scene_core", _fake_core)
    tool = at.build_rebuild_scene_tool(_ctx())
    out = await tool.coroutine(theme="")
    assert "Rebuilt scene" in out
    assert seen["p"]["tool"] == "rebuild_scene"
    assert "reels:" in seen["p"]["label"]  # summary carried in the interrupt label


@pytest.mark.asyncio
async def test_gate_skipped_on_empty_scene(monkeypatch):
    calls = {"interrupt": 0}
    monkeypatch.setattr(at, "interrupt", lambda payload: calls.__setitem__("interrupt", calls["interrupt"] + 1) or "deny")

    class _Empty:
        async def get_document(self, game_id):
            return {"nodes": {}}

    ctx = ToolContext(room_id="", game_id="g1", asset_store=None, asset_hub=None,
                      gdd_store=None, scene_store=_Empty(), scene_critic=None, asset_critic=None)
    tool = at.build_rebuild_scene_tool(ctx)
    out = await tool.coroutine(theme="")
    assert calls["interrupt"] == 0            # no gate when nothing is placed
    assert "Rebuild unavailable" in out or "Nothing to rebuild" in out
