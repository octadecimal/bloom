from app.config import Settings
from app.main import build


def test_build_wires_scene_tools_into_factory():
    ctx = build(Settings(provider_mode="replay", mongo_db="bloom_studio_test"))
    names = ctx.hub._tool_factory.known_tool_names()
    assert {"scene_add_node", "scene_apply_batch"} <= names
    # The room hub holds a scene hub so skill runs can author scenes.
    assert ctx.hub._scene_hub is not None
