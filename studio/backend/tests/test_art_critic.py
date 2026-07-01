import asyncio
import json
from pathlib import Path

from app.replay.cassette import load_scene_art_cassettes, normalize_prompt
from app.scene.art_critic import (
    ReplaySceneArtCritic,
    SceneArtRequest,
    SceneArtVerdict,
)


def test_loader_keys_by_theme_and_default(tmp_path: Path):
    base = tmp_path / "scene_art"
    base.mkdir()
    (base / "default.json").write_text(json.dumps({"passes": [{"premium": True}]}))
    (base / "pirate.json").write_text(json.dumps(
        {"theme": "Pirate Slot", "passes": [{"premium": False, "summary": "flat"}]}))
    out = load_scene_art_cassettes(tmp_path)
    assert out["__default__"] == [{"premium": True}]
    assert out[normalize_prompt("Pirate Slot")] == [{"premium": False, "summary": "flat"}]


def test_replay_returns_keyed_pass_then_benign_default():
    critic = ReplaySceneArtCritic({
        "pirate slot": [
            {"premium": False, "summary": "logo washed out",
             "regenerate": [{"target_handle": "logo", "why": "lost to glow"}]},
            {"premium": True, "summary": "reads premium"},
        ],
    })
    req0 = SceneArtRequest(frame_png=b"x", scene={}, theme="pirate slot", pass_index=0)
    v0 = asyncio.run(critic.grade(req0))
    assert v0.premium is False
    assert v0.regenerate[0].target_handle == "logo"

    # pass_index past the recorded passes -> benign premium (loop can end)
    req9 = SceneArtRequest(frame_png=b"x", scene={}, theme="pirate slot", pass_index=9)
    assert asyncio.run(critic.grade(req9)).premium is True

    # unknown theme, no default -> benign premium (never raises; additive stage)
    req_unknown = SceneArtRequest(frame_png=b"x", scene={}, theme="unknown")
    assert asyncio.run(critic.grade(req_unknown)).premium is True
