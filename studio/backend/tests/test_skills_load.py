from pathlib import Path

from app.agent_tools import ToolFactory
from app.skills import SkillRegistry

_SKILLS_DIR = Path(__file__).resolve().parents[3] / "skills"


def test_tune_math_skill_loads_with_four_tools():
    reg = SkillRegistry(_SKILLS_DIR, ToolFactory(None, None).known_tool_names())
    reg.load()
    spec = reg.get("tune-math")
    assert spec is not None
    assert set(spec.tools) == {
        "read_tuner_setup", "set_tuner_params", "tune_slot_model", "apply_tuned_model",
    }
