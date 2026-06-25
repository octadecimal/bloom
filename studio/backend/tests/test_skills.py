from pathlib import Path

import pytest

from app.skills import SkillRegistry, SkillError, SkillSpec, SkillArg, invocation_text


def write(dir: Path, name: str, text: str) -> None:
    (dir / name).write_text(text, encoding="utf-8")


GOOD = """---
name: generate-sprite
description: Generate a game sprite and add it to the Asset Board.
args:
  - { name: description, type: string, required: true }
  - { name: style, type: string, required: false }
tools: [generate_asset]
---
Use the generate_asset tool to create one sprite. Confirm what you made.
"""


def test_loads_and_lists_skill(tmp_path):
    write(tmp_path, "generate-sprite.md", GOOD)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    listed = reg.list_skills()
    assert listed == [
        {
            "name": "generate-sprite",
            "description": "Generate a game sprite and add it to the Asset Board.",
            "args": [
                {"name": "description", "type": "string", "required": True,
                 "description": "", "default": None, "enum": None},
                {"name": "style", "type": "string", "required": False,
                 "description": "", "default": None, "enum": None},
            ],
        }
    ]
    assert "generate_asset" in reg.get("generate-sprite").body


def test_unknown_tool_fails_fast(tmp_path):
    write(tmp_path, "bad.md", GOOD.replace("generate_asset", "nuke_everything"))
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    with pytest.raises(SkillError):
        reg.load()


def test_validate_args_requires_required(tmp_path):
    write(tmp_path, "generate-sprite.md", GOOD)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.get("generate-sprite")
    assert reg.validate_args(spec, {"description": "a knight"}) == {"description": "a knight"}
    with pytest.raises(SkillError):
        reg.validate_args(spec, {})  # missing required 'description'


ENRICHED = """---
name: gen-bg
description: Generate a background.
args:
  - { name: description, type: string, required: true }
  - { name: mood, type: string, enum: [bright, dark, neutral], default: neutral }
tools: [generate_asset]
---
Generate a background with generate_asset.
"""


def test_enriched_args_load_and_list(tmp_path):
    write(tmp_path, "gen-bg.md", ENRICHED)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    args = reg.list_skills()[0]["args"]
    assert args == [
        {"name": "description", "type": "string", "required": True,
         "description": "", "default": None, "enum": None},
        {"name": "mood", "type": "string", "required": False,
         "description": "", "default": "neutral", "enum": ["bright", "dark", "neutral"]},
    ]


def test_validate_args_applies_default(tmp_path):
    write(tmp_path, "gen-bg.md", ENRICHED)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.get("gen-bg")
    out = reg.validate_args(spec, {"description": "a forest"})
    assert out == {"description": "a forest", "mood": "neutral"}


def test_validate_args_rejects_out_of_enum(tmp_path):
    write(tmp_path, "gen-bg.md", ENRICHED)
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.get("gen-bg")
    with pytest.raises(SkillError):
        reg.validate_args(spec, {"description": "x", "mood": "sparkly"})


def test_repo_skills_dir_loads_background():
    from app.config import get_settings
    from app.gdd.models import GDD_TOOL_NAMES
    from app.scene.document import SCENE_TOOL_NAMES
    from app.tuner.models import TUNER_TOOL_NAMES

    reg = SkillRegistry(
        Path(get_settings().skills_dir),
        known_tools=({"generate_asset", "list_assets", "delete_asset"}
                     | GDD_TOOL_NAMES | SCENE_TOOL_NAMES | TUNER_TOOL_NAMES),
    )
    reg.load()
    names = {s["name"] for s in reg.list_skills()}
    assert {"generate-sprite", "generate-background"} <= names
    bg = reg.get("generate-background")
    assert [a.name for a in bg.args] == ["description", "mood", "aspect"]


def test_write_skill_round_trips(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    spec = reg.write_skill(
        name="my-skill",
        description="A test skill.",
        args=[{"name": "description", "type": "string", "required": True}],
        tools=["generate_asset"],
        body="Do the thing with generate_asset.",
    )
    assert spec.name == "my-skill"
    assert (tmp_path / "my-skill.md").exists()
    # reloaded into the live registry
    assert reg.get("my-skill") is not None
    assert reg.get("my-skill").body == "Do the thing with generate_asset."


def test_write_skill_rejects_unknown_tool(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    with pytest.raises(SkillError):
        reg.write_skill(name="bad", description="x", args=[],
                        tools=["nuke_everything"], body="x")


def test_write_skill_rejects_bad_slug(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    reg.load()
    with pytest.raises(SkillError):
        reg.write_skill(name="../escape", description="x", args=[],
                        tools=[], body="x")


def test_known_tools(tmp_path):
    reg = SkillRegistry(tmp_path, known_tools={"generate_asset"})
    assert reg.known_tools() == ["generate_asset"]


# ---------------------------------------------------------------------------
# invocation_text tests
# ---------------------------------------------------------------------------


def _spec():
    return SkillSpec(name="generate-sprite", description="d", args=[], tools=[], body="b")


def test_invocation_text_prefers_prose():
    assert invocation_text(_spec(), "a knight in armor", {}) == "a knight in armor"


def test_invocation_text_strips_prose():
    assert invocation_text(_spec(), "  a knight  ", {"style": "pixel"}) == "a knight"


def test_invocation_text_renders_args_when_no_prose():
    out = invocation_text(_spec(), "", {"description": "a knight", "style": "pixel"})
    assert out == '/generate-sprite description="a knight", style="pixel"'


def test_invocation_text_bare_name_when_empty():
    assert invocation_text(_spec(), "", {}) == "/generate-sprite"


# ---------------------------------------------------------------------------
# validate_args with enforce_required tests
# ---------------------------------------------------------------------------


def _reg():
    return SkillRegistry(skills_dir=".", known_tools=set())


def _required_spec():
    return SkillSpec(
        name="generate-sprite",
        description="d",
        args=[SkillArg(name="description", type="string", required=True)],
        tools=[],
        body="b",
    )


def test_validate_args_enforces_required_by_default():
    with pytest.raises(SkillError):
        _reg().validate_args(_required_spec(), {})


def test_validate_args_skips_required_when_disabled():
    assert _reg().validate_args(_required_spec(), {}, enforce_required=False) == {}


def test_manage_assets_skill_loads_with_asset_tools():
    from app.config import get_settings
    from app.gdd.models import GDD_TOOL_NAMES
    from app.scene.document import SCENE_TOOL_NAMES
    from app.tuner.models import TUNER_TOOL_NAMES

    reg = SkillRegistry(
        Path(get_settings().skills_dir),
        known_tools=({"generate_asset", "list_assets", "delete_asset"}
                     | GDD_TOOL_NAMES | SCENE_TOOL_NAMES | TUNER_TOOL_NAMES),
    )
    reg.load()
    spec = reg.get("manage-assets")
    assert spec is not None
    assert spec.tools == ["list_assets", "delete_asset"]
    assert any(a.name == "target" and a.required for a in spec.args)
