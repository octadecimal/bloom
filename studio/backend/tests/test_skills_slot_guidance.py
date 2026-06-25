from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_design_game_mentions_slot():
    text = (ROOT / "skills" / "design-game.md").read_text(encoding="utf-8")
    # Assert a concrete slot id token introduced by the new prose.
    # "high1" is absent before the edit and present after — genuine RED-before-GREEN.
    assert "high1" in text.lower()


def test_design_scene_mentions_slot_labeling():
    text = (ROOT / "skills" / "design-scene.md").read_text(encoding="utf-8")
    # Assert the specific compound token "props.slot" rather than "slot" and "props"
    # separately — both words already appear individually but not as "props.slot".
    assert "props.slot" in text.lower()
