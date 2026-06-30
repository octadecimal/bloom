from app.scene.layout.template import template_for, REELS, BACKGROUND
from app.scene.layout.plan import (
    PlannedRole, ScenePlan, canonical_role, resolve_region, scale_to_region,
)


def test_canonical_role_aliases():
    assert canonical_role("reels") == "reels"
    assert canonical_role("reel_frame") == "reels"
    assert canonical_role("grid") == "reels"
    assert canonical_role("BackGround") == "background"
    assert canonical_role("title") == "logo"
    assert canonical_role("spin_button") == "spin"
    assert canonical_role("totally-unknown") is None


def test_resolve_region_places_anchor_center_in_pixels():
    reels = template_for("landscape")[REELS]            # cx=0.5, cy=0.55, w=0.62, h=0.60
    pr = resolve_region(reels, (1280, 720))
    assert (pr.x, pr.y) == (640.0, 396.0)               # 0.5*1280, 0.55*720
    assert (pr.region_w, pr.region_h) == (794, 432)     # round(0.62*1280), round(0.60*720)
    assert pr.z == 20 and pr.fit == "region"


def test_background_resolves_to_cover():
    bg = template_for("landscape")[BACKGROUND]
    pr = resolve_region(bg, (1280, 720))
    assert pr.fit == "cover"


def test_scale_to_region_contains_texture_in_box():
    # a 512x512 texture into a 794x432 box -> limited by height: 432/512
    assert scale_to_region((512, 512), (794, 432)) == 432 / 512
    assert scale_to_region((0, 0), (794, 432)) == 1.0   # guard against div-by-zero


def test_scene_plan_for_role_uses_alias():
    pr = PlannedRole("reels", 640, 396, 0.5, 0.5, 20, "region", 794, 432)
    plan = ScenePlan(canvas=(1280, 720), orientation="landscape",
                     template_version=1, roles={"reels": pr})
    assert plan.for_role("reel_frame") is pr
    assert plan.for_role("nope") is None
