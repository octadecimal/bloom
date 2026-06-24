from pathlib import Path
from app.skills import SkillRegistry
from app.scene.document import SCENE_TOOL_NAMES
from app.gdd.models import GDD_TOOL_NAMES

SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def test_design_scene_skill_loads_with_known_scene_tools():
    known = SCENE_TOOL_NAMES | {"generate_asset", "list_assets", "delete_asset"} | GDD_TOOL_NAMES
    reg = SkillRegistry(SKILLS_DIR, known)
    reg.load()  # raises if any skill declares an unknown tool
    spec = reg.get("design-scene")
    assert spec is not None
    assert set(spec.tools) == SCENE_TOOL_NAMES
    assert "node" in spec.body.lower()  # encodes the node-graph authoring loop
