from io import BytesIO
from pathlib import Path

from PIL import Image

from app.scene.asset_critic import (
    AssetCritiqueRequest,
    AssetVerdict,
    ReplayAssetCritic,
    asset_heuristic,
)


def _png(color, size=(64, 64)) -> bytes:
    buf = BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return buf.getvalue()


def test_heuristic_flags_fully_transparent_cutout():
    empty = Path("tests/fixtures/empty_reel_frame.png").read_bytes()
    v = asset_heuristic(empty, transparent=True)
    assert v is not None and v.action == "regenerate"
    assert "empty" in v.reason.lower() or "covered" in v.reason.lower()


def test_heuristic_flags_flat_opaque_image():
    v = asset_heuristic(_png((20, 20, 20, 255)), transparent=False)
    assert v is not None and v.action == "regenerate"


def test_heuristic_passes_a_rich_transparent_asset():
    # half-opaque/half-transparent, varied => not degenerate
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for x in range(64):
        for y in range(32):
            img.putpixel((x, y), (x * 4 % 256, y * 8 % 256, 128, 255))
    buf = BytesIO(); img.save(buf, format="PNG")
    assert asset_heuristic(buf.getvalue(), transparent=True) is None


async def test_replay_asset_critic_returns_keyed_verdict():
    critic = ReplayAssetCritic({"reel_frame": {"ok": False, "action": "regenerate", "reason": "empty frame"}})
    req = AssetCritiqueRequest(image_png=_png((5, 6, 7, 255), (64, 64)), role="reel_frame", transparent=True)
    # a rich image passes the heuristic, so the cassette decides
    v = await critic.critique(req)
    assert v.action == "regenerate" and v.reason == "empty frame"


async def test_replay_asset_critic_heuristic_short_circuits_before_cassette():
    # degenerate image => heuristic flags it even with a "keep" cassette
    empty = Path("tests/fixtures/empty_reel_frame.png").read_bytes()
    critic = ReplayAssetCritic({"reel_frame": {"ok": True, "action": "keep", "reason": "fine"}})
    req = AssetCritiqueRequest(image_png=empty, role="reel_frame", transparent=True)
    v = await critic.critique(req)
    assert v.action == "regenerate"


async def test_replay_asset_critic_defaults_to_keep_when_no_cassette():
    critic = ReplayAssetCritic({})
    req = AssetCritiqueRequest(image_png=_png((5, 6, 7, 255)), role="logo", transparent=True)
    v = await critic.critique(req)
    assert v.action == "keep"


def test_heuristic_flags_ghosted_solid():
    img = Path("tests/fixtures/ghosted_solid.png").read_bytes()
    v = asset_heuristic(img, transparent=True)
    assert v is not None and v.action == "regenerate"
    assert "see-through" in v.reason.lower() or "transparent" in v.reason.lower()


def test_heuristic_flags_hole_punched_solid():
    img = Path("tests/fixtures/holed_solid.png").read_bytes()
    v = asset_heuristic(img, transparent=True)
    assert v is not None and v.action == "regenerate"
    assert "hole" in v.reason.lower()


def test_heuristic_passes_legit_translucent_glow():
    # has an opaque core => NOT a ghosted solid; must defer to vision (return None)
    img = Path("tests/fixtures/translucent_glow.png").read_bytes()
    assert asset_heuristic(img, transparent=True) is None


def test_asset_prompt_checks_text_and_ghosted_solids():
    from app.scene.asset_critic import ASSET_SYSTEM_PROMPT

    low = ASSET_SYSTEM_PROMPT.lower()
    # item 1: must read and judge text on logos/UI
    assert "text" in low
    assert "misspelled" in low or "illegible" in low
    # item 5 (vision): must flag semi-transparent / ghosted solids
    assert "transparent" in low or "see-through" in low or "ghost" in low
    assert "opaque" in low
