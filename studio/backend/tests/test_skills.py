from pathlib import Path

import pytest

from app.skills import SkillRegistry, SkillError


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
