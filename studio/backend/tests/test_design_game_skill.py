# studio/backend/tests/test_design_game_skill.py
from pathlib import Path
from app.skills import SkillRegistry
from app.gdd.models import GDD_TOOL_NAMES
from app.scene.document import SCENE_TOOL_NAMES

SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def test_design_game_skill_loads_with_known_gdd_tools():
    known = (GDD_TOOL_NAMES | {"generate_asset", "list_assets", "delete_asset"}
             | SCENE_TOOL_NAMES)
    reg = SkillRegistry(SKILLS_DIR, known)
    reg.load()  # raises if any skill declares an unknown tool
    spec = reg.get("design-game")
    assert spec is not None
    assert set(spec.tools) == GDD_TOOL_NAMES
    assert "gap" in spec.body.lower()  # encodes the gap-driven loop
