from app.agent_tools import ToolContext


def test_tool_context_carries_critic_and_capture_broker():
    sentinel_critic = object()
    sentinel_broker = object()
    ctx = ToolContext(
        "r1", "g1", None, None,
        scene_critic=sentinel_critic, capture_broker=sentinel_broker,
    )
    assert ctx.scene_critic is sentinel_critic
    assert ctx.capture_broker is sentinel_broker


def test_tool_context_critic_and_broker_default_to_none():
    ctx = ToolContext("r1", "g1", None, None)
    assert ctx.scene_critic is None
    assert ctx.capture_broker is None
