from app.agent_tools import ToolContext


def test_toolcontext_has_scene_art_critic_field():
    ctx = ToolContext("r", "g", None, None)
    assert ctx.scene_art_critic is None
    ctx2 = ToolContext("r", "g", None, None, scene_art_critic="sentinel")
    assert ctx2.scene_art_critic == "sentinel"
